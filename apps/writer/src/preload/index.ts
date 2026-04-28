import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform
})

contextBridge.exposeInMainWorld('agent', {
  trigger: (text: string) => ipcRenderer.send('agent:trigger', text),
  onChunk: (cb: (text: string) => void) => {
    ipcRenderer.on('agent:chunk', (_, text) => cb(text))
  },
  onDone: (cb: () => void) => {
    ipcRenderer.on('agent:done', () => cb())
  }
})

contextBridge.exposeInMainWorld('wiki', {
  read: (): Promise<string> => ipcRenderer.invoke('wiki:read'),
  save: (markdown: string): Promise<void> => ipcRenderer.invoke('wiki:save', markdown)
})
