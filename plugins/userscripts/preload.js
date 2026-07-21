'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('userscripts', {
  list: () => ipcRenderer.invoke('userscripts:list'),
  save: (script) => ipcRenderer.invoke('userscripts:save', script),
  remove: (id) => ipcRenderer.invoke('userscripts:remove', id),
  toggle: (id, enabled) => ipcRenderer.invoke('userscripts:toggle', id, enabled),
  importFile: () => ipcRenderer.invoke('userscripts:import-file')
});
