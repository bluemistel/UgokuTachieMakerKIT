import React, { useState, useEffect, useRef } from 'react';

const fs = window.require ? window.require('fs-extra') : {};
const path = window.require ? window.require('path') : {};
const { webUtils } = window.require ? window.require('electron') : {};

/**
 * A component that loads a PNG using Base64, crops it to its non-transparent bounds,
 * and adds a 10px margin. Using Base64 avoids file:// protocol CORS issues in Electron.
 */
const TrimmedImage = ({ filePath, alt, style }) => {
    const canvasRef = useRef(null);
    const [dataUrl, setDataUrl] = useState('');

    useEffect(() => {
        if (!filePath) return;
        try {
            const buffer = fs.readFileSync(filePath.replace('file://', ''));
            setDataUrl(`data:image/png;base64,${buffer.toString('base64')}`);
        } catch (e) {
            console.error("Failed to read image for trimming:", e);
        }
    }, [filePath]);

    useEffect(() => {
        if (!dataUrl) return;
        const img = new Image();
        img.src = dataUrl;
        img.onload = () => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const w = img.width;
            const h = img.height;
            if (w === 0 || h === 0) return;

            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(img, 0, 0);

            const imageData = ctx.getImageData(0, 0, w, h);
            const data = imageData.data;
            let minX = w, minY = h, maxX = 0, maxY = 0;
            let found = false;

            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const alpha = data[(y * w + x) * 4 + 3];
                    if (alpha > 0) {
                        minX = Math.min(minX, x);
                        minY = Math.min(minY, y);
                        maxX = Math.max(maxX, x);
                        maxY = Math.max(maxY, y);
                        found = true;
                    }
                }
            }

            if (!found) {
                canvas.width = 1; canvas.height = 1;
                return;
            }

            const margin = 10;
            const cropW = (maxX - minX) + 1;
            const cropH = (maxY - minY) + 1;

            canvas.width = cropW + margin * 2;
            canvas.height = cropH + margin * 2;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, minX, minY, cropW, cropH, margin, margin, cropW, cropH);
        };
    }, [dataUrl]);

    return <canvas ref={canvasRef} style={{ ...style, maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} title={alt} />;
};

export default function EyeblinkLipSyncPopup({ onClose }) {
    const [currentFolder, setCurrentFolder] = useState('');
    const [allImages, setAllImages] = useState([]);
    const [gridImages, setGridImages] = useState([]);
    const [selectedImage, setSelectedImage] = useState(null);
    const [previewDataUrls, setPreviewDataUrls] = useState([]); // Array of Base64 strings
    const [previewIndex, setPreviewIndex] = useState(0);
    const [isPlaying, setIsPlaying] = useState(true);
    const [showAllFiles, setShowAllFiles] = useState(false);
    const [isAiueoMode, setIsAiueoMode] = useState(false);

    // Configuration Area State
    const [baseImage, setBaseImage] = useState(null);
    const [closedImage, setClosedImage] = useState(null);
    const [intermediateImages, setIntermediateImages] = useState([]);
    const [vowelImages, setVowelImages] = useState({ a: null, i: null, u: null, e: null, o: null });
    const [reorderDragIndex, setReorderDragIndex] = useState(null); // 中間フレーム並び替え中の元インデックス

    const previewIntervalRef = useRef(null);
    const containerRef = useRef(null);

    useEffect(() => {
        const regex = /\.(?:[0-9]+|[aiueo])\.png$/i;
        const filtered = allImages.filter(img => {
            if (showAllFiles) return true;
            return !regex.test(img.name);
        }).map(img => {
            const basename = img.name.replace(/\.png$/i, '');
            const hasConfig = allImages.some(x => x.name === `${basename}.0.png`);
            return { ...img, hasConfig };
        });
        setGridImages(filtered);
    }, [allImages, showAllFiles]);

    const loadFolder = async (folderPath) => {
        try {
            if (!(await fs.stat(folderPath)).isDirectory()) {
                alert('フォルダをドロップしてください。');
                return;
            }
            setCurrentFolder(folderPath);
            const files = await fs.readdir(folderPath);
            const pngFiles = files.filter(f => f.toLowerCase().endsWith('.png')).map(f => ({
                name: f,
                fullPath: path.join(folderPath, f)
            }));
            setAllImages(pngFiles);

            setSelectedImage(null);
            setPreviewDataUrls([]);
            setBaseImage(null);
            setClosedImage(null);
            setIntermediateImages([]);
            setVowelImages({ a: null, i: null, u: null, e: null, o: null });
        } catch (err) {
            console.error('Failed to load folder:', err);
            alert('フォルダの読み込みに失敗しました。');
        }
    };

    const handleDragOver = (e) => {
        e.preventDefault();
    };

    const handleDropToFolder = async (e) => {
        e.preventDefault();
        const items = e.dataTransfer.files;
        if (items.length > 0) {
            const item = items[0];
            let itemPath = item.path;
            if (!itemPath && webUtils?.getPathForFile) {
                try { itemPath = webUtils.getPathForFile(item); } catch { }
            }
            if (itemPath) await loadFolder(itemPath);
        }
    };

    const getPreviewPaths = () => {
        if (!baseImage) return [];

        // Prioritize current configuration state
        if (isAiueoMode) {
            if (Object.values(vowelImages).some(v => v) || closedImage) {
                const paths = [baseImage.fullPath];
                ['a', 'i', 'u', 'e', 'o'].forEach(v => {
                    if (vowelImages[v]) paths.push(vowelImages[v].fullPath);
                });
                if (closedImage) paths.push(closedImage.fullPath);
                return paths;
            }
        } else {
            if (intermediateImages.length > 0 || closedImage) {
                const paths = [baseImage.fullPath];
                const reversed = [...intermediateImages].reverse();
                reversed.forEach(img => { if (img) paths.push(img.fullPath); });
                if (closedImage) paths.push(closedImage.fullPath);
                return paths;
            }
        }

        // Fallback to disk files
        const basename = baseImage.name.replace(/\.png$/i, '');
        const paths = [baseImage.fullPath];

        if (isAiueoMode) {
            ['a', 'i', 'u', 'e', 'o'].forEach(v => {
                const vPath = path.join(currentFolder, `${basename}.${v}.png`);
                const matched = allImages.find(x => x.fullPath === vPath);
                if (matched) paths.push(matched.fullPath);
            });
        } else {
            const diskIntermediates = [];
            let i = 1;
            while (true) {
                const iPath = path.join(currentFolder, `${basename}.${i}.png`);
                const found = allImages.find(x => x.fullPath === iPath);
                if (found) {
                    diskIntermediates.push(found.fullPath);
                    i++;
                } else { break; }
            }
            paths.push(...diskIntermediates.reverse());
        }

        const closedPath = path.join(currentFolder, `${basename}.0.png`);
        const foundClosed = allImages.find(x => x.fullPath === closedPath);
        if (foundClosed) paths.push(foundClosed.fullPath);

        return paths;
    };

    const loadPreviewUrls = () => {
        if (!baseImage) {
            setPreviewDataUrls([]);
            return;
        }

        const paths = getPreviewPaths();
        const urls = paths.map(p => {
            try {
                const buffer = fs.readFileSync(p);
                return `data:image/png;base64,${buffer.toString('base64')}`;
            } catch (e) { return ''; }
        }).filter(u => u !== '');

        setPreviewDataUrls(urls);
        // Do not reset previewIndex to 0 here to maintain position when toggling play/pause
    };

    useEffect(() => {
        loadPreviewUrls();
    }, [baseImage, intermediateImages, vowelImages, closedImage, allImages, isAiueoMode]);

    const handleImageSelect = (img) => {
        setSelectedImage(img);
        setBaseImage(img);

        const basename = img.name.replace(/\.png$/i, '');

        // Auto-populate normal intermediates
        const intermediates = [];
        let i = 1;
        while (true) {
            const iPath = path.join(currentFolder, `${basename}.${i}.png`);
            const found = allImages.find(x => x.fullPath === iPath);
            if (found) {
                intermediates.push(found);
                i++;
            } else { break; }
        }
        setIntermediateImages(intermediates);

        // Auto-populate vowels
        const vowels = { a: null, i: null, u: null, e: null, o: null };
        ['a', 'i', 'u', 'e', 'o'].forEach(v => {
            const vPath = path.join(currentFolder, `${basename}.${v}.png`);
            vowels[v] = allImages.find(x => x.fullPath === vPath) || null;
        });
        setVowelImages(vowels);

        // Auto-populate closed
        const closedPath = path.join(currentFolder, `${basename}.0.png`);
        setClosedImage(allImages.find(x => x.fullPath === closedPath) || null);

        setIsPlaying(true);
        setPreviewIndex(0); // Reset only on NEW image selection
    };

    useEffect(() => {
        if (previewIntervalRef.current) clearInterval(previewIntervalRef.current);
        if (previewDataUrls.length > 1 && isPlaying) {
            const intervalMs = Math.floor(1500 / previewDataUrls.length);
            previewIntervalRef.current = setInterval(() => {
                setPreviewIndex(prev => (prev + 1) % previewDataUrls.length);
            }, intervalMs);
        }
        return () => clearInterval(previewIntervalRef.current);
    }, [previewDataUrls, isPlaying]);

    const handleDuplicate = async (e, img) => {
        e.stopPropagation();
        try {
            const ext = path.extname(img.name);
            const base = path.basename(img.name, ext);
            let dupIndex = 1;
            let newName = `${base} (${dupIndex})${ext}`;
            let newPath = path.join(currentFolder, newName);
            while (await fs.pathExists(newPath)) {
                dupIndex++;
                newName = `${base} (${dupIndex})${ext}`;
                newPath = path.join(currentFolder, newName);
            }
            await fs.copy(img.fullPath, newPath);
            await loadFolder(currentFolder);
        } catch (err) { alert('ファイルの複製に失敗しました。'); console.error(err); }
    };

    const handleDelete = async (e, img) => {
        e.stopPropagation();
        if (window.confirm(`「${img.name}」を削除しますか？`)) {
            try {
                await fs.remove(img.fullPath);
                await loadFolder(currentFolder);
                if (selectedImage?.fullPath === img.fullPath) { setSelectedImage(null); setPreviewDataUrls([]); }
            } catch (err) { alert('ファイルの削除に失敗しました。'); console.error(err); }
        }
    };

    const handleDragStartGridItem = (e, img) => {
        e.dataTransfer.setData('gridImage', JSON.stringify(img));
    };

    const handleDropToBase = (e) => {
        e.preventDefault();
        const str = e.dataTransfer.getData('gridImage');
        if (str) {
            const img = JSON.parse(str);
            handleImageSelect(img);
        }
    };

    const handleDropToVowel = (e, vowel) => {
        e.preventDefault();
        const str = e.dataTransfer.getData('gridImage');
        if (str) {
            const img = JSON.parse(str);
            setVowelImages(prev => ({ ...prev, [vowel]: img }));
        }
    };

    const handleDropToClosed = (e) => {
        e.preventDefault();
        const str = e.dataTransfer.getData('gridImage');
        if (str) setClosedImage(JSON.parse(str));
    };

    const handleDropToIntermediate = (e, targetIndex) => {
        e.preventDefault();

        // 中間フレーム同士のドラッグによる並び替え
        const reorderStr = e.dataTransfer.getData('intermediateReorder');
        if (reorderStr !== '') {
            const fromIndex = parseInt(reorderStr, 10);
            setReorderDragIndex(null);
            if (Number.isNaN(fromIndex)) return;
            setIntermediateImages(prev => {
                // 新規追加スロット（末尾＝UI最下部）へは配列先頭へ移動する
                let toIndex = targetIndex === prev.length ? 0 : targetIndex;
                if (fromIndex === toIndex) return prev;
                const next = [...prev];
                const [moved] = next.splice(fromIndex, 1);
                // 取り除いた分だけ挿入位置がずれるので補正
                if (fromIndex < toIndex) toIndex -= 1;
                next.splice(toIndex, 0, moved);
                return next;
            });
            return;
        }

        const str = e.dataTransfer.getData('gridImage');
        if (str) {
            const img = JSON.parse(str);
            setIntermediateImages(prev => {
                if (targetIndex === prev.length) {
                    // 新規追加スロット（UI上は一番下＝閉じの直前）へのドロップ時は、
                    // 配列の先頭に追加することで、UIの下部に正しく配置されるようにする
                    return [img, ...prev];
                }
                // 既存スロットへの上書きドロップ
                const next = [...prev];
                next[targetIndex] = img;
                return next;
            });
        }
    };

    const handleReorderDragStart = (e, index) => {
        e.dataTransfer.setData('intermediateReorder', String(index));
        e.dataTransfer.effectAllowed = 'move';
        setReorderDragIndex(index);
    };

    const handleReorderDragEnd = () => {
        setReorderDragIndex(null);
    };

    const saveSettings = async () => {
        if (!baseImage) return;
        if (!closedImage) { alert('閉じ画像が設定されていません'); return; }

        if (isAiueoMode) {
            const missing = Object.entries(vowelImages).filter(([_, img]) => !img).map(([v]) => v);
            if (missing.length > 0) {
                alert(`あいうえお口パクの場合、全ての母音パーツが必要です。欠落: ${missing.join(', ')}`);
                return;
            }
        }

        const basename = baseImage.name.replace(/\.png$/i, '');
        try {
            const closedPath = path.join(currentFolder, `${basename}.0.png`);
            await fs.copy(closedImage.fullPath, closedPath);

            if (isAiueoMode) {
                for (const [v, img] of Object.entries(vowelImages)) {
                    const vPath = path.join(currentFolder, `${basename}.${v}.png`);
                    await fs.copy(img.fullPath, vPath);
                }
            } else {
                for (let i = 0; i < intermediateImages.length; i++) {
                    const interImg = intermediateImages[i];
                    if (interImg) {
                        const interPath = path.join(currentFolder, `${basename}.${i + 1}.png`);
                        await fs.copy(interImg.fullPath, interPath);
                    }
                }
            }

            alert(`設定を保存し、ファイルを生成しました。`);
            await loadFolder(currentFolder);
            const img = allImages.find(x => x.fullPath === baseImage.fullPath);
            if (img) handleImageSelect(img);
        } catch (err) { console.error("Save failed:", err); alert("保存処理中にエラーが発生しました。"); }
    };

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: '16px', boxSizing: 'border-box' }} 
            onDragOver={e => e.preventDefault()} onDrop={e => e.preventDefault()} ref={containerRef}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <h2 style={{ fontSize: '1.2rem', color: 'var(--accent-color)' }}>目パチ・口パク設定</h2>
                </div>

                {!currentFolder ? (
                    <div className="drop-zone" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        onDragOver={handleDragOver} onDrop={handleDropToFolder}>
                        <p>動く立ち絵として出力されたPNG画像が格納されている<br />「目」か「口」フォルダをドラッグ&ドロップしてください</p>
                    </div>
                ) : (
                    <div style={{ display: 'flex', flex: 1, gap: '15px', minHeight: 0 }}>

                        {/* ① 素材一覧 */}
                        <div className="glass" style={{ width: '310px', flex: 'none', overflowY: 'auto', overflowX: 'hidden', padding: '10px 5px 10px 10px', display: 'flex', flexDirection: 'column' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5px', flex: 'none', paddingRight: '5px' }}>
                                <h3 style={{ fontSize: '0.9rem' }}>素材一覧</h3>
                                <button className="btn-secondary" style={{ fontSize: '0.7rem', padding: '2px 8px' }} onClick={() => setCurrentFolder('')}>変更</button>
                            </div>
                            <label style={{ fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '10px', cursor: 'pointer', opacity: 0.8 }}>
                                <input type="checkbox" checked={showAllFiles} onChange={e => setShowAllFiles(e.target.checked)} />
                                システムファイルを表示
                            </label>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', paddingRight: '12px' }}>
                                {gridImages.map(img => (
                                    <div key={img.fullPath}
                                        className={`grid-item glass ${selectedImage?.fullPath === img.fullPath ? 'selected' : ''}`}
                                        onClick={() => handleImageSelect(img)}
                                        draggable
                                        onDragStart={(e) => handleDragStartGridItem(e, img)}
                                        style={{ cursor: 'grab', padding: '6px' }}>
                                        <div className="grid-item-actions">
                                            <button title="複製" onClick={(e) => handleDuplicate(e, img)}>📑</button>
                                            <button title="削除" onClick={(e) => handleDelete(e, img)}>🗑️</button>
                                        </div>
                                        <div style={{ height: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', pointerEvents: 'none' }}>
                                            <TrimmedImage filePath={img.fullPath} alt={img.name} />
                                        </div>
                                        <div style={{
                                            fontSize: '0.7rem',
                                            textAlign: 'center',
                                            marginTop: '6px',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                            color: img.hasConfig ? '#fef08a' : 'inherit',
                                            fontWeight: img.hasConfig ? 'bold' : 'normal'
                                        }}>{img.name}</div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* ③ 目パチ・口パク設定 */}
                        <div className="glass" style={{ width: '330px', flex: 'none', display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0, padding: '10px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flex: 'none' }}>
                                <h3 style={{ fontSize: '0.9rem' }}>設定領域</h3>
                                <div style={{ display: 'flex', gap: '5px' }}>
                                    <button
                                        className={`btn-secondary ${isAiueoMode ? 'active' : ''}`}
                                        style={{
                                            fontSize: '0.8rem',
                                            padding: '4px 8px',
                                            fontWeight: 'bold',
                                            border: isAiueoMode ? '2px solid #fef08a' : undefined,
                                            boxShadow: isAiueoMode ? '0 0 5px rgba(254, 240, 138, 0.5)' : undefined
                                        }}
                                        onClick={() => setIsAiueoMode(!isAiueoMode)}
                                        title="あいうえお口パクの設定">
                                        あ
                                    </button>
                                    {baseImage && <button className="btn-primary" style={{ fontSize: '0.8rem', padding: '4px 12px' }} onClick={saveSettings}>保存</button>}
                                </div>
                            </div>

                            {!baseImage ? (
                                <div className="drop-zone" style={{ flex: 1 }} onDragOver={handleDragOver} onDrop={handleDropToBase}>
                                    <p style={{ fontSize: '0.8rem', textAlign: 'center', opacity: 0.6 }}>ここに素材を落とすと<br />設定を開始します</p>
                                </div>
                            ) : (
                                <div style={{ flex: 1, overflowY: 'auto', paddingRight: '5px' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', paddingTop: '15px' }}>

                                        {/* 開き */}
                                        <div className="setting-slot drop-zone active" onDragOver={handleDragOver} onDrop={handleDropToBase} style={{ width: '100%', height: '110px', flex: 'none' }}>
                                            <span className="slot-title">1. 開き (基準)</span>
                                            <div style={{ height: '60px', display: 'flex', alignItems: 'center' }}>
                                                <TrimmedImage filePath={baseImage.fullPath} alt="base" />
                                            </div>
                                            <span className="slot-name">{baseImage.name}</span>
                                        </div>

                                        <div style={{ color: 'var(--accent-color)', opacity: 0.3, textAlign: 'center', fontSize: '1rem', margin: '-8px 0' }}>▼</div>

                                        {isAiueoMode ? (
                                            <>
                                                {['a', 'i', 'u', 'e', 'o'].map(v => (
                                                    <div key={v} className="setting-slot drop-zone" onDragOver={handleDragOver} onDrop={(e) => handleDropToVowel(e, v)} style={{ width: '100%', height: '100px', flex: 'none', borderColor: vowelImages[v] ? undefined : '#ffaa44' }}>
                                                        <span className="slot-title">口形: {v.toUpperCase()} {v === 'a' ? '(必須)' : ''}</span>
                                                        {vowelImages[v] ? (
                                                            <>
                                                                <div style={{ height: '50px', display: 'flex', alignItems: 'center' }}>
                                                                    <TrimmedImage filePath={vowelImages[v].fullPath} alt={v} />
                                                                </div>
                                                                <span className="slot-name">{vowelImages[v].name}</span>
                                                            </>
                                                        ) : (
                                                            <p style={{ fontSize: '0.7rem' }}>素材をドロップ</p>
                                                        )}
                                                    </div>
                                                ))}
                                            </>
                                        ) : (
                                            <>
                                                {/* 中間フレーム */}
                                                {intermediateImages.slice().reverse().map((img, revIndex) => {
                                                    const i = intermediateImages.length - 1 - revIndex;
                                                    return (
                                                        <div
                                                            key={`param-${i}`}
                                                            className="setting-slot drop-zone"
                                                            draggable={!!img}
                                                            onDragStart={img ? (e) => handleReorderDragStart(e, i) : undefined}
                                                            onDragEnd={handleReorderDragEnd}
                                                            onDragOver={handleDragOver}
                                                            onDrop={(e) => handleDropToIntermediate(e, i)}
                                                            style={{ width: '100%', height: '110px', flex: 'none', cursor: img ? 'grab' : undefined, opacity: reorderDragIndex === i ? 0.4 : 1 }}
                                                        >
                                                            <span className="slot-title">中間フレーム {i + 1}</span>
                                                            {img ? (
                                                                <>
                                                                    <div style={{ height: '60px', display: 'flex', alignItems: 'center' }}>
                                                                        <TrimmedImage filePath={img.fullPath} alt="intermediate" />
                                                                    </div>
                                                                    <span className="slot-name">{img.name}</span>
                                                                    <button className="btn-icon delete remove-slot" onClick={() => {
                                                                        setIntermediateImages(prev => {
                                                                            const next = [...prev];
                                                                            next.splice(i, 1);
                                                                            return next;
                                                                        });
                                                                    }}>×</button>
                                                                </>
                                                            ) : (
                                                                <p style={{ fontSize: '0.7rem' }}>素材をドロップ</p>
                                                            )}
                                                        </div>
                                                    );
                                                })}

                                                {/* 次の中間フレーム用空スロット */}
                                                <div className="setting-slot drop-zone empty" onDragOver={handleDragOver} onDrop={(e) => handleDropToIntermediate(e, intermediateImages.length)} style={{ width: '100%', height: '50px', flex: 'none' }}>
                                                    <span className="slot-title">中間追加</span>
                                                    <p style={{ fontSize: '0.8rem' }}>+ 中間フレームを追加</p>
                                                </div>
                                            </>
                                        )}

                                        <div style={{ color: 'var(--accent-color)', opacity: 0.3, textAlign: 'center', fontSize: '1rem', margin: '-8px 0' }}>▼</div>

                                        {/* 閉じ */}
                                        <div className="setting-slot drop-zone" onDragOver={handleDragOver} onDrop={handleDropToClosed} style={{ width: '100%', height: '110px', flex: 'none', borderColor: closedImage ? undefined : '#ff4444' }}>
                                            <span className="slot-title">2. 閉じ (必須)</span>
                                            {closedImage ? (
                                                <>
                                                    <div style={{ height: '60px', display: 'flex', alignItems: 'center' }}>
                                                        <TrimmedImage filePath={closedImage.fullPath} alt="closed" />
                                                    </div>
                                                    <span className="slot-name">{closedImage.name}</span>
                                                    <button className="btn-icon delete remove-slot" onClick={() => setClosedImage(null)}>×</button>
                                                </>
                                            ) : (
                                                <p style={{ color: '#ff4444', fontSize: '0.7rem' }}>素材をドロップ</p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* ② プレビュー */}
                        <div className="glass" style={{ flex: 1.2, position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px', overflow: 'hidden' }}>
                            <h3 style={{ fontSize: '0.9rem', alignSelf: 'flex-start', marginBottom: '10px' }}>プレビュー</h3>
                            {previewDataUrls.length > 0 && (
                                <button className="btn-secondary" style={{ position: 'absolute', top: 10, right: 10, fontSize: '0.75rem' }} onClick={() => setIsPlaying(!isPlaying)}>
                                    {isPlaying ? '⏸️ 一時停止' : '▶️ 再生'}
                                </button>
                            )}
                            {selectedImage ? (
                                <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', width: '100%', overflow: 'hidden' }}>
                                    <img src={previewDataUrls.length > 0 ? previewDataUrls[previewIndex] : ''}
                                        alt="preview"
                                        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                                </div>
                            ) : (
                                <p style={{ marginTop: 'auto', marginBottom: 'auto', opacity: 0.4, textAlign: 'center', fontSize: '0.9rem' }}>素材を選択すると<br />アニメーションを表示します</p>
                            )}
                        </div>

                    </div>
                )}
        </div>
    );
}
