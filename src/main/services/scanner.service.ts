import { existsSync } from 'fs'
import { access } from 'fs/promises'
import { join } from 'path'
import { watch, type FSWatcher } from 'chokidar'
import { BrowserWindow } from 'electron'
import log from 'electron-log'
import { IPC } from '@shared/ipc-channels'
import {
  buildLastUploadGroupIndexByStream,
  uploadGroupSiblingStreamKey
} from '@shared/upload-group'
import {
  getUploadTargetSnapshot,
  providersForMode,
  type UploadTargetSnapshot
} from '@shared/cloud-upload'
import type { UploadPathResolveContext } from '@shared/upload-path'
import {
  getActiveProfileScanRoots,
  getProfileWatchedDirectoriesByProvider,
  type ActiveProfileScanRoot
} from '@shared/scan-config'
import {
  getProfileById,
  resolveProfileUploadSnapshot
} from '@shared/upload-profile'
import { getTaskRepo } from '../db/task.repo'
import { getTaskDestinationRepo } from '../db/task-destination.repo'
import { getDayFolderRepo } from '../db/day-folder.repo'
import { getSettingsRepo } from '../db/settings.repo'
import { getDataCollectService } from './data-collect.service'
import { getDayFolderService } from './day-folder.service'
import { getTaskQueueService } from './task-queue.service'
import { FileFilterService } from './file-filter.service'
import {
  discoverUploadGroups,
  type DiscoveredUploadTaskDirectory
} from './date-directory-discovery'
import {
  readProcessTask,
  readTmpUpload,
  writeProcessTask,
  writeTmpUpload
} from '../utils/marker-file'
import type {
  TmpUploadMarker,
  StabilityConfig,
  ScannerStatus,
  DataCollectConfig,
  Task,
  UploadTargetMode,
  CloudProvider,
  AppSettings,
  UploadPathMode,
  PathVariables
} from '@shared/types'

interface PendingDir {
  path: string
  dayFolderId: string
  groupKey: string
  variables: PathVariables
  folderName: string
  uploadRelativePath: string
  checks: number
  discoveredAt: string
  lastSnapshot: Map<string, { size: number; mtimeMs: number }>
  uploadTargetMode?: UploadTargetMode
  profileId?: string
  profileName?: string
  profileSnapshot?: AppSettings['profiles'][number]
  destinationPrefixes?: Partial<Record<CloudProvider, string>>
  destinationUploadRelativePaths?: Partial<Record<CloudProvider, string>>
  destinationPathModes?: TmpUploadMarker['metadata']['destinationPathModes']
  destinationObjectKeyTemplates?: TmpUploadMarker['metadata']['destinationObjectKeyTemplates']
}

const NON_WORK_DIR_REASON = '非任务目录'
const INITIAL_SCAN_DELAY_MS = 3000
const SCAN_BATCH_SIZE = 4
const RECONCILE_BATCH_SIZE = 2

/**
 * 目录扫描服务
 * - Source 指向本地数据根目录
 * - Discovery Rule 发现 UploadGroup 和 UploadTask 目录
 * - 子目录稳定后注册任务，UploadGroup 根据 CompletionPolicy 封账
 */
export class ScannerService {
  private timer: ReturnType<typeof setInterval> | null = null
  private stabilityTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private lastScanAt: string | null = null
  private nextScanAt: string | null = null
  private pendingDirs: Map<string, PendingDir> = new Map()
  private lastScanResults: ScannerStatus['lastScanResults'] = null
  private watcher: FSWatcher | null = null
  private scanDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private watcherErrorHandled = false
  private lastWatcherWarningAt = 0
  private scanInProgress = false
  private scanQueued = false
  private reconcileQueue: string[] = []
  private reconcileQueuedIds = new Set<string>()
  private reconcileInProgress = false
  private stabilityCursor = 0

  start(): void {
    if (this.running) return
    this.running = true

    const settings = getSettingsRepo()
    const allSettings = settings.getAll()
    const activeRoots = getActiveProfileScanRoots(allSettings.profiles)
    const directories = activeRoots.map((root) => root.directory)
    const intervalMs = (allSettings.scan.intervalSeconds || 30) * 1000

    this.startWatcher(directories)
    this.timer = setInterval(() => this.scheduleFullScan(), intervalMs)
    this.scheduleFullScan(INITIAL_SCAN_DELAY_MS)

    const stabilityConfig = settings.get<StabilityConfig>('stability')
    const checkInterval = stabilityConfig?.checkIntervalMs || 5000
    this.stabilityTimer = setInterval(() => this.checkStability(), checkInterval)

    log.info('扫描器已启动, 间隔:', intervalMs / 1000, '秒')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.stabilityTimer) {
      clearInterval(this.stabilityTimer)
      this.stabilityTimer = null
    }
    if (this.watcher) {
      void this.watcher.close()
      this.watcher = null
    }
    if (this.scanDebounceTimer) {
      clearTimeout(this.scanDebounceTimer)
      this.scanDebounceTimer = null
    }
    this.scanQueued = false
    this.reconcileQueue = []
    this.reconcileQueuedIds.clear()
    this.running = false
    this.nextScanAt = null
    log.info('扫描器已停止')
    this.broadcastStatus()
  }

  isRunning(): boolean {
    return this.running
  }

  getStatus(): ScannerStatus {
    const settings = getSettingsRepo()
    const allSettings = settings.getAll()
    const stabilityConfig = settings.get<StabilityConfig>('stability')
    const requiredChecks = stabilityConfig?.checkCount || 3
    const activeRoots = getActiveProfileScanRoots(allSettings.profiles)
    const watchedDirectoriesByProvider = getProfileWatchedDirectoriesByProvider(
      allSettings.profiles
    )

    const pendingStabilityChecks: ScannerStatus['pendingStabilityChecks'] = []
    for (const pending of this.pendingDirs.values()) {
      pendingStabilityChecks.push({
        path: pending.path,
        checks: pending.checks,
        requiredChecks,
        discoveredAt: pending.discoveredAt
      })
    }

    return {
      running: this.running,
      lastScanAt: this.lastScanAt,
      nextScanAt: this.nextScanAt,
      watchedDirectories: activeRoots.map((root) => root.directory),
      watchedDirectoriesByProvider,
      pendingStabilityChecks,
      lastScanResults: this.lastScanResults
    }
  }

  triggerScan(): void {
    this.scheduleFullScan(0)
  }

  private async scan(): Promise<void> {
    if (!this.running) return
    if (this.scanInProgress) {
      this.scanQueued = true
      return
    }

    this.scanInProgress = true
    const settings = getSettingsRepo()
    const allSettings = settings.getAll()
    const scanConfig = allSettings.scan
    const activeRoots = getActiveProfileScanRoots(allSettings.profiles)
    const directories = activeRoots.map((root) => root.directory)
    const intervalMs = (scanConfig?.intervalSeconds || 30) * 1000
    const seenChildPaths = new Set<string>()

    let scannedDirs = 0
    let newDirsFound = 0
    let existingDirs = 0
    let ignoredDirectories = 0
    let skippedChildren = 0

    try {
      for (const root of activeRoots) {
        if (!(await this.pathExists(root.directory))) {
          log.warn('扫描根目录不存在:', root.directory)
          continue
        }
        const profile = getProfileById(allSettings, root.profileId)
        const result = await this.scanRootDirectory(
          root,
          seenChildPaths,
          profile
        )
        scannedDirs += result.scanned
        newDirsFound += result.newFound
        existingDirs += result.existing
        ignoredDirectories += result.ignored
        skippedChildren += result.skipped
        await this.yieldToEventLoop()
      }

      for (const pendingPath of this.pendingDirs.keys()) {
        if (!seenChildPaths.has(pendingPath)) {
          this.pendingDirs.delete(pendingPath)
        }
      }

      await this.reconcileDeletedTasks(seenChildPaths, directories)

      this.lastScanAt = new Date().toISOString()
      this.nextScanAt = new Date(Date.now() + intervalMs).toISOString()
      this.lastScanResults = {
        scannedDirs,
        newDirsFound,
        existingDirs,
        ignoredDirectories,
        skippedChildren,
        timestamp: this.lastScanAt
      }
      this.broadcastStatus()
    } finally {
      this.scanInProgress = false
      if (this.scanQueued && this.running) {
        this.scanQueued = false
        this.scheduleFullScan(250)
      }
    }
  }

  private async scanRootDirectory(
    root: ActiveProfileScanRoot,
    seenChildPaths: Set<string>,
    profile = getProfileById(getSettingsRepo().getAll(), root.profileId)
  ): Promise<{ scanned: number; newFound: number; existing: number; ignored: number; skipped: number }> {
    let scanned = 0
    let newFound = 0
    let existing = 0
    let ignored = 0
    let skipped = 0

    try {
      const groups = await discoverUploadGroups(
        root.directory,
        profile.discovery
      )
      const lastGroupIndexByStream = buildLastUploadGroupIndexByStream(groups)
      for (let index = 0; index < groups.length; index++) {
        const group = groups[index]
        const result = await this.scanUploadGroupDirectory(
          root.directory,
          group.folderPath,
          group.groupKey,
          group.variables,
          group.taskDirectories,
          seenChildPaths,
          root.providers,
          profile
        )
        scanned += result.scanned
        newFound += result.newFound
        existing += result.existing
        ignored += result.ignored
        skipped += result.skipped

        const shouldCloseByRollover =
          profile.completion.mode === 'rollover' &&
          lastGroupIndexByStream.get(uploadGroupSiblingStreamKey(group.relativePath)) !== index
        const shouldCloseByMarker =
          profile.completion.mode === 'marker-file' &&
          existsSync(join(group.folderPath, profile.completion.markerFile))
        if (shouldCloseByRollover || shouldCloseByMarker) {
          const uploadGroup = getDayFolderRepo().getByPath(group.folderPath)
          if (uploadGroup?.uploadGroupStatus === 'open') {
            getDayFolderRepo().markClosing(uploadGroup.id)
            getDayFolderService().refresh(uploadGroup.id)
          }
        }

        if ((index + 1) % SCAN_BATCH_SIZE === 0) {
          await this.yieldToEventLoop()
        }
      }
    } catch (err) {
      log.error('扫描数据根目录失败:', root.directory, err)
    }

    return { scanned, newFound, existing, ignored, skipped }
  }

  private async scanUploadGroupDirectory(
    sourceRootDir: string,
    groupPath: string,
    groupKey: string,
    groupVariables: PathVariables,
    discoveredTasks: DiscoveredUploadTaskDirectory[],
    seenChildPaths: Set<string>,
    providers: CloudProvider[],
    profile: AppSettings['profiles'][number]
  ): Promise<{ scanned: number; newFound: number; existing: number; ignored: number; skipped: number }> {
    const dayFolder = getDayFolderRepo().ensure(
      groupPath,
      groupKey,
      groupVariables,
      profile.id
    )
    const childNames = Array.from(
      new Set(discoveredTasks.map((task) => task.folderName))
    ).sort()
    let scanned = 0
    let newFound = 0
    let existing = 0
    let ignored = 0
    let skipped = 0

    try {
      for (let index = 0; index < discoveredTasks.length; index++) {
        const discoveredTask = discoveredTasks[index]
        const childName = discoveredTask.folderName
        const childPath = discoveredTask.folderPath
        const variables = discoveredTask.ignored
          ? groupVariables
          : { ...groupVariables, ...discoveredTask.variables }
        const pathContext: UploadPathResolveContext = {
          sourcePath: childPath,
          basePath: sourceRootDir,
          variables
        }
        const targetSnapshot = this.pendingTargetSnapshot(providers, pathContext, profile)
        const uploadRelativePath = targetSnapshot.uploadRelativePath
        seenChildPaths.add(childPath)
        scanned++

        const existingTask = getTaskRepo().getByFolderPath(childPath)
        if (existingTask) {
          this.attachTaskToDayFolder(existingTask, dayFolder.id)
          getTaskRepo().updateGroupVariables(existingTask.id, variables)
          this.pendingDirs.delete(childPath)
          if (
            dayFolder.ignored &&
            existingTask.status !== 'completed' &&
            existingTask.status !== 'synced'
          ) {
            getTaskRepo().skip(existingTask.id, '用户忽略整个归档组')
            this.broadcastTaskStatus(
              existingTask.id,
              existingTask.status,
              'skipped'
            )
          }
          existing++
          continue
        }

        if (discoveredTask.ignored) {
          const task = this.registerIgnoredDir(
            childPath,
            childName,
            dayFolder.id,
            uploadRelativePath,
            variables,
            providers,
            targetSnapshot
          )
          this.broadcastTaskStatus(task.id, task.status, 'skipped')
          ignored++
          skipped++
          continue
        }

        const processMarker = readProcessTask(childPath)
        if (processMarker?.status === 'completed') {
          this.registerLegacyCompletedDir(
            childPath,
            childName,
            dayFolder.id,
            groupKey,
            variables,
            processMarker,
            readTmpUpload(childPath)
          )
          existing++
          continue
        }

        const tmpMarker = readTmpUpload(childPath)
        if (tmpMarker) {
          const markerUploadRelativePath =
            tmpMarker.metadata.uploadRelativePath ?? uploadRelativePath
          const task = this.registerNewDir({
            path: childPath,
            dayFolderId: dayFolder.id,
            groupKey,
            variables,
            folderName: childName,
            uploadRelativePath: markerUploadRelativePath,
            checks: 0,
            discoveredAt: tmpMarker.createdAt || new Date().toISOString(),
            lastSnapshot: new Map(),
            uploadTargetMode: tmpMarker.metadata.uploadTargetMode,
            profileId: tmpMarker.metadata.profileId,
            profileName: tmpMarker.metadata.profileName,
            profileSnapshot: tmpMarker.metadata.profileSnapshot,
            destinationPrefixes: tmpMarker.metadata.destinationPrefixes,
            destinationUploadRelativePaths:
              tmpMarker.metadata.destinationUploadRelativePaths ||
              this.legacyDestinationUploadRelativePaths(
                tmpMarker.metadata.uploadTargetMode,
                markerUploadRelativePath
              ),
            destinationPathModes: tmpMarker.metadata.destinationPathModes,
            destinationObjectKeyTemplates:
              tmpMarker.metadata.destinationObjectKeyTemplates
          })
          if (dayFolder.ignored) {
            getTaskRepo().skip(task.id, '用户忽略整个归档组')
            this.broadcastTaskStatus(task.id, task.status, 'skipped')
          } else {
            this.queueReconcileTask(task)
          }
          existing++
          continue
        }

        if (!this.pendingDirs.has(childPath)) {
          log.info('发现新任务目录, 注册持续同步任务:', childPath)
          const pending: PendingDir = {
            path: childPath,
            dayFolderId: dayFolder.id,
            groupKey,
            variables,
            folderName: childName,
            uploadRelativePath,
            checks: 0,
            discoveredAt: new Date().toISOString(),
            lastSnapshot: new Map(),
            uploadTargetMode: targetSnapshot.mode,
            profileId: targetSnapshot.profileId,
            profileName: targetSnapshot.profileName,
            profileSnapshot: targetSnapshot.profileSnapshot,
            destinationPrefixes: targetSnapshot.prefixes,
            destinationUploadRelativePaths: targetSnapshot.uploadRelativePaths,
            destinationPathModes: targetSnapshot.pathModes,
            destinationObjectKeyTemplates: targetSnapshot.objectKeyTemplates
          }
          const task = this.registerNewDir(pending)
          if (dayFolder.ignored) {
            getTaskRepo().skip(task.id, '用户忽略整个归档组')
            this.broadcastTaskStatus(task.id, task.status, 'skipped')
          } else {
            this.queueReconcileTask(task)
          }
          newFound++
        }

        if ((index + 1) % SCAN_BATCH_SIZE === 0) {
          await this.yieldToEventLoop()
        }
      }
    } catch (err) {
      log.error('扫描归档组失败:', groupPath, err)
    }

    getDayFolderService().refresh(dayFolder.id, childNames)
    return { scanned, newFound, existing, ignored, skipped }
  }

  private checkStability(): void {
    const taskIds = getTaskRepo().listContinuouslyMonitoredTaskIds()
    if (taskIds.length > 0) {
      const batchSize = Math.min(RECONCILE_BATCH_SIZE, taskIds.length)
      for (let i = 0; i < batchSize; i++) {
        const taskId = taskIds[(this.stabilityCursor + i) % taskIds.length]
        if (taskId) this.queueReconcileTask(taskId)
      }
      this.stabilityCursor = (this.stabilityCursor + batchSize) % taskIds.length
    }
    this.broadcastStatus()
  }

  private registerNewDir(pending: PendingDir): Task {
    const settings = getSettingsRepo().getAll()
    const snapshot =
      pending.uploadTargetMode && pending.destinationPrefixes
        ? {
            mode: pending.uploadTargetMode,
            prefixes: {
              aliyun: pending.destinationPrefixes.aliyun || '',
              tencent: pending.destinationPrefixes.tencent || ''
            },
          uploadRelativePaths:
              pending.destinationUploadRelativePaths ||
              this.legacyDestinationUploadRelativePaths(
                pending.uploadTargetMode,
                pending.uploadRelativePath
              ),
            uploadRelativePath: pending.uploadRelativePath,
            profileId: pending.profileId,
            profileName: pending.profileName,
            profileSnapshot: pending.profileSnapshot,
            pathModes: pending.destinationPathModes,
            objectKeyTemplates: pending.destinationObjectKeyTemplates
          }
        : this.legacySnapshotForPendingDir(pending, settings)
    const marker: TmpUploadMarker = {
      version: 2,
      createdAt: new Date().toISOString(),
      folderPath: pending.path,
      metadata: {
        source: 'local',
        dayFolderId: pending.dayFolderId,
        date: pending.variables.date,
        groupKey: pending.groupKey,
        groupVariables: pending.variables,
        uploadRelativePath: pending.uploadRelativePath,
        uploadTargetMode: snapshot.mode,
        profileId: snapshot.profileId,
        profileName: snapshot.profileName,
        profileSnapshot: snapshot.profileSnapshot,
        destinationPrefixes: snapshot.prefixes,
        destinationUploadRelativePaths: snapshot.uploadRelativePaths,
        destinationPathModes: snapshot.pathModes,
        destinationObjectKeyTemplates: snapshot.objectKeyTemplates
      }
    }

    writeTmpUpload(pending.path, marker)
    const task = this.ensureTaskRegistered(
      pending.path,
      pending.folderName,
      pending.dayFolderId,
      pending.uploadRelativePath,
      snapshot,
      pending.variables
    )
    log.info('任务目录已注册为上传任务:', pending.path)
    setTimeout(() => this.collectDataInfo(pending.path), 0)
    getDayFolderService().refresh(pending.dayFolderId)
    return task
  }

  private registerIgnoredDir(
    dirPath: string,
    folderName: string,
    dayFolderId: string,
    uploadRelativePath: string,
    variables: PathVariables,
    providers?: CloudProvider[],
    targetSnapshot?: UploadTargetSnapshot
  ): Task {
    const task = this.ensureTaskRegistered(
      dirPath,
      folderName,
      dayFolderId,
      uploadRelativePath,
      targetSnapshot || (providers ? getUploadTargetSnapshot(getSettingsRepo().getAll()) : undefined),
      variables
    )
    if (task.status !== 'skipped' || task.errorMessage !== NON_WORK_DIR_REASON) {
      getTaskRepo().skip(task.id, NON_WORK_DIR_REASON)
      log.info('已忽略非任务目录:', dirPath)
    }
    getDayFolderService().refresh(dayFolderId)
    return getTaskRepo().getById(task.id) || task
  }

  private startWatcher(directories: string[]): void {
    if (this.watcher) void this.watcher.close()
    this.watcherErrorHandled = false
    const existingDirectories = directories.filter((directory) =>
      existsSync(directory)
    )
    if (existingDirectories.length === 0) return

    this.watcher = watch(existingDirectories, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: false,
      // 只监听 Source/Group/Task 附近的目录结构。
      // 文件变化由稳定性检查和 30 秒全量校准处理，避免大量小文件耗尽 inotify。
      depth: 4,
      ignored: (path, stats) => {
        const normalized = path.replace(/\\/g, '/')
        return (
          stats?.isFile() === true ||
          normalized.includes('/.git/') ||
          normalized.endsWith('/tmp_upload.json') ||
          normalized.endsWith('/process_task.json') ||
          normalized.endsWith('/day_upload.json')
        )
      }
    })

    this.watcher
      .on('addDir', () => this.scheduleFullScan())
      .on('unlinkDir', () => this.scheduleFullScan())
      .on('error', (error) => this.handleWatcherError(error))
  }

  private scheduleFullScan(delayMs = 500): void {
    if (this.scanDebounceTimer) clearTimeout(this.scanDebounceTimer)
    this.scanDebounceTimer = setTimeout(() => {
      this.scanDebounceTimer = null
      void this.scan()
    }, delayMs)
  }

  private handleWatcherError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const isResourceLimit =
      message.includes('ENOSPC') ||
      message.includes('EMFILE') ||
      message.includes('file watchers')

    if (isResourceLimit && !this.watcherErrorHandled) {
      this.watcherErrorHandled = true
      log.warn(
        '目录事件监控达到系统资源上限，已关闭事件监听并回退到周期扫描:',
        message
      )
      const watcher = this.watcher
      this.watcher = null
      if (watcher) void watcher.close()
      return
    }

    const now = Date.now()
    if (now - this.lastWatcherWarningAt >= 60_000) {
      this.lastWatcherWarningAt = now
      log.warn('目录事件监控异常，周期扫描仍会继续:', message)
    }
  }

  queueReconcileTask(task: Pick<Task, 'id'> | string): void {
    const taskId = typeof task === 'string' ? task : task.id
    if (!this.enqueueReconcileTaskId(taskId)) return
    void this.processReconcileQueue()
  }

  queueReconcileTaskIds(taskIds: string[]): void {
    let queued = false
    for (const taskId of taskIds) {
      queued = this.enqueueReconcileTaskId(taskId) || queued
    }
    if (queued) void this.processReconcileQueue()
  }

  private enqueueReconcileTaskId(taskId: string): boolean {
    if (this.reconcileQueuedIds.has(taskId)) return false
    this.reconcileQueuedIds.add(taskId)
    this.reconcileQueue.push(taskId)
    return true
  }

  private async processReconcileQueue(): Promise<void> {
    if (this.reconcileInProgress) return
    this.reconcileInProgress = true
    try {
      while (this.reconcileQueue.length > 0) {
        const taskId = this.reconcileQueue.shift()!
        this.reconcileQueuedIds.delete(taskId)
        const task = getTaskRepo().getById(taskId)
        if (task) {
          await this.reconcileTask(task)
        }
        await this.yieldToEventLoop()
      }
    } finally {
      this.reconcileInProgress = false
    }
  }

  async reconcileTask(task: Task): Promise<void> {
    if (
      task.status === 'skipped' ||
      task.status === 'paused' ||
      task.status === 'completed'
    ) {
      return
    }
    if (!(await this.pathExists(task.folderPath))) {
      if (task.status !== 'synced') {
        getTaskQueueService().cancelRunningTask(task.id)
        getTaskRepo().skip(task.id, '源目录已删除')
        getDayFolderService().refreshForTask(task.id)
        this.broadcastTaskStatus(task.id, task.status, 'skipped')
      }
      return
    }

    try {
      const settings = getSettingsRepo().getAll()
      const fileFilter = new FileFilterService(
        task.profileSnapshot?.filter || settings.filter
      )
      const stableChecks =
        task.sourceType === 'local' && task.dayFolderId
          ? Math.max(2, settings.stability.checkCount || 2)
          : 1
      await getTaskRepo().reconcileFileBatches(
        task.id,
        fileFilter.scanFolderBatches(task.folderPath),
        stableChecks
      )
      const updated = getTaskRepo().getById(task.id)
      if (updated && updated.status !== task.status) {
        this.broadcastTaskStatus(task.id, task.status, updated.status)
      }
      getDayFolderService().refreshForTask(task.id)
    } catch (err) {
      if (!(await this.pathExists(task.folderPath))) {
        getTaskQueueService().cancelRunningTask(task.id)
        getTaskRepo().skip(task.id, '源目录已删除')
        getDayFolderService().refreshForTask(task.id)
        this.broadcastTaskStatus(task.id, task.status, 'skipped')
        return
      }
      log.warn('持续同步校准失败:', task.folderPath, err)
    }
  }

  private async reconcileDeletedTasks(
    seenChildPaths: Set<string>,
    watchedDirectories: string[]
  ): Promise<void> {
    const normalizedRoots = watchedDirectories.map((directory) =>
      directory.replace(/[\\/]+$/, '')
    )
    const tasks = getTaskRepo().listMonitorableLocalUnfinishedTasks()
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index]
      if (
        !normalizedRoots.some(
          (root) =>
            task.folderPath === root ||
            task.folderPath.startsWith(`${root}/`) ||
            task.folderPath.startsWith(`${root}\\`)
        )
      ) {
        continue
      }
      if (seenChildPaths.has(task.folderPath) || (await this.pathExists(task.folderPath))) continue
      if (
        task.status === 'completed' ||
        task.status === 'synced' ||
        task.status === 'skipped'
      ) {
        continue
      }
      getTaskQueueService().cancelRunningTask(task.id)
      getTaskRepo().skip(task.id, '源目录已删除')
      getDayFolderService().refreshForTask(task.id)
      this.broadcastTaskStatus(task.id, task.status, 'skipped')

      if ((index + 1) % SCAN_BATCH_SIZE === 0) {
        await this.yieldToEventLoop()
      }
    }
  }

  private broadcastTaskStatus(
    taskId: string,
    oldStatus: Task['status'],
    newStatus: Task['status']
  ): void {
    for (const win of BrowserWindow?.getAllWindows?.() ?? []) {
      win.webContents.send(IPC.TASK_STATUS_CHANGE, {
        taskId,
        oldStatus,
        newStatus
      })
    }
  }

  private registerLegacyCompletedDir(
    dirPath: string,
    folderName: string,
    dayFolderId: string,
    groupKey: string,
    variables: PathVariables,
    processMarker: NonNullable<ReturnType<typeof readProcessTask>>,
    tmpMarker: ReturnType<typeof readTmpUpload>
  ): void {
    const legacyUploadRelativePath = folderName
    const markerProviders = Object.keys(processMarker.destinations || {}) as CloudProvider[]
    const mode = processMarker.uploadTargetMode || (
      markerProviders.includes('tencent') && markerProviders.includes('aliyun')
        ? 'both'
        : markerProviders.includes('tencent')
          ? 'tencent'
          : 'aliyun'
    )
    const currentSettings = getSettingsRepo().getAll()
    const prefixes = {
      aliyun:
        tmpMarker?.metadata.destinationPrefixes?.aliyun ||
        currentSettings.oss.prefix ||
        '',
      tencent:
        tmpMarker?.metadata.destinationPrefixes?.tencent ||
        currentSettings.tencentS3.prefix ||
        ''
    }
    const uploadRelativePaths =
      tmpMarker?.metadata.destinationUploadRelativePaths ||
      this.legacyDestinationUploadRelativePaths(mode, legacyUploadRelativePath)
    const task = this.ensureTaskRegistered(
      dirPath,
      folderName,
      dayFolderId,
      legacyUploadRelativePath,
      {
        mode,
        prefixes,
        uploadRelativePaths,
        uploadRelativePath: legacyUploadRelativePath
      },
      variables
    )
    const taskRepo = getTaskRepo()
    taskRepo.setTotals(task.id, processMarker.totalFiles, 0)
    taskRepo.updateProgress(task.id, processMarker.uploadedFiles, 0)
    taskRepo.updateStatus(task.id, 'completed')
    for (const destination of getTaskDestinationRepo().listByTask(task.id)) {
      const marker = processMarker.destinations?.[destination.provider]
      getTaskDestinationRepo().setTotals(
        task.id,
        destination.provider,
        marker?.totalFiles ?? processMarker.totalFiles,
        0
      )
      getTaskDestinationRepo().updateProgress(
        task.id,
        destination.provider,
        marker?.uploadedFiles ?? processMarker.uploadedFiles,
        0
      )
      getTaskDestinationRepo().updateStatus(
        task.id,
        destination.provider,
        'completed'
      )
    }

    writeTmpUpload(dirPath, {
      version: 2,
      createdAt: new Date().toISOString(),
      folderPath: dirPath,
      metadata: {
        source: 'local',
        dayFolderId,
        date: variables.date,
        groupKey,
        groupVariables: variables,
        uploadRelativePath: legacyUploadRelativePath,
        uploadTargetMode: mode,
        destinationPrefixes: prefixes,
        destinationUploadRelativePaths: uploadRelativePaths
      }
    })
    writeProcessTask(dirPath, {
      ...processMarker,
      taskId: task.id,
      status: 'completed',
      lastUpdated: new Date().toISOString()
    })
    getDayFolderService().refresh(dayFolderId)
    log.info('信任旧完成标记并登记任务目录:', dirPath)
  }

  private ensureTaskRegistered(
    dirPath: string,
    folderName: string,
    dayFolderId: string,
    uploadRelativePath: string,
    targetSnapshot?: UploadTargetSnapshot,
    groupVariables: PathVariables = {}
  ): Task {
    const taskRepo = getTaskRepo()
    const existing = taskRepo.getByFolderPath(dirPath)
    if (existing) {
      this.attachTaskToDayFolder(existing, dayFolderId)
      return taskRepo.getById(existing.id)!
    }

    const settings = getSettingsRepo().getAll()
    const snapshot = targetSnapshot || getUploadTargetSnapshot(settings)
    return taskRepo.create({
      folderPath: dirPath,
      folderName,
      ossPrefix: snapshot.prefixes.aliyun,
      uploadTargetMode: snapshot.mode,
      destinationPrefixes: snapshot.prefixes,
      destinationUploadRelativePaths: snapshot.uploadRelativePaths,
      destinationPathModes: snapshot.pathModes,
      destinationObjectKeyTemplates: snapshot.objectKeyTemplates,
      dayFolderId,
      uploadRelativePath,
      sourceType: 'local',
      profileId: snapshot.profileId,
      profileName: snapshot.profileName,
      profileSnapshot: snapshot.profileSnapshot,
      groupVariables
    })
  }

  private pendingTargetSnapshot(
    providers: CloudProvider[],
    context: UploadPathResolveContext,
    profile: AppSettings['profiles'][number]
  ): {
    uploadTargetMode: UploadTargetMode
    destinationPrefixes: Record<CloudProvider, string>
    destinationUploadRelativePaths: Partial<Record<CloudProvider, string>>
    uploadRelativePath: string
    mode: UploadTargetMode
    prefixes: Record<CloudProvider, string>
    uploadRelativePaths: Partial<Record<CloudProvider, string>>
    profileId: string
    profileName: string
    profileSnapshot: AppSettings['profiles'][number]
    pathModes: Partial<Record<CloudProvider, UploadPathMode>>
    objectKeyTemplates: Partial<Record<CloudProvider, string | null>>
  } {
    const snapshot = resolveProfileUploadSnapshot(
      profile,
      context,
      providers,
    )
    return {
      uploadTargetMode: snapshot.mode,
      destinationPrefixes: snapshot.prefixes,
      destinationUploadRelativePaths: snapshot.uploadRelativePaths,
      uploadRelativePath: snapshot.uploadRelativePath,
      mode: snapshot.mode,
      prefixes: snapshot.prefixes,
      uploadRelativePaths: snapshot.uploadRelativePaths,
      profileId: snapshot.profileId,
      profileName: snapshot.profileName,
      profileSnapshot: snapshot.profileSnapshot,
      pathModes: snapshot.pathModes,
      objectKeyTemplates: snapshot.objectKeyTemplates
    }
  }

  private legacySnapshotForPendingDir(
    pending: PendingDir,
    settings: AppSettings
  ): UploadTargetSnapshot {
    const snapshot = getUploadTargetSnapshot(settings)
    return {
      ...snapshot,
      uploadRelativePath: pending.uploadRelativePath,
      uploadRelativePaths: this.legacyDestinationUploadRelativePaths(
        snapshot.mode,
        pending.uploadRelativePath
      )
    }
  }

  private attachTaskToDayFolder(
    task: Task,
    dayFolderId: string
  ): void {
    if (task.dayFolderId !== dayFolderId) {
      getTaskRepo().updateDayFolderId(task.id, dayFolderId)
    }
  }

  private legacyDestinationUploadRelativePaths(
    mode: UploadTargetMode | undefined,
    uploadRelativePath: string | undefined
  ): Partial<Record<CloudProvider, string>> {
    if (uploadRelativePath === undefined) return {}
    const paths: Partial<Record<CloudProvider, string>> = {}
    for (const provider of providersForMode(mode || 'aliyun')) {
      paths[provider] = uploadRelativePath
    }
    return paths
  }

  private collectDataInfo(dirPath: string): void {
    const settings = getSettingsRepo()
    const dataCollectConfig = settings.get<DataCollectConfig>('dataCollect')
    if (!dataCollectConfig?.enabled) return

    try {
      const info = getDataCollectService().collectDataInfo(dirPath)
      if (info) {
        for (const win of BrowserWindow?.getAllWindows?.() ?? []) {
          win.webContents.send(IPC.DATA_COLLECT_RESULT, info)
        }
      }
    } catch (err) {
      log.warn('数采分析失败:', dirPath, err)
    }
  }

  private broadcastStatus(): void {
    const status = this.getStatus()
    for (const win of BrowserWindow?.getAllWindows?.() ?? []) {
      win.webContents.send(IPC.SCANNER_EVENT, status)
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  private async yieldToEventLoop(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

let instance: ScannerService | null = null
export function getScannerService(): ScannerService {
  if (!instance) instance = new ScannerService()
  return instance
}
