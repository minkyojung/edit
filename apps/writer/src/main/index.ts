import { app, BrowserWindow, shell, ipcMain } from 'electron'
import { join } from 'path'
import { spawn, ChildProcess } from 'child_process'
import { trigger } from './agentService'
import { bootstrapWiki } from './wikiService'

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

  bootstrapWiki().catch((err) => console.error('[wiki bootstrap]', err))

  ipcMain.on('agent:trigger', (_, text: string) => {
    trigger(text, win.webContents)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  proofServer?.kill()
  if (process.platform !== 'darwin') app.quit()
})
