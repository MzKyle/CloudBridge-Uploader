import { existsSync, readdirSync } from 'fs'
import { rm } from 'fs/promises'
import { basename, join } from 'path'
import log from 'electron-log'
import { getTaskRepo } from '../db/task.repo'
import { getUploadGroupRepo } from '../db/upload-group.repo'
import { getSettingsRepo } from '../db/settings.repo'
import { getTaskDestinationRepo } from '../db/task-destination.repo'
import { getUploadGroupService } from './upload-group.service'
import { FileFilterService } from './file-filter.service'
import { resolveCleanupPolicyForGroup } from './upload-group-policy'
import { assertSafeCleanupPath } from '../utils/cleanup-path-safety'
import type { CleanupConfig, Task, UploadGroupSummary } from '@shared/types'

interface CleanupServiceHooks {
  beforeGroupRemove?: (group: UploadGroupSummary) => void | Promise<void>
}

const MARKER_FILE_NAMES = new Set([
  'tmp_upload.json',
  'process_task.json',
  'day_upload.json'
])

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

  constructor(private readonly hooks: CleanupServiceHooks = {}) {}

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
      const uploadGroupRepo = getUploadGroupRepo()
      const tasks = config.enabled
        ? taskRepo.getCompletedForCleanup(retentionDays)
        : []
      const uploadGroups = uploadGroupRepo.listCleanupCandidates()

      if (tasks.length === 0 && uploadGroups.length === 0) return

      log.info(
        `自动清理: 发现 ${uploadGroups.length} 个归档组、${tasks.length} 个独立任务可清理 ` +
          `(保留天数: ${retentionDays})`
      )

      let cleaned = 0
      for (const uploadGroup of uploadGroups) {
        try {
          const resolved = resolveCleanupPolicyForGroup(uploadGroup)
          if (!resolved.policy.enabled) continue

          const groupRetentionDays = this.normalizeRetentionDays(resolved.policy)
          if (!this.retentionExpired(uploadGroup.sealedAt || uploadGroup.completedAt, groupRetentionDays)) {
            continue
          }
          if (!existsSync(uploadGroup.folderPath)) continue

          await this.refreshGroupFiles(uploadGroup.id)
          const latest = uploadGroupRepo.recalculate(uploadGroup.id)
          if (!latest) continue
          // onlyAfterSealed is a deprecated compatibility field. Runtime cleanup
          // always keeps sealed/cleanable as a hard safety invariant.
          if (!this.isSealedCleanupCandidate(latest)) continue
          if (!this.retentionExpired(latest.sealedAt || latest.completedAt, groupRetentionDays)) continue
          if (!uploadGroupRepo.isSafeToClean(latest.id)) {
            continue
          }
          if (!uploadGroupRepo.claimCleanup(latest.id)) {
            continue
          }

          let cleanupClaimActive = true
          try {
            const claimed = uploadGroupRepo.getById(latest.id)
            if (
              !claimed ||
              !existsSync(claimed.folderPath) ||
              claimed.uploadGroupStatus !== 'cleanable' ||
              !this.retentionExpired(claimed.sealedAt || claimed.completedAt, groupRetentionDays)
            ) {
              uploadGroupRepo.releaseCleanupClaim(latest.id)
              cleanupClaimActive = false
              continue
            }

            await this.hooks.beforeGroupRemove?.(claimed)
            await this.refreshGroupFiles(claimed.id)
            const validated = uploadGroupRepo.recalculate(claimed.id)
            if (
              !validated ||
              validated.uploadGroupStatus !== 'cleanable' ||
              !this.retentionExpired(validated.sealedAt || validated.completedAt, groupRetentionDays) ||
              !uploadGroupRepo.isSafeToClean(validated.id) ||
              !this.hasOnlyDiscoveredGroupContent(validated.id, validated.folderPath)
            ) {
              uploadGroupRepo.releaseCleanupClaim(latest.id)
              cleanupClaimActive = false
              continue
            }

            await assertSafeCleanupPath({
              targetPath: validated.folderPath,
              sourceRoots: resolved.sourceRoots
            })
            await rm(validated.folderPath, { recursive: true, force: true })
            uploadGroupRepo.markCleaned(validated.id)
            cleanupClaimActive = false
          } finally {
            if (cleanupClaimActive) {
              uploadGroupRepo.releaseCleanupClaim(latest.id)
            }
          }
          cleaned++
          log.info(
            `自动清理: 已删除归档组 ${latest.folderPath} ` +
            `(归档组ID: ${latest.id}, sealedAt: ${latest.sealedAt}, ` +
            `保留天数: ${groupRetentionDays})`
          )
        } catch (err) {
          log.error(`自动清理归档组失败: ${uploadGroup.folderPath}`, err)
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

  private hasOnlyDiscoveredGroupContent(
    uploadGroupId: string,
    groupPath: string
  ): boolean {
    const groupName = basename(groupPath)
    const expectedRoots = getUploadGroupRepo()
      .listChildFolderNames(uploadGroupId)
      .map((name) => this.normalizeRelativePath(name === groupName ? '' : name))

    const stack = ['']
    while (stack.length > 0) {
      const current = stack.pop()!
      const absolute = current ? join(groupPath, current) : groupPath
      let entries
      try {
        entries = readdirSync(absolute, { withFileTypes: true })
      } catch {
        return false
      }

      for (const entry of entries) {
        const relativePath = this.normalizeRelativePath(
          current ? join(current, entry.name) : entry.name
        )
        if (entry.isDirectory()) {
          if (!this.isExpectedGroupPath(relativePath, expectedRoots, true)) {
            return false
          }
          stack.push(relativePath)
          continue
        }
        if (entry.isFile() && MARKER_FILE_NAMES.has(entry.name)) {
          continue
        }
        if (!this.isExpectedGroupPath(relativePath, expectedRoots, false)) {
          return false
        }
      }
    }

    return true
  }

  private isExpectedGroupPath(
    relativePath: string,
    expectedRoots: string[],
    isDirectory: boolean
  ): boolean {
    for (const root of expectedRoots) {
      if (!root) return true
      if (relativePath === root || relativePath.startsWith(`${root}/`)) {
        return true
      }
      if (isDirectory && root.startsWith(`${relativePath}/`)) {
        return true
      }
    }
    return false
  }

  private normalizeRelativePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  }

  private async refreshGroupFiles(uploadGroupId: string): Promise<void> {
    const tasks = getUploadGroupRepo().getChildTasks(uploadGroupId)
    await Promise.all(tasks.map((task) => this.refreshTaskFiles(task)))
    getUploadGroupService().refresh(uploadGroupId)
  }

  private async refreshTaskFiles(task: Task): Promise<void> {
    if (!existsSync(task.folderPath) || task.status === 'skipped') return
    const settings = getSettingsRepo().getAll()
    const requiredStableChecks =
      task.sourceType === 'local' && task.uploadGroupId
        ? Math.max(2, settings.stability.checkCount || 2)
        : 1
    await getTaskRepo().reconcileFileBatches(
      task.id,
      new FileFilterService(
        task.ruleSnapshot?.filter || settings.filter
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
        destination.connectionId
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
