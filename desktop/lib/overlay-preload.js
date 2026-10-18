/* Tartarus Overlay: what the overlay page gets from the shell. */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, fn) => {
  if (typeof fn === 'function') ipcRenderer.on(channel, (e, data) => fn(data));
};

contextBridge.exposeInMainWorld('Overlay', {
  onShell: (fn) => listen('shell', fn),
  onGame: (fn) => listen('game', fn),
  onFollow: (fn) => listen('follow', fn),
  onAdvice: (fn) => listen('advice', fn),
  // board, follow, capture, fix, recheck, report, report-new, hide, lock,
  // pick-log, reload, restart
  command: (name) => ipcRenderer.send('overlay:command', String(name)),
  size: (height) => ipcRenderer.send('overlay:size', Number(height)),
  // Dragging the card by its head: 'start', then how far the pointer moved
  // since (dx, dy), then 'end'.
  drag: (phase, dx, dy) => ipcRenderer.send('overlay:drag', String(phase), Number(dx) || 0, Number(dy) || 0),
});
