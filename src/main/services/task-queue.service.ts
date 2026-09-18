import { EventEmitter } from 'events'
import log from 'electron-log'
import { getTaskRepo } from '../db/task.repo'
import { getSettingsRepo } from '../db/settings.repo'
import { getCleanupService } from './cleanup.service'
import { getUploadGroupService } from './upload-group.service'
import { getTaskDestinationRepo } from '../db/task-destination.repo'
import type {
  Task,
  TaskStatus,
  UploadConfig,
  UploadQueueStartInput,
  UploadQueueStatus,
  UploadQueueStopInput
} from '@shared/types'

/**
 * 任务队列服务
 * - 维护有限并发的任务执行池
 * - 状态机管理：pending → scanning → uploading → completed / failed
 */
export class TaskQueueService extends EventEmitter {
  private runningTasks: Map<string, { cancel: () => void }> = new Map()
  private processTimer: ReturnType<typeof setInterval> | null = null
  private initialProcessTimer: ReturnType<typeof setTimeout> | null = null
  private uploadGateOpen = false
  private priorityTaskIds = new Set<string>()
  private priorityActive = false
  private priorityOverrideWindow = false
  private taskRunner:
    | ((task: Task, signal: AbortSignal) => Promise<TaskStatus>)
    | null = null

  setTaskRunner(
    runner: (task: Task, signal: AbortSignal) => Promise<TaskStatus>
  ): void {
    this.taskRunner = runner
  }

  start(): void {
    if (this.processTimer) return
    // 每 2 秒检查一次队列
    this.processTimer = setInterval(() => void this.processQueue(), 2000)
    // 让主窗口先完成绘制，再恢复上传任务。
    this.initialProcessTimer = setTimeout(() => {
      this.initialProcessTimer = null
      void this.processQueue()
    }, 1500)
    log.info('任务队列已启动')
  }

  stop(): void {
    if (this.initialProcessTimer) {
      clearTimeout(this.initialProcessTimer)
      this.initialProcessTimer = null
    }
    if (this.processTimer) {
      clearInterval(this.processTimer)
      this.processTimer = null
    }
    log.info('任务队列已停止')
  }

  getStatus(): UploadQueueStatus {
    const uploadConfig = getSettingsRepo().get<UploadConfig>('upload')
    this.syncPriorityState(false)
    return {
      gateOpen: this.uploadGateOpen,
      priorityActive: this.priorityActive,
      priorityTaskIds: Array.from(this.priorityTaskIds),
      priorityRemaining: this.priorityTaskIds.size,
      runningTaskIds: Array.from(this.runningTasks.keys()),
      overrideWindow: this.priorityOverrideWindow,
      withinUploadWindow: this.isWithinUploadWindow(
        uploadConfig?.startAfterTime,
        uploadConfig?.endBeforeTime
      ),
      uploadWindow: {
        startAfterTime: uploadConfig?.startAfterTime ?? null,
        endBeforeTime: uploadConfig?.endBeforeTime ?? null
      }
    }
  }

  startUploading(input: UploadQueueStartInput): UploadQueueStatus {
    const taskRepo = getTaskRepo()
    const taskIds = this.resolveStartTaskIds(input)
    taskRepo.resumeManyForUpload(taskIds)

    this.uploadGateOpen = true
    this.priorityTaskIds = new Set(taskIds)
    this.priorityActive = this.priorityTaskIds.size > 0
    this.priorityOverrideWindow =
      Boolean(input.overrideWindow) && this.priorityActive
    this.syncPriorityState(false)
    this.emitQueueStatus()
    void this.processQueue()
    log.info(
      `上传队列已放行，优先任务 ${this.priorityTaskIds.size} 个，` +
        `overrideWindow=${this.priorityOverrideWindow}`
    )
    return this.getStatus()
  }

  stopUploading(input: UploadQueueStopInput): UploadQueueStatus {
    this.uploadGateOpen = false
    this.priorityTaskIds.clear()
    this.priorityActive = false
    this.priorityOverrideWindow = false

    if (input.mode === 'pause-running') {
      for (const taskId of Array.from(this.runningTasks.keys())) {
        this.pauseRunningTask(taskId)
      }
    }

    this.emitQueueStatus()
    log.info('上传队列已停止:', input.mode)
    return this.getStatus()
  }

  getRunningCount(): number {
    return this.runningTasks.size
  }

  isTaskRunning(taskId: string): boolean {
    return this.runningTasks.has(taskId)
  }

  cancelRunningTask(taskId: string): void {
    const running = this.runningTasks.get(taskId)
    if (running) {
      running.cancel()
      this.runningTasks.delete(taskId)
      this.emitQueueStatus()
    }
  }

  private async processQueue(): Promise<void> {
    if (!this.taskRunner) return
    if (!this.uploadGateOpen) return
    this.syncPriorityState()

    const settings = getSettingsRepo()
    const uploadConfig = settings.get<UploadConfig>('upload')
    const withinUploadWindow = this.isWithinUploadWindow(
      uploadConfig?.startAfterTime,
      uploadConfig?.endBeforeTime
    )
    const canOverrideWindow =
      this.priorityActive && this.priorityOverrideWindow
    if (!withinUploadWindow && !canOverrideWindow) return

    const maxConcurrent = uploadConfig?.maxConcurrentTasks || 4

    const taskRepo = getTaskRepo()
    const availableSlots = maxConcurrent - this.runningTasks.size
    if (availableSlots <= 0) return

    const pendingTasks = this.priorityActive
      ? taskRepo.listRunnable()
      : taskRepo.listRunnable(undefined, 1)
    const prioritizedTasks = this.priorityActive
      ? pendingTasks.filter((task) => this.priorityTaskIds.has(task.id))
      : pendingTasks
    const eligibleTasks = prioritizedTasks.filter((task) =>
      canOverrideWindow ||
      this.isTaskEligibleForCurrentStartCycle(
        task,
        uploadConfig?.startAfterTime
      )
    )
    // 每轮只启动一个新任务，避免多个大目录在主进程中同时做首次校准。
    const toRun = eligibleTasks.slice(0, Math.min(availableSlots, 1))

    for (const task of toRun) {
      this.executeTask(task)
    }
  }

  private async executeTask(task: Task): Promise<void> {
    const taskRepo = getTaskRepo()
    const controller = new AbortController()

    this.runningTasks.set(task.id, { cancel: () => controller.abort() })

    try {
      taskRepo.updateStatus(task.id, 'uploading')
      this.emitQueueStatus()
      this.emit('task:status-change', {
        taskId: task.id,
        oldStatus: task.status,
        newStatus: 'uploading'
      })

      const finalStatus = await this.taskRunner!(task, controller.signal)

      if (!controller.signal.aborted) {
        taskRepo.updateStatus(task.id, finalStatus)
        getUploadGroupService().refreshForTask(task.id)
        if (finalStatus === 'completed') {
          getCleanupService().scheduleCleanup()
        }
        this.emit('task:status-change', {
          taskId: task.id,
          oldStatus: 'uploading',
          newStatus: finalStatus
        })
        log.info(`任务状态更新为 ${finalStatus}:`, task.folderPath)
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const errMsg = err instanceof Error ? err.message : String(err)
        taskRepo.updateStatus(task.id, 'failed', errMsg)
        getTaskDestinationRepo().updateIncompleteStatuses(
          task.id,
          'failed',
          errMsg
        )
        getUploadGroupService().refreshForTask(task.id)
        this.emit('task:status-change', {
          taskId: task.id,
          oldStatus: 'uploading',
          newStatus: 'failed'
        })
        log.error('任务失败:', task.folderPath, errMsg)
      }
    } finally {
      this.runningTasks.delete(task.id)
      this.syncPriorityState()
      this.emitQueueStatus()
      void this.processQueue()
    }
  }

  private resolveStartTaskIds(input: UploadQueueStartInput): string[] {
    const taskRepo = getTaskRepo()
    if (input.scope === 'all-pending') {
      return taskRepo.listPendingUploadTaskIds()
    }

    const ids = new Set<string>()
    for (const taskId of input.taskIds || []) {
      if (taskId) ids.add(taskId)
    }
    const uploadGroupTaskIds = taskRepo.listPendingUploadTaskIdsByUploadGroupIds(
      input.uploadGroupIds || []
    )
    for (const taskId of uploadGroupTaskIds) ids.add(taskId)
    return Array.from(ids)
  }

  private syncPriorityState(emit = true): void {
    if (!this.priorityActive && this.priorityTaskIds.size === 0) return

    let changed = false
    for (const taskId of Array.from(this.priorityTaskIds)) {
      const task = getTaskRepo().getById(taskId)
      if (!task || this.isPriorityTerminalStatus(task.status)) {
        this.priorityTaskIds.delete(taskId)
        changed = true
      }
    }

    if (this.priorityTaskIds.size === 0 && this.priorityActive) {
      this.priorityActive = false
      this.priorityOverrideWindow = false
      changed = true
    }

    if (changed && emit) this.emitQueueStatus()
  }

  private pauseRunningTask(taskId: string): void {
    const running = this.runningTasks.get(taskId)
    if (!running) return
    running.cancel()
    this.runningTasks.delete(taskId)
    getTaskRepo().updateStatus(taskId, 'paused')
    getTaskDestinationRepo().updateIncompleteStatuses(taskId, 'paused')
    getUploadGroupService().refreshForTask(taskId)
    this.emit('task:status-change', {
      taskId,
      oldStatus: 'uploading',
      newStatus: 'paused'
    })
  }

  private isPriorityTerminalStatus(status: TaskStatus): boolean {
    return (
      status === 'completed' ||
      status === 'synced' ||
      status === 'skipped' ||
      status === 'failed' ||
      status === 'paused'
    )
  }

  private emitQueueStatus(): void {
    this.emit('upload-queue:event', this.getStatus())
  }

  private isWithinUploadWindow(startAfterTime?: string | null, endBeforeTime?: string | null): boolean {
    const startMinutes = this.parseMinutes(startAfterTime)
    const endMinutes = this.parseMinutes(endBeforeTime)
    const now = new Date()
    const currentMinutes = now.getHours() * 60 + now.getMinutes()

    // 开始/结束都不设置：随时可启动
    if (startMinutes === null && endMinutes === null) return true

    // 只设置开始时间：每天到达开始时间后可启动
    if (startMinutes !== null && endMinutes === null) {
      return currentMinutes >= startMinutes
    }

    // 只设置结束时间：每天在结束时间前可启动
    if (startMinutes === null && endMinutes !== null) {
      return currentMinutes <= endMinutes
    }

    if (startMinutes === null || endMinutes === null) return true

    // 开始时间 == 结束时间：视为全天可上传
    if (startMinutes === endMinutes) return true

    // 普通区间：例如 08:00 - 20:30
    if (startMinutes < endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes
    }

    // 跨午夜区间：例如 20:30 - 06:00
    return currentMinutes >= startMinutes || currentMinutes <= endMinutes
  }

  private parseMinutes(time: string | null | undefined): number | null {
    if (!time || !time.trim()) return null
    const match = time.match(/^(\d{1,2}):(\d{1,2})$/)
    if (!match) return null
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
    return hour * 60 + minute
  }

  private isTaskEligibleForCurrentStartCycle(task: Task, startAfterTime?: string | null): boolean {
    const startMinutes = this.parseMinutes(startAfterTime)
    if (startMinutes === null) return true

    const cycleStart = this.getCurrentStartCycleStart(startMinutes, new Date())
    const createdAtMs = new Date(task.createdAt).getTime()
    if (Number.isNaN(createdAtMs)) return true
    return createdAtMs <= cycleStart.getTime()
  }

  private getCurrentStartCycleStart(startMinutes: number, now: Date): Date {
    const todayStart = new Date(now)
    todayStart.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0)

    if (now.getTime() >= todayStart.getTime()) {
      return todayStart
    }

    const previousStart = new Date(todayStart)
    previousStart.setDate(previousStart.getDate() - 1)
    return previousStart
  }
}

let instance: TaskQueueService | null = null
export function getTaskQueueService(): TaskQueueService {
  if (!instance) instance = new TaskQueueService()
  return instance
}
