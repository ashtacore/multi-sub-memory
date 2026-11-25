import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let startup;
let stopping = false;
let stopped = false;

app.on('before-quit', (event) => {
  if (!startup || stopped) return;
  event.preventDefault();
  if (stopping) return;
  stopping = true;
  void startup.then((dashboard) => dashboard.close()).finally(() => {
    stopped = true;
    app.quit();
  }).catch((error) => console.error(error));
});

app.on('window-all-closed', () => app.quit());

async function startDashboard() {
  const source = app.isPackaged
    ? pathToFileURL(path.join(process.resourcesPath, 'dashboard', 'src', 'ui', 'server.mjs'))
    : new URL('../src/ui/server.mjs', import.meta.url);
  const { startDashboardServer } = await import(source.href);
  return startDashboardServer({ cwd: null, globalMode: true, port: 0 });
}

app.whenReady().then(async () => {
  startup = startDashboard();
  const dashboard = await startup;
  if (stopping) return;

  const window = new BrowserWindow({
    title: 'Multi-Sub Memory',
    width: 1200,
    height: 820,
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.mjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  function restrictNavigation(event) {
    const target = URL.parse(event.url);
    if (target?.protocol !== 'http:' || target.origin !== dashboard.url) event.preventDefault();
  }
  window.webContents.on('will-frame-navigate', restrictNavigation);
  window.webContents.on('will-redirect', restrictNavigation);
  await window.loadURL(dashboard.url + '/');
}).catch((error) => {
  if (!stopping) dialog.showErrorBox('Could not open Multi-Sub Memory', error.message);
  app.quit();
});
