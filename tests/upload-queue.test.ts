import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  runMigrations,
  setDbForTests
} from '../src/main/db/database'
import { TaskRepo } from '../src/main/db/task.repo'
import { getTaskDestinationRepo } from '../src/main/db/task-destination.repo'
import { TaskQueueService } from '../src/main/services/task-queue.service'
import type { Task, TaskStatus } from '../src/shared/types'

function openTestDb(): Database.Database {
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

function createReadyTask(repo: TaskRepo, name: string): Task {
  const task = repo.create({
    folderPath: `/tmp/${name}`,
    folderName: name,
    sourceType: 'manual'
  })
  repo.createFile(task.id, 'data.csv', 10, 1)
  getTaskDestinationRepo().ensureForTaskFiles(task.id)
  return repo.getById(task.id)!
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await Promise.resolve()
}

test('upload queue does not run tasks until manually opened', async () => {
  const db = openTestDb()
  try {
    const repo = new TaskRepo()
    createReadyTask(repo, 'closed-gate')
    const started: string[] = []
    const queue = new TaskQueueService() as unknown as {
      setTaskRunner: TaskQueueService['setTaskRunner']
      processQueue: () => Promise<void>
    }
    queue.setTaskRunner(async (task) => {
      started.push(task.id)
      return 'completed'
    })

    await queue.processQueue()
    await flushAsyncWork()

    assert.deepEqual(started, [])
  } finally {
    closeTestDb(db)
  }
})

test('selected upload starts only selected tasks before normal queue work', async () => {
  const db = openTestDb()
  try {
    const repo = new TaskRepo()
    const selected = createReadyTask(repo, 'selected-task')
    const later = createReadyTask(repo, 'later-task')
    const started: string[] = []
    let releaseSelected!: () => void
    const selectedDone = new Promise<void>((resolve) => {
      releaseSelected = resolve
    })

    const queue = new TaskQueueService() as unknown as TaskQueueService & {
      processQueue: () => Promise<void>
    }
    queue.setTaskRunner(async (task) => {
      started.push(task.id)
      if (task.id === selected.id) await selectedDone
      return 'completed'
    })

    queue.startUploading({ scope: 'selected', taskIds: [selected.id] })
    await flushAsyncWork()
    await queue.processQueue()
    await flushAsyncWork()

    assert.deepEqual(started, [selected.id])

    releaseSelected()
    await flushAsyncWork()
    await flushAsyncWork()

    assert.deepEqual(started, [selected.id, later.id])
  } finally {
    closeTestDb(db)
  }
})

test('pause-running stop marks active uploads paused', async () => {
  const db = openTestDb()
  try {
    const repo = new TaskRepo()
    const task = createReadyTask(repo, 'pause-running')
    const queue = new TaskQueueService()
    queue.setTaskRunner(
      async (_task, signal): Promise<TaskStatus> =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve('paused'), {
            once: true
          })
        })
    )

    queue.startUploading({ scope: 'selected', taskIds: [task.id] })
    await flushAsyncWork()
    assert.deepEqual(queue.getStatus().runningTaskIds, [task.id])

    queue.stopUploading({ mode: 'pause-running' })
    await flushAsyncWork()

    assert.equal(repo.getById(task.id)?.status, 'paused')
    assert.equal(queue.getStatus().gateOpen, false)
  } finally {
    closeTestDb(db)
  }
})

test('shutdown closes upload gate and preserves completed destinations', async () => {
  const db = openTestDb()
  try {
    const repo = new TaskRepo()
    const destinationRepo = getTaskDestinationRepo()
    const task = repo.create({
      folderPath: '/tmp/shutdown-running',
      folderName: 'shutdown-running',
      sourceType: 'manual',
      destinations: [
        {
          connectionId: 'archive-a',
          connectionName: 'Archive A',
          connectionType: 's3',
          uploadRelativePath: ''
        },
        {
          connectionId: 'archive-b',
          connectionName: 'Archive B',
          connectionType: 's3',
          uploadRelativePath: ''
        }
      ]
    })
    repo.createFile(task.id, 'data.csv', 10, 1)
    destinationRepo.ensureForTaskFiles(task.id)
    destinationRepo.updateStatus(task.id, 'archive-a', 'completed')

    const queue = new TaskQueueService()
    queue.setTaskRunner(
      async (_task, signal): Promise<TaskStatus> =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve('paused'), {
            once: true
          })
        })
    )

    queue.startUploading({ scope: 'selected', taskIds: [task.id] })
    await flushAsyncWork()
    assert.deepEqual(queue.getStatus().runningTaskIds, [task.id])

    const status = queue.shutdown()
    await flushAsyncWork()

    assert.equal(status.gateOpen, false)
    assert.deepEqual(queue.getStatus().runningTaskIds, [])
    assert.equal(repo.getById(task.id)?.status, 'paused')
    assert.deepEqual(
      destinationRepo.listByTask(task.id).map((destination) => ({
        connectionId: destination.connectionId,
        status: destination.status
      })),
      [
        { connectionId: 'archive-a', status: 'completed' },
        { connectionId: 'archive-b', status: 'paused' }
      ]
    )
  } finally {
    closeTestDb(db)
  }
})
