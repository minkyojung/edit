import { app, BrowserWindow, shell, ipcMain, IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import { spawn, ChildProcess } from 'child_process'
import { trigger, shutdown as agentShutdown, resetSession, getSettings, setSettings } from './agentService'
import { chat, stopChat } from './chatService'
import type { ChatMessage } from './chatService'
import type { AgentSettings } from './agentSettings'
import { bootstrapWiki, readBelief, writeBelief } from './wikiService'
import { startOAuthFlow, completeOAuthFlow, hasToken, clearToken, onAuthChange } from './oauthService'
import { bootstrapDoc, getCollabSession } from './docService'

let proofServer: ChildProcess | null = null

function startProofServer(): void {
  // out/main/ → apps/writer/ → apps/ → root(montpellier)
  const rootDir = join(__dirname, '../../../..')
  const serverPath = join(rootDir, 'node_modules/proof-sdk')
  const tsxBin = join(rootDir, 'node_modules/.bin/tsx')
  proofServer = spawn(tsxBin, ['server/index.ts'], {
    cwd: serverPath,
    stdio: 'pipe',
    env: {
      ...process.env,
      COLLAB_EMBEDDED_WS: 'true'
    }
  })

  proofServer.stdout?.on('data', (data) => {
    console.log('[proof-server]', data.toString().trim())
  })

  proofServer.stderr?.on('data', (data) => {
    console.error('[proof-server]', data.toString().trim())
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  startProofServer()
  const win = createWindow()

  bootstrapWiki().catch((err) => {
    console.error('[wiki bootstrap]', err)
    win.webContents.send('server:error')
  })

  bootstrapDoc().catch((err) => console.error('[doc bootstrap]', err))

  ipcMain.handle('doc:collab-session', async (_: IpcMainInvokeEvent) => {
    return getCollabSession()
  })

  ipcMain.on('agent:trigger', (_, text: string, processedHistory: unknown) => {
    trigger(text, win.webContents, Array.isArray(processedHistory) ? processedHistory : [])
  })

  ipcMain.handle('wiki:read', async (_: IpcMainInvokeEvent) => {
    return readBelief()
  })

  ipcMain.handle('wiki:save', async (_: IpcMainInvokeEvent, markdown: string) => {
    await writeBelief(markdown)
    await resetSession()
  })

  ipcMain.on('chat:send', (_, messages: ChatMessage[], documentContext: string | null, model: string) => {
    chat(messages, documentContext, model, win.webContents).catch((err) =>
      console.error('[chat IPC]', err)
    )
  })

  ipcMain.on('chat:stop', () => { stopChat().catch((err) => console.error('[chat stop]', err)) })

  ipcMain.handle('agent:get-settings', async () => getSettings())
  ipcMain.handle('agent:set-settings', async (_: IpcMainInvokeEvent, s: AgentSettings) => setSettings(s))

  ipcMain.handle('auth:oauth-status', async () => (hasToken() ? 'authenticated' : 'unauthenticated'))
  ipcMain.handle('auth:oauth-start', async () => startOAuthFlow())
  ipcMain.handle('auth:oauth-complete', async (_: IpcMainInvokeEvent, code: string) => {
    await completeOAuthFlow(code)
  })
  ipcMain.handle('auth:logout', async () => clearToken())

  onAuthChange((status) => {
    if (!win.isDestroyed()) win.webContents.send('auth:changed', status)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  agentShutdown().catch(() => undefined)
  proofServer?.kill()
  if (process.platform !== 'darwin') app.quit()
})
