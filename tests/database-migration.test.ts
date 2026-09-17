import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  reconcileStartupState,
  runMigrations
} from '../src/main/db/database'

function createLegacyDatabase(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      folder_path TEXT NOT NULL,
      folder_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      total_files INTEGER NOT NULL DEFAULT 0,
      uploaded_files INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      uploaded_bytes INTEGER NOT NULL DEFAULT 0,
      oss_prefix TEXT,
      error_message TEXT,
      source_type TEXT NOT NULL DEFAULT 'local',
      source_machine_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE task_files (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      oss_key TEXT,
      upload_id TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

  `)
  return db
}

test('migration adds profile and object key template columns', () => {
  const db = createLegacyDatabase()
  runMigrations(db)

  const taskColumns = (db.pragma('table_info(tasks)') as Array<{ name: string }>)
    .map((column) => column.name)
  const destinationColumns = (db.pragma('table_info(task_destinations)') as Array<{ name: string }>)
    .map((column) => column.name)
  const dayFolderColumns = (db.pragma('table_info(day_folders)') as Array<{ name: string }>)
    .map((column) => column.name)

  assert.ok(taskColumns.includes('profile_id'))
  assert.ok(taskColumns.includes('profile_name'))
  assert.ok(taskColumns.includes('profile_snapshot_json'))
  assert.ok(destinationColumns.includes('path_mode'))
  assert.ok(destinationColumns.includes('object_key_template'))
  assert.ok(dayFolderColumns.includes('last_content_activity_at'))
})

test('migration backfills legacy day folders into upload groups', () => {
  const db = createLegacyDatabase()
  const now = new Date().toISOString()
  db.exec(`
    CREATE TABLE day_folders (
      id TEXT PRIMARY KEY,
      folder_path TEXT NOT NULL UNIQUE,
      folder_name TEXT NOT NULL,
      date_value TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'collecting',
      child_folders_json TEXT NOT NULL DEFAULT '[]',
      total_children INTEGER NOT NULL DEFAULT 0,
      completed_children INTEGER NOT NULL DEFAULT 0,
      total_files INTEGER NOT NULL DEFAULT 0,
      uploaded_files INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      uploaded_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
  `)
  const insert = db.prepare(`
    INSERT INTO day_folders (
      id, folder_path, folder_name, date_value, status, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insert.run('done', '/data/2026-03-14', '2026-03-14', '2026-03-14', 'completed', now, now, now)
  insert.run('blocked', '/data/2026-03-15', '2026-03-15', '2026-03-15', 'blocked', now, now, null)
  insert.run('active', '/data/2026-03-16', '2026-03-16', '2026-03-16', 'processing', now, now, null)

  runMigrations(db)
  runMigrations(db)

  const rows = db.prepare(`
    SELECT id, date_value, group_key, variables_json, status, upload_group_status,
      discovered_at, last_content_activity_at, sealed_at
    FROM day_folders
    ORDER BY id
  `).all()
  assert.deepEqual(rows, [
    {
      id: 'active',
      date_value: '2026-03-16',
      group_key: '2026-03-16',
      variables_json: '{"date":"2026-03-16"}',
      status: 'processing',
      upload_group_status: 'closing',
      discovered_at: now,
      last_content_activity_at: now,
      sealed_at: null
    },
    {
      id: 'blocked',
      date_value: '2026-03-15',
      group_key: '2026-03-15',
      variables_json: '{"date":"2026-03-15"}',
      status: 'blocked',
      upload_group_status: 'error',
      discovered_at: now,
      last_content_activity_at: now,
      sealed_at: null
    },
    {
      id: 'done',
      date_value: '2026-03-14',
      group_key: '2026-03-14',
      variables_json: '{"date":"2026-03-14"}',
      status: 'completed',
      upload_group_status: 'sealed',
      discovered_at: now,
      last_content_activity_at: now,
      sealed_at: now
    }
  ])

  db.close()
})

test('legacy migration skips completed file details and preserves unfinished progress', () => {
  const db = createLegacyDatabase()
  const now = new Date().toISOString()
  const insertTask = db.prepare(`
    INSERT INTO tasks (
      id, folder_path, folder_name, status, total_files, uploaded_files,
      total_bytes, uploaded_bytes, oss_prefix, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insertTask.run(
    'completed-task',
    '/data/2026-03-14/completed',
    'completed',
    'completed',
    2,
    2,
    30,
    30,
    'upload',
    now,
    now,
    now
  )
  insertTask.run(
    'failed-task',
    '/data/2026-03-14/failed',
    'failed',
    'failed',
    2,
    1,
    30,
    10,
    'upload',
    now,
    now,
    now
  )

  const insertFile = db.prepare(`
    INSERT INTO task_files (
      id, task_id, relative_path, file_size, status, oss_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insertFile.run('completed-file-1', 'completed-task', 'a.csv', 10, 'completed', 'upload/a.csv', now, now)
  insertFile.run('completed-file-2', 'completed-task', 'b.csv', 20, 'completed', 'upload/b.csv', now, now)
  insertFile.run('failed-file-1', 'failed-task', 'a.csv', 10, 'completed', 'upload/a.csv', now, now)
  insertFile.run('failed-file-2', 'failed-task', 'b.csv', 20, 'failed', null, now, now)

  runMigrations(db)
  runMigrations(db)

  const destinations = db.prepare(
    'SELECT task_id, provider, status, upload_relative_path FROM task_destinations ORDER BY task_id'
  ).all()
  assert.deepEqual(destinations, [
    {
      task_id: 'completed-task',
      provider: 'aliyun',
      status: 'completed',
      upload_relative_path: ''
    },
    {
      task_id: 'failed-task',
      provider: 'aliyun',
      status: 'failed',
      upload_relative_path: '2026-03-14/failed'
    }
  ])

  const fileDestinations = db.prepare(`
    SELECT task_file_id, provider, status
    FROM task_file_destinations
    ORDER BY task_file_id
  `).all()
  assert.deepEqual(fileDestinations, [
    { task_file_id: 'failed-file-1', provider: 'aliyun', status: 'completed' },
    { task_file_id: 'failed-file-2', provider: 'aliyun', status: 'failed' }
  ])

  const uploadPaths = db.prepare(
    'SELECT id, upload_relative_path FROM tasks ORDER BY id'
  ).all()
  assert.deepEqual(uploadPaths, [
    { id: 'completed-task', upload_relative_path: '' },
    {
      id: 'failed-task',
      upload_relative_path: '2026-03-14/failed'
    }
  ])

  db.close()
})

test('startup reconciliation resumes existing sources and skips deleted sources', () => {
  const db = createLegacyDatabase()
  runMigrations(db)
  const root = mkdtempSync(join(tmpdir(), 'uploader-reconcile-'))
  const existingPath = join(root, 'existing')
  const missingPath = join(root, 'missing')
  mkdirSync(existingPath)
  const now = new Date().toISOString()
  const insertTask = db.prepare(`
    INSERT INTO tasks (
      id, folder_path, folder_name, status, oss_prefix, upload_target_mode,
      upload_relative_path, source_type, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', 'aliyun', ?, 'local', ?, ?)
  `)
  insertTask.run(
    'existing-task',
    existingPath,
    'existing',
    'uploading',
    '2026-06-18/existing',
    now,
    now
  )
  insertTask.run(
    'missing-task',
    missingPath,
    'missing',
    'uploading',
    '2026-06-18/missing',
    now,
    now
  )

  db.prepare(`
    INSERT INTO task_destinations (
      id, task_id, provider, connection_id, connection_name, status, prefix, created_at, updated_at
    ) VALUES (?, ?, 'aliyun', 'aliyun-prod', '阿里云 OSS', 'uploading', '', ?, ?)
  `).run('destination-existing', 'existing-task', now, now)
  db.prepare(`
    INSERT INTO task_destinations (
      id, task_id, provider, connection_id, connection_name, status, prefix, created_at, updated_at
    ) VALUES (?, ?, 'aliyun', 'aliyun-prod', '阿里云 OSS', 'uploading', '', ?, ?)
  `).run('destination-missing', 'missing-task', now, now)

  reconcileStartupState(db)

  assert.deepEqual(
    db.prepare('SELECT id, status FROM tasks ORDER BY id').all(),
    [
      { id: 'existing-task', status: 'pending' },
      { id: 'missing-task', status: 'skipped' }
    ]
  )
  assert.deepEqual(
    db.prepare(
      'SELECT task_id, status FROM task_destinations ORDER BY task_id'
    ).all(),
    [
      { task_id: 'existing-task', status: 'pending' },
      { task_id: 'missing-task', status: 'skipped' }
    ]
  )

  rmSync(root, { recursive: true, force: true })
  db.close()
})

test('migration removes legacy duplicate file rows before adding unique index', () => {
  const db = createLegacyDatabase()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (
      id, folder_path, folder_name, status, oss_prefix, source_type,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'pending', '', 'local', ?, ?)
  `).run('duplicate-task', '/data/duplicate', 'duplicate', now, now)
  const insertFile = db.prepare(`
    INSERT INTO task_files (
      id, task_id, relative_path, file_size, status, created_at, updated_at
    ) VALUES (?, 'duplicate-task', 'same.jpg', 10, 'pending', ?, ?)
  `)
  insertFile.run('duplicate-file-1', now, now)
  insertFile.run('duplicate-file-2', now, now)

  runMigrations(db)

  const count = db.prepare(
    `SELECT COUNT(*) AS count
     FROM task_files
     WHERE task_id = 'duplicate-task' AND relative_path = 'same.jpg'`
  ).get() as { count: number }
  assert.equal(count.count, 1)
  assert.ok(
    db.prepare(
      `SELECT 1 FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_task_files_task_path'`
    ).get()
  )
  db.close()
})
