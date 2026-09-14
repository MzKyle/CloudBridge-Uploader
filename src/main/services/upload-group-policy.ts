import { getProfileSourceDirectories } from '@shared/scan-config'
import type {
  CleanupPolicy,
  DayFolderSummary,
  Task,
  UploadProfile
} from '@shared/types'
import { DEFAULT_CLEANUP_POLICY } from '@shared/upload-profile'
import { getSettingsRepo } from '../db/settings.repo'
import { getTaskRepo } from '../db/task.repo'

export interface ResolvedCleanupPolicyForGroup {
  policy: CleanupPolicy
  sourceRoots: string[]
  profile: UploadProfile | null
}

export function resolveCleanupPolicyForGroup(
  group: DayFolderSummary,
  tasks: Task[] = getTaskRepo().listByDayFolder(group.id)
): ResolvedCleanupPolicyForGroup {
  const settings = getSettingsRepo().getAll()
  const snapshotProfile = findSnapshotProfile(group, tasks)
  const currentProfile = group.profileId
    ? settings.profiles.find((profile) => profile.id === group.profileId) || null
    : null
  const profile = snapshotProfile || currentProfile
  const policy = normalizeCleanupPolicy(
    profile?.cleanup || settings.cleanup,
    DEFAULT_CLEANUP_POLICY
  )
  const snapshotSourceRoots = snapshotProfile
    ? getProfileSourceDirectories(snapshotProfile)
    : []
  const currentSourceRoots = currentProfile
    ? getProfileSourceDirectories(currentProfile)
    : []
  const sourceRoots = firstNonEmpty(
    snapshotSourceRoots,
    currentSourceRoots,
    settings.scan.directories
  )

  return {
    policy,
    sourceRoots,
    profile
  }
}

function firstNonEmpty(...values: string[][]): string[] {
  return values.find((value) => value.length > 0) || []
}

function findSnapshotProfile(
  group: DayFolderSummary,
  tasks: Task[]
): UploadProfile | null {
  const orderedTasks = [...tasks].sort((a, b) =>
    Date.parse(a.createdAt) - Date.parse(b.createdAt)
  )
  return (
    orderedTasks.find((task) =>
      task.profileSnapshot?.cleanup &&
      (!group.profileId ||
        task.profileSnapshot.id === group.profileId ||
        task.profileId === group.profileId)
    )?.profileSnapshot ||
    orderedTasks.find((task) => task.profileSnapshot?.cleanup)?.profileSnapshot ||
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
