import { getRuleSourceDirectories } from '@shared/scan-config'
import type {
  CleanupPolicy,
  UploadGroupSummary,
  Task,
  UploadRule
} from '@shared/types'
import { DEFAULT_CLEANUP_POLICY } from '@shared/upload-rule'
import { getSettingsRepo } from '../db/settings.repo'
import { getTaskRepo } from '../db/task.repo'

export interface ResolvedCleanupPolicyForGroup {
  policy: CleanupPolicy
  sourceRoots: string[]
  rule: UploadRule | null
}

export function resolveCleanupPolicyForGroup(
  group: UploadGroupSummary,
  tasks: Task[] = getTaskRepo().listByUploadGroup(group.id)
): ResolvedCleanupPolicyForGroup {
  const settings = getSettingsRepo().getAll()
  const snapshotRule = findSnapshotRule(group, tasks)
  const currentRule = group.ruleId
    ? settings.rules.find((rule) => rule.id === group.ruleId) || null
    : null
  const rule = snapshotRule || currentRule
  const policy = normalizeCleanupPolicy(
    rule?.cleanup || settings.cleanup,
    DEFAULT_CLEANUP_POLICY
  )
  const snapshotSourceRoots = snapshotRule
    ? getRuleSourceDirectories(snapshotRule)
    : []
  const currentSourceRoots = currentRule
    ? getRuleSourceDirectories(currentRule)
    : []
  const sourceRoots = firstNonEmpty(
    snapshotSourceRoots,
    currentSourceRoots,
    settings.rules.flatMap(getRuleSourceDirectories)
  )

  return {
    policy,
    sourceRoots,
    rule
  }
}

function firstNonEmpty(...values: string[][]): string[] {
  return values.find((value) => value.length > 0) || []
}

function findSnapshotRule(
  group: UploadGroupSummary,
  tasks: Task[]
): UploadRule | null {
  const orderedTasks = [...tasks].sort((a, b) =>
    Date.parse(a.createdAt) - Date.parse(b.createdAt)
  )
  return (
    orderedTasks.find((task) =>
      task.ruleSnapshot?.cleanup &&
      (!group.ruleId ||
        task.ruleSnapshot.id === group.ruleId ||
        task.ruleId === group.ruleId)
    )?.ruleSnapshot ||
    orderedTasks.find((task) => task.ruleSnapshot?.cleanup)?.ruleSnapshot ||
    null
  )
}

function normalizeCleanupPolicy(
  rawPolicy: CleanupPolicy | undefined,
  fallback: CleanupPolicy
): CleanupPolicy {
  const retentionDays = Number(rawPolicy?.retentionDays)
  return {
    enabled:
      typeof rawPolicy?.enabled === 'boolean'
        ? rawPolicy.enabled
        : fallback.enabled,
    retentionDays: Number.isFinite(retentionDays)
      ? Math.max(0, Math.floor(retentionDays))
      : fallback.retentionDays,
    onlyAfterSealed:
      typeof rawPolicy?.onlyAfterSealed === 'boolean'
        ? rawPolicy.onlyAfterSealed
        : fallback.onlyAfterSealed
  }
}
