import { app, BrowserWindow, shell, ipcMain, IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import { spawn, ChildProcess } from 'child_process'
import { trigger, shutdown as agentShutdown, resetSession } from './agentService'
import { bootstrapWiki, readBelief, writeBelief } from './wikiService'
import { checkAuth, runLogin } from './authService'
import { startOAuthFlow, completeOAuthFlow, hasToken, clearToken, onAuthChange } from './oauthService'
import { bootstrapDoc, getCollabSession } from './docService'
import { acceptMark, rejectMark } from './markService'

let proofServer: ChildProcess | null = null

function startProofServer(): void {
  // out/main/ → apps/writer/ → apps/ → montpellier/packages/proof-sdk
  const serverPath = join(__dirname, '../../../../packages/proof-sdk')
  proofServer = spawn('npm', ['run', 'serve'], {
    cwd: serverPath,
    stdio: 'pipe',
    shell: true,
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

  ipcMain.handle('mark:accept', async (_: IpcMainInvokeEvent, markId: string) => {
    await acceptMark(markId)
  })

  ipcMain.handle('mark:reject', async (_: IpcMainInvokeEvent, markId: string) => {
    await rejectMark(markId)
  })

  ipcMain.on('agent:trigger', (_, text: string) => {
    trigger(text, win.webContents)
  })

  ipcMain.handle('wiki:read', async (_: IpcMainInvokeEvent) => {
    return readBelief()
  })

  ipcMain.handle('wiki:save', async (_: IpcMainInvokeEvent, markdown: string) => {
    await writeBelief(markdown)
    await resetSession()
  })

  ipcMain.handle('auth:status', async (_: IpcMainInvokeEvent) => {
    return checkAuth()
  })

  ipcMain.handle('auth:login', async (_: IpcMainInvokeEvent) => {
    await runLogin()
    return checkAuth()
  })

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
