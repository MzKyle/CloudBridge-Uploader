import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrations, setDbForTests } from '../src/main/db/database'
import { SettingsRepo } from '../src/main/db/settings.repo'
import { TaskDestinationRepo, type FileDestinationUploadTarget } from '../src/main/db/task-destination.repo'
import { TaskRepo } from '../src/main/db/task.repo'
import { CloudUploadService } from '../src/main/services/cloud-upload.service'
import { TaskRunnerService } from '../src/main/services/task-runner.service'
import type { CloudConnection, PathMappingConfig, Task } from '../src/shared/types'

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

function s3Connection(id: string, name = id): CloudConnection {
  return {
    id,
    name,
    type: 's3',
    config: {
      endpoint: 'http://localhost:9000',
      bucket: id,
      region: 'us-east-1',
      prefix: id,
      accessKeyId: '',
      accessKeySecret: '',
      forcePathStyle: true,
      allowInsecureTls: true
    }
  }
}

function createTaskWithDestinations(
  repo: TaskRepo,
  folderPath: string,
  connectionIds: string[]
): Task {
  return repo.create({
    folderPath,
    folderName: folderPath.split(/[\\/]/).at(-1) || 'task',
    sourceType: 'manual',
    destinations: connectionIds.map((connectionId) => ({
      connectionId,
      connectionName: connectionId,
      connectionType: connectionId === 'aliyun-prod' ? 'aliyun-oss' : 's3',
      prefix: connectionId,
      uploadRelativePath: ''
    })),
    ruleId: 'rule-multi',
    ruleName: 'Multi Destination',
    ruleSnapshot: {
      id: 'rule-multi',
      name: 'Multi Destination',
      enabled: true,
      source: { roots: [folderPath] },
      destinations: connectionIds.map((connectionId) => ({ connectionId })),
      pathMapping: { mode: 'keep-relative' },
      discovery: {},
      completion: { mode: 'rollover' },
      cleanup: { enabled: false, retentionDays: 7, onlyAfterSealed: true },
      filter: { whitelist: [], blacklist: [], regex: [], suffixes: [] }
    }
  })
}

test('two S3 connections create independent task and file destinations', () => {
  const db = createDatabase()
  try {
    const repo = new TaskRepo()
    const destinationRepo = new TaskDestinationRepo()
    const task = createTaskWithDestinations(repo, '/data/minio-task', [
      'minio-a',
      'minio-b'
    ])
    const file = repo.createFile(task.id, 'a.jpg', 10, 1)
    destinationRepo.ensureForTaskFiles(task.id)

    assert.deepEqual(
      destinationRepo.listByTask(task.id).map((destination) => destination.connectionId),
      ['minio-a', 'minio-b']
    )
    assert.equal('legacyProvider' in destinationRepo.listByTask(task.id)[0], false)
    assert.deepEqual(
      destinationRepo.listFileTargets(task.id).map((target) => ({
        taskFileId: target.taskFileId,
        connectionId: target.connectionId
      })),
      [
        { taskFileId: file.id, connectionId: 'minio-a' },
        { taskFileId: file.id, connectionId: 'minio-b' }
      ]
    )
    assert.equal('legacyProvider' in destinationRepo.listFileTargets(task.id)[0], false)
  } finally {
    closeDatabase(db)
  }
})

test('aliyun and two S3 connections coexist as three destinations', () => {
  const db = createDatabase()
  try {
    const task = createTaskWithDestinations(new TaskRepo(), '/data/three-way', [
      'aliyun-prod',
      'minio-a',
      'minio-b'
    ])

    assert.deepEqual(
      new TaskDestinationRepo().listByTask(task.id).map((destination) => destination.connectionId),
      ['aliyun-prod', 'minio-a', 'minio-b']
    )
  } finally {
    closeDatabase(db)
  }
})

test('destination status and progress are isolated by connectionId', () => {
  const db = createDatabase()
  try {
    const repo = new TaskRepo()
    const destinationRepo = new TaskDestinationRepo()
    const task = createTaskWithDestinations(repo, '/data/progress-task', [
      'minio-a',
      'minio-b'
    ])
    repo.createFile(task.id, 'a.jpg', 10, 1)
    destinationRepo.ensureForTaskFiles(task.id)

    destinationRepo.updateStatus(task.id, 'minio-a', 'completed')
    destinationRepo.updateStatus(task.id, 'minio-b', 'failed', 'network')
    destinationRepo.updateProgress(task.id, 'minio-a', 10, 100)
    destinationRepo.updateProgress(task.id, 'minio-b', 3, 30)
    destinationRepo.resetFailed(task.id, 'minio-b')

    assert.deepEqual(
      destinationRepo.listByTask(task.id).map((destination) => ({
        connectionId: destination.connectionId,
        status: destination.status,
        uploadedFiles: destination.uploadedFiles
      })),
      [
        { connectionId: 'minio-a', status: 'completed', uploadedFiles: 10 },
        { connectionId: 'minio-b', status: 'pending', uploadedFiles: 3 }
      ]
    )
  } finally {
    closeDatabase(db)
  }
})

test('duplicate object keys are isolated per connection', () => {
  interface ObjectKeyBaseContext {
    sourcePath: string
    basePath?: string
    variables: Record<string, string>
    rulePathMapping?: PathMappingConfig
  }
  interface TaskRunnerInternals {
    assertNoDuplicateObjectKeys: (
      destinationByConnectionId: Map<string, Task['destinations'][number]>,
      jobs: FileDestinationUploadTarget[],
      objectKeyBaseContext: ObjectKeyBaseContext
    ) => void
  }
  const service = new TaskRunnerService() as unknown as TaskRunnerInternals
  const context: ObjectKeyBaseContext = {
    sourcePath: '/data/task',
    variables: {},
    rulePathMapping: { mode: 'flatten' }
  }
  const destinationA = {
    id: 'dest-a',
    taskId: 'task-1',
    connectionId: 'minio-a',
    connectionName: 'Minio A',
    status: 'pending',
    prefix: 'archive',
    uploadRelativePath: '',
    pathMode: 'target-root',
    objectKeyTemplate: null,
    totalFiles: 0,
    uploadedFiles: 0,
    totalBytes: 0,
    uploadedBytes: 0,
    errorMessage: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null
  } as Task['destinations'][number]
  const destinationB = {
    ...destinationA,
    id: 'dest-b',
    connectionId: 'minio-b',
    connectionName: 'Minio B'
  } as Task['destinations'][number]
  const makeTarget = (
    id: string,
    taskDestinationId: string,
    connectionId: string,
    relativePath: string
  ): FileDestinationUploadTarget => ({
    id,
    taskFileId: `file-${id}`,
    taskDestinationId,
    connectionId,
    status: 'pending',
    objectKey: null,
    plannedObjectKey: null,
    uploadId: null,
    errorMessage: null,
    createdAt: destinationA.createdAt,
    updatedAt: destinationA.updatedAt,
    taskId: 'task-1',
    relativePath,
    fileSize: 10,
    mtimeMs: 1,
    retryCount: 0,
    nextRetryAt: null,
    sourceStatus: 'present',
    stableCount: 1
  })

  assert.doesNotThrow(() =>
    service.assertNoDuplicateObjectKeys(
      new Map([
        ['minio-a', destinationA],
        ['minio-b', destinationB]
      ]),
      [
        makeTarget('a1', 'dest-a', 'minio-a', 'left/a.jpg'),
        makeTarget('b1', 'dest-b', 'minio-b', 'right/a.jpg')
      ],
      context
    )
  )

  assert.throws(
    () =>
      service.assertNoDuplicateObjectKeys(
        new Map([['minio-a', destinationA]]),
        [
          makeTarget('a1', 'dest-a', 'minio-a', 'left/a.jpg'),
          makeTarget('a2', 'dest-a', 'minio-a', 'right/a.jpg')
        ],
        context
      ),
    /minio-a 对象 Key 重复/
  )
})

test('retrying a failed S3 connection does not re-upload the succeeded S3 connection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'destination-retry-'))
  const db = createDatabase()
  const originalCreateUploader = CloudUploadService.prototype.createTaskUploader
  const originalValidate = CloudUploadService.prototype.validateConnection
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'a.jpg'), 'image')
    new SettingsRepo().saveAll({
      connections: [s3Connection('minio-a'), s3Connection('minio-b')]
    })
    const task = createTaskWithDestinations(new TaskRepo(), root, [
      'minio-a',
      'minio-b'
    ])
    const calls = new Map<string, number>()
    let minioBShouldFail = true

    CloudUploadService.prototype.validateConnection = () => null
    CloudUploadService.prototype.createTaskUploader = async function (connection) {
      return {
        provider: 'tencent',
        uploadFile: async (_filePath, objectKey) => {
          calls.set(connection.id, (calls.get(connection.id) || 0) + 1)
          if (connection.id === 'minio-b' && minioBShouldFail) {
            throw new Error('minio-b failed')
          }
          return { objectKey }
        },
        uploadBuffer: async (_buffer, objectKey) => objectKey,
        abort: () => {},
        dispose: () => {}
      }
    }

    await new TaskRunnerService().run(task)
    assert.deepEqual(Object.fromEntries(calls), {
      'minio-a': 1,
      'minio-b': 1
    })
    assert.deepEqual(
      new TaskDestinationRepo().listByTask(task.id).map((destination) => ({
        connectionId: destination.connectionId,
        status: destination.status
      })),
      [
        { connectionId: 'minio-a', status: 'completed' },
        { connectionId: 'minio-b', status: 'failed' }
      ]
    )

    minioBShouldFail = false
    new TaskRepo().retry(task.id, 'minio-b')
    await new TaskRunnerService().run(new TaskRepo().getById(task.id)!)

    assert.deepEqual(Object.fromEntries(calls), {
      'minio-a': 1,
      'minio-b': 2
    })
  } finally {
    CloudUploadService.prototype.createTaskUploader = originalCreateUploader
    CloudUploadService.prototype.validateConnection = originalValidate
    closeDatabase(db)
    rmSync(root, { recursive: true, force: true })
  }
})

test('migration rewrites destination unique constraints to connectionId and preserves data', () => {
  const db = createDatabase()
  try {
    const now = new Date().toISOString()
    db.pragma('foreign_keys = OFF')
    db.exec(`
      DROP TABLE task_file_destinations;
      DROP TABLE task_destinations;
      CREATE TABLE task_destinations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        connection_id TEXT,
        connection_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        prefix TEXT NOT NULL DEFAULT '',
        upload_relative_path TEXT NOT NULL DEFAULT '',
        path_mode TEXT NOT NULL DEFAULT 'target-root',
        object_key_template TEXT,
        total_files INTEGER NOT NULL DEFAULT 0,
        uploaded_files INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        uploaded_bytes INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(task_id, provider)
      );
      CREATE TABLE task_file_destinations (
        id TEXT PRIMARY KEY,
        task_file_id TEXT NOT NULL,
        task_destination_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        connection_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        object_key TEXT,
        planned_object_key TEXT,
        upload_id TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_file_id, provider)
      );
    `)
    db.pragma('foreign_keys = ON')
    db.prepare(
      `INSERT INTO tasks (
        id, folder_path, folder_name, status, oss_prefix, upload_target_mode,
        upload_relative_path, source_type, created_at, updated_at
      ) VALUES ('task-old', '/data/old', 'old', 'pending', '', 'both', '', 'manual', ?, ?)`
    ).run(now, now)
    db.prepare(
      `INSERT INTO task_files (
        id, task_id, relative_path, file_size, status, mtime_ms,
        last_seen_at, source_status, stable_count, created_at, updated_at
      ) VALUES ('file-old', 'task-old', 'a.jpg', 10, 'failed', 1, ?, 'present', 1, ?, ?)`
    ).run(now, now, now)
    db.prepare(
      `INSERT INTO task_destinations (
        id, task_id, provider, status, total_files, uploaded_files,
        total_bytes, uploaded_bytes, error_message, created_at, updated_at
      ) VALUES ('dest-old', 'task-old', 'tencent', 'failed', 1, 0, 10, 0, 'network', ?, ?)`
    ).run(now, now)
    db.prepare(
      `INSERT INTO task_file_destinations (
        id, task_file_id, task_destination_id, provider, status, object_key,
        upload_id, error_message, created_at, updated_at
      ) VALUES ('target-old', 'file-old', 'dest-old', 'tencent', 'failed', 'old/a.jpg', 'upload-1', 'network', ?, ?)`
    ).run(now, now)

    runMigrations(db)

    assert.equal(hasUniqueIndex(db, 'task_destinations', ['task_id', 'connection_id']), true)
    assert.equal(hasUniqueIndex(db, 'task_file_destinations', ['task_file_id', 'connection_id']), true)
    assert.deepEqual(
      db.prepare(
        `SELECT connection_id, status, total_files, uploaded_files,
          total_bytes, uploaded_bytes, error_message
         FROM task_destinations`
      ).all(),
      [
        {
          connection_id: 's3-compatible',
          status: 'failed',
          total_files: 1,
          uploaded_files: 0,
          total_bytes: 10,
          uploaded_bytes: 0,
          error_message: 'network'
        }
      ]
    )
    assert.deepEqual(
      db.prepare(
        `SELECT connection_id, status, object_key, upload_id, error_message
         FROM task_file_destinations`
      ).all(),
      [
        {
          connection_id: 's3-compatible',
          status: 'failed',
          object_key: 'old/a.jpg',
          upload_id: 'upload-1',
          error_message: 'network'
        }
      ]
    )
  } finally {
    closeDatabase(db)
  }
})

function hasUniqueIndex(
  db: Database.Database,
  table: string,
  columns: string[]
): boolean {
  const indexes = db.pragma(`index_list(${table})`) as Array<{
    name: string
    unique: number
  }>
  return indexes.some((index) => {
    if (!index.unique) return false
    const indexedColumns = (db.pragma(`index_info(${index.name})`) as Array<{
      name: string
    }>).map((column) => column.name)
    return (
      indexedColumns.length === columns.length &&
      indexedColumns.every((column, index) => column === columns[index])
    )
  })
}
