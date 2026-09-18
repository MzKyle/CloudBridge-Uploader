import { existsSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'
import { BrowserWindow } from 'electron'
import log from 'electron-log'
import { IPC } from '@shared/ipc-channels'
import { isDateFolderName } from '@shared/legacy-date-folder'
import { joinOssPath } from '@shared/upload-path'
import { getRuleSourceDirectories } from '@shared/scan-config'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { renderPathMapping } from '@shared/path-mapping'
import { getTaskRepo } from '../db/task.repo'
import {
  getTaskDestinationRepo,
  type FileDestinationUploadTarget
} from '../db/task-destination.repo'
import { getSettingsRepo } from '../db/settings.repo'
import { getCloudUploadService } from './cloud-upload.service'
import { getCloudConnectionStore } from './cloud-connection-store.service'
import type { CloudTaskUploader } from './cloud-upload.types'
import { FileFilterService } from './file-filter.service'
import { SpeedCalculator } from '../utils/speed-calculator'
import { getUploadSemaphore } from '../utils/upload-semaphore'
import type {
  PathMappingConfig,
  Task,
  TaskProgress,
  TaskStatus
} from '@shared/types'

interface UploadPipelineResult {
  uploadRootPath: string
  files: Array<{
    relativePath: string
    fileSize: number
    mtimeMs: number
    plannedObjectKey?: string
  }>
  requiredStableChecks: number
}

interface DestinationRuntime {
  connectionId: string
  connectionName: string | null
  uploader: CloudTaskUploader
  speed: SpeedCalculator
  uploadedFiles: number
  uploadedBytes: number
  totalFiles: number
  totalBytes: number
  queuedFiles: number
  failedFiles: number
  skippedFiles: number
  activeUploads: Map<string, number>
  transferredBytes: number
  lastBroadcastAt: number
  lastProgressPersistAt: number
  activeBytes: number
}

interface LogicalProgress {
  completedThisRun: Set<string>
  uploadedFiles: number
  uploadedBytes: number
  lastPersistAt: number
}

interface ObjectKeyBaseContext {
  sourcePath: string
  basePath?: string
  variables: Record<string, string>
  rulePathMapping?: PathMappingConfig
}

const RETRY_DELAYS_MS = [1000, 2000, 5000, 15000, 30000]
const PROGRESS_PERSIST_INTERVAL_MS = 1000

export class TaskRunnerService {
  async run(task: Task, signal?: AbortSignal): Promise<TaskStatus> {
    const taskRepo = getTaskRepo()
    const destinationRepo = getTaskDestinationRepo()
    const settings = getSettingsRepo().getAll()
    const stableChecks =
      task.sourceType === 'local' && task.uploadGroupId
        ? Math.max(2, settings.stability.checkCount || 2)
        : 1

    if (!existsSync(task.folderPath)) {
      destinationRepo.updateIncompleteStatuses(
        task.id,
        'skipped',
        '源目录已删除'
      )
      return 'skipped'
    }

    const uploadPlan = await this.prepareUploadPlan(task, stableChecks)
    const uploadRootPath = uploadPlan.uploadRootPath
    if (!existsSync(uploadRootPath)) {
      throw new Error('上传工作目录不存在')
    }

    const requiredStableChecks = uploadPlan.requiredStableChecks
    await this.reconcileBeforeUpload(
      task,
      requiredStableChecks,
      uploadPlan
    )
    const destinations = destinationRepo.listByTask(task.id)
    if (destinations.length === 0) {
      throw new Error('任务没有配置任何上传目标')
    }
    const destinationByConnectionId = new Map(
      destinations.map((destination) => [destination.connectionId, destination])
    )
    const connectionStore = getCloudConnectionStore()
    const objectKeyBaseContext = this.buildObjectKeyBaseContext(task)

    const jobs = destinationRepo.listReadyFileTargets(
      task.id,
      requiredStableChecks
    )
    if (jobs.length === 0) {
      taskRepo.recalculateProgress(task.id)
      return this.updateDestinationFinalStates(task)
    }
    this.assertNoDuplicateObjectKeys(
      destinationByConnectionId,
      jobs,
      objectKeyBaseContext
    )
    const jobConnectionIds = new Set(jobs.map((job) => job.connectionId))
    for (const destination of destinations) {
      if (!jobConnectionIds.has(destination.connectionId)) continue
      const connection = connectionStore.resolve(destination.connectionId)
      const error = getCloudUploadService().validateConnection(connection)
      if (error) throw new Error(error)
    }
    const initialLogicalSummary = taskRepo.summarizeFiles(task.id)
    const logicalProgress: LogicalProgress = {
      completedThisRun: new Set(),
      uploadedFiles: initialLogicalSummary.completedFiles,
      uploadedBytes: initialLogicalSummary.completedBytes,
      lastPersistAt: 0
    }

    const connectionIds = Array.from(jobConnectionIds)
    const runtimes = new Map<string, DestinationRuntime>()
    try {
      for (const connectionId of connectionIds) {
        const destination = destinationByConnectionId.get(connectionId)
        if (!destination) continue
        const connection = connectionStore.resolve(destination.connectionId)
        const uploader = await getCloudUploadService().createTaskUploader(
          connection,
          settings.upload.multipartThreshold
        )
        const destinationSummary = destinationRepo.summarizeFileTargets(
          task.id,
          connectionId
        )
        runtimes.set(connectionId, {
          connectionId,
          connectionName: destination.connectionName,
          uploader,
          speed: new SpeedCalculator(),
          uploadedFiles: destinationSummary.uploaded,
          uploadedBytes: destinationSummary.uploadedBytes,
          totalFiles: destinationSummary.total,
          totalBytes: destinationSummary.totalBytes,
          queuedFiles: destinationSummary.pending,
          failedFiles: destinationSummary.failed,
          skippedFiles: destinationSummary.skipped,
          activeUploads: new Map(),
          activeBytes: 0,
          transferredBytes: 0,
          lastBroadcastAt: 0,
          lastProgressPersistAt: 0
        })
        destinationRepo.updateStatus(task.id, connectionId, 'uploading')
        this.broadcastDestinationStatus(task.id, destination, 'uploading')
      }
    } catch (error) {
      for (const runtime of runtimes.values()) runtime.uploader.dispose()
      throw error
    }

    const abortUploaders = (): void => {
      for (const runtime of runtimes.values()) runtime.uploader.abort()
    }
    signal?.addEventListener('abort', abortUploaders, { once: true })

    const maxConcurrentUploads =
      settings.upload.maxConcurrentUploads ||
      DEFAULT_SETTINGS.upload.maxConcurrentUploads
    const multipartThreshold =
      settings.upload.multipartThreshold ||
      DEFAULT_SETTINGS.upload.multipartThreshold
    const semaphore = getUploadSemaphore(maxConcurrentUploads)
    let nextIndex = 0
    const workerCount = Math.max(
      1,
      Math.min(settings.upload.maxFilesPerTask || 12, jobs.length)
    )

    const runNext = async (): Promise<void> => {
      while (nextIndex < jobs.length && !signal?.aborted) {
        const target = jobs[nextIndex++]
        await this.uploadTarget(
          task,
          target,
          runtimes,
          semaphore,
          logicalProgress,
          destinationByConnectionId,
          objectKeyBaseContext,
          uploadRootPath,
          multipartThreshold,
          signal
        )
      }
    }

    try {
      await Promise.all(
        Array.from({ length: workerCount }, () => runNext())
      )
    } finally {
      signal?.removeEventListener('abort', abortUploaders)
      this.persistLogicalProgress(task.id, logicalProgress, true)
      for (const [connectionId, runtime] of runtimes) {
        this.persistDestinationProgress(task.id, connectionId, runtime, true)
      }
      for (const runtime of runtimes.values()) runtime.uploader.dispose()
    }

    if (signal?.aborted) {
      return getTaskRepo().getById(task.id)?.status || 'paused'
    }

    taskRepo.recalculateProgress(task.id)
    const finalStatus = this.updateDestinationFinalStates(task)
    return finalStatus
  }

  private async prepareUploadPlan(task: Task, stableChecks: number): Promise<UploadPipelineResult> {
    const settings = getSettingsRepo().getAll()
    const fileFilter = new FileFilterService(
      task.ruleSnapshot?.filter || settings.filter
    )
    const files: UploadPipelineResult['files'] = []
    for await (const batch of fileFilter.scanFolderBatches(task.folderPath)) {
      for (const file of batch) {
        files.push({
          relativePath: file.relativePath,
          fileSize: file.size,
          mtimeMs: file.mtimeMs
        })
      }
    }
    return {
      uploadRootPath: task.folderPath,
      files,
      requiredStableChecks: stableChecks
    }
  }

  private async reconcileBeforeUpload(
    task: Task,
    stableChecks: number,
    uploadPlan: UploadPipelineResult
  ): Promise<void> {
    const files =
      uploadPlan.files.map((file) => ({
        relativePath: file.relativePath,
        size: file.fileSize,
        mtimeMs: file.mtimeMs,
        plannedObjectKey: file.plannedObjectKey
      }))
    getTaskRepo().reconcileFiles(
      task.id,
      files,
      stableChecks,
      { replacePlannedObjectKeys: true }
    )
  }

  private assertNoDuplicateObjectKeys(
    destinationByConnectionId: Map<string, Task['destinations'][number]>,
    jobs: FileDestinationUploadTarget[],
    objectKeyBaseContext: ObjectKeyBaseContext
  ): void {
    const keysByConnection = new Map<string, Map<string, string>>()
    for (const target of jobs) {
      const destination = destinationByConnectionId.get(target.connectionId)
      if (!destination) continue
      const objectKey = this.renderTaskObjectKey(
        destination,
        target.relativePath,
        target.plannedObjectKey,
        objectKeyBaseContext
      )
      const connectionKeys = keysByConnection.get(target.connectionId) || new Map()
      const existing = connectionKeys.get(objectKey)
      if (existing && existing !== target.relativePath) {
        throw new Error(
          `${target.connectionId} 对象 Key 重复: ${objectKey} (${existing}, ${target.relativePath})`
        )
      }
      connectionKeys.set(objectKey, target.relativePath)
      keysByConnection.set(target.connectionId, connectionKeys)
    }
  }

  private renderTaskObjectKey(
    destination: Task['destinations'][number],
    relativePath: string,
    plannedObjectKey: string | null | undefined,
    objectKeyBaseContext: ObjectKeyBaseContext
  ): string {
    if (plannedObjectKey) return plannedObjectKey
    const mapping = objectKeyBaseContext.rulePathMapping || { mode: 'keep-relative' as const }
    const mappedPath = renderPathMapping(
      mapping,
      {
        sourcePath: objectKeyBaseContext.sourcePath,
        relativePath,
        variables: objectKeyBaseContext.variables
      }
    )
    return joinOssPath(destination.prefix, mappedPath)
  }

  private buildObjectKeyBaseContext(task: Task): ObjectKeyBaseContext {
    const groupVariables = task.groupVariables || {}
    const variables = Object.keys(groupVariables).length > 0
      ? groupVariables
      : this.deriveLegacyVariables(task.folderPath)
    return {
      sourcePath: task.folderPath,
      basePath: this.findRuleBasePath(task),
      variables,
      rulePathMapping: task.ruleSnapshot?.pathMapping
    }
  }

  private deriveLegacyVariables(folderPath: string): Record<string, string> {
    const workDirName = basename(folderPath)
    const dateName = basename(dirname(folderPath))
    return isDateFolderName(dateName)
      ? { date: dateName, session: workDirName, workDir: workDirName }
      : { session: workDirName, workDir: workDirName }
  }

  private findRuleBasePath(task: Task): string | undefined {
    const rule = task.ruleSnapshot
    if (!rule) return undefined
    for (const directory of getRuleSourceDirectories(rule)) {
      if (
        task.folderPath === directory ||
        task.folderPath.startsWith(`${directory}/`) ||
        task.folderPath.startsWith(`${directory}\\`)
      ) {
        return directory
      }
    }
    return undefined
  }

  private async uploadTarget(
    task: Task,
    target: FileDestinationUploadTarget,
    runtimes: Map<string, DestinationRuntime>,
    semaphore: ReturnType<typeof getUploadSemaphore>,
    logicalProgress: LogicalProgress,
    destinationByConnectionId: Map<string, Task['destinations'][number]>,
    objectKeyBaseContext: ObjectKeyBaseContext,
    uploadRootPath: string,
    multipartThreshold: number,
    signal?: AbortSignal
  ): Promise<void> {
    const taskRepo = getTaskRepo()
    const destinationRepo = getTaskDestinationRepo()
    const runtime = runtimes.get(target.connectionId)
    const destination = destinationByConnectionId.get(target.connectionId)
    if (!runtime || !destination) return

    const localPath = join(uploadRootPath, target.relativePath)
    if (!existsSync(localPath)) {
      destinationRepo.updateFileStatus(
        target.id,
        'skipped',
        undefined,
        undefined,
        '源文件已删除'
      )
      destinationRepo.recalculateLogicalFile(target.taskFileId)
      runtime.skippedFiles++
      runtime.queuedFiles = Math.max(0, runtime.queuedFiles - 1)
      this.persistDestinationProgress(task.id, target.connectionId, runtime)
      this.broadcastProgress(task.id, runtime, null, true)
      return
    }

    let acquired = false
    const uploadWeight = this.getUploadSlotWeight(
      target.fileSize,
      multipartThreshold,
      semaphore.getMax()
    )
    try {
      await semaphore.acquire(signal, uploadWeight)
      acquired = true
      if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError')

      const before = statSync(localPath)
      if (
        before.size !== target.fileSize ||
        before.mtimeMs !== target.mtimeMs
      ) {
        taskRepo.markFileChanged(
          target.taskFileId,
          before.size,
          before.mtimeMs
        )
        log.info('文件在进入上传前发生变化，等待重新稳定:', localPath)
        return
      }
      destinationRepo.updateFileStatus(target.id, 'uploading')
      runtime.activeUploads.set(target.id, 0)
      runtime.queuedFiles = Math.max(0, runtime.queuedFiles - 1)
      this.broadcastProgress(
        task.id,
        runtime,
        target.relativePath,
        true
      )

      const objectKey = this.renderTaskObjectKey(
        destination,
        target.relativePath,
        target.plannedObjectKey,
        objectKeyBaseContext
      )
      let previousLoaded = 0
      const result = await runtime.uploader.uploadFile(
        localPath,
        objectKey,
        target.fileSize,
        (fraction) => {
          const loaded = Math.min(
            target.fileSize,
            Math.max(0, Math.round(target.fileSize * fraction))
          )
          const delta = Math.max(0, loaded - previousLoaded)
          previousLoaded = loaded
          runtime.transferredBytes += delta
          runtime.activeBytes +=
            loaded - (runtime.activeUploads.get(target.id) || 0)
          runtime.activeUploads.set(target.id, loaded)
          runtime.speed.addSample(runtime.transferredBytes)
          this.broadcastProgress(
            task.id,
            runtime,
            target.relativePath
          )
        },
        signal
      )

      if (existsSync(localPath)) {
        const after = statSync(localPath)
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs
        ) {
          taskRepo.markFileChanged(target.taskFileId, after.size, after.mtimeMs)
          log.info('文件上传期间发生变化，重新排队:', localPath)
          return
        }
      }

      destinationRepo.updateFileStatus(
        target.id,
        'completed',
        result.objectKey,
        result.uploadId
      )
      const logicalStatus = destinationRepo.recalculateLogicalFile(
        target.taskFileId
      )
      if (logicalStatus === 'completed') {
        taskRepo.clearRetry(target.taskFileId)
        if (!logicalProgress.completedThisRun.has(target.taskFileId)) {
          logicalProgress.completedThisRun.add(target.taskFileId)
          logicalProgress.uploadedFiles++
          logicalProgress.uploadedBytes += target.fileSize
          this.persistLogicalProgress(task.id, logicalProgress)
        }
      }
      runtime.uploadedFiles++
      runtime.uploadedBytes += target.fileSize
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (taskRepo.getById(task.id)?.status !== 'skipped') {
          destinationRepo.updateFileStatus(target.id, 'pending')
        }
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      if (
        this.isRetriableUploadError(error) &&
        target.retryCount < RETRY_DELAYS_MS.length
      ) {
        const delay = this.retryDelay(target.retryCount)
        const nextRetryAt = new Date(Date.now() + delay).toISOString()
        const retryCount = taskRepo.scheduleRetry(
          target.taskFileId,
          message,
          nextRetryAt
        )
        destinationRepo.updateFileStatus(
          target.id,
          'pending',
          undefined,
          undefined,
          `第 ${retryCount} 次重试等待中: ${message}`
        )
        log.warn(
          `任务 ${task.id} [${target.connectionId}] 将在 ${delay}ms 后重试: ${target.relativePath}`
        )
      } else {
        destinationRepo.updateFileStatus(
          target.id,
          'failed',
          undefined,
          undefined,
          message
        )
        destinationRepo.recalculateLogicalFile(target.taskFileId)
        runtime.failedFiles++
        log.error(
          `上传失败 [${target.connectionId}] ${target.relativePath}:`,
          message
        )
      }
    } finally {
      runtime.activeBytes = Math.max(
        0,
        runtime.activeBytes - (runtime.activeUploads.get(target.id) || 0)
      )
      runtime.activeUploads.delete(target.id)
      if (acquired) semaphore.release(uploadWeight)
      this.persistDestinationProgress(task.id, target.connectionId, runtime)
      this.broadcastProgress(task.id, runtime, null, true)
    }
  }

  private getUploadSlotWeight(
    fileSize: number,
    multipartThreshold: number,
    maxConcurrentUploads: number
  ): number {
    if (fileSize <= multipartThreshold) return 1
    return Math.max(1, Math.min(4, Math.floor(maxConcurrentUploads || 1)))
  }

  private persistDestinationProgress(
    taskId: string,
    connectionId: string,
    runtime: DestinationRuntime,
    force = false
  ): void {
    const now = Date.now()
    if (
      !force &&
      now - runtime.lastProgressPersistAt < PROGRESS_PERSIST_INTERVAL_MS
    ) {
      return
    }
    getTaskDestinationRepo().updateProgress(
      taskId,
      connectionId,
      runtime.uploadedFiles,
      runtime.uploadedBytes
    )
    runtime.lastProgressPersistAt = now
  }

  private persistLogicalProgress(
    taskId: string,
    logicalProgress: LogicalProgress,
    force = false
  ): void {
    const now = Date.now()
    if (
      !force &&
      now - logicalProgress.lastPersistAt < PROGRESS_PERSIST_INTERVAL_MS
    ) {
      return
    }
    getTaskRepo().updateProgress(
      taskId,
      logicalProgress.uploadedFiles,
      logicalProgress.uploadedBytes
    )
    logicalProgress.lastPersistAt = now
  }

  private updateDestinationFinalStates(task: Task): TaskStatus {
    const repo = getTaskDestinationRepo()
    let taskStatus: TaskStatus =
      task.sourceType === 'local' && task.uploadGroupId ? 'synced' : 'completed'

    for (const destination of repo.listByTask(task.id)) {
      const summary = repo.summarizeFileTargets(task.id, destination.connectionId)

      if (summary.failed > 0) {
        const examples = repo.listFailedFileTargetExamples(
          task.id,
          destination.connectionId
        )
        const message = `${summary.failed} 个文件上传失败，例如 ${examples
          .map(
            (example) =>
              `${example.relativePath}: ${example.errorMessage || 'unknown error'}`
          )
          .join(' | ')}`
        repo.updateStatus(task.id, destination.connectionId, 'failed', message)
        this.broadcastDestinationStatus(
          task.id,
          destination,
          'failed',
          message
        )
        taskStatus = 'failed'
      } else if (summary.pending > 0) {
        repo.updateStatus(
          task.id,
          destination.connectionId,
          'retrying',
          `${summary.pending} 个文件等待自动重试或稳定`
        )
        this.broadcastDestinationStatus(
          task.id,
          destination,
          'retrying',
          `${summary.pending} 个文件等待自动重试或稳定`
        )
        if (taskStatus !== 'failed') taskStatus = 'retrying'
      } else {
        const status: TaskStatus =
          task.sourceType === 'local' && task.uploadGroupId
            ? 'synced'
            : 'completed'
        repo.updateStatus(
          task.id,
          destination.connectionId,
          status,
          summary.skipped > 0 ? `${summary.skipped} 个源文件已跳过` : undefined
        )
        this.broadcastDestinationStatus(
          task.id,
          destination,
          status,
          summary.skipped > 0 ? `${summary.skipped} 个源文件已跳过` : undefined
        )
      }
      repo.setTotals(
        task.id,
        destination.connectionId,
        summary.total,
        summary.totalBytes
      )
      repo.updateProgress(
        task.id,
        destination.connectionId,
        summary.uploaded,
        summary.uploadedBytes
      )
    }

    return taskStatus
  }

  private broadcastProgress(
    taskId: string,
    runtime: DestinationRuntime,
    currentFile: string | null,
    force = false
  ): void {
    const now = Date.now()
    if (!force && now - runtime.lastBroadcastAt < 250) return
    runtime.lastBroadcastAt = now
    const progress: TaskProgress = {
      taskId,
      connectionId: runtime.connectionId,
      connectionName: runtime.connectionName,
      uploadedFiles: runtime.uploadedFiles,
      totalFiles: runtime.totalFiles,
      uploadedBytes: Math.min(
        runtime.totalBytes,
        runtime.uploadedBytes + runtime.activeBytes
      ),
      totalBytes: runtime.totalBytes,
      speed: runtime.speed.getSpeed(),
      currentFile,
      queuedFiles: runtime.queuedFiles,
      activeUploads: runtime.activeUploads.size,
      failedFiles: runtime.failedFiles,
      skippedFiles: runtime.skippedFiles,
      transferredBytes: runtime.transferredBytes
    }
    for (const win of BrowserWindow?.getAllWindows?.() ?? []) {
      win.webContents.send(IPC.TASK_PROGRESS, progress)
    }
  }

  private broadcastDestinationStatus(
    taskId: string,
    destination: Task['destinations'][number],
    status: TaskStatus,
    errorMessage?: string
  ): void {
    for (const win of BrowserWindow?.getAllWindows?.() ?? []) {
      win.webContents.send(IPC.TASK_DESTINATION_CHANGE, {
        taskId,
        connectionId: destination.connectionId,
        connectionName: destination.connectionName,
        status,
        errorMessage
      })
    }
  }

  private retryDelay(retryCount: number): number {
    const base =
      RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)]
    const jitter = 0.8 + Math.random() * 0.4
    return Math.round(base * jitter)
  }

  private isRetriableUploadError(errorValue: unknown): boolean {
    const error = errorValue as {
      code?: string
      status?: number
      name?: string
      message?: string
      $metadata?: { httpStatusCode?: number }
    }
    const status = error.status || error.$metadata?.httpStatusCode
    if (typeof status === 'number' && (status === 429 || status >= 500)) {
      return true
    }
    const transientCodes = new Set([
      'ECONNRESET',
      'ETIMEDOUT',
      'ESOCKETTIMEDOUT',
      'EAI_AGAIN',
      'ENOTFOUND',
      'EPIPE',
      'ECONNREFUSED'
    ])
    if (error.code && transientCodes.has(error.code)) return true
    const text = `${error.name || ''} ${error.message || ''}`.toLowerCase()
    return (
      text.includes('timeout') ||
      text.includes('temporarily unavailable') ||
      text.includes('socket hang up')
    )
  }
}

let instance: TaskRunnerService | null = null
export function getTaskRunnerService(): TaskRunnerService {
  if (!instance) instance = new TaskRunnerService()
  return instance
}
