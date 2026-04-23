import { join } from 'node:path'

import type { BrowserWindowConstructorOptions } from 'electron'

import type { FileStorage } from './storage/fileStorage'

export interface BrowserWindowInstance {
  loadURL: (url: string) => Promise<void>
  loadFile: (filePath: string) => Promise<void>
  webContents: {
    setWindowOpenHandler: (handler: () => { action: 'deny' }) => void
  }
}

export interface BrowserWindowFactory {
  new (options: BrowserWindowConstructorOptions): BrowserWindowInstance
  getAllWindows: () => BrowserWindowInstance[]
}

export function getMainWindowOptions(preloadPath: string, platform: NodeJS.Platform = process.platform): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#fffef9',
    titleBarStyle: platform === 'darwin' ? 'hiddenInset' : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: join(__dirname, '../../resources/icons/app.ico')
  }
}

export async function createMainWindow({
  BrowserWindow,
  storage,
  env = process.env,
  baseDir = __dirname,
  platform = process.platform
}: {
  BrowserWindow: BrowserWindowFactory
  storage: FileStorage
  env?: NodeJS.ProcessEnv
  baseDir?: string
  platform?: NodeJS.Platform
}): Promise<BrowserWindowInstance> {
  await storage.ensureReady()

  const browserWindow = new BrowserWindow(
    getMainWindowOptions(join(baseDir, '../preload/index.mjs'), platform)
  )

  browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (env.ELECTRON_RENDERER_URL) {
    await browserWindow.loadURL(env.ELECTRON_RENDERER_URL)
  } else {
    await browserWindow.loadFile(join(baseDir, '../renderer/index.html'))
  }

  return browserWindow
}
