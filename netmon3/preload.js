// NetMon preload — secure bridge between main & renderer
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('netmon', {
  onSpeedUpdate: (callback) => {
    ipcRenderer.on('speed-update', (_event, dlBps, ulBps) => callback(dlBps, ulBps))
  },
  onIPUpdate: (callback) => {
    ipcRenderer.on('ip-update', (_event, ip, loc) => callback(ip, loc))
  },

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  getHourlyData: () => ipcRenderer.invoke('get-hourly-data'),
  getDailyData: () => ipcRenderer.invoke('get-daily-data'),
  getTodayPeaks: () => ipcRenderer.invoke('get-today-peaks'),
  getInterfaces: () => ipcRenderer.invoke('get-interfaces'),

  closeWidget: () => ipcRenderer.invoke('close-widget'),
  hideToTray: () => ipcRenderer.invoke('hide-to-tray'),
})
