import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import { runMigrations, setDbForTests } from '../src/main/db/database'
import { DayFolderRepo } from '../src/main/db/day-folder.repo'
import { SettingsRepo } from '../src/main/db/settings.repo'
import { TaskRepo } from '../src/main/db/task.repo'
import { getTaskDestinationRepo } from '../src/main/db/task-destination.repo'
import { CleanupService } from '../src/main/services/cleanup.service'
import { isSafeCleanupPath } from '../src/main/utils/cleanup-path-safety'
import type { CleanupPolicy, UploadRule } from '../src/shared/types'

interface CleanupFixture {
  groupPath: string
  groupId: string
  taskId: string
  fileId: string
}

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

function createCleanupFixture(root: string): CleanupFixture {
  return createCleanupFixtureForProfile(root, 'profile-1', 'batch-1')
}

function createCleanupFixtureForProfile(
  root: string,
  ruleId: string,
  groupName: string,
  ruleSnapshot?: UploadRule
): CleanupFixture {
  const groupPath = join(root, groupName)
  const taskPath = join(groupPath, 'session-1')
  const filePath = join(taskPath, 'data.bin')
  mkdirSync(taskPath, { recursive: true })
  writeFileSync(filePath, 'uploaded')

  const dayFolderRepo = new DayFolderRepo()
  const group = dayFolderRepo.ensure(
    groupPath,
    groupName,
    { batch: groupName },
    ruleId
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
    ruleId,
    ruleName: ruleSnapshot?.name || ruleId,
    ruleSnapshot,
    groupVariables: { batch: groupName }
  })
  const stats = statSync(filePath)
  const file = taskRepo.createFile(task.id, 'data.bin', stats.size, stats.mtimeMs)

  return {
    groupPath,
    groupId: group.id,
    taskId: task.id,
    fileId: file.id
  }
}

function createProfile(
  id: string,
  root: string,
  cleanup: CleanupPolicy
): UploadRule {
  const base = DEFAULT_SETTINGS.rules[0] as UploadRule
  return {
    ...base,
    id,
    name: id,
    source: {
      roots: [root]
    },
    cleanup
  }
}

function saveProfiles(
  rules: UploadRule[],
  cleanup: CleanupPolicy = {
    enabled: false,
    retentionDays: 7,
    onlyAfterSealed: true
  }
): void {
  new SettingsRepo().saveAll({
    rules,
    activeRuleId: rules[0]?.id || 'default',
    cleanup
  })
}

function setOldCompletedGroupTimestamps(db: Database.Database, groupId: string): void {
  const old = '2000-01-01T00:00:00.000Z'
  db.prepare(`
    UPDATE day_folders
    SET status = 'completed', completed_at = ?, sealed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(old, old, old, groupId)
}

function markFixtureSafeAndSealed(
  db: Database.Database,
  fixture: CleanupFixture,
  sealedAt = '2000-01-01T00:00:00.000Z'
): void {
  const dayFolderRepo = new DayFolderRepo()
  const taskRepo = new TaskRepo()
  const destinationRepo = getTaskDestinationRepo()

  dayFolderRepo.transitionStatus(fixture.groupId, 'sealed')
  taskRepo.updateStatus(fixture.taskId, 'completed')
  destinationRepo.updateStatus(fixture.taskId, 'aliyun-prod', 'completed')
  db.prepare(`
    UPDATE task_files
    SET status = 'completed', stable_count = 2
    WHERE id = ?
  `).run(fixture.fileId)
  destinationRepo.ensureForTaskFiles(fixture.taskId)
  for (const target of destinationRepo.listFileTargets(fixture.taskId)) {
    destinationRepo.updateFileStatus(
      target.id,
      'completed',
      `archive/${target.relativePath}`
    )
  }
  db.prepare(`
    UPDATE day_folders
    SET status = 'completed', completed_at = ?, sealed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(sealedAt, sealedAt, sealedAt, fixture.groupId)
}

test('cleanup safety requires sealed groups with completed tasks, destinations, and files', () => {
  const db = createDatabase()
  const root = mkdtempSync(join(tmpdir(), 'cleanup-safe-'))
  try {
    const fixture = createCleanupFixture(root)
    const dayFolderRepo = new DayFolderRepo()
    const taskRepo = new TaskRepo()
    const destinationRepo = getTaskDestinationRepo()

    assert.equal(dayFolderRepo.isSafeToClean(fixture.groupId), false)

    dayFolderRepo.transitionStatus(fixture.groupId, 'sealed')
    assert.equal(dayFolderRepo.isSafeToClean(fixture.groupId), false)

    taskRepo.updateStatus(fixture.taskId, 'completed')
    assert.equal(dayFolderRepo.isSafeToClean(fixture.groupId), false)

    destinationRepo.updateStatus(fixture.taskId, 'aliyun-prod', 'completed')
    assert.equal(dayFolderRepo.isSafeToClean(fixture.groupId), false)

    db.prepare(`
      UPDATE task_files
      SET status = 'completed', stable_count = 2
      WHERE id = ?
    `).run(fixture.fileId)
    assert.equal(dayFolderRepo.isSafeToClean(fixture.groupId), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    closeDatabase(db)
  }
})

test('cleanup service deletes and marks only safe sealed upload groups', async () => {
  const db = createDatabase()
  const root = mkdtempSync(join(tmpdir(), 'cleanup-delete-'))
  try {
    const fixture = createCleanupFixture(root)
    const dayFolderRepo = new DayFolderRepo()
    const taskRepo = new TaskRepo()
    const destinationRepo = getTaskDestinationRepo()

    saveProfiles([
      createProfile(
        'profile-1',
        root,
        {
          enabled: true,
          retentionDays: 0,
          onlyAfterSealed: true
        }
      )
    ], {
        enabled: true,
        retentionDays: 0,
        onlyAfterSealed: true
      })

    await new CleanupService().cleanup()
    assert.equal(existsSync(fixture.groupPath), true)

    dayFolderRepo.transitionStatus(fixture.groupId, 'sealed')
    taskRepo.updateStatus(fixture.taskId, 'completed')
    destinationRepo.updateStatus(fixture.taskId, 'aliyun-prod', 'completed')
    db.prepare(`
      UPDATE task_files
      SET status = 'completed', stable_count = 2
      WHERE id = ?
    `).run(fixture.fileId)
    getTaskDestinationRepo().ensureForTaskFiles(fixture.taskId)
    for (const target of getTaskDestinationRepo().listFileTargets(fixture.taskId)) {
      getTaskDestinationRepo().updateFileStatus(
        target.id,
        'completed',
        `archive/${target.relativePath}`
      )
    }
    setOldCompletedGroupTimestamps(db, fixture.groupId)

    await new CleanupService().cleanup()

    assert.equal(existsSync(fixture.groupPath), false)
    assert.equal(dayFolderRepo.getById(fixture.groupId)?.uploadGroupStatus, 'cleaned')
  } finally {
    rmSync(root, { recursive: true, force: true })
    closeDatabase(db)
  }
})

test('cleanup service resolves independent cleanup policies per profile', async () => {
  const db = createDatabase()
  const root = mkdtempSync(join(tmpdir(), 'cleanup-profile-enabled-'))
  try {
    const profileAFixture = createCleanupFixtureForProfile(root, 'profile-a', 'batch-a')
    const profileBFixture = createCleanupFixtureForProfile(root, 'profile-b', 'batch-b')
    saveProfiles([
      createProfile('profile-a', root, {
        enabled: true,
        retentionDays: 0,
        onlyAfterSealed: true
      }),
      createProfile('profile-b', root, {
        enabled: false,
        retentionDays: 0,
        onlyAfterSealed: true
      })
    ])
    markFixtureSafeAndSealed(db, profileAFixture)
    markFixtureSafeAndSealed(db, profileBFixture)

    await new CleanupService().cleanup()

    assert.equal(existsSync(profileAFixture.groupPath), false)
    assert.equal(existsSync(profileBFixture.groupPath), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    closeDatabase(db)
  }
})

test('cleanup service applies each profile retention independently', async () => {
  const db = createDatabase()
  const root = mkdtempSync(join(tmpdir(), 'cleanup-profile-retention-'))
  try {
    const profileAFixture = createCleanupFixtureForProfile(root, 'profile-a', 'batch-a')
    const profileBFixture = createCleanupFixtureForProfile(root, 'profile-b', 'batch-b')
    saveProfiles([
      createProfile('profile-a', root, {
        enabled: true,
        retentionDays: 0,
        onlyAfterSealed: true
      }),
      createProfile('profile-b', root, {
        enabled: true,
        retentionDays: 30,
        onlyAfterSealed: true
      })
    ])
    markFixtureSafeAndSealed(db, profileAFixture, '2000-01-01T00:00:00.000Z')
    markFixtureSafeAndSealed(db, profileBFixture, new Date().toISOString())

    await new CleanupService().cleanup()

    assert.equal(existsSync(profileAFixture.groupPath), false)
    assert.equal(existsSync(profileBFixture.groupPath), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    closeDatabase(db)
  }
})

test('cleanup service prefers task profile snapshot over current profile cleanup', async () => {
  const db = createDatabase()
  const root = mkdtempSync(join(tmpdir(), 'cleanup-profile-snapshot-'))
  try {
    const snapshotProfile = createProfile('profile-a', root, {
      enabled: true,
      retentionDays: 30,
      onlyAfterSealed: true
    })
    const fixture = createCleanupFixtureForProfile(
      root,
      'profile-a',
      'batch-a',
      snapshotProfile
    )
    saveProfiles([
      createProfile('profile-a', root, {
        enabled: true,
        retentionDays: 0,
        onlyAfterSealed: true
      })
    ])
    markFixtureSafeAndSealed(
      db,
      fixture,
      new Date(Date.now() - 1000).toISOString()
    )

    await new CleanupService().cleanup()

    assert.equal(existsSync(fixture.groupPath), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    closeDatabase(db)
  }
})

test('cleanup path safety guard rejects roots, traversal, and external symlinks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-guard-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'cleanup-guard-outside-'))
  const child = join(root, 'group-1')
  const symlinkPath = join(root, 'external-link')
  try {
    mkdirSync(child)
    symlinkSync(outside, symlinkPath, 'dir')

    assert.equal(await isSafeCleanupPath({ targetPath: root, sourceRoots: [root] }), false)
    assert.equal(await isSafeCleanupPath({ targetPath: '/', sourceRoots: [root] }), false)
    assert.equal(await isSafeCleanupPath({ targetPath: 'C:\\', sourceRoots: [root] }), false)
    assert.equal(
      await isSafeCleanupPath({ targetPath: join(root, '..'), sourceRoots: [root] }),
      false
    )
    assert.equal(
      await isSafeCleanupPath({ targetPath: symlinkPath, sourceRoots: [root] }),
      false
    )
    assert.equal(await isSafeCleanupPath({ targetPath: child, sourceRoots: [root] }), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
