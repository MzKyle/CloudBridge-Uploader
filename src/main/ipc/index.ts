import { BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { statfs } from 'fs/promises'
import { basename, dirname, normalize } from 'path'
import log from 'electron-log'
import { IPC } from '@shared/ipc-channels'
import type {
  AppSettings,
  CloudProvider,
  ConnectionTestInput,
  DayFolderListQuery,
  DiskUsageInfo,
  HistoryQuery,
  OSSListQuery,
  TaskListQuery,
  UploadRuleDryRunInput,
  UploadQueueStartInput,
  UploadQueueStopInput
} from '@shared/types'
import {
  buildObjectKeyVariables,
  extractProfilePathVariables,
  getProfileById,
  renderObjectKey,
  resolveProfileUploadSnapshot,
  validateObjectKeyTemplate,
  validateObjectKeyValue,
  type UploadPathPreview
} from '@shared/upload-profile'
import { getDayFolderRepo } from '../db/day-folder.repo'
import { getHistoryRepo } from '../db/history.repo'
import { getSettingsRepo } from '../db/settings.repo'
import { getTaskDestinationRepo } from '../db/task-destination.repo'
import { getTaskRepo } from '../db/task.repo'
import { getCleanupService } from '../services/cleanup.service'
import { getOSSBrowserService } from '../services/oss-browser.service'
import { getOSSUploadService } from '../services/oss-upload.service'
import { getScannerService } from '../services/scanner.service'
import { getTaskQueueService } from '../services/task-queue.service'
import { getTencentS3UploadService } from '../services/tencent-s3-upload.service'
import { getDayFolderService } from '../services/day-folder.service'
import { getUploadRuleDryRunService } from '../services/upload-rule-dry-run.service'
import { shouldRestartScannerAfterSettingsSave } from '@shared/settings-effects'
import { getMainWindow, createOSSPreviewWindow } from '../index'

export function registerAllIpc(): void {
  function broadcastStatusChange(taskId: string, newStatus: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.TASK_STATUS_CHANGE, { taskId, newStatus })
    }
  }

  ipcMain.handle(IPC.TASK_LIST, (_event, args?: TaskListQuery) => {
    return getTaskRepo().listByQuery(args)
  })

  ipcMain.handle(IPC.TASK_GET, (_event, args: { taskId: string }) => {
    return getTaskRepo().getById(args.taskId)
  })

  ipcMain.handle(IPC.TASK_DETAIL, (_event, args: { taskId: string }) => {
    const task = getTaskRepo().getById(args.taskId)
    if (!task) throw new Error('任务不存在')
    return {
      task,
      files: getTaskRepo().listFileDetails(args.taskId)
    }
  })

  ipcMain.handle(IPC.TASK_ADD_FOLDER, (_event, args: { folderPath: string; profileId?: string }) => {
    const taskRepo = getTaskRepo()
    const settings = getSettingsRepo().getAll()
    const profile = getProfileById(settings, args.profileId)
    const variables = extractProfilePathVariables(
      profile,
      args.folderPath,
      dirname(args.folderPath)
    )
    const snapshot = resolveProfileUploadSnapshot(profile, {
      sourcePath: args.folderPath,
      variables
    })
    const folderName = basename(args.folderPath)
    const task = taskRepo.create({
      folderPath: args.folderPath,
      folderName,
      ossPrefix: snapshot.prefixes.aliyun,
      uploadTargetMode: snapshot.mode,
      destinationPrefixes: snapshot.prefixes,
      destinationUploadRelativePaths: snapshot.uploadRelativePaths,
      destinationPathModes: snapshot.pathModes,
      destinationObjectKeyTemplates: snapshot.objectKeyTemplates,
      uploadRelativePath: snapshot.uploadRelativePath,
      sourceType: 'manual',
      profileId: snapshot.profileId,
      profileName: snapshot.profileName,
      profileSnapshot: snapshot.profileSnapshot,
      groupVariables: variables
    })
    getScannerService().queueReconcileTask(task)
    return getTaskRepo().getById(task.id)
  })

  ipcMain.handle(IPC.TASK_PAUSE, (_event, args: { taskId: string }) => {
    getTaskQueueService().cancelRunningTask(args.taskId)
    getTaskRepo().updateStatus(args.taskId, 'paused')
    getTaskDestinationRepo().updateIncompleteStatuses(args.taskId, 'paused')
    getDayFolderService().refreshForTask(args.taskId)
    broadcastStatusChange(args.taskId, 'paused')
  })

  ipcMain.handle(IPC.TASK_RESUME, (_event, args: { taskId: string }) => {
    getTaskRepo().retry(args.taskId)
    getDayFolderService().refreshForTask(args.taskId)
    broadcastStatusChange(args.taskId, 'pending')
  })

  ipcMain.handle(IPC.TASK_CANCEL, (_event, args: { taskId: string }) => {
    getTaskQueueService().cancelRunningTask(args.taskId)
    getTaskRepo().skip(args.taskId, '用户跳过')
    getDayFolderService().refreshForTask(args.taskId)
    broadcastStatusChange(args.taskId, 'skipped')
  })

  ipcMain.handle(IPC.TASK_SKIP, (_event, args: { taskId: string }) => {
    getTaskQueueService().cancelRunningTask(args.taskId)
    getTaskRepo().skip(args.taskId, '用户跳过')
    getDayFolderService().refreshForTask(args.taskId)
    broadcastStatusChange(args.taskId, 'skipped')
  })

  ipcMain.handle(IPC.TASK_RESTORE, (_event, args: { taskId: string }) => {
    const task = getTaskRepo().getById(args.taskId)
    if (!task) throw new Error('任务不存在')
    if (!existsSync(task.folderPath)) throw new Error('源目录不存在，无法恢复')
    getTaskRepo().restore(args.taskId)
    const restored = getTaskRepo().getById(args.taskId)
    if (restored) getScannerService().queueReconcileTask(restored)
    getDayFolderService().refreshForTask(args.taskId)
    broadcastStatusChange(args.taskId, 'scanning')
  })

  ipcMain.handle(IPC.TASK_RETRY, (_event, args: { taskId: string; provider?: CloudProvider }) => {
    getTaskRepo().retry(args.taskId, args.provider)
    getDayFolderService().refreshForTask(args.taskId)
    broadcastStatusChange(args.taskId, 'pending')
  })

  ipcMain.handle(IPC.UPLOAD_QUEUE_STATUS, () => getTaskQueueService().getStatus())
  ipcMain.handle(IPC.UPLOAD_QUEUE_START, (_event, args: UploadQueueStartInput) => {
    return getTaskQueueService().startUploading(args)
  })
  ipcMain.handle(IPC.UPLOAD_QUEUE_STOP, (_event, args: UploadQueueStopInput) => {
    return getTaskQueueService().stopUploading(args)
  })

  ipcMain.handle(IPC.SCANNER_STATUS, () => getScannerService().getStatus())
  ipcMain.handle(IPC.SCANNER_TRIGGER, () => getScannerService().triggerScan())
  ipcMain.handle(IPC.SCANNER_START, () => getScannerService().start())
  ipcMain.handle(IPC.SCANNER_STOP, () => getScannerService().stop())

  ipcMain.handle(IPC.DAY_FOLDER_LIST, (_event, query?: DayFolderListQuery) => {
    return getDayFolderRepo().list(query)
  })

  ipcMain.handle(IPC.DAY_FOLDER_DELETE, (_event, args: { id: string; provider?: CloudProvider }) => {
    getDayFolderRepo().deleteCompleted(args.id, args.provider)
  })

  ipcMain.handle(IPC.DAY_FOLDER_IGNORE, (_event, args: { id: string }) => {
    const repo = getDayFolderRepo()
    repo.setIgnored(args.id, true)
    for (const task of repo.getChildTasks(args.id)) {
      if (task.status === 'completed' || task.status === 'synced') continue
      getTaskQueueService().cancelRunningTask(task.id)
      getTaskRepo().skip(task.id, '用户忽略整个归档组')
      broadcastStatusChange(task.id, 'skipped')
    }
    return getDayFolderService().refresh(args.id)
  })

  ipcMain.handle(IPC.DAY_FOLDER_RESTORE, (_event, args: { id: string }) => {
    const repo = getDayFolderRepo()
    repo.setIgnored(args.id, false)
    for (const task of repo.getChildTasks(args.id)) {
      if (task.status !== 'skipped' || !existsSync(task.folderPath)) continue
      getTaskRepo().restore(task.id)
      const restored = getTaskRepo().getById(task.id)
      if (restored) getScannerService().queueReconcileTask(restored)
      broadcastStatusChange(task.id, 'scanning')
    }
    return getDayFolderService().refresh(args.id)
  })

  ipcMain.handle(IPC.UPLOAD_GROUP_CLOSE, (_event, args: { id: string }) => {
    return getDayFolderService().requestCloseUploadGroup(args.id)
  })

  ipcMain.handle(IPC.SETTINGS_GET_ALL, () => getSettingsRepo().getAll())

  ipcMain.handle(IPC.SETTINGS_SAVE, (_event, data: Partial<AppSettings>) => {
    getSettingsRepo().saveAll(data)
    if (data.cleanup !== undefined) getCleanupService().scheduleCleanup()
    if (shouldRestartScannerAfterSettingsSave(data)) {
      getScannerService().stop()
      getScannerService().start()
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.SETTINGS_TEST_OSS, async (_event, config: AppSettings['oss']) => {
    return getOSSUploadService().testConnection(config)
  })

  ipcMain.handle(IPC.SETTINGS_TEST_TENCENT_S3, async (_event, config: AppSettings['tencentS3']) => {
    return getTencentS3UploadService().testConnection(config)
  })

  ipcMain.handle(IPC.CONNECTION_TEST, async (_event, input: ConnectionTestInput) => {
    const settings = getSettingsRepo().getAll()
    if (input.type === 'aliyun-oss') {
      return getOSSUploadService().testConnection({
        ...settings.oss,
        ...input.config
      })
    }
    return getTencentS3UploadService().testConnection({
      ...settings.tencentS3,
      ...input.config
    })
  })

  ipcMain.handle(IPC.UPLOAD_RULE_DRY_RUN, (_event, input: UploadRuleDryRunInput) => {
    return getUploadRuleDryRunService().run(input)
  })

  ipcMain.handle(
    IPC.UPLOAD_PATH_PREVIEW,
    (_event, args: {
      profileId?: string
      sourcePath: string
      provider?: CloudProvider
      sampleFiles?: string[]
    }): UploadPathPreview => {
      const settings = getSettingsRepo().getAll()
      const profile = getProfileById(settings, args.profileId)
      const folderName = basename(args.sourcePath)
      const variables = extractProfilePathVariables(
        profile,
        args.sourcePath,
        dirname(args.sourcePath)
      )
      const context = {
        sourcePath: args.sourcePath,
        basePath: dirname(args.sourcePath),
        variables
      }
      const requestedProviders = args.provider ? [args.provider] : undefined
      const snapshot = resolveProfileUploadSnapshot(profile, context, requestedProviders)
      const sampleFiles = (args.sampleFiles?.length
        ? args.sampleFiles
        : ['camera/0001.jpg', 'data/sample.csv']
      ).slice(0, 20)

      return {
        profileId: profile.id,
        profileName: profile.name,
        sourcePath: args.sourcePath,
        providers: Object.keys(snapshot.pathModes || {}).map((providerKey) => {
          const provider = providerKey as CloudProvider
          const pathMode = snapshot.pathModes?.[provider] || 'target-root'
          const objectKeyTemplate = snapshot.objectKeyTemplates?.[provider] ?? null
          const errors = objectKeyTemplate
            ? [...validateObjectKeyTemplate(objectKeyTemplate)]
            : []
          const keys: string[] = []
          for (const relativePath of sampleFiles) {
            try {
              const key = renderObjectKey(
                {
                  provider,
                  prefix: snapshot.prefixes[provider],
                  uploadRelativePath: snapshot.uploadRelativePaths[provider] ?? '',
                  pathMode,
                  objectKeyTemplate
                },
                {
                  ...context,
                  profileId: profile.id,
                  profileName: profile.name,
                  folderName,
                  relativePath
                }
              )
              const valueErrors = validateObjectKeyValue(key)
              if (valueErrors.length > 0) errors.push(...valueErrors)
              keys.push(key)
            } catch (error) {
              errors.push(error instanceof Error ? error.message : String(error))
            }
          }
          const duplicateKeys = keys.filter((key, index) => keys.indexOf(key) !== index)
          return {
            provider,
            prefix: snapshot.prefixes[provider],
            uploadRelativePath: snapshot.uploadRelativePaths[provider] ?? '',
            pathMode,
            objectKeyTemplate,
            variables: buildObjectKeyVariables(provider, {
              ...context,
              profileId: profile.id,
              profileName: profile.name,
              folderName,
              relativePath: sampleFiles[0] || ''
            }),
            keys,
            errors: Array.from(new Set(errors)),
            warnings: duplicateKeys.length > 0
              ? [`存在重复对象 Key: ${Array.from(new Set(duplicateKeys)).join(', ')}`]
              : []
          }
        })
      }
    }
  )

  ipcMain.handle(IPC.OSS_BROWSER_LIST, async (_event, args: OSSListQuery) => {
    return getOSSBrowserService().list(args?.prefix, args?.continuationToken, args?.maxKeys)
  })
  ipcMain.handle(IPC.OSS_BROWSER_HEAD, async (_event, args: { key: string }) => {
    return getOSSBrowserService().head(args.key)
  })
  ipcMain.handle(IPC.OSS_BROWSER_GET_IMAGE, async (_event, args: { key: string; maxBytes?: number }) => {
    return getOSSBrowserService().getImagePreview(args.key, args.maxBytes)
  })
  ipcMain.handle(IPC.OSS_BROWSER_OPEN_PREVIEW_WINDOW, (_event, args: { key: string }) => {
    createOSSPreviewWindow(args.key)
  })

  ipcMain.handle(IPC.HISTORY_LIST, (_event, query: HistoryQuery) => {
    return getHistoryRepo().list(query)
  })
  ipcMain.handle(IPC.HISTORY_CLEAR, (_event, args?: { before?: string; provider?: CloudProvider }) => {
    getHistoryRepo().clear(args?.before, args?.provider)
    getDayFolderRepo().clearCompleted(args?.before, args?.provider)
  })
  ipcMain.handle(IPC.HISTORY_DELETE, (_event, args: { id: string; provider?: CloudProvider }) => {
    getHistoryRepo().deleteById(args.id, args.provider)
  })

  ipcMain.handle(IPC.DIALOG_SELECT_FOLDER, async () => {
    const win = getMainWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.DIALOG_SELECT_DIRECTORY, async () => {
    const win = getMainWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.DISK_USAGE, async () => {
    const settings = getSettingsRepo().getAll()
    const paths = new Set<string>()
    for (const profile of settings.profiles) {
      for (const root of profile.source.roots) {
        paths.add(normalize(root).replace(/[\\/]+$/, ''))
      }
    }
    const results: DiskUsageInfo[] = []
    for (const path of paths) {
      try {
        if (!existsSync(path)) continue
        const stats = await statfs(path)
        const totalBytes = stats.bsize * stats.blocks
        const freeBytes = stats.bsize * stats.bavail
        const usedBytes = totalBytes - freeBytes
        const usagePercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0
        results.push({ path, totalBytes, freeBytes, usedBytes, usagePercent })
      } catch (err) {
        log.warn('获取磁盘用量失败:', path, err)
      }
    }
    return results
  })
}
