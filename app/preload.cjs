const { contextBridge, ipcRenderer } = require('electron/renderer');

contextBridge.exposeInMainWorld('fiberApp', {
  ping: () => ipcRenderer.invoke('app:ping'),
  getDefaults: () => ipcRenderer.invoke('app:get-defaults'),
  openFile: (options) => ipcRenderer.invoke('dialog:open-file', options),
  openFolder: (options) => ipcRenderer.invoke('dialog:open-folder', options),
  saveFile: (options) => ipcRenderer.invoke('dialog:save-file', options),
  inspectProject: (projectFolderPath) => ipcRenderer.invoke('project:inspect', { projectFolderPath }),
  generate: (payload) => ipcRenderer.invoke('generation:run', payload),
  generateCrossCheck: (payload) => ipcRenderer.invoke('crosscheck:generate', payload),
  inspectConnectionBalance: (payload) => ipcRenderer.invoke('mdb:inspect-connection-balance', payload),
  adjustConnections: (payload) => ipcRenderer.invoke('mdb:adjust-connections', payload),
  fixCustomerDempings: (payload) => ipcRenderer.invoke('mdb:fix-customer-dempings', payload),
  updateFc: (payload) => ipcRenderer.invoke('mdb:update-fc', payload),
  openRiserWindow: (payload) => ipcRenderer.invoke('riser:open-window', payload),
  loadRiserData: (payload) => ipcRenderer.invoke('riser:load-data', payload),
  applyRiserData: (payload) => ipcRenderer.invoke('mdb:apply-riser-data', payload),
  applyGlaspoortProject: (payload) => ipcRenderer.invoke('mdb:apply-glaspoort-project', payload),
  rebuildCustomerComplexes: (payload) => ipcRenderer.invoke('mdb:rebuild-customer-complexes', payload),
  drawCustomerCoordinates: (payload) => ipcRenderer.invoke('dwg:draw-customers', payload),
  clearCustomerCoordinates: (payload) => ipcRenderer.invoke('dwg:clear-customers', payload),
  extractCustomerCoordinates: (payload) => ipcRenderer.invoke('dwg:extract-customers', payload),
  removeExtraRoles: (payload) => ipcRenderer.invoke('dwg:remove-extra-roles', payload),
  drawAccessnetWithoutAddress: (payload) => ipcRenderer.invoke('dwg:draw-accessnet-without-address', payload),
  getOapCoordinate: (payload) => ipcRenderer.invoke('dwg:get-oap-coordinate', payload),
  pickRiserEtCoordinate: (payload) => ipcRenderer.invoke('dwg:pick-riser-et-coordinate', payload),
  cancelGeneration: () => ipcRenderer.invoke('generation:cancel'),
  showItemInFolder: (targetPath) => ipcRenderer.invoke('shell:show-item', targetPath),
  onGenerationEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('generation:event', listener);

    return () => {
      ipcRenderer.removeListener('generation:event', listener);
    };
  }
});
