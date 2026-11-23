const { app, BrowserWindow, Menu, Tray, Notification, nativeImage, globalShortcut, clipboard,
  dialog, ipcMain, protocol, net, shell, nativeTheme } = require('electron');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const storage = require('./store.cjs');
const { createRecognizer } = require('./ocr.cjs');

const demo = !app.isPackaged && process.argv.includes('--demo');
app.setName(demo ? 'Memory Demo' : 'Memory');
app.setAppUserModelId('app.memory.desktop');
const dataPath = process.env.MEMORY_DEV_DATA && !app.isPackaged
  ? path.resolve(process.env.MEMORY_DEV_DATA) : app.getPath('userData');
if (process.env.MEMORY_DEV_DATA && !app.isPackaged) {
  fs.mkdirSync(dataPath, { recursive: true });
  app.setPath("userData", dataPath);
}
const configFile = path.join(dataPath, 'settings.json');
const recognize = createRecognizer(path.join(dataPath, 'ocr-v1'));
const icon = path.join(__dirname, 'ui', 'app.png');
const pages = new Set(['index.html', 'app.js', 'icons.js', 'styles.css', 'app.png']);
const storeOperations = new Set(['list', 'get', 'create', 'edit', 'delete', 'restore', 'detach', 'purge',
  'restoreRevision', 'revisions', 'tags', 'image', 'retryOcr']);
const writes = new Set(['create', 'edit', 'delete', 'restore', 'detach', 'purge', 'restoreRevision', 'retryOcr']);
const themes = new Set(['light', 'dark', 'system']);
let window;
let tray;
let quitting = false;
let saving = false;
let runningOcr = false;
let shortcutError = '';
let activeShortcut = '';
let notification;

protocol.registerSchemesAsPrivileged([{ scheme: 'memory', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function send(event) {
  if (window && !window.isDestroyed()) window.webContents.send('memory:update', event);
}

function notify(title, body, silent = true) {
  if (Notification.isSupported()) {
    notification?.close();
    notification = new Notification({ title, body, silent, icon });
    notification.show();
  }
}

async function clipboardContent() {
  const items = await clipboard.read();
  const text = items.find((item) => item.types.includes('text/plain'));
  const picture = items.find((item) => item.types.includes('image/png') || item.types.includes('image/jpeg'));
  const body = text ? await (await text.getType('text/plain')).text() : '';
  const images = [];
  if (picture) {
    const type = picture.types.includes('image/png') ? 'image/png' : 'image/jpeg';
    const blob = await picture.getType(type);
    if (blob.size > storage.maxImage) throw new Error('每张图片最多 25 MB。');
    images.push(Buffer.from(await blob.arrayBuffer()));
  }
  return { body, images };
}

async function capture() {
  const input = await clipboardContent();
  if (!input.body.trim() && !input.images.length) throw new Error('剪贴板没有可保存的文本或图片。');
  return storage.run(configFile, 'create', { ...input, kind: 'capture', quick: true });
}

async function quickCapture() {
  if (saving) return;
  saving = true;
  try {
    const { value } = await capture();
    const message = value.duplicate ? '刚刚已保存' : '已保存到收件箱';
    send({ type: 'capture', message });
    notify('Memory', message);
  } catch (error) {
    send({ type: 'error', message: error.message });
    notify('Memory · 保存失败', error.message, false);
  } finally {
    saving = false;
  }
}

async function processOcr() {
  if (runningOcr || quitting) return;
  runningOcr = true;
  try {
    for (;;) {
      const config = storage.readConfig(configFile);
      const pending = storage.run(configFile, 'pendingOcr', { scope: config.scope }).value;
      if (!pending || quitting) break;
      let text = '';
      let ok = false;
      try {
        text = await recognize(storage.imagePath(config.directory, pending.hash));
        ok = true;
      } catch (error) {
        console.error('OCR:', error.message);
      }
      if (storage.readConfig(configFile).scope !== config.scope) continue;
      const result = storage.run(configFile, 'completeOcr', { id: pending.id, ok, text, scope: config.scope });
      send({ type: 'ocr', id: result.value?.id });
    }
  } catch (error) {
    console.error('OCR queue:', error.message);
  } finally {
    runningOcr = false;
  }
}

function windowColors() {
  return nativeTheme.shouldUseDarkColors
    ? { backgroundColor: '#191a1f', titleBarOverlay: { color: '#141519', symbolColor: '#a5a8b3', height: 34 } }
    : { backgroundColor: '#f6f7fa', titleBarOverlay: { color: '#f2f3f7', symbolColor: '#50566a', height: 34 } };
}

function updateWindowColors() {
  if (!window || window.isDestroyed()) return;
  const { backgroundColor, titleBarOverlay } = windowColors();
  window.setBackgroundColor(backgroundColor);
  if (process.platform === 'win32') window.setTitleBarOverlay(titleBarOverlay);
  send({ type: 'appearance', colorScheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light' });
}

function openWindow() {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  const { backgroundColor, titleBarOverlay } = windowColors();
  window = new BrowserWindow({
    width: 1300, height: 830, minWidth: 660, minHeight: 540, show: false, icon,
    backgroundColor, title: 'Memory',
    autoHideMenuBar: true,
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay
    } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (tray) window.hide();
    else app.quit();
  });
  window.loadURL('memory://app/index.html');
}

function settingsResult() {
  const config = storage.readConfig(configFile);
  const command = process.execPath;
  const script = path.join(__dirname, 'mcp.cjs');
  const env = { ELECTRON_RUN_AS_NODE: '1', MEMORY_CONFIG: configFile };
  const mcp = { command, args: [script], env };
  const opencode = { mcp: { memory: { type: 'local', command: [command, script], environment: env, enabled: true } } };
  const toml = (value) => JSON.stringify(value);
  const codex = [
    '[mcp_servers.memory]', 'command = ' + toml(command), 'args = [' + toml(script) + ']', '',
    '[mcp_servers.memory.env]', ...Object.entries(env).map(([key, value]) => key + ' = ' + toml(value))
  ].join('\n');
  const powershell = (value) => "'" + value.replaceAll("'", "''") + "'";
  const claudeCommand = ['claude mcp add memory --transport stdio --scope user',
    ...Object.entries(env).map(([key, value]) => '--env ' + powershell(key + '=' + value)),
    '--', powershell(command), powershell(script)
  ].join(' ');
  return { ...config, theme: nativeTheme.themeSource, colorScheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    shortcutError, autoStartSupported: process.platform === 'win32',
    snippets: { codex, claude: claudeCommand, opencode: JSON.stringify(opencode, null, 2) } };
}

function registerShortcut(shortcut) {
  if (shortcut === activeShortcut) return;
  if (!globalShortcut.register(shortcut, quickCapture)) throw new Error('此快捷键已被占用，请使用其他组合。');
  if (activeShortcut) globalShortcut.unregister(activeShortcut);
  activeShortcut = shortcut;
}

function validateShortcut(value) {
  if (!/^(?:(?:Control|Alt|Shift|Super)\+){2,4}(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(value) ||
      new Set(value.split('+')).size !== value.split('+').length) {
    throw new Error('请输入至少两个修饰键和一个字母、数字或功能键。');
  }
}

function libraryWork(operation, source, target) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'library-worker.cjs'), { workerData: { operation, source, target } });
    worker.once('message', (result) => result.ok ? resolve() : reject(new Error(result.error)));
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code) reject(new Error('备份操作未完成。')); });
  });
}

let libraryBusy = false;
async function libraryAction(operation) {
  if (libraryBusy) throw new Error('已有知识库操作正在执行。');
  libraryBusy = true;
  try {
    const config = storage.readConfig(configFile);
    if (operation === 'backup') {
      const result = await dialog.showOpenDialog(window, { title: '选择存放备份的目录', properties: ['openDirectory'] });
      if (result.canceled) return null;
      const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
      const backup = path.join(result.filePaths[0], 'Memory-' + stamp);
      await libraryWork('copy', config.directory, backup);
      return { directory: backup };
    }
    const result = await dialog.showOpenDialog(window, {
      title: operation === 'restoreLibrary' ? '选择 Memory 备份目录' : '选择已有知识库目录',
      properties: ['openDirectory']
    });
    if (result.canceled) return null;
    let [directory] = result.filePaths;
    if (operation === 'restoreLibrary') {
      await libraryWork('validate', directory);
      const location = await dialog.showOpenDialog(window, { title: '选择恢复副本的存放目录', properties: ['openDirectory'] });
      if (location.canceled) return null;
      const target = path.join(location.filePaths[0], 'Memory-恢复-' + crypto.randomUUID().slice(0, 8));
      await libraryWork('copy', directory, target);
      directory = target;
    }
    await libraryWork('validate', directory);
    const current = storage.readConfig(configFile);
    storage.writeConfig(configFile, { ...current, directory, scope: crypto.randomUUID() });
    send({ type: 'switch' });
    void processOcr();
    return { directory };
  } finally {
    libraryBusy = false;
  }
}

ipcMain.handle('memory:request', async (event, operation, input = {}) => {
  if (event.sender !== window?.webContents || event.senderFrame?.url !== 'memory://app/index.html') {
    return { error: '请求来源无效。' };
  }
  try {
    let result;
    if (storeOperations.has(operation)) {
      if (input.images) input.images = input.images.map((image) => Buffer.from(image, 'base64'));
      result = storage.run(configFile, operation, input);
      if (writes.has(operation)) void processOcr();
      return result;
    }
    if (operation === 'captureClipboard') {
      result = await capture();
      void processOcr();
      return result;
    }
    if (operation === 'settings') return { value: settingsResult() };
    if (operation === 'setTheme') {
      if (!themes.has(input.theme)) throw new Error('请选择有效的外观主题。');
      const config = storage.readConfig(configFile);
      storage.writeConfig(configFile, { ...config, theme: input.theme });
      nativeTheme.themeSource = input.theme;
      return { value: input.theme };
    }
    if (operation === 'saveSettings') {
      validateShortcut(input.shortcut);
      const previous = storage.readConfig(configFile);
      registerShortcut(input.shortcut);
      try {
        const autoStart = Boolean(input.autoStart && process.platform === 'win32' && !demo);
        if (process.platform === 'win32' && !demo) {
          app.setLoginItemSettings({ openAtLogin: autoStart, args: ['--background'] });
        }
        storage.writeConfig(configFile, { ...previous, shortcut: input.shortcut, autoStart });
      } catch (error) {
        if (activeShortcut !== previous.shortcut) registerShortcut(previous.shortcut);
        throw error;
      }
      shortcutError = '';
      return { value: settingsResult() };
    }
    if (operation === 'copy') {
      await clipboard.writeText(input.text);
      return { value: true };
    }
    if (operation === 'openDirectory') {
      const error = await shell.openPath(storage.readConfig(configFile).directory);
      if (error) throw new Error(error);
      return { value: true };
    }
    if (['backup', 'switchLibrary', 'restoreLibrary'].includes(operation)) return { value: await libraryAction(operation) };
    throw new Error('不支持的操作。');
  } catch (error) {
    return { error: error.message };
  }
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { if (app.isReady()) globalShortcut.unregisterAll(); });

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', openWindow);
  app.whenReady().then(async () => {
    const config = storage.initialize(configFile, path.join(dataPath, 'Library'));
    nativeTheme.themeSource = themes.has(config.theme) ? config.theme : 'dark';
    nativeTheme.on('updated', updateWindowColors);
    protocol.handle('memory', (request) => {
      const url = new URL(request.url);
      const filename = url.pathname.slice(1);
      if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
      if (filename === 'lucide.woff2') {
        const root = path.dirname(require.resolve('lucide/package.json'));
        return net.fetch(pathToFileURL(path.join(root, 'font', filename)).href);
      }
      if (!pages.has(filename)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(path.join(__dirname, 'ui', filename)).href);
    });
    Menu.setApplicationMenu(null);
    try {
      tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 20, height: 20 }));
      tray.setToolTip('Memory');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开 Memory', click: openWindow },
        { label: '保存剪贴板', click: quickCapture },
        { type: 'separator' },
        { label: '退出 Memory', click: () => app.quit() }
      ]));
      tray.on('double-click', openWindow);
    } catch (error) {
      console.error('Tray:', error.message);
    }
    try {
      registerShortcut(config.shortcut);
    } catch (error) {
      shortcutError = error.message;
    }
    if (demo) await require('../test/demo.cjs').seed(configFile);
    if (!process.argv.includes('--background') || !tray) openWindow();
    setInterval(() => {
      void processOcr();
      try {
        const { scope } = storage.readConfig(configFile);
        send({ type: 'refresh', scope });
      } catch (error) {
        console.error('Refresh:', error.message);
      }
    }, 2400).unref();
    void processOcr();
  }).catch((error) => {
    dialog.showErrorBox('Memory 无法启动', error.message);
    app.quit();
  });
}
