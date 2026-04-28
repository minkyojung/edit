import { app, BrowserWindow, shell, ipcMain, IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import { spawn, ChildProcess } from 'child_process'
import { trigger, shutdown as agentShutdown, resetSession } from './agentService'
import { bootstrapWiki, readBelief, writeBelief } from './wikiService'
import { checkAuth, runLogin } from './authService'

let proofServer: ChildProcess | null = null

function startProofServer(): void {
  // out/main/ → apps/writer/ → apps/ → montpellier/packages/proof-sdk
  const serverPath = join(__dirname, '../../../../packages/proof-sdk')
  proofServer = spawn('npm', ['run', 'serve'], {
    cwd: serverPath,
    stdio: 'pipe',
    shell: true
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  agentShutdown().catch(() => undefined)
  proofServer?.kill()
  if (process.platform !== 'darwin') app.quit()
})
