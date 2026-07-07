import {
  app,
  BrowserWindow,
  shell,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  dialog
} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerAllIpc } from './ipc'
import { initDatabase } from './db/database'
import { getSettingsRepo } from './db/settings.repo'
import { getScannerService } from './services/scanner.service'
import { getTaskQueueService } from './services/task-queue.service'
import { getTaskRunnerService } from './services/task-runner.service'
import { getExtensionRuntimeService } from './services/extension-runtime.service'
import { getCleanupService } from './services/cleanup.service'
import { getGenericConverterService } from './services/generic-converter.service'
import { getTaskRepo } from './db/task.repo'
import { initLogger } from './utils/logger'
import { IPC } from '@shared/ipc-channels'
import type { LogConfig } from '@shared/types'
import log from 'electron-log'

let mainWindow: BrowserWindow | null = null
let startupWindow: BrowserWindow | null = null
let ossPreviewWindow: BrowserWindow | null = null
let tray: Tray | null = null
let servicesStarted = false

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  const window = mainWindow || startupWindow
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
})

async function createStartupWindow(): Promise<void> {
  startupWindow = new BrowserWindow({
    width: 460,
    height: 220,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: '云桥上传器正在启动',
    backgroundColor: '#f8fafc',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  startupWindow.once('ready-to-show', () => startupWindow?.show())
  const html = `<!doctype html>
    <html lang="zh-CN">
      <head><meta charset="utf-8"><title>正在启动</title></head>
      <body style="margin:0;font-family:sans-serif;background:#f8fafc;color:#0f172a">
        <main style="height:220px;display:flex;flex-direction:column;align-items:center;justify-content:center">
          <div style="font-size:18px;font-weight:600">云桥上传器正在启动</div>
          <div style="margin-top:14px;font-size:14px;color:#475569">正在检查和升级本地数据库，请勿重复启动或强制关机。</div>
          <div style="margin-top:8px;font-size:12px;color:#64748b">历史文件较多时首次升级可能需要几分钟。</div>
        </main>
      </body>
    </html>`
  await startupWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: '云桥上传器',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    startupWindow?.destroy()
    startupWindow = null
    mainWindow?.show()
    if (!servicesStarted) {
      servicesStarted = true
      setTimeout(() => {
        try {
          startServices()
        } catch (error) {
          log.error('后台服务启动失败:', error)
        }
      }, 500)
    }
  })

  // 关闭时隐藏到托盘而不是退出
  mainWindow.on('close', (e) => {
    if (!(app as unknown as { isQuitting: boolean }).isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  // 使用一个简单的 16x16 图标（纯色方块作为占位）
  const icon = nativeImage.createEmpty()
  tray = new Tray(icon.isEmpty() ? nativeImage.createFromBuffer(Buffer.alloc(0)) : icon)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        ; (app as unknown as { isQuitting: boolean }).isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setToolTip('云桥上传器')
  tray.setContextMenu(contextMenu)
  tray.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

function registerHotkey(): void {
  try {
    const settingsRepo = getSettingsRepo()
    const hotkey = settingsRepo.get<string>('hotkey') || 'CommandOrControl+Shift+U'
    globalShortcut.register(hotkey, () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide()
        } else {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    })
  } catch (err) {
    log.error('注册快捷键失败:', err)
  }
}

function startServices(): void {
  const taskQueue = getTaskQueueService()
  const taskRunner = getTaskRunnerService()
  const extensionRuntime = getExtensionRuntimeService()
  const genericConverter = getGenericConverterService()
  const taskRepo = getTaskRepo()
  const scanner = getScannerService()

  // 连接任务队列和执行器
  taskQueue.setTaskRunner(async (task, signal) => {
    const finalStatus = await taskRunner.run(task, signal)
    if (signal.aborted) return finalStatus

    if (finalStatus === 'completed') {
      const updatedTask = taskRepo.getById(task.id)
      if (updatedTask) extensionRuntime.notifyTaskEvent(updatedTask, 'task_completed')
    }
    return finalStatus
  })

  taskQueue.on('task:status-change', (event: { taskId: string; newStatus: string }) => {
    if (event.newStatus === 'failed') {
      const task = taskRepo.getById(event.taskId)
      if (task) extensionRuntime.notifyTaskEvent(task, 'task_failed')
    }

    // 广播状态变更到渲染进程
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.TASK_STATUS_CHANGE, event)
    }
  })

  taskQueue.on('upload-queue:event', (status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.UPLOAD_QUEUE_EVENT, status)
    }
  })

  genericConverter.on('status', (status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.GENERIC_CONVERTER_EVENT, status)
    }
  })

  // 恢复未完成的任务
  const unfinishedTaskIds = taskRepo.listUnfinishedTaskIds()
  if (unfinishedTaskIds.length > 0) {
    log.info(`发现 ${unfinishedTaskIds.length} 个未完成任务，等待后台队列分批恢复`)
  }

  // 启动任务队列
  taskQueue.start()

  // 启动扫描器
  scanner.start()

  scanner.queueReconcileTaskIds(unfinishedTaskIds)

  // 启动自动清理服务
  getCleanupService().start()

  // 启动按 Profile 配置的外部转换工具
  genericConverter.syncWithSettings()

  log.info('所有服务已启动')
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  electronApp.setAppUserModelId('com.uploader.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 初始化日志系统（在数据库之前，使用默认配置）
  initLogger()
  process.on('uncaughtException', (error) => {
    log.error('主进程未捕获异常:', error)
  })
  process.on('unhandledRejection', (reason) => {
    log.error('主进程未处理 Promise 异常:', reason)
  })
  app.on('render-process-gone', (_event, webContents, details) => {
    log.error('渲染进程异常退出:', {
      reason: details.reason,
      exitCode: details.exitCode,
      url: webContents.getURL()
    })
  })
  app.on('child-process-gone', (_event, details) => {
    log.error('Electron 子进程异常退出:', details)
  })

  await createStartupWindow()

  // 初始化数据库
  initDatabase()

  // 从数据库读取日志配置并重新初始化
  const logConfig = getSettingsRepo().get<LogConfig>('log')
  if (logConfig?.directory) {
    initLogger(logConfig)
  }

  // 注册所有 IPC 处理器
  registerAllIpc()

  // 创建窗口
  createWindow()

  // 创建托盘
  createTray()

  // 注册全局快捷键
  registerHotkey()

  log.info('应用界面初始化完成，后台服务将在窗口显示后启动')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  log.error('应用启动失败:', error)
  startupWindow?.destroy()
  startupWindow = null
  dialog.showErrorBox(
    '云桥上传器启动失败',
    message.includes('database is locked')
      ? '数据库正在被另一个程序进程使用。请结束旧的云桥上传器进程后重试。'
      : `${message}\n\n请查看 ~/.config/electron-uploader/logs 下的日志。`
  )
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  getScannerService().stop()
  getTaskQueueService().stop()
  getCleanupService().stop()
  getGenericConverterService().stopAll()
})

  ; (app as unknown as { isQuitting: boolean }).isQuitting = false

app.on('before-quit', () => {
  ; (app as unknown as { isQuitting: boolean }).isQuitting = true
})

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function createOSSPreviewWindow(key: string): void {
  const encodedKey = encodeURIComponent(key)
  const hash = `oss-preview?key=${encodedKey}`

  if (ossPreviewWindow && !ossPreviewWindow.isDestroyed()) {
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      ossPreviewWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/${hash}`)
    } else {
      ossPreviewWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash })
    }
    ossPreviewWindow.show()
    ossPreviewWindow.focus()
    return
  }

  ossPreviewWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: 'OSS 预览',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  ossPreviewWindow.on('closed', () => {
    ossPreviewWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    ossPreviewWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/${hash}`)
  } else {
    ossPreviewWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
}
