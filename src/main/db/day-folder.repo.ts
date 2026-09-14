import { join, normalize } from 'path'
import { v4 as uuid } from 'uuid'
import type {
  CloudProvider,
  CompletionPolicy,
  DayFolderListQuery,
  DayFolderSummary,
  PathVariables,
  Task,
  UploadGroupStatus
} from '@shared/types'
import {
  assertUploadGroupTransition,
  deriveUploadGroupStatus,
  mapLegacyDayFolderStatus,
  uploadGroupStatusToDayFolderStatus
} from '@shared/upload-group'
import { DEFAULT_COMPLETION_POLICY } from '@shared/upload-profile'
import { getDb } from './database'
import { getTaskRepo } from './task.repo'
import { getSettingsRepo } from './settings.repo'

interface DayFolderRecord extends DayFolderSummary {
  childFolders: string[]
}

function normalizeFolderPath(p: string): string {
  return normalize(p).replace(/[\\/]+$/, '')
}

function safeParseVariables(
  value: unknown,
  fallback: PathVariables = {}
): PathVariables {
  if (typeof value !== 'string' || !value) return fallback
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([key, item]) => [key, String(item)])
    )
  } catch {
    return fallback
  }
}

function safeParseProfile(value: string): Task['profileSnapshot'] {
  try {
    return JSON.parse(value) as NonNullable<Task['profileSnapshot']>
  } catch {
    return null
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function rowToRecord(row: Record<string, unknown>): DayFolderRecord {
  let childFolders: string[] = []
  try {
    const parsed = JSON.parse((row.child_folders_json as string) || '[]')
    if (Array.isArray(parsed)) {
      childFolders = parsed.filter((value): value is string => typeof value === 'string')
    }
  } catch {
    childFolders = []
  }
  const variables = safeParseVariables(row.variables_json, {
    date: (row.date_value as string) || ''
  })
  const legacyStatus = row.status as DayFolderSummary['status']
  const uploadGroupStatus =
    (row.upload_group_status as UploadGroupStatus | undefined) ||
    mapLegacyDayFolderStatus(legacyStatus)
  const discoveredAt = (row.discovered_at as string) || (row.created_at as string)
  const lastContentActivityAt =
    (row.last_content_activity_at as string) ||
    discoveredAt ||
    (row.updated_at as string) ||
    (row.created_at as string)

  return {
    id: row.id as string,
    folderPath: row.folder_path as string,
    folderName: row.folder_name as string,
    date: row.date_value as string,
    status: legacyStatus,
    profileId: (row.profile_id as string) || null,
    groupKey: (row.group_key as string) || (row.date_value as string),
    variables,
    uploadGroupStatus,
    discoveredAt,
    lastContentActivityAt,
    sealedAt: (row.sealed_at as string) || null,
    cleanableAt: (row.cleanable_at as string) || null,
    cleanedAt: (row.cleaned_at as string) || null,
    totalChildren: row.total_children as number,
    completedChildren: row.completed_children as number,
    totalFiles: row.total_files as number,
    uploadedFiles: row.uploaded_files as number,
    totalBytes: row.total_bytes as number,
    uploadedBytes: row.uploaded_bytes as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    completedAt: (row.completed_at as string) || null,
    ignored: Boolean(row.ignored),
    childFolders
  }
}

export class DayFolderRepo {
  ensure(
    folderPath: string,
    groupKey: string,
    variables: PathVariables = { date: groupKey },
    profileId?: string | null
  ): DayFolderSummary {
    const existing = this.getRecordByPath(folderPath)
    if (existing) {
      this.updateGroupMetadata(existing.id, groupKey, variables, profileId ?? existing.profileId)
      return this.getById(existing.id) || existing
    }

    const db = getDb()
    const id = uuid()
    const now = new Date().toISOString()
    const normalizedPath = normalizeFolderPath(folderPath)
    db.prepare(
      `INSERT INTO day_folders (
        id, folder_path, folder_name, date_value, status, child_folders_json,
        created_at, updated_at, profile_id, group_key, variables_json,
        upload_group_status, discovered_at, last_content_activity_at
      ) VALUES (?, ?, ?, ?, 'collecting', '[]', ?, ?, ?, ?, ?, 'open', ?, ?)`
    ).run(
      id,
      normalizedPath,
      groupKey,
      groupKey,
      now,
      now,
      profileId || null,
      groupKey,
      JSON.stringify(variables),
      now,
      now
    )
    return this.getById(id)!
  }

  getById(id: string): DayFolderSummary | null {
    const record = this.getRecordById(id)
    return record ? this.toSummary(record) : null
  }

  getByPath(folderPath: string): DayFolderSummary | null {
    const record = this.getRecordByPath(folderPath)
    return record ? this.toSummary(record) : null
  }

  list(query: DayFolderListQuery = {}): DayFolderSummary[] {
    const db = getDb()
    const conditions: string[] = []
    const params: unknown[] = []

    if (query.status) {
      conditions.push('status = ?')
      params.push(query.status)
    } else if (query.includeCompleted === false) {
      conditions.push("status NOT IN ('completed', 'completed_with_skips')")
    }
    if (query.provider) {
      conditions.push(
        `EXISTS (
          SELECT 1
          FROM tasks t
          INNER JOIN task_destinations td ON td.task_id = t.id
          WHERE t.day_folder_id = day_folders.id
            AND td.provider = ?
        )`
      )
      params.push(query.provider)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(query.limit || 100, 1000))
    const rows = db.prepare(
      `SELECT * FROM day_folders ${where}
       ORDER BY date_value DESC, updated_at DESC LIMIT ?`
    ).all(...params, limit) as Record<string, unknown>[]

    return rows.map((row) => this.toSummary(rowToRecord(row)))
  }

  updateDiscovery(id: string, childFolders: string[]): void {
    const db = getDb()
    const existing = this.getRecordById(id)
    const normalizedChildren = Array.from(
      new Set([...(existing?.childFolders || []), ...childFolders])
    ).sort()
    const contentChanged = !arraysEqual(normalizedChildren, existing?.childFolders || [])
    const now = new Date().toISOString()
    db.prepare(
      `UPDATE day_folders
       SET child_folders_json = ?, total_children = ?,
           last_content_activity_at = CASE WHEN ? = 1 THEN ? ELSE last_content_activity_at END,
           updated_at = ?
       WHERE id = ?`
    ).run(
      JSON.stringify(normalizedChildren),
      normalizedChildren.length,
      contentChanged ? 1 : 0,
      now,
      now,
      id
    )
  }

  updateGroupMetadata(
    id: string,
    groupKey: string,
    variables: PathVariables,
    profileId?: string | null
  ): void {
    getDb().prepare(
      `UPDATE day_folders
       SET group_key = ?, variables_json = ?, profile_id = COALESCE(?, profile_id),
           discovered_at = COALESCE(discovered_at, created_at),
           updated_at = ?
       WHERE id = ?`
    ).run(
      groupKey,
      JSON.stringify(variables),
      profileId || null,
      new Date().toISOString(),
      id
    )
  }

  markClosing(id: string): void {
    this.transitionStatus(id, 'closing')
  }

  markCleanable(id: string): void {
    this.transitionStatus(id, 'cleanable')
  }

  markCleaned(id: string): void {
    this.transitionStatus(id, 'cleaned')
  }

  markContentActivity(id: string, occurredAt = new Date().toISOString()): void {
    getDb().prepare(
      `UPDATE day_folders
       SET last_content_activity_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(occurredAt, occurredAt, id)
  }

  transitionStatus(id: string, nextStatus: UploadGroupStatus): void {
    const current = this.getRecordById(id)
    if (!current) return
    assertUploadGroupTransition(current.uploadGroupStatus, nextStatus)
    if (current.uploadGroupStatus === nextStatus) return
    const now = new Date().toISOString()
    getDb().prepare(
      `UPDATE day_folders
       SET upload_group_status = ?,
           sealed_at = CASE WHEN ? = 'sealed' THEN COALESCE(sealed_at, ?) ELSE sealed_at END,
           cleanable_at = CASE WHEN ? = 'cleanable' THEN COALESCE(cleanable_at, ?) ELSE cleanable_at END,
           cleaned_at = CASE WHEN ? = 'cleaned' THEN COALESCE(cleaned_at, ?) ELSE cleaned_at END,
           updated_at = ?
       WHERE id = ?`
    ).run(nextStatus, nextStatus, now, nextStatus, now, nextStatus, now, now, id)
  }

  recalculate(id: string, now = new Date()): DayFolderSummary | null {
    const record = this.getRecordById(id)
    if (!record) return null

    const tasks = getTaskRepo().listByDayFolder(id)
    const latestByPath = new Map<string, Task>()
    for (const task of tasks) {
      const normalizedPath = normalizeFolderPath(task.folderPath)
      if (!latestByPath.has(normalizedPath)) {
        latestByPath.set(normalizedPath, task)
      }
    }

    const childTasks = record.childFolders.map((folderName) =>
      latestByPath.get(normalizeFolderPath(join(record.folderPath, folderName))) ||
      (folderName === record.folderName
        ? latestByPath.get(normalizeFolderPath(record.folderPath))
        : null) ||
      null
    )
    const childStatuses = childTasks.map((task) => task?.status || null)
    const uploadGroupStatus = deriveUploadGroupStatus({
      currentStatus: record.uploadGroupStatus,
      completion: this.completionPolicyFor(record, childTasks),
      taskStatuses: childStatuses,
      lastContentActivityAt: record.lastContentActivityAt,
      now
    })
    const status = record.ignored
      ? 'completed_with_skips'
      : uploadGroupStatusToDayFolderStatus(uploadGroupStatus, childStatuses)
    const completedChildren = childTasks.filter(
      (task) =>
        task?.status === 'completed' ||
        task?.status === 'synced' ||
        task?.status === 'skipped'
    ).length
    const totalFiles = childTasks.reduce((sum, task) => sum + (task?.totalFiles || 0), 0)
    const uploadedFiles = childTasks.reduce((sum, task) => sum + (task?.uploadedFiles || 0), 0)
    const totalBytes = childTasks.reduce((sum, task) => sum + (task?.totalBytes || 0), 0)
    const uploadedBytes = childTasks.reduce((sum, task) => sum + (task?.uploadedBytes || 0), 0)
    const updatedAt = new Date().toISOString()
    const completedAt =
      status === 'completed' || status === 'completed_with_skips'
        ? record.completedAt || updatedAt
        : null
    const sealedAt =
      uploadGroupStatus === 'sealed' ||
      uploadGroupStatus === 'cleanable' ||
      uploadGroupStatus === 'cleaned'
        ? record.sealedAt || completedAt || updatedAt
        : record.sealedAt

    getDb().prepare(
      `UPDATE day_folders SET
        status = ?, completed_children = ?, total_files = ?, uploaded_files = ?,
        total_bytes = ?, uploaded_bytes = ?, upload_group_status = ?,
        updated_at = ?, completed_at = ?, sealed_at = ?
       WHERE id = ?`
    ).run(
      status,
      completedChildren,
      totalFiles,
      uploadedFiles,
      totalBytes,
      uploadedBytes,
      uploadGroupStatus,
      updatedAt,
      completedAt,
      sealedAt,
      id
    )

    return this.getById(id)
  }

  getChildTasks(id: string): Task[] {
    const record = this.getRecordById(id)
    if (!record) return []

    const expectedPaths = new Set(
      record.childFolders.map((name) => normalizeFolderPath(join(record.folderPath, name)))
    )
    if (record.childFolders.includes(record.folderName)) {
      expectedPaths.add(normalizeFolderPath(record.folderPath))
    }
    const latestByPath = new Map<string, Task>()
    for (const task of getTaskRepo().listByDayFolder(id)) {
      const path = normalizeFolderPath(task.folderPath)
      if (expectedPaths.has(path) && !latestByPath.has(path)) {
        latestByPath.set(path, task)
      }
    }
    return record.childFolders
      .map((name) => latestByPath.get(normalizeFolderPath(join(record.folderPath, name))))
      .filter((task): task is Task => Boolean(task))
  }

  getCompletedForCleanup(retentionDays: number): DayFolderSummary[] {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString()
    const rows = getDb().prepare(
      `SELECT * FROM day_folders
       WHERE upload_group_status IN ('sealed', 'cleanable')
         AND COALESCE(sealed_at, completed_at) IS NOT NULL
         AND COALESCE(sealed_at, completed_at) < ?
       ORDER BY COALESCE(sealed_at, completed_at) ASC`
    ).all(cutoff) as Record<string, unknown>[]
    return rows.map((row) => this.toSummary(rowToRecord(row)))
  }

  listCleanupCandidates(): DayFolderSummary[] {
    const rows = getDb().prepare(
      `SELECT * FROM day_folders
       WHERE upload_group_status IN ('sealed', 'cleanable')
         AND COALESCE(sealed_at, completed_at) IS NOT NULL
       ORDER BY COALESCE(sealed_at, completed_at) ASC`
    ).all() as Record<string, unknown>[]
    return rows.map((row) => this.toSummary(rowToRecord(row)))
  }

  isSafeToClean(id: string): boolean {
    const record = this.getRecordById(id)
    if (!record) return false
    if (record.uploadGroupStatus !== 'sealed' && record.uploadGroupStatus !== 'cleanable') {
      return false
    }

    const blockingTasks = getDb().prepare(
      `SELECT COUNT(*) AS count
       FROM tasks
       WHERE day_folder_id = ?
         AND status IN ('pending', 'scanning', 'uploading', 'retrying', 'failed', 'paused')`
    ).get(id) as { count: number }
    if ((blockingTasks.count || 0) > 0) return false

    const incompleteDestinations = getDb().prepare(
      `SELECT COUNT(*) AS count
       FROM task_destinations
       WHERE task_id IN (SELECT id FROM tasks WHERE day_folder_id = ?)
         AND status NOT IN ('completed', 'synced', 'skipped')`
    ).get(id) as { count: number }
    if ((incompleteDestinations.count || 0) > 0) return false

    const incompleteFiles = getDb().prepare(
      `SELECT COUNT(*) AS count
       FROM task_files
       WHERE task_id IN (SELECT id FROM tasks WHERE day_folder_id = ?)
         AND source_status = 'present'
         AND status NOT IN ('completed', 'skipped')`
    ).get(id) as { count: number }
    return (incompleteFiles.count || 0) === 0
  }

  clearCompleted(before?: string, provider?: CloudProvider): void {
    const db = getDb()
    if (provider) {
      const transaction = db.transaction(() => {
        const params: unknown[] = [provider]
        let beforeCondition = ''
        if (before) {
          beforeCondition = ' AND df.completed_at < ?'
          params.push(before)
        }
        db.prepare(
          `DELETE FROM task_destinations
           WHERE provider = ?
             AND task_id IN (
               SELECT t.id
               FROM tasks t
               INNER JOIN day_folders df ON df.id = t.day_folder_id
               WHERE df.status IN ('completed', 'completed_with_skips')
                 AND df.completed_at IS NOT NULL${beforeCondition}
             )`
        ).run(...params)
        db.prepare(
          `DELETE FROM tasks
           WHERE day_folder_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM task_destinations td WHERE td.task_id = tasks.id
             )`
        ).run()
        db.prepare(
          `DELETE FROM day_folders
           WHERE status IN ('completed', 'completed_with_skips')
             AND NOT EXISTS (
               SELECT 1
               FROM tasks t
               INNER JOIN task_destinations td ON td.task_id = t.id
               WHERE t.day_folder_id = day_folders.id
             )`
        ).run()
      })
      transaction()
      return
    }

    if (before) {
      db.prepare(
        "DELETE FROM day_folders WHERE status IN ('completed', 'completed_with_skips') AND completed_at < ?"
      ).run(before)
    } else {
      db.prepare(
        "DELETE FROM day_folders WHERE status IN ('completed', 'completed_with_skips')"
      ).run()
    }
  }

  deleteCompleted(id: string, provider?: CloudProvider): void {
    const db = getDb()
    if (provider) {
      const transaction = db.transaction(() => {
        db.prepare(
          `DELETE FROM task_destinations
           WHERE provider = ?
             AND task_id IN (SELECT id FROM tasks WHERE day_folder_id = ?)`
        ).run(provider, id)
        db.prepare(
          `DELETE FROM tasks
           WHERE day_folder_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM task_destinations td WHERE td.task_id = tasks.id
             )`
        ).run(id)
        db.prepare(
          `DELETE FROM day_folders
           WHERE id = ?
             AND status IN ('completed', 'completed_with_skips')
             AND NOT EXISTS (
               SELECT 1
               FROM tasks t
               INNER JOIN task_destinations td ON td.task_id = t.id
               WHERE t.day_folder_id = day_folders.id
             )`
        ).run(id)
      })
      transaction()
      return
    }

    db.prepare(
      "DELETE FROM day_folders WHERE id = ? AND status IN ('completed', 'completed_with_skips')"
    ).run(id)
  }

  setIgnored(id: string, ignored: boolean): void {
    getDb().prepare(
      `UPDATE day_folders
       SET ignored = ?, updated_at = ?
       WHERE id = ?`
    ).run(ignored ? 1 : 0, new Date().toISOString(), id)
  }

  private getRecordById(id: string): DayFolderRecord | null {
    const row = getDb().prepare('SELECT * FROM day_folders WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToRecord(row) : null
  }

  private getRecordByPath(folderPath: string): DayFolderRecord | null {
    const normalizedPath = normalizeFolderPath(folderPath)
    const row = getDb().prepare('SELECT * FROM day_folders WHERE folder_path = ?').get(normalizedPath) as
      | Record<string, unknown>
      | undefined
    return row ? rowToRecord(row) : null
  }

  private completionPolicyFor(
    record: DayFolderRecord,
    childTasks: Array<Task | null>
  ): CompletionPolicy {
    const taskPolicy = childTasks.find((task) => task?.profileSnapshot?.completion)
      ?.profileSnapshot?.completion
    if (taskPolicy) return taskPolicy
    const row = getDb().prepare(
      `SELECT profile_snapshot_json
       FROM tasks
       WHERE day_folder_id = ? AND profile_snapshot_json IS NOT NULL
       ORDER BY created_at ASC
       LIMIT 1`
    ).get(record.id) as { profile_snapshot_json: string } | undefined
    const profile = row ? safeParseProfile(row.profile_snapshot_json) : null
    if (profile?.completion) return profile.completion
    if (record.profileId) {
      const currentProfile = getSettingsRepo()
        .getAll()
        .profiles.find((item) => item.id === record.profileId)
      if (currentProfile?.completion) return currentProfile.completion
    }
    return DEFAULT_COMPLETION_POLICY
  }

  private toSummary(record: DayFolderRecord): DayFolderSummary {
    const { childFolders: _childFolders, ...summary } = record
    return summary
  }
}

let instance: DayFolderRepo | null = null
export function getDayFolderRepo(): DayFolderRepo {
  if (!instance) instance = new DayFolderRepo()
  return instance
}
