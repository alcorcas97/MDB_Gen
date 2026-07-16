const { contextBridge, ipcRenderer } = require('electron/renderer');

contextBridge.exposeInMainWorld('crStudio', {
  ping: () => ipcRenderer.invoke('app:ping'),
  getDefaults: () => ipcRenderer.invoke('app:get-defaults'),
  openFolder: (options) => ipcRenderer.invoke('dialog:open-folder', options),
  saveFile: (options) => ipcRenderer.invoke('dialog:save-file', options),
  inspectCase: (caseFolderPath) => ipcRenderer.invoke('case:inspect', { caseFolderPath }),
  exportReport: (payload) => ipcRenderer.invoke('case:export-report', payload),
  discoverSources: (payload) => ipcRenderer.invoke('case:discover-sources', payload),
  buildVnTree: (payload) => ipcRenderer.invoke('case:build-vn-tree', payload),
  showItemInFolder: (targetPath) => ipcRenderer.invoke('shell:show-item', targetPath)
});
