'use strict';
// The only bridge between Bluey's windows and the app. Keys can be set but never read back.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bluey', {
  state: () => ipcRenderer.invoke('state'),
  set: (name, value) => ipcRenderer.invoke('set', name, value),
  setKey: (name, value) => ipcRenderer.invoke('key', name, value),
  focus: (command, args) => ipcRenderer.invoke('focus', command, args),
  pairing: (action) => ipcRenderer.invoke('pairing', action),
  onState: (callback) => ipcRenderer.on('state', (_e, state) => callback(state)),
  onGaze: (callback) => ipcRenderer.on('gaze', (_e, gaze) => callback(gaze)),
});
