import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import log from 'electron-log'
import { getTaskRepo } from '../db/task.repo'
import { getDayFolderRepo } from '../db/day-folder.repo'
import { getSettingsRepo } from '../db/settings.repo'
import { getTaskDestinationRepo } from '../db/task-destination.repo'
import { getDayFolderService } from './day-folder.service'
import { FileFilterService } from './file-filter.service'
import { resolveCleanupPolicyForGroup } from './upload-group-policy'
import { assertSafeCleanupPath } from '../utils/cleanup-path-safety'
import type { CleanupConfig, Task } from '@shared/types'

/**
 * 自动清理服务
 * 定期删除已完成上传的本地文件夹，释放磁盘空间
 * 仅清理自动扫描的本地归档组和独立 local 任务
 * 手动添加的文件夹（sourceType='manual'）不参与清理
 */
export class CleanupService {
  private timer: ReturnType<typeof setInterval> | null = null
  private pendingRun: ReturnType<typeof setTimeout> | null = null
  private running = false

  start(): void {
    if (this.timer) return
    // 避免应用刚启动、任务恢复和目录扫描期间同时进行大量删除。
    this.scheduleCleanup(5 * 60 * 1000)
    this.timer = setInterval(() => void this.cleanup(), 3600000)
    log.info('自动清理服务已启动')
  }

  stop(): void {
    if (this.pendingRun) {
      clearTimeout(this.pendingRun)
      this.pendingRun = null
    }
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    log.info('自动清理服务已停止')
  }

  scheduleCleanup(delayMs = 0): void {
    if (this.pendingRun) {
      clearTimeout(this.pendingRun)
    }

    this.pendingRun = setTimeout(() => {
      this.pendingRun = null
      void this.cleanup()
    }, Math.max(0, delayMs))
  }

  async cleanup(): Promise<void> {
    if (this.running) return
    this.running = true

    try {
      const settings = getSettingsRepo()
      const config = settings.getAll().cleanup

      const retentionDays = this.normalizeRetentionDays(config)
      const taskRepo = getTaskRepo()
      const dayFolderRepo = getDayFolderRepo()
      const tasks = config.enabled
        ? taskRepo.getCompletedForCleanup(retentionDays)
        : []
      const dayFolders = dayFolderRepo.listCleanupCandidates()

      if (tasks.length === 0 && dayFolders.length === 0) return

      log.info(
        `自动清理: 发现 ${dayFolders.length} 个归档组、${tasks.length} 个独立任务可清理 ` +
          `(保留天数: ${retentionDays})`
      )

      let cleaned = 0
      for (const dayFolder of dayFolders) {
        try {
          const resolved = resolveCleanupPolicyForGroup(dayFolder)
          if (!resolved.policy.enabled) continue

          const groupRetentionDays = this.normalizeRetentionDays(resolved.policy)
          if (!this.retentionExpired(dayFolder.sealedAt || dayFolder.completedAt, groupRetentionDays)) {
            continue
          }
          if (!existsSync(dayFolder.folderPath)) continue

          await this.refreshGroupFiles(dayFolder.id)
          const latest = dayFolderRepo.recalculate(dayFolder.id)
          if (!latest) continue
          // onlyAfterSealed is a deprecated compatibility field. Runtime cleanup
          // always keeps sealed/cleanable as a hard safety invariant.
          if (!this.isSealedCleanupCandidate(latest)) continue
          if (!this.retentionExpired(latest.sealedAt || latest.completedAt, groupRetentionDays)) continue
          if (!dayFolderRepo.isSafeToClean(latest.id)) {
            continue
          }
          await assertSafeCleanupPath({
            targetPath: latest.folderPath,
            sourceRoots: resolved.sourceRoots
          })
          dayFolderRepo.markCleanable(latest.id)
          await rm(latest.folderPath, { recursive: true, force: true })
          dayFolderRepo.markCleaned(latest.id)
          cleaned++
          log.info(
            `自动清理: 已删除归档组 ${latest.folderPath} ` +
            `(归档组ID: ${latest.id}, sealedAt: ${latest.sealedAt}, ` +
            `保留天数: ${groupRetentionDays})`
          )
        } catch (err) {
          log.error(`自动清理归档组失败: ${dayFolder.folderPath}`, err)
        }
      }

      for (const task of tasks) {
        try {
          if (!existsSync(task.folderPath)) {
            continue
          }
          await this.refreshTaskFiles(task)
          const latest = taskRepo.getById(task.id)
          if (!latest || !this.isStandaloneTaskSafeToClean(latest)) {
            continue
          }
          await rm(task.folderPath, { recursive: true, force: true })
          cleaned++
          log.info(`自动清理: 已删除 ${task.folderPath} (任务ID: ${task.id}, 完成于: ${task.completedAt})`)
        } catch (err) {
          log.error(`自动清理失败: ${task.folderPath}`, err)
        }
      }

      if (cleaned > 0) {
        log.info(`自动清理完成: 共删除 ${cleaned} 个文件夹`)
      }
    } catch (err) {
      log.error('自动清理服务异常:', err)
    } finally {
      this.running = false
    }
  }

  private normalizeRetentionDays(config: CleanupConfig): number {
    if (!Number.isFinite(config.retentionDays)) {
      return 7
    }

    return Math.max(0, Math.floor(config.retentionDays))
  }

  private retentionExpired(timestamp: string | null, retentionDays: number): boolean {
    if (!timestamp) return false
    const time = Date.parse(timestamp)
    if (!Number.isFinite(time)) return false
    return time < Date.now() - retentionDays * 86400000
  }

  private isSealedCleanupCandidate(group: { uploadGroupStatus: string }): boolean {
    return group.uploadGroupStatus === 'sealed' || group.uploadGroupStatus === 'cleanable'
  }

  private async refreshGroupFiles(dayFolderId: string): Promise<void> {
    const tasks = getDayFolderRepo().getChildTasks(dayFolderId)
    await Promise.all(tasks.map((task) => this.refreshTaskFiles(task)))
    getDayFolderService().refresh(dayFolderId)
  }

  private async refreshTaskFiles(task: Task): Promise<void> {
    if (!existsSync(task.folderPath) || task.status === 'skipped') return
    const settings = getSettingsRepo().getAll()
    const requiredStableChecks =
      task.sourceType === 'local' && task.dayFolderId
        ? Math.max(2, settings.stability.checkCount || 2)
        : 1
    await getTaskRepo().reconcileFileBatches(
      task.id,
      new FileFilterService(
        task.profileSnapshot?.filter || settings.filter
      ).scanFolderBatches(task.folderPath),
      requiredStableChecks
    )
  }

  private isStandaloneTaskSafeToClean(task: Task): boolean {
    if (task.status !== 'completed') return false
    if (task.destinations.length === 0) return false
    if (
      task.destinations.some(
        (destination) => destination.status !== 'completed' && destination.status !== 'synced'
      )
    ) {
      return false
    }

    const summary = getTaskRepo().summarizeFiles(task.id)
    if (summary.failedFiles > 0) return false
    const destinationRepo = getTaskDestinationRepo()
    for (const destination of task.destinations) {
      const destinationSummary = destinationRepo.summarizeFileTargets(
        task.id,
        destination.provider
      )
      if (destinationSummary.failed > 0 || destinationSummary.pending > 0) {
        return false
      }
    }
    return summary.totalFiles === summary.completedFiles + summary.skippedFiles
  }
}

let instance: CleanupService | null = null
export function getCleanupService(): CleanupService {
  if (!instance) instance = new CleanupService()
  return instance
}
