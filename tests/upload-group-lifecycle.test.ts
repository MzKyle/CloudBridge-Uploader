import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import {
  buildLastUploadGroupIndexByStream,
  deriveUploadGroupStatus,
  uploadGroupSiblingStreamKey
} from '../src/shared/upload-group'
import { runMigrations, setDbForTests } from '../src/main/db/database'
import { DayFolderRepo } from '../src/main/db/day-folder.repo'
import { TaskRepo } from '../src/main/db/task.repo'
import { DayFolderService } from '../src/main/services/day-folder.service'
import type { CompletionPolicy, UploadRule } from '../src/shared/types'

function createDatabase(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  setDbForTests(db)
  return db
}

function closeDatabase(db: Database.Database): void {
  setDbForTests(null)
  db.close()
}

function createProfile(root: string, completion: CompletionPolicy): UploadRule {
  const base = DEFAULT_SETTINGS.rules[0] as UploadRule
  return {
    ...base,
    id: 'rule-1',
    name: 'Rule 1',
    source: {
      roots: [root]
    },
    completion
  }
}

function createGroupWithTask(
  root: string,
  completion: CompletionPolicy,
  taskStatus: 'pending' | 'completed' = 'pending',
  groupName = 'batch-1'
): { groupId: string; taskId: string } {
  const groupPath = join(root, groupName)
  const taskPath = join(groupPath, 'session-1')
  mkdirSync(taskPath, { recursive: true })

  const dayFolderRepo = new DayFolderRepo()
  const profile = createProfile(root, completion)
  const group = dayFolderRepo.ensure(
    groupPath,
    groupName,
    { batch: groupName },
    profile.id
  )
  dayFolderRepo.updateDiscovery(group.id, ['session-1'])

  const taskRepo = new TaskRepo()
  const task = taskRepo.create({
    folderPath: taskPath,
    folderName: 'session-1',
    dayFolderId: group.id,
    uploadRelativePath: `${groupName}/session-1`,
    destinations: [
      {
        connectionId: 'aliyun-prod',
        connectionName: '阿里云 OSS',
        connectionType: 'aliyun-oss',
        uploadRelativePath: `${groupName}/session-1`
      }
    ],
    sourceType: 'local',
    ruleId: profile.id,
    ruleName: profile.name,
    ruleSnapshot: profile,
    groupVariables: { batch: groupName }
  })
  if (taskStatus === 'completed') {
    taskRepo.updateStatus(task.id, 'completed')
  }

  return { groupId: group.id, taskId: task.id }
}

function setContentActivity(
  db: Database.Database,
  groupId: string,
  timestamp: string
): void {
  db.prepare(`
    UPDATE day_folders
    SET last_content_activity_at = ?, updated_at = ?
    WHERE id = ?
  `).run(timestamp, timestamp, groupId)
}

test('refresh and recalculation do not update upload group content activity', () => {
  const db = createDatabase()
  const root = mkdtempSync(join(tmpdir(), 'group-activity-refresh-'))
  try {
    const { groupId } = createGroupWithTask(root, { mode: 'manual' })
    const dayFolderRepo = new DayFolderRepo()
    const frozen = '2000-01-01T00:00:00.000Z'
    setContentActivity(db, groupId, frozen)

    dayFolderRepo.updateGroupMetadata(groupId, 'batch-1', { batch: 'batch-1' }, 'rule-1')
    dayFolderRepo.updateDiscovery(groupId, ['session-1'])
    dayFolderRepo.recalculate(groupId, new Date('2026-09-13T10:00:00.000Z'))
    new DayFolderService().refresh(groupId)

    assert.equal(dayFolderRepo.getById(groupId)?.lastContentActivityAt, frozen)
  } finally {
    rmSync(root, { recursive: true, force: true })
    closeDatabase(db)
  }
})

test('new tasks and file content changes update upload group content activity', () => {
  const db = createDatabase()
  const root = mkdtempSync(join(tmpdir(), 'group-activity-content-'))
  try {
    const groupPath = join(root, 'batch-1')
    const firstTaskPath = join(groupPath, 'session-1')
    const secondTaskPath = join(groupPath, 'session-2')
    mkdirSync(firstTaskPath, { recursive: true })
    mkdirSync(secondTaskPath, { recursive: true })

    const dayFolderRepo = new DayFolderRepo()
    const taskRepo = new TaskRepo()
    const profile = createProfile(root, { mode: 'inactivity', idleMinutes: 5 })
    const group = dayFolderRepo.ensure(groupPath, 'batch-1', {}, profile.id)
    const frozen = '2000-01-01T00:00:00.000Z'
    setContentActivity(db, group.id, frozen)

    const firstTask = taskRepo.create({
      folderPath: firstTaskPath,
      folderName: 'session-1',
      dayFolderId: group.id,
      uploadRelativePath: 'batch-1/session-1',
      ruleId: profile.id,
      ruleName: profile.name,
      ruleSnapshot: profile
    })
    assert.notEqual(dayFolderRepo.getById(group.id)?.lastContentActivityAt, frozen)

    setContentActivity(db, group.id, frozen)
    taskRepo.reconcileFiles(
      firstTask.id,
      [{ relativePath: 'data.bin', size: 10, mtimeMs: 100 }],
      2
    )
    assert.notEqual(dayFolderRepo.getById(group.id)?.lastContentActivityAt, frozen)

    const afterInsert = dayFolderRepo.getById(group.id)?.lastContentActivityAt
    taskRepo.reconcileFiles(
      firstTask.id,
      [{ relativePath: 'data.bin', size: 10, mtimeMs: 100 }],
      2
    )
    assert.equal(dayFolderRepo.getById(group.id)?.lastContentActivityAt, afterInsert)

    setContentActivity(db, group.id, frozen)
    taskRepo.reconcileFiles(
      firstTask.id,
      [{ relativePath: 'data.bin', size: 12, mtimeMs: 200 }],
      2
    )
    assert.notEqual(dayFolderRepo.getById(group.id)?.lastContentActivityAt, frozen)

    setContentActivity(db, group.id, frozen)
    taskRepo.create({
      folderPath: secondTaskPath,
      folderName: 'session-2',
      dayFolderId: group.id,
      uploadRelativePath: 'batch-1/session-2',
      ruleId: profile.id,
      ruleName: profile.name,
      ruleSnapshot: profile
    })
    assert.notEqual(dayFolderRepo.getById(group.id)?.lastContentActivityAt, frozen)
  } finally {
    rmSync(root, { recursive: true, force: true })
    closeDatabase(db)
  }
})

test('inactivity completion uses last content activity instead of record updates', () => {
  const db = createDatabase()
  const root = mkdtempSync(join(tmpdir(), 'group-inactivity-'))
  try {
    const { groupId } = createGroupWithTask(
      root,
      { mode: 'inactivity', idleMinutes: 5 },
      'completed'
    )
    const dayFolderRepo = new DayFolderRepo()

    setContentActivity(db, groupId, '2026-09-13T10:00:00.000Z')
    dayFolderRepo.updateGroupMetadata(groupId, 'batch-1', { batch: 'batch-1' }, 'rule-1')
    assert.equal(
      dayFolderRepo.recalculate(
        groupId,
        new Date('2026-09-13T10:06:00.000Z')
      )?.uploadGroupStatus,
      'sealed'
    )

    const { groupId: freshGroupId } = createGroupWithTask(
      root,
      { mode: 'inactivity', idleMinutes: 5 },
      'completed',
      'batch-2'
    )
    setContentActivity(db, freshGroupId, '2026-09-13T10:04:00.000Z')
    assert.equal(
      dayFolderRepo.recalculate(
        freshGroupId,
        new Date('2026-09-13T10:06:00.000Z')
      )?.uploadGroupStatus,
      'open'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    closeDatabase(db)
  }
})

test('none completion never automatically seals an open group', () => {
  assert.equal(
    deriveUploadGroupStatus({
      currentStatus: 'open',
      completion: { mode: 'none' },
      taskStatuses: ['completed']
    }),
    'open'
  )
})

test('manual close moves open groups to closing and seals after terminal tasks', () => {
  const db = createDatabase()
  const root = mkdtempSync(join(tmpdir(), 'group-manual-close-'))
  try {
    const { groupId, taskId } = createGroupWithTask(root, { mode: 'manual' })
    const service = new DayFolderService()

    assert.equal(service.requestCloseUploadGroup(groupId)?.uploadGroupStatus, 'closing')

    new TaskRepo().updateStatus(taskId, 'completed')
    assert.equal(service.refresh(groupId)?.uploadGroupStatus, 'sealed')
  } finally {
    rmSync(root, { recursive: true, force: true })
    closeDatabase(db)
  }
})

test('rollover only closes older groups in the same sibling stream', () => {
  const groups = [
    { relativePath: 'machine-A/001' },
    { relativePath: 'machine-A/002' },
    { relativePath: 'machine-B/001' },
    { relativePath: 'machine-B/002' }
  ]
  const lastIndexByStream = buildLastUploadGroupIndexByStream(groups)

  assert.deepEqual(
    groups.map((group, index) => ({
      streamKey: uploadGroupSiblingStreamKey(group.relativePath),
      shouldClose: lastIndexByStream.get(uploadGroupSiblingStreamKey(group.relativePath)) !== index
    })),
    [
      { streamKey: 'machine-A', shouldClose: true },
      { streamKey: 'machine-A', shouldClose: false },
      { streamKey: 'machine-B', shouldClose: true },
      { streamKey: 'machine-B', shouldClose: false }
    ]
  )
})
