const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memory', {
  request: (operation, input) => ipcRenderer.invoke('memory:request', operation, input),
  subscribe: (update) => {
    const listener = (_event, data) => update(data);
    ipcRenderer.on('memory:update', listener);
    return () => ipcRenderer.removeListener('memory:update', listener);
  }
});
