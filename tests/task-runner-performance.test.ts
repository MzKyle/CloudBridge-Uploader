import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  runMigrations,
  setDbForTests
} from '../src/main/db/database'
import {
  TaskDestinationRepo,
  type FileDestinationUploadTarget
} from '../src/main/db/task-destination.repo'
import { TaskRepo } from '../src/main/db/task.repo'
import { TaskRunnerService } from '../src/main/services/task-runner.service'
import type { PathMappingConfig, Task } from '../src/shared/types'

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

function insertLegacyUploadGroup(
  db: Database.Database,
  id: string,
  dateValue = '2026-06-30'
): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO day_folders (
      id, folder_path, folder_name, date_value, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, `/data/${id}`, id, dateValue, now, now)
}

test('logical progress persistence is throttled and force flushes latest values', () => {
  const originalUpdateProgress = TaskRepo.prototype.updateProgress
  const originalNow = Date.now
  const calls: Array<{
    taskId: string
    uploadedFiles: number
    uploadedBytes: number
  }> = []
  let now = 1_000_000

  TaskRepo.prototype.updateProgress = function (
    taskId: string,
    uploadedFiles: number,
    uploadedBytes: number
  ): void {
    calls.push({ taskId, uploadedFiles, uploadedBytes })
  }
  Date.now = () => now

  try {
    const service = new TaskRunnerService() as unknown as {
      persistLogicalProgress: (
        taskId: string,
        logicalProgress: {
          completedThisRun: Set<string>
          uploadedFiles: number
          uploadedBytes: number
          lastPersistAt: number
        },
        force?: boolean
      ) => void
    }
    const progress = {
      completedThisRun: new Set<string>(),
      uploadedFiles: 1,
      uploadedBytes: 10,
      lastPersistAt: 0
    }

    service.persistLogicalProgress('task-1', progress)
    progress.uploadedFiles = 2
    progress.uploadedBytes = 20
    now += 250
    service.persistLogicalProgress('task-1', progress)

    assert.deepEqual(calls, [
      { taskId: 'task-1', uploadedFiles: 1, uploadedBytes: 10 }
    ])

    progress.uploadedFiles = 3
    progress.uploadedBytes = 30
    service.persistLogicalProgress('task-1', progress, true)

    assert.deepEqual(calls, [
      { taskId: 'task-1', uploadedFiles: 1, uploadedBytes: 10 },
      { taskId: 'task-1', uploadedFiles: 3, uploadedBytes: 30 }
    ])
  } finally {
    TaskRepo.prototype.updateProgress = originalUpdateProgress
    Date.now = originalNow
  }
})

test('upload slot weight treats multipart-sized files as weighted work', () => {
  const service = new TaskRunnerService() as unknown as {
    getUploadSlotWeight: (
      fileSize: number,
      multipartThreshold: number,
      maxConcurrentUploads: number
    ) => number
  }
  const threshold = 100 * 1024 * 1024

  assert.equal(service.getUploadSlotWeight(threshold, threshold, 12), 1)
  assert.equal(service.getUploadSlotWeight(threshold + 1, threshold, 12), 4)
  assert.equal(service.getUploadSlotWeight(threshold + 1, threshold, 2), 2)
})

test('unfinished task id listing avoids destination hydration', () => {
  const db = createDatabase()

  const originalListByTaskIds = TaskDestinationRepo.prototype.listByTaskIds
  let destinationBatchLoads = 0
  const createdAt = {
    pending: '2026-06-30T00:00:00.000Z',
    completed: '2026-06-30T00:00:01.000Z',
    paused: '2026-06-30T00:00:02.000Z'
  }
  const insertTask = db.prepare(`
    INSERT INTO tasks (
      id, folder_path, folder_name, status, oss_prefix, upload_target_mode,
      upload_relative_path, source_type, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', 'aliyun', ?, 'local', ?, ?)
  `)

  try {
    insertTask.run(
      'pending-task',
      '/tmp/pending-task',
      'pending-task',
      'pending',
      'pending-task',
      createdAt.pending,
      createdAt.pending
    )
    insertTask.run(
      'completed-task',
      '/tmp/completed-task',
      'completed-task',
      'completed',
      'completed-task',
      createdAt.completed,
      createdAt.completed
    )
    insertTask.run(
      'paused-task',
      '/tmp/paused-task',
      'paused-task',
      'paused',
      'paused-task',
      createdAt.paused,
      createdAt.paused
    )

    TaskDestinationRepo.prototype.listByTaskIds = function (taskIds: string[]) {
      destinationBatchLoads++
      return originalListByTaskIds.call(this, taskIds)
    }

    const repo = new TaskRepo()
    assert.deepEqual(repo.listUnfinishedTaskIds(), [
      'pending-task',
      'paused-task'
    ])
    assert.equal(destinationBatchLoads, 0)
  } finally {
    TaskDestinationRepo.prototype.listByTaskIds = originalListByTaskIds
    closeDatabase(db)
  }
})

test('continuous monitor id listing avoids destination hydration', () => {
  const db = createDatabase()
  const repo = new TaskRepo()
  const originalListByTaskIds = TaskDestinationRepo.prototype.listByTaskIds
  let destinationBatchLoads = 0

  try {
    insertLegacyUploadGroup(db, 'day-1')
    insertLegacyUploadGroup(db, 'day-2', '2026-07-01')
    const pending = repo.create({
      folderPath: '/data/day-1/work-pending',
      folderName: 'work-pending',
      uploadGroupId: 'day-1',
      uploadRelativePath: 'day-1/work-pending'
    })
    const skipped = repo.create({
      folderPath: '/data/day-1/work-skipped',
      folderName: 'work-skipped',
      uploadGroupId: 'day-1',
      uploadRelativePath: 'day-1/work-skipped'
    })
    repo.skip(skipped.id)
    repo.create({
      folderPath: '/data/day-2/work-other',
      folderName: 'work-other',
      uploadGroupId: 'day-2',
      uploadRelativePath: 'day-2/work-other'
    })

    TaskDestinationRepo.prototype.listByTaskIds = function (taskIds: string[]) {
      destinationBatchLoads++
      return originalListByTaskIds.call(this, taskIds)
    }

    assert.deepEqual(repo.listContinuouslyMonitoredTaskIds('2026-06-30'), [
      pending.id
    ])
    assert.equal(destinationBatchLoads, 0)
  } finally {
    TaskDestinationRepo.prototype.listByTaskIds = originalListByTaskIds
    closeDatabase(db)
  }
})

test('scanner-style reconcile does not rewrite planned object keys', () => {
  const db = createDatabase()
  const taskRepo = new TaskRepo()
  const destinationRepo = new TaskDestinationRepo()

  try {
    const task = taskRepo.create({
      folderPath: '/tmp/source',
      folderName: 'source',
      destinations: [
        {
          connectionId: 'aliyun-prod',
          connectionName: '阿里云 OSS',
          connectionType: 'aliyun-oss',
          prefix: '',
          uploadRelativePath: 'source'
        },
        {
          connectionId: 's3-compatible',
          connectionName: 'S3 兼容存储',
          connectionType: 's3',
          prefix: '',
          uploadRelativePath: 'source'
        }
      ],
      sourceType: 'manual'
    })
    const file = {
      relativePath: 'sample/camera_0/10000000.jpg',
      size: 10,
      mtimeMs: 1000
    }
    const plannedObjectKey =
      'station2/vla/1mm/2026-07-05/sample/camera_0/10000000.jpg'

    taskRepo.reconcileFiles(
      task.id,
      [{ ...file, plannedObjectKey }],
      1
    )

    assert.ok(
      destinationRepo
        .listReadyFileTargets(task.id, 1)
        .every((target) => target.plannedObjectKey === plannedObjectKey)
    )

    taskRepo.reconcileFiles(task.id, [file], 1)

    assert.ok(
      destinationRepo
        .listReadyFileTargets(task.id, 1)
        .every((target) => target.plannedObjectKey === plannedObjectKey)
    )

    taskRepo.reconcileFiles(
      task.id,
      [{ ...file, plannedObjectKey: undefined }],
      1,
      { replacePlannedObjectKeys: true }
    )

    assert.ok(
      destinationRepo
        .listReadyFileTargets(task.id, 1)
        .every((target) => target.plannedObjectKey === null)
    )
  } finally {
    closeDatabase(db)
  }
})

test('object key validation reuses task-level path context', () => {
  interface ObjectKeyBaseContext {
    sourcePath: string
    basePath?: string
    variables: Record<string, string>
    rulePathMapping?: PathMappingConfig
  }
  interface TaskRunnerInternals {
    findRuleBasePath: (task: Task) => string | undefined
    buildObjectKeyBaseContext: (task: Task) => ObjectKeyBaseContext
    assertNoDuplicateObjectKeys: (
      destinationByConnectionId: Map<string, Task['destinations'][number]>,
      jobs: FileDestinationUploadTarget[],
      objectKeyBaseContext: ObjectKeyBaseContext
    ) => void
  }

  const service = new TaskRunnerService() as unknown as TaskRunnerInternals
  let basePathLookups = 0
  service.findRuleBasePath = () => {
    basePathLookups++
    return '/data/root'
  }
  const task = {
    id: 'task-1',
    folderPath: '/data/root/2026-06-30/work-1',
    folderName: 'work-1',
    status: 'pending',
    totalFiles: 0,
    uploadedFiles: 0,
    totalBytes: 0,
    uploadedBytes: 0,
    ossPrefix: '',
    destinations: [],
    uploadGroupId: 'day-1',
    uploadRelativePath: '2026-06-30/work-1',
    errorMessage: null,
    sourceType: 'local',
    sourceMachineId: null,
    ruleId: 'rule-1',
    ruleName: 'Rule 1',
    ruleSnapshot: {
      id: 'rule-1',
      name: 'Rule 1',
      enabled: true,
      source: {
        roots: ['/data/root']
      },
      destinations: [
        {
          connectionId: 'aliyun-prod'
        }
      ],
      pathMapping: {
        mode: 'keep-relative'
      },
      discovery: {},
      completion: {
        mode: 'rollover'
      },
      cleanup: {
        enabled: false,
        retentionDays: 7,
        onlyAfterSealed: true
      },
      filter: {
        whitelist: [],
        blacklist: [],
        regex: [],
        suffixes: []
      }
    },
    groupVariables: {},
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    completedAt: null
  } as Task
  const destination = {
    id: 'destination-1',
    taskId: task.id,
    connectionId: 'aliyun-prod',
    connectionName: '阿里云 OSS',
    status: 'pending',
    prefix: 'upload',
    uploadRelativePath: '',
    pathMode: 'keep-source',
    objectKeyTemplate: null,
    totalFiles: 0,
    uploadedFiles: 0,
    totalBytes: 0,
    uploadedBytes: 0,
    errorMessage: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: null
  } as Task['destinations'][number]
  const jobs = Array.from({ length: 1000 }, (_, index) => ({
    id: `target-${index}`,
    taskFileId: `file-${index}`,
    taskDestinationId: destination.id,
    connectionId: 'aliyun-prod',
    status: 'pending',
    objectKey: null,
    plannedObjectKey: null,
    uploadId: null,
    errorMessage: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    taskId: task.id,
    relativePath: `camera/${String(index).padStart(5, '0')}.jpg`,
    fileSize: 10,
    mtimeMs: 1000,
    retryCount: 0,
    nextRetryAt: null,
    sourceStatus: 'present',
    stableCount: 2
  })) as FileDestinationUploadTarget[]

  const baseContext = service.buildObjectKeyBaseContext(task)
  service.assertNoDuplicateObjectKeys(
    new Map([['aliyun-prod', destination]]),
    jobs,
    baseContext
  )

  assert.equal(basePathLookups, 1)
})
