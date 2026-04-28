import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { spawn, ChildProcess } from 'child_process'

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

function createWindow(): void {
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
}

app.whenReady().then(() => {
  startProofServer()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  proofServer?.kill()
  if (process.platform !== 'darwin') app.quit()
})
