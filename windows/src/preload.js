'use strict';
// The only bridge between Bluey's windows and the app. Keys can be set but never read back.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bluey', {
  state: () => ipcRenderer.invoke('state'),
  set: (name, value) => ipcRenderer.invoke('set', name, value),
  setKey: (name, value) => ipcRenderer.invoke('key', name, value),
  focus: (command, args) => ipcRenderer.invoke('focus', command, args),
  pairing: (action) => ipcRenderer.invoke('pairing', action),
  action: (name) => ipcRenderer.invoke('action', name),
  onState: (callback) => ipcRenderer.on('state', (_e, state) => callback(state)),
  // The cursor overlay
  onOverlay: (callback) => ipcRenderer.on('overlay', (_e, message) => callback(message)),
  overlayState: (state) => ipcRenderer.send('overlay-state', state),
  // The research card
  onReport: (callback) => ipcRenderer.on('report', (_e, state) => callback(state)),
  reportAction: (action, url) => ipcRenderer.send('report-action', action, url),
});
