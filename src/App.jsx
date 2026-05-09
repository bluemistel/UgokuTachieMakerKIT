import React, { useState, useEffect, useRef, useCallback } from 'react';
import { readPsd } from 'ag-psd';
import EyeblinkLipSyncPopup from './EyeblinkLipSyncPopup';

const fs = window.require ? window.require('fs-extra') : {};
const path = window.require ? window.require('path') : {};
const { webUtils } = window.require ? window.require('electron') : {};

// Back-to-Front rendering order
const RENDER_ORDER = ['後', '体', '顔色', '口', '目', '眉', '髪', '他'];
const SLOT_COUNT = 3;
const CURRENT_VERSION = '1.0.7';
const BOOTH_URL = 'https://bluemist.booth.pm/items/8064115';
const NOTION_FORM_URL = 'https://ionian-gallimimus-e47.notion.site/32b8c5bf8aa481978f37e470a25e1e01';

const INITIAL_MAPPING_DATA = RENDER_ORDER.reduce((acc, cat) => {
  acc[cat] = { mode: cat === '体' ? 'composite' : 'simple', items: [], composites: cat === '体' ? [{ name: '体1', layers: [] }] : [] };
  return acc;
}, {});

// --- PSDTool Notation Parser ---
function parseLayerName(rawName) {
  let name = rawName || '';
  let isForced = false;
  let isRadio = false;
  let flipType = null;

  if (name.startsWith('!')) { isForced = true; name = name.slice(1); }
  else if (name.startsWith('*')) { isRadio = true; name = name.slice(1); }

  const flipPatterns = [':flipxy', ':flipx', ':flipy'];
  for (const p of flipPatterns) {
    if (name.endsWith(p)) { flipType = p.slice(1); name = name.slice(0, -p.length); break; }
  }

  return { displayName: name.trim(), isForced, isRadio, flipType };
}

function App() {
  const [psdData, setPsdData] = useState(null);
  const [psdPath, setPsdPath] = useState('');
  const [treeData, setTreeData] = useState([]);
  const [expandedNodes, setExpandedNodes] = useState(new Set());
  const [viewMode, setViewMode] = useState('mapping');
  const [selectedPaths, setSelectedPaths] = useState(new Set());
  const [lastSelectedPath, setLastSelectedPath] = useState(null);
  const [mappingData, setMappingData] = useState(INITIAL_MAPPING_DATA);
  const [selections, setSelections] = useState({});
  const [disabledSlots, setDisabledSlots] = useState(new Set());
  const [radioSelections, setRadioSelections] = useState({}); // parentPath → selectedChildFullPath
  const [treeVisibility, setTreeVisibility] = useState({}); // path → boolean (for manual toggles)
  const [showFlipLayers, setShowFlipLayers] = useState(false);
  const [previewComposite, setPreviewComposite] = useState(null); // { category, variantIdx } for click-preview
  const [isProcessing, setIsProcessing] = useState(false);
  const canvasRef = useRef(null);
  const wrapperRef = useRef(null);
  const nodeMapRef = useRef(new Map());
  const [outputPath, setOutputPath] = useState('');
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportWidth, setExportWidth] = useState(0);
  const [exportHeight, setExportHeight] = useState(0);
  const [maintainAspect, setMaintainAspect] = useState(true);
  const [exportFolderName, setExportFolderName] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [mappingWidth, setMappingWidth] = useState(340);
  const [mainTab, setMainTab] = useState('mapping'); // 'mapping' or 'animation'
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showAppInfoModal, setShowAppInfoModal] = useState(false);
  const [latestVersion, setLatestVersion] = useState(null);
  const isResizingSidebar = useRef(false);
  const isResizingMapping = useRef(false);

  // Zoom & Pan state
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastMousePos, setLastMousePos] = useState({ x: 0, y: 0 });
  const [hasMovedDuringClick, setHasMovedDuringClick] = useState(false);

  const sanitizeFilename = (name) => name.replace(/:/g, '：').replace(/\*/g, '＊').replace(/[\\/?"<>|!]/g, '').trim();

  const saveState = useCallback(async (currentPsdPath, currentMappingData, currentSelections, currentDisabledSlots, currentRadioSelections, currentOutputPath, currentFolderName, currentTreeVisibility) => {
    if (!currentPsdPath) return;
    try {
      const configPath = `${currentPsdPath}.config.json`;
      await fs.writeJson(configPath, {
        mappingData: currentMappingData,
        selections: currentSelections,
        disabledSlots: Array.from(currentDisabledSlots),
        radioSelections: currentRadioSelections,
        treeVisibility: currentTreeVisibility,
        outputPath: currentOutputPath,
        exportFolderName: currentFolderName,
        version: '12.1'
      }, { spaces: 2 });
    } catch (err) { console.error('Failed to auto-save:', err); }
  }, []);

  useEffect(() => {
    if (psdPath && !isProcessing) {
      const timer = setTimeout(() => saveState(psdPath, mappingData, selections, disabledSlots, radioSelections, outputPath, exportFolderName, treeVisibility), 1000);
      return () => clearTimeout(timer);
    }
  }, [mappingData, selections, disabledSlots, radioSelections, outputPath, exportFolderName, psdPath, saveState, isProcessing, treeVisibility]);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (isResizingSidebar.current) setSidebarWidth(Math.max(150, Math.min(600, e.clientX)));
      if (isResizingMapping.current) setMappingWidth(Math.max(250, Math.min(800, window.innerWidth - e.clientX)));
    };
    const handleMouseUp = () => { isResizingSidebar.current = false; isResizingMapping.current = false; document.body.style.cursor = 'default'; };
    const handleClickOutside = (e) => { if (!e.target.closest('.menu-container')) setDropdownOpen(false); };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('mousedown', handleClickOutside);
    return () => { 
      window.removeEventListener('mousemove', handleMouseMove); 
      window.removeEventListener('mouseup', handleMouseUp); 
      window.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleDrop = async (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      let filePath = file.path;
      if (!filePath && webUtils?.getPathForFile) { try { filePath = webUtils.getPathForFile(file); } catch { } }
      if (filePath && (filePath.toLowerCase().endsWith('.psd') || filePath.toLowerCase().endsWith('.psb'))) loadPsd(filePath);
    }
  };

  const loadPsd = async (filePath) => {
    setIsProcessing(true);
    try {
      const buffer = await fs.readFile(filePath);
      const psd = readPsd(buffer, { skipLayerImageData: false, skipThumbnail: true });
      setPsdData(psd);
      setPsdPath(filePath);
      const psdDir = path.dirname(filePath);
      const psdName = path.basename(filePath, path.extname(filePath));
      setOutputPath(psdDir);
      setExportFolderName(`${psdName}_Export`);
      setExportWidth(psd.width);
      setExportHeight(psd.height);

      const buildTree = (children, parentPath = '', inForcedTree = false) => [...children].reverse().map(child => {
        const { displayName, isForced, isRadio, flipType } = parseLayerName(child.name);
        child.flipType = flipType; // store for drawing logic
        const currentPath = parentPath ? `${parentPath}/${child.name}` : child.name;
        const childInForcedTree = inForcedTree || isForced;
        return {
          id: currentPath, rawName: child.name, name: displayName, fullPath: currentPath,
          isFolder: !!child.children, isForced, inForcedTree: childInForcedTree, isRadio, flipType,
          node: child, children: child.children ? buildTree(child.children, currentPath, childInForcedTree) : null
        };
      });

      const tree = psd.children ? buildTree(psd.children) : [];
      const flatMap = new Map();
      const flatList = [];
      const initRadio = {};
      const initVisibility = {};

      const traverse = (nodes, parentPath = '') => {
        const radioSiblings = nodes.filter(n => n.isRadio);
        if (radioSiblings.length > 0) {
          const defaultRadio = radioSiblings.find(n => !n.node?.hidden) || radioSiblings[0];
          if (defaultRadio && !initRadio[parentPath]) {
            initRadio[parentPath] = defaultRadio.fullPath;
          }
        }
        nodes.forEach(n => {
          flatMap.set(n.fullPath, n.node);
          flatList.push(n.fullPath);
          initVisibility[n.fullPath] = !n.node.hidden;
          if (n.children) traverse(n.children, n.fullPath);
        });
      };
      traverse(tree);
      nodeMapRef.current = flatMap;
      nodeMapRef.current.pathList = flatList;
      setTreeData(tree);
      setExpandedNodes(new Set());
      setMappingData(INITIAL_MAPPING_DATA);
      setSelections({});
      setDisabledSlots(new Set());
      setRadioSelections(initRadio);
      setTreeVisibility(initVisibility);
      setSelectedPaths(new Set());
      setPreviewComposite(null);
      setZoom(1);
      setOffset({ x: 0, y: 0 });

      // Calculate initial fit zoom
      setTimeout(() => {
        if (wrapperRef.current && psd.width && psd.height) {
          const wr = wrapperRef.current.getBoundingClientRect();
          const margin = 40;
          const availableW = wr.width - margin;
          const availableH = wr.height - margin;
          const fitZoom = Math.min(availableW / psd.width, availableH / psd.height, 1);
          setZoom(fitZoom);
          // Center it
          setOffset({
            x: (wr.width - psd.width * fitZoom) / 2,
            y: (wr.height - psd.height * fitZoom) / 2
          });
        }
      }, 100);

      const configPath = `${filePath}.config.json`;
      if (await fs.pathExists(configPath)) {
        const saved = await fs.readJson(configPath);
        if (saved) {
          if (saved.mappingData) setMappingData(saved.mappingData);
          else {
            const migrated = { ...INITIAL_MAPPING_DATA };
            if (saved.mappings) Object.entries(saved.mappings).forEach(([cat, list]) => { migrated[cat].items = list; });
            if (saved.bodyVariants) migrated['体'].composites = saved.bodyVariants;
            setMappingData(migrated);
          }
          if (saved.selections) setSelections(saved.selections);
          if (saved.disabledSlots) setDisabledSlots(new Set(saved.disabledSlots));
          if (saved.radioSelections) setRadioSelections(s => ({ ...initRadio, ...saved.radioSelections }));
          if (saved.treeVisibility) setTreeVisibility(v => ({ ...initVisibility, ...saved.treeVisibility }));
          if (saved.outputPath) setOutputPath(saved.outputPath);
          if (saved.exportFolderName) setExportFolderName(saved.exportFolderName);
        }
      }
    } catch (err) { console.error("Failed to load PSD:", err); alert("PSDファイルの読み込みに失敗しました。"); }
    finally { setIsProcessing(false); }
  };

  const checkUpdate = async () => {
    try {
      const res = await fetch('https://api.github.com/repos/bluemistel/UgokuTachieMakerKIT/releases/latest');
      const data = await res.json();
      if (data && data.tag_name) {
        setLatestVersion(data.tag_name.replace(/^v/, ''));
      }
    } catch (err) { console.error('Failed to fetch update info:', err); }
  };

  const openExternal = (url) => {
    if (window.require) {
      const { shell } = window.require('electron');
      shell.openExternal(url);
    }
  };

  const toggleExpand = (nodeId) => {
    const s = new Set(expandedNodes);
    s.has(nodeId) ? s.delete(nodeId) : s.add(nodeId);
    setExpandedNodes(s);
  };

  const handleNodeClick = (e, node) => {
    // If clicking a radio row, do not toggle the radio here unless it's handled on the icon
    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;
    if (isShift && lastSelectedPath && nodeMapRef.current.pathList) {
      const list = nodeMapRef.current.pathList;
      const [s, end] = [list.indexOf(lastSelectedPath), list.indexOf(node.fullPath)];
      const [lo, hi] = s < end ? [s, end] : [end, s];
      setSelectedPaths(new Set([...selectedPaths, ...list.slice(lo, hi + 1)]));
    } else if (isCtrl) {
      const ns = new Set(selectedPaths);
      ns.has(node.fullPath) ? ns.delete(node.fullPath) : ns.add(node.fullPath);
      setSelectedPaths(ns);
    } else {
      setSelectedPaths(new Set([node.fullPath]));
    }
    setLastSelectedPath(node.fullPath);
  };

  const handleRadioToggle = (e, node) => {
    e.stopPropagation();
    const parts = node.fullPath.split('/');
    parts.pop();
    const parentPath = parts.join('/');
    setRadioSelections(prev => ({ ...prev, [parentPath]: node.fullPath }));
  };

  const handleCategoryDrop = (e, category, compositeIdx = null) => {
    e.preventDefault();
    const dragType = e.dataTransfer.getData('dragType');
    const newData = { ...mappingData };
    const catConfig = newData[category];

    if (dragType === 'internal-reorder') {
      const srcIdx = parseInt(e.dataTransfer.getData('sourceIdx'));
      const srcCompIdx = parseInt(e.dataTransfer.getData('sourceCompIdx'));
      const srcCat = e.dataTransfer.getData('sourceCat');
      if (srcCat === category && srcCompIdx === compositeIdx) {
        const layers = [...catConfig.composites[compositeIdx].layers];
        const [moved] = layers.splice(srcIdx, 1);
        layers.push(moved);
        catConfig.composites[compositeIdx].layers = layers;
        setMappingData(newData);
      }
      return;
    }

    const nodeDataStr = e.dataTransfer.getData('nodes');
    if (!nodeDataStr) return;
    const dropNodes = JSON.parse(nodeDataStr);

    const processNode = (node, result) => {
      if (!node.isFolder) { result.push(node); return; }
      const live = nodeMapRef.current.get(node.fullPath);
      if (live?.children) {
        const hasSub = live.children.some(c => c.children?.length > 0);
        if (hasSub) { alert(`フォルダ ${node.name} は多階層のため展開できません`); return; }
        live.children.forEach(child => {
          const childPath = `${node.fullPath}/${child.name}`;
          result.push({ id: childPath, name: `${node.name}_${child.name}`, fullPath: childPath, isFolder: false });
        });
      }
    };

    const addTo = (list) => {
      const existing = new Set(list.map(i => i.fullPath));
      const processed = [];
      dropNodes.forEach(n => processNode(n, processed));
      processed.forEach(n => { if (!existing.has(n.fullPath)) list.push(n); });
    };

    if (catConfig.mode === 'composite' && compositeIdx !== null) addTo(catConfig.composites[compositeIdx].layers);
    else { addTo(catConfig.items); if (!selections[category]) setSelections(p => ({ ...p, [category]: 0 })); }
    setMappingData(newData);
  };

  const handleInternalReorder = (e, category, compositeIdx, targetIdx) => {
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer.getData('dragType') !== 'internal-reorder') return;
    const srcIdx = parseInt(e.dataTransfer.getData('sourceIdx'));
    const srcCompIdx = parseInt(e.dataTransfer.getData('sourceCompIdx'));
    const srcCat = e.dataTransfer.getData('sourceCat');
    if (srcCat === category && srcCompIdx === compositeIdx && srcIdx !== targetIdx) {
      const newData = { ...mappingData };
      const layers = [...newData[category].composites[compositeIdx].layers];
      const [moved] = layers.splice(srcIdx, 1);
      layers.splice(targetIdx, 0, moved);
      newData[category].composites[compositeIdx].layers = layers;
      setMappingData(newData);
    }
  };

  const removeFromCategory = (category, fullPath, compositeIdx = null) => {
    const newData = { ...mappingData };
    const cat = newData[category];
    if (cat.mode === 'composite' && compositeIdx !== null)
      cat.composites[compositeIdx].layers = cat.composites[compositeIdx].layers.filter(l => l.fullPath !== fullPath);
    else cat.items = cat.items.filter(n => n.fullPath !== fullPath);
    setMappingData(newData);
  };

  const clearCategory = (category) => {
    const newData = { ...mappingData };
    const cat = newData[category];
    if (cat.mode === 'composite') cat.composites = [{ name: `${category}1`, layers: [] }];
    else cat.items = [];
    setMappingData(newData);
    const newSel = { ...selections, [category]: 0 };
    if (category === '他' || category === '後') { for (let i = 1; i <= SLOT_COUNT; i++) newSel[`${category}${i}`] = 0; }
    setSelections(newSel);
  };

  const toggleCategoryMode = (category) => {
    const newData = { ...mappingData };
    const cat = newData[category];
    cat.mode = cat.mode === 'simple' ? 'composite' : 'simple';
    if (cat.mode === 'composite' && cat.composites.length === 0) cat.composites = [{ name: `${category}1`, layers: [] }];
    setMappingData(newData);
  };

  const incrementName = (name) => {
    const m = name.match(/(\d+)$/);
    return m ? name.replace(/\d+$/, parseInt(m[1]) + 1) : name + ' 2';
  };

  const addCompositeVariant = (category) => {
    const newData = { ...mappingData };
    const cat = newData[category];
    const lastName = cat.composites.length > 0 ? cat.composites[cat.composites.length - 1].name : `${category}0`;
    cat.composites.push({ name: incrementName(lastName), layers: [] });
    setMappingData(newData);
  };

  const duplicateCompositeVariant = (category, idx) => {
    const newData = { ...mappingData };
    const cat = newData[category];
    const src = cat.composites[idx];
    cat.composites.splice(idx + 1, 0, { name: incrementName(src.name), layers: [...src.layers] });
    setMappingData(newData);
  };

  const removeCompositeVariant = (category, idx) => {
    const newData = { ...mappingData };
    const cat = newData[category];
    if (cat.composites.length <= 1) return;
    cat.composites.splice(idx, 1);
    setMappingData(newData);
  };

  const toggleSlotVisibility = (slotKey) => {
    const s = new Set(disabledSlots);
    s.has(slotKey) ? s.delete(slotKey) : s.add(slotKey);
    setDisabledSlots(s);
  };

  const isValidCanvas = (c) => c && (c instanceof HTMLCanvasElement || c instanceof ImageBitmap);

  const drawNodeRecursively = (targetNode, ctx, scale = 1, globalFlipH = false, canvasWidth = 0) => {
    if (!targetNode) return;
    if (isValidCanvas(targetNode.canvas)) {
      ctx.save();
      const flipThisLayer = globalFlipH;
      if (flipThisLayer) {
        ctx.translate(canvasWidth, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(targetNode.canvas, targetNode.left * scale, targetNode.top * scale,
        targetNode.canvas.width * scale, targetNode.canvas.height * scale);
      ctx.restore();
    } else if (targetNode.children) {
      targetNode.children.forEach(c => drawNodeRecursively(c, ctx, scale, globalFlipH, canvasWidth));
    }
  };

  const collectForcedPaths = useCallback((nodes) => {
    const paths = [];
    const walk = (ns) => ns.forEach(n => {
      if (n.isForced && !n.isFolder) paths.push(n.fullPath);
      if (n.children) walk(n.children);
    });
    walk(nodes);
    return paths;
  }, []);

  const renderPreview = useCallback(() => {
    if (!psdData || !canvasRef.current || !nodeMapRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    canvas.width = psdData.width;
    canvas.height = psdData.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (viewMode === 'mapping') {
      if (previewComposite) {
        const { category, variantIdx } = previewComposite;
        const variant = mappingData[category]?.composites[variantIdx];
        if (variant) {
          const shouldFlip = showFlipLayers;
          variant.layers.forEach(l => drawNodeRecursively(nodeMapRef.current.get(l.fullPath), ctx, 1, shouldFlip, canvas.width));
        }
        return;
      }
      if (selectedPaths.size > 0) {
        selectedPaths.forEach(p => drawNodeRecursively(nodeMapRef.current.get(p), ctx, 1, showFlipLayers, canvas.width));
      }
      return;
    }

    const mappedPaths = new Set();
    Object.values(mappingData).forEach(cat => {
      cat.items.forEach(i => mappedPaths.add(i.fullPath));
      cat.composites.forEach(c => c.layers.forEach(l => mappedPaths.add(l.fullPath)));
    });

    // Draw unmapped layers (Base, Forced, Radio)
    const drawUnmappedLayers = (nodes, parentPath = '') => {
      const radioKey = parentPath;
      const selectedRadioPath = radioSelections[radioKey];

      [...nodes].reverse().forEach(child => {
        const fullPath = child.fullPath;
        if (mappedPaths.has(fullPath)) return;
        if (child.flipType && child.flipType !== 'flipx') return; // Hide standard flips if drawn here

        // Skip entire subtree if hidden via treeVisibility manually
        // EXCEPT if it's explicitly forced !Layer (following manual override logic)
        const isVisible = treeVisibility[fullPath] !== false;
        if (!isVisible && !child.isForced) return;

        if (child.isRadio) {
          if (fullPath !== selectedRadioPath) return;
        }

        if (!child.isFolder) {
          let shouldDraw = child.isForced;
          if (!shouldDraw && child.inForcedTree && isVisible) shouldDraw = true;

          if (shouldDraw) {
            const liveNode = nodeMapRef.current.get(fullPath);
            drawNodeRecursively(liveNode, ctx, 1, showFlipLayers, canvas.width);
          }
        } else if (child.children) {
          drawUnmappedLayers(child.children, fullPath);
        }
      });
    };
    drawUnmappedLayers(treeData);

    RENDER_ORDER.forEach(category => {
      const cat = mappingData[category];

      if (category === '他' || category === '後') {
        for (let i = 1; i <= SLOT_COUNT; i++) {
          const slotKey = `${category}${i}`;
          if (disabledSlots.has(slotKey)) continue;
          if (cat.mode === 'composite') {
            const vi = selections[slotKey] || 0;
            const variant = cat.composites[vi];
            if (variant) {
              const shouldFlip = showFlipLayers;
              variant.layers.forEach(l => drawNodeRecursively(nodeMapRef.current.get(l.fullPath), ctx, 1, shouldFlip, canvas.width));
            }
          } else {
            const item = cat.items[selections[slotKey] || 0];
            if (item) {
              const shouldFlip = showFlipLayers;
              drawNodeRecursively(nodeMapRef.current.get(item.fullPath), ctx, 1, shouldFlip, canvas.width);
            }
          }
        }
        return; // Slot logic handled separately
      }

      // Universal check for all other categories
      if (disabledSlots.has(category)) return;

      if (cat.mode === 'composite') {
        const vi = selections[category] || 0;
        const variant = cat.composites[vi];
        if (variant) {
          const shouldFlip = showFlipLayers;
          variant.layers.forEach(l => drawNodeRecursively(nodeMapRef.current.get(l.fullPath), ctx, 1, shouldFlip, canvas.width));
        }
      } else {
        const item = cat.items[selections[category] || 0];
        if (item) {
          const shouldFlip = showFlipLayers;
          drawNodeRecursively(nodeMapRef.current.get(item.fullPath), ctx, 1, shouldFlip, canvas.width);
        }
      }
    });
  }, [psdData, viewMode, selectedPaths, previewComposite, mappingData, selections, disabledSlots, radioSelections, treeData, collectForcedPaths, showFlipLayers]);

  useEffect(() => { renderPreview(); }, [renderPreview]);

  const handleWidthChange = (val) => {
    const w = parseInt(val) || 0; setExportWidth(w);
    if (maintainAspect && psdData) setExportHeight(Math.round(w / (psdData.width / psdData.height)));
  };
  const handleHeightChange = (val) => {
    const h = parseInt(val) || 0; setExportHeight(h);
    if (maintainAspect && psdData) setExportWidth(Math.round(h * (psdData.width / psdData.height)));
  };

  const handleExport = async () => {
    if (!psdData || !outputPath || !exportFolderName) { alert("書き出し設定が正しくありません。"); return; }
    setIsProcessing(true); setShowExportModal(false);
    try {
      const scale = exportWidth / psdData.width;
      const finalPath = path.join(outputPath, exportFolderName);
      await fs.ensureDir(finalPath);
      const ec = document.createElement('canvas');
      ec.width = exportWidth; ec.height = exportHeight;
      const exCtx = ec.getContext('2d');
      const saveImg = async (drawFn, dir, name) => {
        await fs.ensureDir(dir);
        exCtx.clearRect(0, 0, ec.width, ec.height); drawFn(exCtx);
        const buf = await new Promise(res => ec.toBlob(b => { const r = new FileReader(); r.onloadend = () => res(Buffer.from(r.result)); r.readAsArrayBuffer(b); }, 'image/png'));
        await fs.writeFile(path.join(dir, `${sanitizeFilename(name)}.png`), buf);
      };
      const getUniqueName = (baseName, usedSet) => {
        let name = baseName;
        let count = 1;
        while (usedSet.has(name.toLowerCase())) {
          name = `${baseName} (${count})`;
          count++;
        }
        usedSet.add(name.toLowerCase());
        return name;
      };

      for (const cat of RENDER_ORDER) {
        const cc = mappingData[cat];
        const dir = path.join(finalPath, cat);
        const usedNames = new Set();
        if (cc.mode === 'composite') {
          for (const v of cc.composites) {
            if (!v.layers.length) continue;
            const isFlip = v.layers.some(l => nodeMapRef.current.get(l.fullPath)?.flipType === 'flipx');
            let exportName = v.name;
            if (isFlip && !exportName.includes(':flipx')) exportName += ':flipx';
            
            exportName = getUniqueName(exportName, usedNames);
            const safeName = sanitizeFilename(exportName);
            await saveImg(ctx => {
              // Always export as normal (non-flipped) regardless of UI toggle
              v.layers.forEach(l => drawNodeRecursively(nodeMapRef.current.get(l.fullPath), ctx, scale, false, ec.width));
            }, dir, safeName);
          }
        } else {
          for (const item of cc.items) {
            const node = nodeMapRef.current.get(item.fullPath);
            let exportName = item.name;
            if (node?.flipType) {
              exportName += `:${node.flipType}`;
            }

            exportName = getUniqueName(exportName, usedNames);
            const safeName = sanitizeFilename(exportName);
            await saveImg(ctx => {
              // Always export as normal (non-flipped) regardless of UI toggle
              drawNodeRecursively(node, ctx, scale, false, ec.width);
            }, dir, safeName);
          }
        }
      }
      alert("書き出しが完了しました！");
    } catch (err) { console.error(err); alert("書き出しに失敗しました: " + err.message); }
    finally { setIsProcessing(false); }
  };

  const renderTreeNode = (node, depth = 0, parentPath = '') => {
    const isExpanded = expandedNodes.has(node.id);
    const isSelected = selectedPaths.has(node.fullPath);
    if (node.flipType && !showFlipLayers) return null;

    const radioKey = parentPath;
    const selectedRadioPath = radioSelections[radioKey];
    const isRadioSelected = node.isRadio && node.fullPath === selectedRadioPath;
    const isVisible = treeVisibility[node.fullPath] !== false;

    let icon = node.isFolder ? '📁' : '🖼️';
    if (node.isForced) icon = '📌';
    else if (node.isRadio) icon = isRadioSelected ? '🔘' : '⚪';
    else if (node.flipType) icon = '🔄';

    const itemClass = ['node-item', node.isFolder ? 'folder' : 'layer', isSelected ? 'selected' : '', node.isForced ? 'forced' : '', node.isRadio ? (isRadioSelected ? 'radio-selected' : 'radio') : '', node.flipType ? 'flip-layer' : ''].filter(Boolean).join(' ');

    return (
      <div key={node.id} className="tree-node-container" style={{ marginLeft: `${depth * 12}px` }}>
        <div className={itemClass} draggable onDragStart={(e) => {
          const toDrag = selectedPaths.has(node.fullPath) && selectedPaths.size > 1 ? [...selectedPaths].map(p => { const n = nodeMapRef.current.get(p); return n ? { id: p, name: n.name, fullPath: p, isFolder: !!n.children } : null; }).filter(Boolean) : [{ id: node.id, name: node.name, fullPath: node.fullPath, isFolder: node.isFolder }];
          e.dataTransfer.setData('nodes', JSON.stringify(toDrag));
          e.dataTransfer.setData('dragType', 'external-layer');
        }} onClick={(e) => handleNodeClick(e, node)}>
          {node.isFolder && <span className="expand-icon" onClick={e => { e.stopPropagation(); toggleExpand(node.id); }}>{isExpanded ? '▼' : '▶'}</span>}

          {!node.isForced && !node.isRadio && (
            <input
              type="checkbox"
              checked={isVisible}
              className="node-visibility-checkbox"
              onChange={(e) => {
                e.stopPropagation();
                setTreeVisibility(prev => ({ ...prev, [node.fullPath]: e.target.checked }));
              }}
              onClick={(e) => e.stopPropagation()}
            />
          )}

          <span className="icon" onClick={node.isRadio ? (e) => handleRadioToggle(e, node) : undefined}>{icon}</span>
          <span className="name">{node.name}</span>
          {node.isForced && <span className="tag forced-tag">必須</span>}
          {node.flipType && <span className="tag flip-tag">{node.flipType}</span>}
        </div>
        {node.isFolder && isExpanded && node.children && <div className="tree-children">{node.children.map(c => renderTreeNode(c, depth + 1, node.fullPath))}</div>}
      </div>
    );
  };

  const handleWheel = (e) => {
    if (!psdData) return;
    // We'll use a native listener to prevent default if possible, 
    // but for now let's just make sure we use the right logic.
    const delta = -e.deltaY;
    const zoomSpeed = 0.001;
    const factor = Math.pow(1.1, delta / 100);
    const newZoom = Math.min(Math.max(zoom * factor, 0.1), 20);

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const zoomRatio = newZoom / zoom;
    setOffset({
      x: x - (x - offset.x) * zoomRatio,
      y: y - (y - offset.y) * zoomRatio
    });
    setZoom(newZoom);
  };

  const handleZoomBtn = (direction) => {
    if (!psdData || !wrapperRef.current) return;
    const factor = direction === 'in' ? 1.2 : 1 / 1.2;
    const newZoom = Math.min(Math.max(zoom * factor, 0.1), 20);
    const wr = wrapperRef.current.getBoundingClientRect();
    
    // Zoom from center of the wrapper
    const centerX = wr.width / 2;
    const centerY = wr.height / 2;

    const zoomRatio = newZoom / zoom;
    setOffset({
      x: centerX - (centerX - offset.x) * zoomRatio,
      y: centerY - (centerY - offset.y) * zoomRatio
    });
    setZoom(newZoom);
  };

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const preventDefault = (e) => { if (psdData) e.preventDefault(); };
    wrapper.addEventListener('wheel', preventDefault, { passive: false });
    return () => wrapper.removeEventListener('wheel', preventDefault);
  }, [psdData]);

  const handleResetZoom = () => {
    if (!psdData || !wrapperRef.current) return;
    const wr = wrapperRef.current.getBoundingClientRect();
    const margin = 40;
    const availableW = wr.width - margin;
    const availableH = wr.height - margin;
    const fitZoom = Math.min(availableW / psdData.width, availableH / psdData.height, 1);
    setZoom(fitZoom);
    setOffset({
      x: (wr.width - psdData.width * fitZoom) / 2,
      y: (wr.height - psdData.height * fitZoom) / 2
    });
  };

  const handleMouseDown = (e) => {
    if (!psdData) return;
    // Panning with middle click or left click + Space (simulated by just left click for now as it's simpler)
    // Actually, let's use middle click or right click for panning to avoid conflict with selection
    // Or just left click if we don't have other interactions on the canvas.
    // The user wants click to exit combination mode, so let's use left click drag for pan but track movement.
    setIsPanning(true);
    setLastMousePos({ x: e.clientX, y: e.clientY });
    setHasMovedDuringClick(false);
  };

  const handleMouseMove = (e) => {
    if (!isPanning) return;
    const dx = e.clientX - lastMousePos.x;
    const dy = e.clientY - lastMousePos.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      setHasMovedDuringClick(true);
    }
    setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
    setLastMousePos({ x: e.clientX, y: e.clientY });
  };

  const handleMouseUp = () => {
    setIsPanning(false);
  };

  const handleCanvasClick = (e) => {
    if (hasMovedDuringClick) return; // Ignore if it was a drag
    if (previewComposite) {
      setPreviewComposite(null);
    }
  };

  return (
    <div className="app-container main-layout">
      <header className="header glass">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <img src="icon.png" alt="logo" className="header-logo" />
          <h1>動く立ち絵MakerKIT</h1>
          <div className="mode-switcher glass">
            <button className={mainTab === 'mapping' ? 'active' : ''} onClick={() => setMainTab('mapping')}>仕分け</button>
            <button className={mainTab === 'animation' ? 'active' : ''} onClick={() => setMainTab('animation')}>目パチ・口パク</button>
          </div>
          {mainTab === 'mapping' && psdData && (
            <div className="mode-switcher glass sub-switcher" style={{ marginLeft: '10px', fontSize: '0.8rem' }}>
              <button className={viewMode === 'mapping' ? 'active' : ''} onClick={() => { setViewMode('mapping'); setPreviewComposite(null); }}>レイヤー設定</button>
              <button className={viewMode === 'preview' ? 'active' : ''} onClick={() => { setViewMode('preview'); setPreviewComposite(null); }}>プレビュー</button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
          {psdData && (
            <>
              <button className="btn-secondary" onClick={() => window.location.reload()} title="初期状態に戻して別のPSDファイルを読み込みます" disabled={isProcessing}>
                リロード
              </button>
              <label className="toggle-label flip-toggle">
                <input type="checkbox" checked={showFlipLayers} onChange={e => setShowFlipLayers(e.target.checked)} />
                <span>左右反転表示</span>
              </label>
            </>
          )}
          <button className="btn-primary" onClick={() => setShowExportModal(true)} disabled={!psdData || isProcessing}>
            {isProcessing ? '書き出し中...' : 'YMM4形式で書き出し'}
          </button>

          <div className="menu-container">
            <button className="btn-menu" onClick={() => setDropdownOpen(!dropdownOpen)}>☰</button>
            {dropdownOpen && (
              <div className="dropdown-menu">
                <button className="dropdown-item" onClick={() => { setDropdownOpen(false); checkUpdate(); setShowAppInfoModal(true); }}>アプリ情報</button>
                <button className="dropdown-item" onClick={() => { setDropdownOpen(false); openExternal(NOTION_FORM_URL); }}>不具合報告・要望</button>
              </div>
            )}
          </div>
        </div>
      </header>

      {mainTab === 'mapping' ? (
        <div className="workspace">
          <aside className="tree-sidebar glass" style={{ width: `${sidebarWidth}px`, flex: 'none' }}>
          <div className="sidebar-header">
            <h3>レイヤー</h3>
            {!psdData && <span style={{ fontSize: '0.8rem', opacity: 0.5 }}>ファイル未選択</span>}
          </div>
          <div className="scroll-area">
            {treeData.map(n => renderTreeNode(n))}
          </div>
        </aside>

        <div className="resizer-h" onMouseDown={() => { isResizingSidebar.current = true; document.body.style.cursor = 'col-resize'; }} />

        <main className="preview-center" style={{ flex: 1 }}>
          <div 
            className="canvas-wrapper glass" 
            ref={wrapperRef}
            onDragOver={e => e.preventDefault()} 
            onDrop={handleDrop}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onClick={handleCanvasClick}
            onDoubleClick={handleResetZoom}
            style={{ cursor: isPanning ? 'grabbing' : (psdData ? 'crosshair' : 'default') }}
          >
            {!psdData ? (
              <div className="drop-zone"><p>ここにPSDファイルをドラッグ＆ドロップ</p></div>
            ) : (
              <div className="zoom-container" style={{ 
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
                transformOrigin: '0 0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <canvas ref={canvasRef} />
              </div>
            )}
            {psdData && (
              <div className="zoom-controls glass" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => handleZoomBtn('out')} title="縮小">-</button>
                <span className="zoom-percentage" onClick={handleResetZoom} title="全体表示リセット">{Math.round(zoom * 100)}%</span>
                <button onClick={() => handleZoomBtn('in')} title="拡大">+</button>
              </div>
            )}
            {viewMode === 'mapping' && previewComposite && (
              <div className="selection-label composite-preview-badge">
                📦 結合プレビュー: {mappingData[previewComposite.category]?.composites[previewComposite.variantIdx]?.name}
                <button onClick={(e) => { e.stopPropagation(); setPreviewComposite(null); }} style={{ marginLeft: 8, background: 'none', border: 'none', color: '#fff', cursor: 'pointer' }}>✕</button>
              </div>
            )}
            {viewMode === 'mapping' && !previewComposite && selectedPaths.size > 0 && <div className="selection-label">選択中: {selectedPaths.size} アイテム</div>}
          </div>
          {viewMode === 'preview' && (
            <div className="viewer-controls glass">
              <h4>プレビューコントロール</h4>
              <div className="category-sliders">
                {RENDER_ORDER.slice().reverse().map(category => {
                  const cat = mappingData[category];

                  if (category === '他' || category === '後') {
                    return [1, 2, 3].map(i => {
                      const slotKey = `${category}${i}`;
                      const items = cat.mode === 'composite' ? cat.composites : cat.items;
                      const hidden = disabledSlots.has(slotKey);
                      return items.length > 0 && (
                        <div key={`sl-${slotKey}`} className={`mini-slider slot ${hidden ? 'hidden' : ''}`}>
                          <div className="label">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <button className={`visibility-toggle ${hidden ? 'off' : 'on'}`} onClick={() => toggleSlotVisibility(slotKey)}>{hidden ? '👁️‍🗨️' : '👁️'}</button>
                              <span className="slot-badge">{slotKey}</span>
                            </div>
                            <span className="val">{items[selections[slotKey] || 0]?.name}</span>
                          </div>
                          <input type="range" min="0" max={items.length - 1} value={selections[slotKey] || 0} disabled={hidden} onChange={e => setSelections({ ...selections, [slotKey]: parseInt(e.target.value) })} />
                        </div>
                      );
                    });
                  }

                  const items = cat.mode === 'composite' ? cat.composites : cat.items;
                  const hidden = disabledSlots.has(category);
                  return items.length > 0 && (
                    <div key={`sl-${category}`} className={`mini-slider ${cat.mode} ${hidden ? 'hidden' : ''}`}>
                      <div className="label">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <button className={`visibility-toggle ${hidden ? 'off' : 'on'}`} onClick={() => toggleSlotVisibility(category)}>{hidden ? '👁️‍🗨️' : '👁️'}</button>
                          <span>{category}{cat.mode === 'composite' ? ' (結合)' : ''}</span>
                        </div>
                        <span className="val">{items[selections[category] || 0]?.name}</span>
                      </div>
                      <input type="range" min="0" max={items.length - 1} value={selections[category] || 0} disabled={hidden} onChange={e => setSelections({ ...selections, [category]: parseInt(e.target.value) })} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </main>

        <div className="resizer-h" onMouseDown={() => { isResizingMapping.current = true; document.body.style.cursor = 'col-resize'; }} />

        <div className="mapping-grid glass" style={{ width: `${mappingWidth}px`, flex: 'none' }}>
          <div className="mapping-header"><h3>カテゴリ仕分け</h3></div>
          <div className="grid">
            {RENDER_ORDER.slice().reverse().map(category => {
              const cat = mappingData[category];
              return (
                <div key={`zone-${category}`} className={`category-zone glass ${cat.mode} ${viewMode === 'preview' ? 'dimmed' : ''}`}>
                  <div className="zone-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <h4 title="ドラッグ&ドロップの後に名前をクリックして選択">{category}</h4>
                      <div className="mode-toggle" onClick={() => toggleCategoryMode(category)} title="結合グループを作成します。グループ内は1枚に結合された見た目になります">
                        <div className={`track ${cat.mode}`}><div className="thumb" /></div>
                        <span className="label">結合モード</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <button className="btn-clear" onClick={() => clearCategory(category)}>全削除</button>
                      {cat.mode === 'composite' && <button className="btn-icon add" onClick={() => addCompositeVariant(category)}>+</button>}
                    </div>
                  </div>

                  {cat.mode === 'composite' && <p className="order-hint">左側が奥、右側が手前に描画されます</p>}

                  {cat.mode === 'composite' ? (
                    <div className="composites-list">
                      {cat.composites.map((variant, cIdx) => (
                        <div key={`comp-${category}-${cIdx}`} className={`composite-item ${previewComposite?.category === category && previewComposite?.variantIdx === cIdx ? 'previewing' : ''}`} onDragOver={e => e.preventDefault()} onDrop={e => handleCategoryDrop(e, category, cIdx)} onClick={() => setPreviewComposite(prev => prev?.category === category && prev?.variantIdx === cIdx ? null : { category, variantIdx: cIdx })}>
                          <div className="item-header" onClick={e => e.stopPropagation()}>
                            <input type="text" value={variant.name} onChange={e => { const nd = { ...mappingData }; nd[category].composites[cIdx].name = e.target.value; setMappingData(nd); }} />
                            <div className="actions">
                              <button className="btn-icon" onClick={() => duplicateCompositeVariant(category, cIdx)} title="複製">📑</button>
                              <button className="btn-icon delete" onClick={() => removeCompositeVariant(category, cIdx)}>×</button>
                            </div>
                          </div>
                          <div className="assigned-nodes">
                            {variant.layers.map((l, lIdx) => (
                              <div key={`layer-${category}-${cIdx}-${lIdx}-${l.fullPath}`} className="assigned-node mini draggable" draggable onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData('sourceIdx', lIdx); e.dataTransfer.setData('sourceCompIdx', cIdx); e.dataTransfer.setData('sourceCat', category); e.dataTransfer.setData('dragType', 'internal-reorder'); }} onDragOver={e => e.preventDefault()} onDrop={e => handleInternalReorder(e, category, cIdx, lIdx)} onClick={e => e.stopPropagation()}>
                                <span>{l.name}</span>
                                <button onClick={() => removeFromCategory(category, l.fullPath, cIdx)}>×</button>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="assigned-nodes list-mode" onDragOver={e => e.preventDefault()} onDrop={e => handleCategoryDrop(e, category)}>
                      {cat.items.map((n, nIdx) => (
                        <div key={`item-${category}-${nIdx}-${n.fullPath}`} className="assigned-node mini">
                          <span title={n.name}>{n.name}</span>
                          <button onClick={() => removeFromCategory(category, n.fullPath)}>×</button>
                        </div>
                      ))}
                      {!cat.items.length && <span className="placeholder">素材をドロップ</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    ) : (
      <div className="workspace" style={{ padding: '0' }}>
        <EyeblinkLipSyncPopup />
      </div>
    )}

      {showExportModal && (
        <div className="modal-overlay">
          <div className="modal-content glass">
            <h2>書き出し設定</h2>
            <div className="form-group">
              <label>出力先フォルダ:</label>
              <input type="text" value={outputPath} onChange={e => setOutputPath(e.target.value)} className="glass" />
            </div>
            <div className="form-group">
              <label>フォルダ名:</label>
              <input type="text" value={exportFolderName} onChange={e => setExportFolderName(e.target.value)} className="glass" />
            </div>
            <div className="form-row">
              <div className="form-group"><label>幅:</label><input type="number" value={exportWidth} onChange={e => handleWidthChange(e.target.value)} className="glass" /></div>
              <div className="form-group"><label>高さ:</label><input type="number" value={exportHeight} onChange={e => handleHeightChange(e.target.value)} className="glass" /></div>
            </div>
            <div className="form-group checkbox">
              <label><input type="checkbox" checked={maintainAspect} onChange={e => setMaintainAspect(e.target.checked)} /> アスペクト比を維持</label>
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowExportModal(false)}>キャンセル</button>
              <button className="btn-primary" onClick={handleExport}>書き出し</button>
            </div>
          </div>
        </div>
      )}

      {showAppInfoModal && (
        <div className="modal-overlay" onClick={() => setShowAppInfoModal(false)}>
          <div className="modal-content glass" onClick={e => e.stopPropagation()}>
            <h2>アプリ情報</h2>
            <div className="version-info-box">
              <div className="version-row">
                <span>現在のバージョン:</span>
                <span className="version-badge">{CURRENT_VERSION}</span>
              </div>
              {latestVersion && (
                <div className="version-row">
                  <span>最新のバージョン:</span>
                  <span className="version-badge" style={{ background: latestVersion === CURRENT_VERSION ? '#10b981' : '#f59e0b' }}>
                    {latestVersion}
                  </span>
                </div>
              )}
              {latestVersion && latestVersion !== CURRENT_VERSION && (
                <div className="update-available">
                  <p>最新バージョンが利用可能です！</p>
                  <button className="btn-primary" onClick={() => openExternal(BOOTH_URL)}>Boothでダウンロード</button>
                </div>
              )}
              {!latestVersion && <p style={{ fontSize: '0.8rem', opacity: 0.5 }}>アップデート情報を確認中...</p>}
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowAppInfoModal(false)}>閉じる</button>
            </div>
          </div>
        </div>
      )}


    </div>
  );
}

export default App;
