import { ipcMain, dialog, BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc-channels'
import { getTaskRepo } from '../db/task.repo'
import { getSettingsRepo } from '../db/settings.repo'
import { getHistoryRepo } from '../db/history.repo'
import { getScannerService } from '../services/scanner.service'
import { getTaskQueueService } from '../services/task-queue.service'
import { getSSHRsyncService } from '../services/ssh-rsync.service'
import { getOSSUploadService } from '../services/oss-upload.service'
import { getTencentS3UploadService } from '../services/tencent-s3-upload.service'
import { getOSSBrowserService } from '../services/oss-browser.service'
import { getExtensionRuntimeService } from '../services/extension-runtime.service'
import { getGenericConverterService } from '../services/generic-converter.service'
import { getCleanupService } from '../services/cleanup.service'
import { getDayFolderRepo } from '../db/day-folder.repo'
import { getDayFolderService } from '../services/day-folder.service'
import { createOSSPreviewWindow, getMainWindow } from '../index'
import { getDb } from '../db/database'
import { getDataCollectService } from '../services/data-collect.service'
import { getTaskDestinationRepo } from '../db/task-destination.repo'
import { v4 as uuid } from 'uuid'
import type { AppSettings, CloudProvider, HistoryQuery, TaskListQuery, SSHMachine, SSHMachineInput, RsyncProgress, TransferMode, DiskUsageInfo, DayFolderListQuery, UploadPathMode, UploadProfile, UploadQueueStartInput, UploadQueueStopInput, OSSListQuery } from '@shared/types'
import { basename, dirname, normalize } from 'path'
import { shouldRestartScannerAfterSettingsSave } from '@shared/settings-effects'
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
import { existsSync } from 'fs'
import { statfs } from 'fs/promises'
import log from 'electron-log'
import { writeTmpUpload } from '../utils/marker-file'

function rowToSSHMachine(row: Record<string, unknown>): SSHMachine {
  return {
    id: row.id as string,
    name: row.name as string,
    host: row.host as string,
    port: row.port as number,
    username: row.username as string,
    authType: row.auth_type as SSHMachine['authType'],
    privateKeyPath: (row.private_key_path as string) || null,
    remoteDir: row.remote_dir as string,
    localDir: row.local_dir as string,
    bwLimit: row.bw_limit as number,
    cpuNice: row.cpu_nice as number,
    transferMode: (row.transfer_mode as TransferMode) || 'rsync',
    profileId: (row.profile_id as string) || null,
    enabled: Boolean(row.enabled),
    lastSyncAt: (row.last_sync_at as string) || null,
    createdAt: row.created_at as string
  }
}

export function registerAllIpc(): void {
  /** Broadcast task status change to all renderer windows */
  function broadcastStatusChange(taskId: string, newStatus: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.TASK_STATUS_CHANGE, { taskId, newStatus })
    }
  }

  // ---- 任务管理 ----
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
    const settingsRepo = getSettingsRepo()
    const settings = settingsRepo.getAll()
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

  // ---- 上传队列 ----
  ipcMain.handle(IPC.UPLOAD_QUEUE_STATUS, () => {
    return getTaskQueueService().getStatus()
  })

  ipcMain.handle(IPC.UPLOAD_QUEUE_START, (_event, args: UploadQueueStartInput) => {
    return getTaskQueueService().startUploading(args)
  })

  ipcMain.handle(IPC.UPLOAD_QUEUE_STOP, (_event, args: UploadQueueStopInput) => {
    return getTaskQueueService().stopUploading(args)
  })

  // ---- 扫描器 ----
  ipcMain.handle(IPC.SCANNER_STATUS, () => {
    return getScannerService().getStatus()
  })

  ipcMain.handle(IPC.SCANNER_TRIGGER, () => {
    getScannerService().triggerScan()
  })

  ipcMain.handle(IPC.SCANNER_START, () => {
    getScannerService().start()
  })

  ipcMain.handle(IPC.SCANNER_STOP, () => {
    getScannerService().stop()
  })

  // ---- 日期目录汇总 ----
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
      getTaskRepo().skip(task.id, '用户忽略整个日期')
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

  // ---- 设置 ----
  ipcMain.handle(IPC.SETTINGS_GET_ALL, () => {
    return getSettingsRepo().getAll()
  })

  ipcMain.handle(IPC.SETTINGS_SAVE, (_event, data: Partial<AppSettings>) => {
    getSettingsRepo().saveAll(data)
    if (data.cleanup !== undefined) {
      getCleanupService().scheduleCleanup()
    }
    if (shouldRestartScannerAfterSettingsSave(data)) {
      getScannerService().stop()
      getScannerService().start()
    }
    getGenericConverterService().syncWithSettings()
    return { ok: true }
  })

  ipcMain.handle(IPC.SETTINGS_TEST_OSS, async (_event, config: AppSettings['oss']) => {
    return getOSSUploadService().testConnection(config)
  })

  ipcMain.handle(
    IPC.SETTINGS_TEST_TENCENT_S3,
    async (_event, config: AppSettings['tencentS3']) => {
      return getTencentS3UploadService().testConnection(config)
    }
  )

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
      const snapshot = resolveProfileUploadSnapshot(
        profile,
        context,
        requestedProviders
      )
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
          const duplicateKeys = keys.filter(
            (key, index) => keys.indexOf(key) !== index
          )
          const warnings = duplicateKeys.length > 0
            ? [`存在重复对象 Key: ${Array.from(new Set(duplicateKeys)).join(', ')}`]
            : []
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
            warnings
          }
        })
      }
    }
  )

  // ---- 项目能力 ----
  ipcMain.handle(IPC.CAPABILITY_LIST, () => {
    return getExtensionRuntimeService().listCapabilities()
  })

  ipcMain.handle(IPC.CAPABILITY_PROFILE_STATUS, (_event, args?: { profileId?: string }) => {
    return getExtensionRuntimeService().getProjectCapabilityStatus(args?.profileId)
  })

  ipcMain.handle(IPC.CAPABILITY_TASK_RUNS, (_event, args: { taskId: string }) => {
    return getExtensionRuntimeService().listTaskRuns(args.taskId)
  })

  // ---- 项目插件兼容别名 ----
  ipcMain.handle(IPC.PLUGIN_LIST, () => {
    return getExtensionRuntimeService().listManifests()
  })

  ipcMain.handle(IPC.PLUGIN_PROFILE_STATUS, (_event, args?: { profileId?: string }) => {
    return getExtensionRuntimeService().getProfileStatus(args?.profileId)
  })

  ipcMain.handle(IPC.PLUGIN_TASK_RUNS, (_event, args: { taskId: string }) => {
    return getExtensionRuntimeService().listTaskRuns(args.taskId)
  })

  // ---- OSS 浏览器工具插件 ----
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

  // ---- 通用转换工具插件 ----
  ipcMain.handle(IPC.GENERIC_CONVERTER_STATUS, () => {
    return getGenericConverterService().getStatus()
  })

  ipcMain.handle(IPC.GENERIC_CONVERTER_START, async (_event, args: { profileId: string }) => {
    return getGenericConverterService().startProfile(args.profileId)
  })

  ipcMain.handle(IPC.GENERIC_CONVERTER_STOP, (_event, args: { profileId: string }) => {
    return getGenericConverterService().stopProfile(args.profileId)
  })

  ipcMain.handle(IPC.GENERIC_CONVERTER_SCAN_NOW, async (_event, args: { profileId: string }) => {
    return getGenericConverterService().scanNow(args.profileId)
  })

  // ---- SSH 机器 CRUD ----
  ipcMain.handle(IPC.SSH_LIST_MACHINES, () => {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM ssh_machines ORDER BY created_at DESC').all() as Record<string, unknown>[]
    return rows.map(rowToSSHMachine)
  })

  ipcMain.handle(IPC.SSH_ADD_MACHINE, (_event, input: SSHMachineInput) => {
    const db = getDb()
    const id = uuid()
    const now = new Date().toISOString()
    const profileId = input.profileId || getSettingsRepo().getAll().activeProfileId
    db.prepare(
      `INSERT INTO ssh_machines (id, name, host, port, username, auth_type, private_key_path, encrypted_password, remote_dir, local_dir, bw_limit, cpu_nice, transfer_mode, profile_id, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.name, input.host, input.port, input.username, input.authType, input.privateKeyPath || null, input.password || null, input.remoteDir, input.localDir, input.bwLimit, input.cpuNice, input.transferMode || 'rsync', profileId, input.enabled ? 1 : 0, now)
    const row = db.prepare('SELECT * FROM ssh_machines WHERE id = ?').get(id) as Record<string, unknown>
    return rowToSSHMachine(row)
  })

  ipcMain.handle(IPC.SSH_UPDATE_MACHINE, (_event, machine: SSHMachine) => {
    const db = getDb()
    db.prepare(
      `UPDATE ssh_machines SET name=?, host=?, port=?, username=?, auth_type=?, private_key_path=?, remote_dir=?, local_dir=?, bw_limit=?, cpu_nice=?, transfer_mode=?, profile_id=?, enabled=? WHERE id=?`
    ).run(machine.name, machine.host, machine.port, machine.username, machine.authType, machine.privateKeyPath, machine.remoteDir, machine.localDir, machine.bwLimit, machine.cpuNice, machine.transferMode || 'rsync', machine.profileId || null, machine.enabled ? 1 : 0, machine.id)
  })

  ipcMain.handle(IPC.SSH_DELETE_MACHINE, (_event, args: { id: string }) => {
    const db = getDb()
    db.prepare('DELETE FROM ssh_machines WHERE id = ?').run(args.id)
  })

  ipcMain.handle(IPC.SSH_TEST_CONNECTION, async (_event, args: { id: string }) => {
    const db = getDb()
    const row = db.prepare('SELECT * FROM ssh_machines WHERE id = ?').get(args.id) as Record<string, unknown> | undefined
    if (!row) return { ok: false, error: '机器不存在' }
    const machine = rowToSSHMachine(row)
    const password = (row.encrypted_password as string) || undefined
    return getSSHRsyncService().testConnection(machine, password)
  })

  ipcMain.handle(IPC.RSYNC_START, async (_event, args: { machineId: string }) => {
    const db = getDb()
    const row = db.prepare('SELECT * FROM ssh_machines WHERE id = ?').get(args.machineId) as Record<string, unknown> | undefined
    if (!row) throw new Error('机器不存在')
    const machine = rowToSSHMachine(row)
    const password = (row.encrypted_password as string) || undefined

    try {
      await getSSHRsyncService().startRsync(machine, password, (progress: RsyncProgress) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(IPC.RSYNC_PROGRESS, progress)
        }
      })
      // 更新最后同步时间
      db.prepare('UPDATE ssh_machines SET last_sync_at = ? WHERE id = ?').run(new Date().toISOString(), args.machineId)

      // rsync 完成后自动注册本地目录为上传任务
      const taskRepo = getTaskRepo()
      const settingsRepo = getSettingsRepo()
      const settings = settingsRepo.getAll()
      const profile = getProfileById(settings, machine.profileId)
      const localDir = normalize(machine.localDir).replace(/[\\/]+$/, '')
      const variables = extractProfilePathVariables(
        profile,
        machine.remoteDir,
        dirname(machine.remoteDir)
      )
      const snapshot = resolveProfileUploadSnapshot(profile, {
        sourcePath: machine.remoteDir,
        fallbackDirectoryPath: localDir,
        variables
      })
      const existing = taskRepo.getByFolderPath(localDir)
      let markerMode = snapshot.mode
      let markerPrefixes = snapshot.prefixes
      let markerUploadRelativePath = snapshot.uploadRelativePath
      let markerUploadRelativePaths = snapshot.uploadRelativePaths
      let markerPathModes = snapshot.pathModes
      let markerObjectKeyTemplates = snapshot.objectKeyTemplates
      let markerProfileId: string | undefined = snapshot.profileId
      let markerProfileName: string | undefined = snapshot.profileName
      let markerProfileSnapshot: UploadProfile | undefined = snapshot.profileSnapshot
      if (!existing || existing.status === 'completed' || existing.status === 'failed') {
        const task = taskRepo.create({
          folderPath: localDir,
          folderName: basename(localDir),
          ossPrefix: snapshot.prefixes.aliyun,
          uploadTargetMode: snapshot.mode,
          destinationPrefixes: snapshot.prefixes,
          destinationUploadRelativePaths: snapshot.uploadRelativePaths,
          destinationPathModes: snapshot.pathModes,
          destinationObjectKeyTemplates: snapshot.objectKeyTemplates,
          uploadRelativePath: snapshot.uploadRelativePath,
          sourceType: 'rsync',
          sourceMachineId: machine.id,
          profileId: snapshot.profileId,
          profileName: snapshot.profileName,
          profileSnapshot: snapshot.profileSnapshot,
          groupVariables: variables
        })
        getScannerService().queueReconcileTask(task)
        log.info('rsync 完成, 自动创建上传任务:', localDir)
      } else {
        const current = taskRepo.getById(existing.id) || existing
        markerMode = current.uploadTargetMode
        markerPrefixes = {
          aliyun:
            current.destinations.find((item) => item.provider === 'aliyun')?.prefix ||
            '',
          tencent:
            current.destinations.find((item) => item.provider === 'tencent')?.prefix ||
            ''
        }
        markerUploadRelativePaths = Object.fromEntries(
          current.destinations.map((destination) => [
            destination.provider,
            destination.uploadRelativePath
          ])
        ) as Partial<Record<CloudProvider, string>>
        markerPathModes = Object.fromEntries(
          current.destinations.map((destination) => [
            destination.provider,
            destination.pathMode
          ])
        ) as Partial<Record<CloudProvider, UploadPathMode>>
        markerObjectKeyTemplates = Object.fromEntries(
          current.destinations.map((destination) => [
            destination.provider,
            destination.objectKeyTemplate
          ])
        ) as Partial<Record<CloudProvider, string | null>>
        markerUploadRelativePath = current.uploadRelativePath
        markerProfileId = current.profileId || undefined
        markerProfileName = current.profileName || undefined
        markerProfileSnapshot = current.profileSnapshot || undefined
      }

      // 写入标记文件，防止 scanner 重复做稳定性检查
      writeTmpUpload(localDir, {
        version: 2,
        createdAt: new Date().toISOString(),
        folderPath: localDir,
        metadata: {
          source: 'rsync',
          machineId: machine.id,
          uploadRelativePath: markerUploadRelativePath,
          uploadTargetMode: markerMode,
          profileId: markerProfileId,
          profileName: markerProfileName,
          profileSnapshot: markerProfileSnapshot,
          groupVariables: variables,
          destinationPrefixes: markerPrefixes,
          destinationUploadRelativePaths: markerUploadRelativePaths,
          destinationPathModes: markerPathModes,
          destinationObjectKeyTemplates: markerObjectKeyTemplates
        }
      })
    } catch (err) {
      log.error('rsync 失败:', err)
      throw err
    }
  })

  ipcMain.handle(IPC.RSYNC_STOP, (_event, args: { machineId: string }) => {
    getSSHRsyncService().stopRsync(args.machineId)
  })

  // ---- 历史 ----
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

  // ---- 对话框 ----
  ipcMain.handle(IPC.DIALOG_SELECT_FOLDER, async () => {
    const win = getMainWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.DIALOG_SELECT_DIRECTORY, async () => {
    const win = getMainWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ---- SFTP 直传 OSS ----
  ipcMain.handle(IPC.SFTP_START, async (_event, args: { machineId: string }) => {
    const db = getDb()
    const row = db.prepare('SELECT * FROM ssh_machines WHERE id = ?').get(args.machineId) as Record<string, unknown> | undefined
    if (!row) throw new Error('机器不存在')
    const machine = rowToSSHMachine(row)
    const password = (row.encrypted_password as string) || undefined
    const settings = getSettingsRepo().getAll()

    try {
      const result = await getSSHRsyncService().sftpStreamToCloud(
        machine,
        password,
        settings,
        (progress) => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send(IPC.SFTP_PROGRESS, progress)
          }
        }
      )
      db.prepare('UPDATE ssh_machines SET last_sync_at = ? WHERE id = ?').run(new Date().toISOString(), args.machineId)
      return result
    } catch (err) {
      log.error('SFTP 直传失败:', err)
      throw err
    }
  })

  ipcMain.handle(IPC.SFTP_STOP, (_event, args: { machineId: string }) => {
    getSSHRsyncService().stopRsync(args.machineId)
  })

  // ---- 数采模式 ----
  ipcMain.handle(IPC.DATA_COLLECT_LIST, () => {
    return getDataCollectService().getAll()
  })

  ipcMain.handle(IPC.DATA_COLLECT_RUN, (_event, args: { folderPath: string }) => {
    const result = getDataCollectService().collectDataInfo(args.folderPath)
    if (result) {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC.DATA_COLLECT_RESULT, result)
      }
    }
    return result
  })

  // ---- 磁盘用量 ----
  ipcMain.handle(IPC.DISK_USAGE, async () => {
    const settingsRepo = getSettingsRepo()
    const scanConfig = settingsRepo.getAll().scan
    const db = getDb()

    // 收集所有需要检查的路径
    const paths = new Set<string>()
    if (scanConfig?.directories) {
      for (const d of scanConfig.directories) paths.add(normalize(d).replace(/[\\/]+$/, ''))
    }
    const sshRows = db.prepare('SELECT local_dir FROM ssh_machines WHERE enabled = 1').all() as Array<{ local_dir: string }>
    for (const r of sshRows) {
      paths.add(normalize(r.local_dir).replace(/[\\/]+$/, ''))
    }

    const results: DiskUsageInfo[] = []
    for (const p of paths) {
      try {
        if (!existsSync(p)) continue
        const stats = await statfs(p)
        const totalBytes = stats.bsize * stats.blocks
        const freeBytes = stats.bsize * stats.bavail
        const usedBytes = totalBytes - freeBytes
        const usagePercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0
        results.push({ path: p, totalBytes, freeBytes, usedBytes, usagePercent })
      } catch (err) {
        log.warn('获取磁盘用量失败:', p, err)
      }
    }
    return results
  })

}
