"use strict";
const { app, BrowserWindow, Menu } = require("electron");
const path = require("path");
function createWindow() {
  const isDev = !app.isPackaged;
  if (!isDev) {
    Menu.setApplicationMenu(null);
  }
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "ウゴメキ",
    icon: path.join(__dirname, "../public/icon.png"),
    // Altキーでも出ない
    autoHideMenuBar: !isDev,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  if (!isDev) {
    win.setMenuBarVisibility(false);
    win.removeMenu();
  }
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}
app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
