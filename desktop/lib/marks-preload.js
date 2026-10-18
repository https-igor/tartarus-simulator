/* Tartarus Overlay: what the marks page gets from the shell. */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('Marks', {
  onMarks: (fn) => {
    if (typeof fn === 'function') ipcRenderer.on('marks', (e, data) => fn(data));
  },
});
