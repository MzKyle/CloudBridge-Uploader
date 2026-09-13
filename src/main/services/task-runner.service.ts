import { existsSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'
import { BrowserWindow } from 'electron'
import log from 'electron-log'
import { IPC } from '@shared/ipc-channels'
import { isDateFolderName } from '@shared/day-folder'
import { getProfileSourceDirectories } from '@shared/scan-config'
import { DEFAULT_SETTINGS } from '@shared/constants'
import {
  renderObjectKey,
  type ObjectKeyRenderContext
} from '@shared/upload-profile'
import { getTaskRepo } from '../db/task.repo'
import {
  getTaskDestinationRepo,
  type FileDestinationUploadTarget
} from '../db/task-destination.repo'
import { getSettingsRepo } from '../db/settings.repo'
import { getCloudUploadService } from './cloud-upload.service'
import type { CloudTaskUploader } from './cloud-upload.types'
import { getUploadPipelineRuntimeService } from './upload-pipeline-runtime.service'
import { writeProcessTask } from '../utils/marker-file'
import { SpeedCalculator } from '../utils/speed-calculator'
import { getUploadSemaphore } from '../utils/upload-semaphore'
import type {
  CloudProvider,
  ProcessTaskMarker,
  Task,
  UploadPipelineResult,
  TaskProgress,
  TaskStatus
} from '@shared/types'

interface ProviderRuntime {
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

type ObjectKeyBaseContext = Omit<ObjectKeyRenderContext, 'relativePath'>

const RETRY_DELAYS_MS = [1000, 2000, 5000, 15000, 30000]
const MARKER_WRITE_INTERVAL_MS = 5000
const PROGRESS_PERSIST_INTERVAL_MS = 1000

export class TaskRunnerService {
  async run(task: Task, signal?: AbortSignal): Promise<TaskStatus> {
    const taskRepo = getTaskRepo()
    const destinationRepo = getTaskDestinationRepo()
    const settings = getSettingsRepo().getAll()
    const stableChecks =
      task.sourceType === 'local' && task.dayFolderId
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

    const uploadPlan = await getUploadPipelineRuntimeService().prepareUploadPlan(
      task,
      stableChecks
    )
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
    const destinationByProvider = new Map(
      destinations.map((destination) => [destination.provider, destination])
    )
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
      destinationByProvider,
      jobs,
      objectKeyBaseContext
    )
    const jobProviders = new Set(jobs.map((job) => job.provider))
    for (const destination of destinations) {
      if (!jobProviders.has(destination.provider)) continue
      const error = getCloudUploadService().validateProvider(
        destination.provider,
        settings
      )
      if (error) throw new Error(error)
    }
    const initialLogicalSummary = taskRepo.summarizeFiles(task.id)
    const logicalProgress: LogicalProgress = {
      completedThisRun: new Set(),
      uploadedFiles: initialLogicalSummary.completedFiles,
      uploadedBytes: initialLogicalSummary.completedBytes,
      lastPersistAt: 0
    }

    const providers = Array.from(jobProviders)
    const runtimes = new Map<CloudProvider, ProviderRuntime>()
    try {
      for (const provider of providers) {
        const destination = destinationByProvider.get(provider)
        if (!destination) continue
        const uploader = await getCloudUploadService().createTaskUploader(
          provider,
          settings,
          settings.upload.multipartThreshold
        )
        const providerSummary = destinationRepo.summarizeFileTargets(
          task.id,
          provider
        )
        runtimes.set(provider, {
          uploader,
          speed: new SpeedCalculator(),
          uploadedFiles: providerSummary.uploaded,
          uploadedBytes: providerSummary.uploadedBytes,
          totalFiles: providerSummary.total,
          totalBytes: providerSummary.totalBytes,
          queuedFiles: providerSummary.pending,
          failedFiles: providerSummary.failed,
          skippedFiles: providerSummary.skipped,
          activeUploads: new Map(),
          activeBytes: 0,
          transferredBytes: 0,
          lastBroadcastAt: 0,
          lastProgressPersistAt: 0
        })
        destinationRepo.updateStatus(task.id, provider, 'uploading')
        this.broadcastDestinationStatus(task.id, provider, 'uploading')
      }
    } catch (error) {
      for (const runtime of runtimes.values()) runtime.uploader.dispose()
      throw error
    }

    const abortUploaders = (): void => {
      for (const runtime of runtimes.values()) runtime.uploader.abort()
    }
    signal?.addEventListener('abort', abortUploaders, { once: true })

    const markerDestinations = destinations.map((destination) =>
      jobProviders.has(destination.provider)
        ? { ...destination, status: 'uploading' as const }
        : destination
    )
    const marker = this.createCompactMarker(
      { ...task, status: 'uploading' },
      markerDestinations
    )
    this.writeMarker(task.folderPath, marker)
    const markerTimer = setInterval(() => {
      const currentTask = taskRepo.getById(task.id)
      if (!currentTask) return
      this.writeMarker(
        task.folderPath,
        this.createCompactMarker(currentTask, currentTask.destinations)
      )
    }, MARKER_WRITE_INTERVAL_MS)

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
          destinationByProvider,
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
      clearInterval(markerTimer)
      signal?.removeEventListener('abort', abortUploaders)
      this.persistLogicalProgress(task.id, logicalProgress, true)
      for (const [provider, runtime] of runtimes) {
        this.persistProviderProgress(task.id, provider, runtime, true)
      }
      for (const runtime of runtimes.values()) runtime.uploader.dispose()
    }

    if (signal?.aborted) {
      return getTaskRepo().getById(task.id)?.status || 'paused'
    }

    taskRepo.recalculateProgress(task.id)
    const finalStatus = this.updateDestinationFinalStates(task)
    const currentTask = taskRepo.getById(task.id) || task
    const finalTask = { ...currentTask, status: finalStatus }
    this.writeMarker(
      task.folderPath,
      this.createCompactMarker(finalTask, finalTask.destinations)
    )
    return finalStatus
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
    destinationByProvider: Map<CloudProvider, Task['destinations'][number]>,
    jobs: FileDestinationUploadTarget[],
    objectKeyBaseContext: ObjectKeyBaseContext
  ): void {
    const keysByProvider = new Map<CloudProvider, Map<string, string>>()
    for (const target of jobs) {
      const destination = destinationByProvider.get(target.provider)
      if (!destination) continue
      const objectKey = this.renderTaskObjectKey(
        destination,
        target.relativePath,
        target.plannedObjectKey,
        objectKeyBaseContext
      )
      const providerKeys = keysByProvider.get(target.provider) || new Map()
      const existing = providerKeys.get(objectKey)
      if (existing && existing !== target.relativePath) {
        throw new Error(
          `${target.provider} 对象 Key 重复: ${objectKey} (${existing}, ${target.relativePath})`
        )
      }
      providerKeys.set(objectKey, target.relativePath)
      keysByProvider.set(target.provider, providerKeys)
    }
  }

  private renderTaskObjectKey(
    destination: Task['destinations'][number],
    relativePath: string,
    plannedObjectKey: string | null | undefined,
    objectKeyBaseContext: ObjectKeyBaseContext
  ): string {
    if (plannedObjectKey) return plannedObjectKey
    return renderObjectKey(
      {
        provider: destination.provider,
        prefix: destination.prefix,
        uploadRelativePath: destination.uploadRelativePath,
        pathMode: destination.pathMode,
        objectKeyTemplate: destination.objectKeyTemplate
      },
      this.buildObjectKeyContext(objectKeyBaseContext, relativePath)
    )
  }

	  private buildObjectKeyBaseContext(task: Task): ObjectKeyBaseContext {
	    const groupVariables = task.groupVariables || {}
	    const variables = Object.keys(groupVariables).length > 0
	      ? groupVariables
	      : this.deriveLegacyVariables(task.folderPath)
    return {
      sourcePath: task.folderPath,
      basePath: this.findProfileBasePath(task),
      dateName: variables.date,
      workDirName: variables.workDir || variables.session || task.folderName,
      variables,
      folderName: task.folderName,
      profileId: task.profileId,
      profileName: task.profileName,
      createdAt: task.createdAt
    }
  }

  private buildObjectKeyContext(
    baseContext: ObjectKeyBaseContext,
    relativePath: string
  ): ObjectKeyRenderContext {
    return {
      ...baseContext,
      relativePath
    }
  }

  private deriveLegacyVariables(folderPath: string): Record<string, string> {
    const workDirName = basename(folderPath)
    const dateName = basename(dirname(folderPath))
    return isDateFolderName(dateName)
      ? { date: dateName, session: workDirName, workDir: workDirName }
      : { session: workDirName, workDir: workDirName }
  }

  private findProfileBasePath(task: Task): string | undefined {
    const profile = task.profileSnapshot
    if (!profile) return undefined
    for (const directory of getProfileSourceDirectories(profile)) {
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
    runtimes: Map<CloudProvider, ProviderRuntime>,
    semaphore: ReturnType<typeof getUploadSemaphore>,
    logicalProgress: LogicalProgress,
    destinationByProvider: Map<CloudProvider, Task['destinations'][number]>,
    objectKeyBaseContext: ObjectKeyBaseContext,
    uploadRootPath: string,
    multipartThreshold: number,
    signal?: AbortSignal
  ): Promise<void> {
    const taskRepo = getTaskRepo()
    const destinationRepo = getTaskDestinationRepo()
    const runtime = runtimes.get(target.provider)
    const destination = destinationByProvider.get(target.provider)
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
      this.persistProviderProgress(task.id, target.provider, runtime)
      this.broadcastProgress(task.id, target.provider, runtime, null, true)
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
        target.provider,
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
            target.provider,
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
          `任务 ${task.id} [${target.provider}] 将在 ${delay}ms 后重试: ${target.relativePath}`
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
          `上传失败 [${target.provider}] ${target.relativePath}:`,
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
      this.persistProviderProgress(task.id, target.provider, runtime)
      this.broadcastProgress(task.id, target.provider, runtime, null, true)
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

  private persistProviderProgress(
    taskId: string,
    provider: CloudProvider,
    runtime: ProviderRuntime,
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
      provider,
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
      task.sourceType === 'local' && task.dayFolderId ? 'synced' : 'completed'

    for (const destination of repo.listByTask(task.id)) {
      const summary = repo.summarizeFileTargets(task.id, destination.provider)

      if (summary.failed > 0) {
        const examples = repo.listFailedFileTargetExamples(
          task.id,
          destination.provider
        )
        const message = `${summary.failed} 个文件上传失败，例如 ${examples
          .map(
            (example) =>
              `${example.relativePath}: ${example.errorMessage || 'unknown error'}`
          )
          .join(' | ')}`
        repo.updateStatus(task.id, destination.provider, 'failed', message)
        this.broadcastDestinationStatus(
          task.id,
          destination.provider,
          'failed',
          message
        )
        taskStatus = 'failed'
      } else if (summary.pending > 0) {
        repo.updateStatus(
          task.id,
          destination.provider,
          'retrying',
          `${summary.pending} 个文件等待自动重试或稳定`
        )
        this.broadcastDestinationStatus(
          task.id,
          destination.provider,
          'retrying',
          `${summary.pending} 个文件等待自动重试或稳定`
        )
        if (taskStatus !== 'failed') taskStatus = 'retrying'
      } else {
        const status: TaskStatus =
          task.sourceType === 'local' && task.dayFolderId
            ? 'synced'
            : 'completed'
        repo.updateStatus(
          task.id,
          destination.provider,
          status,
          summary.skipped > 0 ? `${summary.skipped} 个源文件已跳过` : undefined
        )
        this.broadcastDestinationStatus(
          task.id,
          destination.provider,
          status,
          summary.skipped > 0 ? `${summary.skipped} 个源文件已跳过` : undefined
        )
      }
      repo.setTotals(
        task.id,
        destination.provider,
        summary.total,
        summary.totalBytes
      )
      repo.updateProgress(
        task.id,
        destination.provider,
        summary.uploaded,
        summary.uploadedBytes
      )
    }

    return taskStatus
  }

  private createCompactMarker(
    task: Task,
    destinations: Task['destinations']
  ): ProcessTaskMarker {
    const destinationRepo = getTaskDestinationRepo()
    const taskSummary = getTaskRepo().summarizeFiles(task.id)
    return {
      version: 3,
      taskId: task.id,
      status: task.status,
      totalFiles: taskSummary.totalFiles,
      uploadedFiles: taskSummary.completedFiles,
      failedFiles: taskSummary.failedFiles,
      skippedFiles: taskSummary.skippedFiles,
      lastUpdated: new Date().toISOString(),
      error:
        task.errorMessage ||
        destinations
          .map((destination) => destination.errorMessage)
          .filter(Boolean)
          .join(' || ') ||
        null,
      uploadTargetMode: task.uploadTargetMode,
      destinations: Object.fromEntries(
        destinations.map((destination) => {
          const summary = destinationRepo.summarizeFileTargets(
            task.id,
            destination.provider
          )
          return [
            destination.provider,
            {
              status: destination.status,
              uploadRelativePath: destination.uploadRelativePath,
              pathMode: destination.pathMode,
              objectKeyTemplate: destination.objectKeyTemplate,
              totalFiles: summary.total,
              uploadedFiles: summary.uploaded,
              failedFiles: summary.failed,
              skippedFiles: summary.skipped,
              error: destination.errorMessage
            }
          ]
        })
      )
    }
  }

  private broadcastProgress(
    taskId: string,
    provider: CloudProvider,
    runtime: ProviderRuntime,
    currentFile: string | null,
    force = false
  ): void {
    const now = Date.now()
    if (!force && now - runtime.lastBroadcastAt < 250) return
    runtime.lastBroadcastAt = now
    const progress: TaskProgress = {
      taskId,
      provider,
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

  private writeMarker(folderPath: string, marker: ProcessTaskMarker): void {
    if (!existsSync(folderPath)) return
    try {
      writeProcessTask(folderPath, marker)
    } catch (error) {
      log.warn('写入任务汇总标记失败:', folderPath, error)
    }
  }

  private broadcastDestinationStatus(
    taskId: string,
    provider: CloudProvider,
    status: TaskStatus,
    errorMessage?: string
  ): void {
    for (const win of BrowserWindow?.getAllWindows?.() ?? []) {
      win.webContents.send(IPC.TASK_DESTINATION_CHANGE, {
        taskId,
        provider,
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
