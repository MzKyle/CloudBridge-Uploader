import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import {
  runMigrations,
  setDbForTests
} from '../src/main/db/database'
import { SettingsRepo } from '../src/main/db/settings.repo'
import { TaskRepo } from '../src/main/db/task.repo'
import { TaskDestinationRepo } from '../src/main/db/task-destination.repo'
import { CloudUploadService } from '../src/main/services/cloud-upload.service'
import { TaskRunnerService } from '../src/main/services/task-runner.service'
import type { CloudConnection, UploadRule } from '../src/shared/types'

function createDatabase(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  setDbForTests(db)
  return db
}

function insertLegacyUploadGroup(db: Database.Database, id: string): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO day_folders (
      id, folder_path, folder_name, date_value, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `/data/${id}`,
    id,
    '2026-06-18',
    now,
    now
  )
}

function s3Connection(id: string): CloudConnection {
  return {
    id,
    name: id,
    type: 's3',
    config: {
      endpoint: 'http://localhost:9000',
      bucket: id,
      region: 'us-east-1',
      prefix: '',
      accessKeyId: '',
      accessKeySecret: '',
      forcePathStyle: true,
      allowInsecureTls: true
    }
  }
}

function uploadRule(id: string, root: string, connectionId: string): UploadRule {
  return {
    ...(DEFAULT_SETTINGS.rules[0] as UploadRule),
    id,
    name: id,
    source: { roots: [root] },
    destinations: [{ connectionId }],
    pathMapping: { mode: 'keep-relative' },
    filter: {
      whitelist: [],
      blacklist: [],
      regex: [],
      suffixes: ['.jpg']
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function listComparableTaskFiles(
  db: Database.Database,
  taskId: string
): Array<Record<string, unknown>> {
  return db.prepare(
    `SELECT relative_path AS relativePath,
       file_size AS fileSize,
       mtime_ms AS mtimeMs,
       status,
       source_status AS sourceStatus,
       stable_count AS stableCount
     FROM task_files
     WHERE task_id = ?
     ORDER BY relative_path`
  ).all(taskId) as Array<Record<string, unknown>>
}

test('incremental discovery waits for stability and requeues changed files', () => {
  const db = createDatabase()
  const repo = new TaskRepo()
  const destinationRepo = new TaskDestinationRepo()
  insertLegacyUploadGroup(db, 'day-1')
  const task = repo.create({
    folderPath: '/data/2026-06-18/work-1',
    folderName: 'work-1',
    uploadGroupId: 'day-1',
    uploadRelativePath: '2026-06-18/work-1'
  })

  const first = repo.reconcileFiles(
    task.id,
    [{ relativePath: 'camera/1.jpg', size: 10, mtimeMs: 100 }],
    2
  )
  assert.equal(first.unstableFiles, 1)
  assert.equal(repo.getById(task.id)?.status, 'scanning')

  const second = repo.reconcileFiles(
    task.id,
    [{ relativePath: 'camera/1.jpg', size: 10, mtimeMs: 100 }],
    2
  )
  assert.equal(second.readyFiles, 1)
  assert.equal(repo.getById(task.id)?.status, 'pending')

  const target = destinationRepo.listFileTargets(task.id)[0]
  destinationRepo.updateFileStatus(target.id, 'completed', 'key')
  destinationRepo.recalculateLogicalFile(target.taskFileId)
  repo.recalculateProgress(task.id)
  repo.reconcileFiles(
    task.id,
    [{ relativePath: 'camera/1.jpg', size: 10, mtimeMs: 100 }],
    2
  )
  assert.equal(repo.getById(task.id)?.status, 'synced')

  repo.reconcileFiles(
    task.id,
    [{ relativePath: 'camera/1.jpg', size: 12, mtimeMs: 200 }],
    2
  )
  assert.equal(repo.getById(task.id)?.status, 'scanning')
  assert.equal(
    destinationRepo.listFileTargets(task.id)[0].status,
    'pending'
  )

  setDbForTests(null)
  db.close()
})

test('batched reconcile matches array reconcile for changed and missing files', async () => {
  const db = createDatabase()
  const repo = new TaskRepo()
  insertLegacyUploadGroup(db, 'day-batched-equivalence')
  const arrayTask = repo.create({
    folderPath: '/data/2026-06-18/work-array',
    folderName: 'work-array',
    uploadGroupId: 'day-batched-equivalence',
    uploadRelativePath: '2026-06-18/work-array'
  })
  const batchedTask = repo.create({
    folderPath: '/data/2026-06-18/work-batched',
    folderName: 'work-batched',
    uploadGroupId: 'day-batched-equivalence',
    uploadRelativePath: '2026-06-18/work-batched'
  })
  const initialFiles = [
    { relativePath: 'camera/1.jpg', size: 10, mtimeMs: 100 },
    { relativePath: 'camera/2.jpg', size: 20, mtimeMs: 100 },
    { relativePath: 'camera/3.jpg', size: 30, mtimeMs: 100 }
  ]
  const nextFiles = [
    { relativePath: 'camera/1.jpg', size: 10, mtimeMs: 100 },
    { relativePath: 'camera/2.jpg', size: 22, mtimeMs: 200 },
    { relativePath: 'camera/4.jpg', size: 40, mtimeMs: 100 }
  ]

  repo.reconcileFiles(arrayTask.id, initialFiles, 2)
  repo.reconcileFiles(arrayTask.id, initialFiles, 2)
  await repo.reconcileFileBatches(batchedTask.id, chunk(initialFiles, 2), 2)
  await repo.reconcileFileBatches(batchedTask.id, chunk(initialFiles, 2), 2)

  const arrayResult = repo.reconcileFiles(arrayTask.id, nextFiles, 2)
  const batchedResult = await repo.reconcileFileBatches(
    batchedTask.id,
    chunk(nextFiles, 2),
    2
  )

  assert.deepEqual(batchedResult, arrayResult)
  assert.deepEqual(
    listComparableTaskFiles(db, batchedTask.id),
    listComparableTaskFiles(db, arrayTask.id)
  )

  setDbForTests(null)
  db.close()
})

test('reconciling 10000 small files remains idempotent', () => {
  const db = createDatabase()
  const repo = new TaskRepo()
  insertLegacyUploadGroup(db, 'day-2')
  const task = repo.create({
    folderPath: '/data/2026-06-18/work-2',
    folderName: 'work-2',
    uploadGroupId: 'day-2',
    uploadRelativePath: '2026-06-18/work-2'
  })
  const files = Array.from({ length: 10_000 }, (_, index) => ({
    relativePath: `camera/${String(index).padStart(5, '0')}.jpg`,
    size: 1024,
    mtimeMs: 100
  }))

  repo.reconcileFiles(task.id, files, 2)
  repo.reconcileFiles(task.id, files, 2)

  const fileCount = db.prepare(
    'SELECT COUNT(*) AS count FROM task_files WHERE task_id = ?'
  ).get(task.id) as { count: number }
  const targetCount = db.prepare(
    `SELECT COUNT(*) AS count
     FROM task_file_destinations
     WHERE task_file_id IN (SELECT id FROM task_files WHERE task_id = ?)`
  ).get(task.id) as { count: number }
  assert.equal(fileCount.count, 10_000)
  assert.equal(targetCount.count, 10_000)
  assert.equal(repo.getById(task.id)?.status, 'pending')

  setDbForTests(null)
  db.close()
})

test('batched reconcile handles 10000 small files idempotently', async () => {
  const db = createDatabase()
  const repo = new TaskRepo()
  insertLegacyUploadGroup(db, 'day-batched-10000')
  const task = repo.create({
    folderPath: '/data/2026-06-18/work-batched-10000',
    folderName: 'work-batched-10000',
    uploadGroupId: 'day-batched-10000',
    uploadRelativePath: '2026-06-18/work-batched-10000'
  })
  const files = Array.from({ length: 10_000 }, (_, index) => ({
    relativePath: `camera/${String(index).padStart(5, '0')}.jpg`,
    size: 1024,
    mtimeMs: 100
  }))

  await repo.reconcileFileBatches(task.id, chunk(files, 500), 2)
  await repo.reconcileFileBatches(task.id, chunk(files, 500), 2)

  const fileCount = db.prepare(
    'SELECT COUNT(*) AS count FROM task_files WHERE task_id = ?'
  ).get(task.id) as { count: number }
  const targetCount = db.prepare(
    `SELECT COUNT(*) AS count
     FROM task_file_destinations
     WHERE task_file_id IN (SELECT id FROM task_files WHERE task_id = ?)`
  ).get(task.id) as { count: number }
  assert.equal(fileCount.count, 10_000)
  assert.equal(targetCount.count, 10_000)
  assert.equal(repo.getById(task.id)?.status, 'pending')

  setDbForTests(null)
  db.close()
})

test('retrying one cloud preserves an already synced destination', () => {
  const db = createDatabase()
  const repo = new TaskRepo()
  const destinationRepo = new TaskDestinationRepo()
  insertLegacyUploadGroup(db, 'day-3')
  const task = repo.create({
    folderPath: '/data/2026-06-18/work-3',
    folderName: 'work-3',
    uploadGroupId: 'day-3',
    uploadRelativePath: '2026-06-18/work-3',
    destinations: [
      {
        connectionId: 'aliyun-prod',
        connectionName: '阿里云 OSS',
        connectionType: 'aliyun-oss',
        uploadRelativePath: '2026-06-18/work-3'
      },
      {
        connectionId: 's3-compatible',
        connectionName: 'S3 兼容存储',
        connectionType: 's3',
        uploadRelativePath: '2026-06-18/work-3'
      }
    ]
  })
  destinationRepo.updateStatus(task.id, 'aliyun-prod', 'synced')
  destinationRepo.updateStatus(task.id, 's3-compatible', 'failed', 'network')

  repo.retry(task.id, 's3-compatible')

  assert.deepEqual(
    destinationRepo.listByTask(task.id).map(({ connectionId, status }) => ({
      connectionId,
      status
    })),
    [
      { connectionId: 'aliyun-prod', status: 'synced' },
      { connectionId: 's3-compatible', status: 'pending' }
    ]
  )

  setDbForTests(null)
  db.close()
})

test('runner requeues a file changed during upload and later uploads the stable version', async () => {
  const db = createDatabase()
  const root = mkdtempSync(join(tmpdir(), 'mutation-upload-'))
  const originalCreateUploader = CloudUploadService.prototype.createTaskUploader
  const originalValidate = CloudUploadService.prototype.validateConnection
  try {
    const filePath = join(root, 'a.jpg')
    mkdirSync(root, { recursive: true })
    writeFileSync(filePath, 'version-a')
    utimesSync(filePath, new Date(1000), new Date(1000))

    const connection = s3Connection('archive-a')
    const rule = uploadRule('rule-mutation', root, connection.id)
    new SettingsRepo().saveAll({
      connections: [connection],
      upload: {
        ...DEFAULT_SETTINGS.upload,
        maxFilesPerTask: 1,
        maxConcurrentUploads: 1
      }
    })
    const task = new TaskRepo().create({
      folderPath: root,
      folderName: 'mutation-upload',
      sourceType: 'manual',
      destinations: [
        {
          connectionId: connection.id,
          connectionName: connection.name,
          connectionType: connection.type,
          prefix: 'archive',
          uploadRelativePath: ''
        }
      ],
      ruleId: rule.id,
      ruleName: rule.name,
      ruleSnapshot: rule
    })

    const uploaded: string[] = []
    let mutated = false
    CloudUploadService.prototype.validateConnection = () => null
    CloudUploadService.prototype.createTaskUploader = async () => ({
      provider: 'tencent',
      uploadFile: async (path, objectKey) => {
        uploaded.push(`${objectKey}:${readFileSync(path, 'utf8')}`)
        if (!mutated) {
          mutated = true
          writeFileSync(path, 'version-b')
          utimesSync(path, new Date(2000), new Date(2000))
        }
        return { objectKey }
      },
      uploadBuffer: async (_buffer, objectKey) => objectKey,
      abort: () => {},
      dispose: () => {}
    })

    assert.equal(await new TaskRunnerService().run(task), 'retrying')
    assert.deepEqual(uploaded, ['archive/a.jpg:version-a'])
    assert.equal(new TaskRepo().getById(task.id)?.status, 'pending')
    assert.equal(new TaskDestinationRepo().listFileTargets(task.id)[0].status, 'pending')

    assert.equal(
      await new TaskRunnerService().run(new TaskRepo().getById(task.id)!),
      'completed'
    )
    assert.deepEqual(uploaded, [
      'archive/a.jpg:version-a',
      'archive/a.jpg:version-b'
    ])
    assert.equal(new TaskDestinationRepo().listFileTargets(task.id)[0].status, 'completed')
  } finally {
    CloudUploadService.prototype.createTaskUploader = originalCreateUploader
    CloudUploadService.prototype.validateConnection = originalValidate
    rmSync(root, { recursive: true, force: true })
    setDbForTests(null)
    db.close()
  }
})
