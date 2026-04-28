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
  },
  onError: (cb: (msg: string) => void) => {
    ipcRenderer.on('agent:error', (_, msg) => cb(msg))
  }
})

contextBridge.exposeInMainWorld('wiki', {
  read: (): Promise<string> => ipcRenderer.invoke('wiki:read'),
  save: (markdown: string): Promise<void> => ipcRenderer.invoke('wiki:save', markdown)
})

contextBridge.exposeInMainWorld('auth', {
  status: (): Promise<string> => ipcRenderer.invoke('auth:status'),
  login: (): Promise<string> => ipcRenderer.invoke('auth:login')
})

contextBridge.exposeInMainWorld('server', {
  onError: (cb: () => void) => {
    ipcRenderer.on('server:error', () => cb())
  }
})

contextBridge.exposeInMainWorld('doc', {
  collabSession: (): Promise<{ collabWsUrl: string; token: string; slug: string }> =>
    ipcRenderer.invoke('doc:collab-session')
})
