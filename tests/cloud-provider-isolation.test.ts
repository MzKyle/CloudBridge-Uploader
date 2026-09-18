import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { getActiveRuleScanRoots } from '../src/shared/scan-config'
import { migrateSettingsToV3 } from '../src/main/migrations/v2-to-v3-settings'
import { runMigrations, setDbForTests } from '../src/main/db/database'
import { getUploadGroupRepo } from '../src/main/db/upload-group.repo'
import { getHistoryRepo } from '../src/main/db/history.repo'
import {
  getTaskDestinationRepo,
  type TaskDestinationCreateInput
} from '../src/main/db/task-destination.repo'
import { getTaskRepo } from '../src/main/db/task.repo'
import { ScannerService } from '../src/main/services/scanner.service'
import type { Task } from '../src/shared/types'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  setDbForTests(db)
  return db
}

function closeTestDb(db: Database.Database): void {
  setDbForTests(null)
  db.close()
}

function listStoredDestinationProviders(
  db: Database.Database,
  taskId: string
): Array<{ provider: string; connectionId: string; uploadRelativePath: string }> {
  return db.prepare(
    `SELECT provider, connection_id AS connectionId, upload_relative_path AS uploadRelativePath
     FROM task_destinations
     WHERE task_id = ?
     ORDER BY connection_id`
  ).all(taskId) as Array<{
    provider: string
    connectionId: string
    uploadRelativePath: string
  }>
}

function cloudDestinations(
  uploadRelativePath: string,
  prefixes: Partial<Record<'aliyun' | 'tencent', string>>
): TaskDestinationCreateInput[] {
  const destinations: TaskDestinationCreateInput[] = []
  if (prefixes.aliyun !== undefined) {
    destinations.push({
      connectionId: 'aliyun-prod',
      connectionName: '阿里云 OSS',
      connectionType: 'aliyun-oss',
      prefix: prefixes.aliyun,
      uploadRelativePath
    })
  }
  if (prefixes.tencent !== undefined) {
    destinations.push({
      connectionId: 's3-compatible',
      connectionName: 'S3 兼容存储',
      connectionType: 's3',
      prefix: prefixes.tencent,
      uploadRelativePath
    })
  }
  return destinations
}

test('migrates legacy provider directories into V3 rule source roots', () => {
  const settings = migrateSettingsToV3({
    cloud: { targetMode: 'both' },
    scan: {
      directories: ['/data', '/extra'],
      providerDirectories: { aliyun: [], tencent: [] },
      intervalSeconds: 30
    },
    profiles: []
  })

  assert.equal(settings.schemaVersion, 3)
  assert.deepEqual(settings.rules[0].source.roots, ['/data', '/extra'])
  assert.deepEqual(
    settings.rules[0].destinations.map((destination) => destination.connectionId),
    ['aliyun-prod', 's3-compatible']
  )
})

test('splits legacy profiles when provider roots diverge', () => {
  const settings = migrateSettingsToV3({
    profiles: [
      {
        id: 'capture',
        name: 'Capture',
        enabled: true,
        targetMode: 'both',
        scan: {
          providerDirectories: {
            aliyun: ['/data/a'],
            tencent: ['/data/t']
          }
        }
      }
    ]
  })

  assert.deepEqual(settings.rules.map((rule) => rule.id), [
    'capture-aliyun',
    'capture-s3'
  ])
  assert.deepEqual(getActiveRuleScanRoots(settings.rules), [
    { directory: '/data/a', ruleId: 'capture-aliyun', ruleName: 'Capture / Aliyun' },
    { directory: '/data/t', ruleId: 'capture-s3', ruleName: 'Capture / S3' }
  ])
})

test('scanner task registration snapshots connection destinations', () => {
  const db = createTestDb()
  try {
    const uploadGroup = getUploadGroupRepo().ensure('/data/2026-06-27', '2026-06-27')
    const scanner = new ScannerService() as unknown as {
      ensureTaskRegistered: (
        dirPath: string,
        folderName: string,
        uploadGroupId: string,
        uploadRelativePath: string,
        targetSnapshot: {
          ruleId: string
          ruleName: string
          ruleSnapshot: Task['ruleSnapshot']
          destinations: Array<{
            connectionId: string
            connectionName: string
            connectionType: 'aliyun-oss' | 's3'
            prefix: string
          }>
        }
      ) => Task
    }

    const bothTask = scanner.ensureTaskRegistered(
      '/data/2026-06-27/both',
      'both',
      uploadGroup.id,
      '2026-06-27/both',
      {
        ruleId: 'rule-1',
        ruleName: 'Rule 1',
        ruleSnapshot: null,
        destinations: [
          {
            connectionId: 'aliyun-prod',
            connectionName: 'Aliyun',
            connectionType: 'aliyun-oss',
            prefix: 'ali/'
          },
          {
            connectionId: 's3-compatible',
            connectionName: 'S3',
            connectionType: 's3',
            prefix: 'ten/'
          }
        ]
      }
    )

    assert.deepEqual(
      getTaskDestinationRepo().listByTask(bothTask.id).map((item) => ({
        connectionId: item.connectionId,
        uploadRelativePath: item.uploadRelativePath
      })),
      [
        { connectionId: 'aliyun-prod', uploadRelativePath: '2026-06-27/both' },
        { connectionId: 's3-compatible', uploadRelativePath: '2026-06-27/both' }
      ]
    )
    assert.equal(
      'legacyProvider' in getTaskDestinationRepo().listByTask(bothTask.id)[0],
      false
    )
    assert.deepEqual(listStoredDestinationProviders(db, bothTask.id), [
      { provider: 'aliyun', connectionId: 'aliyun-prod', uploadRelativePath: '2026-06-27/both' },
      { provider: 'tencent', connectionId: 's3-compatible', uploadRelativePath: '2026-06-27/both' }
    ])
  } finally {
    closeTestDb(db)
  }
})

test('history delete and clear are scoped to the selected connection', () => {
  const db = createTestDb()
  try {
    const task = getTaskRepo().create({
      folderPath: '/data/both',
      folderName: 'both',
      ossPrefix: 'ali/',
      destinations: cloudDestinations('both', { aliyun: 'ali/', tencent: 'ten/' }),
      uploadRelativePath: 'both',
      sourceType: 'manual'
    })
    getTaskDestinationRepo().updateStatus(task.id, 'aliyun-prod', 'completed')
    getTaskDestinationRepo().updateStatus(task.id, 's3-compatible', 'completed')

    assert.equal(getHistoryRepo().list({ page: 1, pageSize: 20, connectionId: 'aliyun-prod' }).total, 1)
    assert.equal(getHistoryRepo().list({ page: 1, pageSize: 20, connectionId: 's3-compatible' }).total, 1)

    getHistoryRepo().deleteById(task.id, 'aliyun-prod')
    assert.deepEqual(
      getTaskDestinationRepo().listByTask(task.id).map((item) => item.connectionId),
      ['s3-compatible']
    )
    assert.equal(getTaskRepo().getById(task.id)?.id, task.id)

    getHistoryRepo().deleteById(task.id, 's3-compatible')
    assert.equal(getTaskRepo().getById(task.id), null)

    const aliyunOnly = getTaskRepo().create({
      folderPath: '/data/aliyun-only',
      folderName: 'aliyun-only',
      ossPrefix: 'ali/',
      destinations: cloudDestinations('aliyun-only', { aliyun: 'ali/' }),
      uploadRelativePath: 'aliyun-only',
      sourceType: 'manual'
    })
    const tencentOnly = getTaskRepo().create({
      folderPath: '/data/tencent-only',
      folderName: 'tencent-only',
      ossPrefix: '',
      destinations: cloudDestinations('tencent-only', { tencent: 'ten/' }),
      uploadRelativePath: 'tencent-only',
      sourceType: 'manual'
    })
    getTaskDestinationRepo().updateStatus(aliyunOnly.id, 'aliyun-prod', 'completed')
    getTaskDestinationRepo().updateStatus(tencentOnly.id, 's3-compatible', 'completed')

    getHistoryRepo().clear(undefined, 'aliyun-prod')
    assert.equal(getTaskRepo().getById(aliyunOnly.id), null)
    assert.equal(getTaskRepo().getById(tencentOnly.id)?.id, tencentOnly.id)
  } finally {
    closeTestDb(db)
  }
})

test('upload group summaries can be filtered and deleted by connection', () => {
  const db = createTestDb()
  try {
    const uploadGroup = getUploadGroupRepo().ensure('/data/2026-06-27', '2026-06-27')
    const task = getTaskRepo().create({
      folderPath: '/data/2026-06-27/both',
      folderName: 'both',
      ossPrefix: 'ali/',
      destinations: cloudDestinations('2026-06-27/both', { aliyun: 'ali/', tencent: 'ten/' }),
      uploadGroupId: uploadGroup.id,
      uploadRelativePath: '2026-06-27/both',
      sourceType: 'local'
    })
    getTaskDestinationRepo().updateStatus(task.id, 'aliyun-prod', 'synced')
    getTaskDestinationRepo().updateStatus(task.id, 's3-compatible', 'synced')
    db.prepare(
      "UPDATE day_folders SET status = 'completed', completed_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), uploadGroup.id)

    assert.equal(getUploadGroupRepo().list({ connectionId: 'aliyun-prod' }).length, 1)
    assert.equal(getUploadGroupRepo().list({ connectionId: 's3-compatible' }).length, 1)

    getUploadGroupRepo().deleteCompleted(uploadGroup.id, 'aliyun-prod')
    assert.equal(getUploadGroupRepo().list({ connectionId: 'aliyun-prod' }).length, 0)
    assert.equal(getUploadGroupRepo().list({ connectionId: 's3-compatible' }).length, 1)
    assert.equal(getUploadGroupRepo().getById(uploadGroup.id)?.id, uploadGroup.id)

    getUploadGroupRepo().deleteCompleted(uploadGroup.id, 's3-compatible')
    assert.equal(getUploadGroupRepo().getById(uploadGroup.id), null)
  } finally {
    closeTestDb(db)
  }
})
