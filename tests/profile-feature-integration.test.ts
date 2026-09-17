import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import { shouldRestartScannerAfterSettingsSave } from '../src/shared/settings-effects'
import type { AppSettings, CloudConnection, UploadRule } from '../src/shared/types'
import {
  runMigrations,
  setDbForTests
} from '../src/main/db/database'
import { SettingsRepo } from '../src/main/db/settings.repo'
import { TaskRepo } from '../src/main/db/task.repo'
import { CloudConnectionStore } from '../src/main/services/cloud-connection-store.service'
import { CredentialStore } from '../src/main/services/credential-store.service'

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

function cloneDefaults(): AppSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings
}

function makeConnection(overrides: Partial<CloudConnection> = {}): CloudConnection {
  return {
    id: 'archive-oss',
    name: 'Archive OSS',
    type: 'aliyun-oss',
    config: {
      endpoint: 'https://oss.example.com',
      bucket: 'archive',
      region: 'oss-cn-hangzhou',
      prefix: 'archive',
      accessKeyId: '',
      accessKeySecret: ''
    },
    ...overrides,
    config: {
      endpoint: 'https://oss.example.com',
      bucket: 'archive',
      region: 'oss-cn-hangzhou',
      prefix: 'archive',
      accessKeyId: '',
      accessKeySecret: '',
      ...(overrides.config || {})
    }
  }
}

function makeRule(
  connectionId: string,
  overrides: Partial<UploadRule> = {}
): UploadRule {
  const base = cloneDefaults().rules[0]
  return {
    ...base,
    id: 'archive-rule',
    name: 'Archive Rule',
    source: {
      roots: ['/data/archive']
    },
    destinations: [{ connectionId }],
    ...overrides,
    source: {
      roots: ['/data/archive'],
      ...overrides.source
    },
    destinations: overrides.destinations || [{ connectionId }],
    pathMapping: overrides.pathMapping || base.pathMapping,
    discovery: {
      ...base.discovery,
      ...overrides.discovery
    },
    completion: overrides.completion || base.completion,
    cleanup: {
      ...base.cleanup,
      ...overrides.cleanup
    },
    filter: {
      ...base.filter,
      ...overrides.filter
    }
  }
}

test('settings repo migrates legacy rows to V3 rules and connections', () => {
  const db = createDatabase()
  try {
    const now = new Date().toISOString()
    const insert = db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
    )
    insert.run('cloud', JSON.stringify({ targetMode: 'both' }), now)
    insert.run(
      'scan',
      JSON.stringify({
        directories: ['/legacy/fallback'],
        providerDirectories: {
          aliyun: ['/legacy/aliyun'],
          tencent: ['/legacy/tencent']
        },
        intervalSeconds: 30
      }),
      now
    )
    insert.run('oss', JSON.stringify({ prefix: 'oss-prefix' }), now)
    insert.run('tencentS3', JSON.stringify({ prefix: 's3-prefix' }), now)

    const repo = new SettingsRepo()
    const settings = repo.getAll()

    assert.equal(settings.schemaVersion, 3)
    assert.deepEqual(
      settings.rules.map((rule) => ({
        id: rule.id,
        roots: rule.source.roots,
        destinations: rule.destinations.map((destination) => destination.connectionId)
      })),
      [
        {
          id: 'default-aliyun',
          roots: ['/legacy/aliyun'],
          destinations: ['aliyun-prod']
        },
        {
          id: 'default-s3',
          roots: ['/legacy/tencent'],
          destinations: ['s3-compatible']
        }
      ]
    )
    assert.equal(settings.connections[0].config.prefix, 'oss-prefix')
    assert.equal(settings.connections[1].config.prefix, 's3-prefix')
    assert.equal(repo.get<number>('schemaVersion'), 3)
    assert.equal(Array.isArray(repo.get<UploadRule[]>('rules')), true)
    assert.equal(Array.isArray(repo.get<CloudConnection[]>('connections')), true)
  } finally {
    closeDatabase(db)
  }
})

test('manual tasks persist V3 rule snapshots and connection destinations', () => {
  const db = createDatabase()
  try {
    const rule = makeRule('archive-oss', {
      filter: {
        whitelist: [],
        blacklist: [],
        regex: [],
        suffixes: ['.jpg']
      },
      pathMapping: {
        mode: 'template',
        template: 'qa/{relativePath}'
      }
    })

    const task = new TaskRepo().create({
      folderPath: '/data/archive/2026-06-29/run-1',
      folderName: 'run-1',
      legacyCloudMode: 'aliyun',
      destinations: [
        {
          provider: 'aliyun',
          connectionId: 'archive-oss',
          connectionName: 'Archive OSS',
          prefix: 'archive',
          uploadRelativePath: 'run-1'
        }
      ],
      uploadRelativePath: 'run-1',
      sourceType: 'manual',
      ruleId: rule.id,
      ruleName: rule.name,
      ruleSnapshot: rule,
      groupVariables: {
        date: '2026-06-29',
        session: 'run-1'
      }
    })

    assert.equal(task.ruleId, 'archive-rule')
    assert.equal(task.ruleName, 'Archive Rule')
    assert.deepEqual(task.ruleSnapshot?.filter.suffixes, ['.jpg'])
    assert.deepEqual(task.groupVariables, {
      date: '2026-06-29',
      session: 'run-1'
    })
    assert.deepEqual(
      task.destinations.map((destination) => ({
        provider: destination.provider,
        connectionId: destination.connectionId,
        connectionName: destination.connectionName,
        prefix: destination.prefix
      })),
      [
        {
          provider: 'aliyun',
          connectionId: 'archive-oss',
          connectionName: 'Archive OSS',
          prefix: 'archive'
        }
      ]
    )
  } finally {
    closeDatabase(db)
  }
})

test('cloud connection store saves, resolves and blocks referenced deletes', () => {
  const db = createDatabase()
  try {
    const repo = new SettingsRepo()
    const store = new CloudConnectionStore()
    const connection = makeConnection()

    store.save(connection)
    assert.equal(store.resolve('archive-oss').config.prefix, 'archive')

    store.save(makeConnection({ name: 'Archive OSS Updated', config: { prefix: 'cold' } }))
    assert.equal(store.resolve('archive-oss').name, 'Archive OSS Updated')
    assert.equal(store.resolve('archive-oss').config.prefix, 'cold')

    const archiveRule = makeRule('archive-oss')
    repo.saveAll({
      rules: [archiveRule],
      activeRuleId: archiveRule.id
    })
    assert.throws(
      () => store.delete('archive-oss'),
      /连接正在被上传规则使用/
    )

    const defaultRule = makeRule('aliyun-prod', {
      id: 'default-rule',
      name: 'Default Rule'
    })
    repo.saveAll({
      rules: [defaultRule],
      activeRuleId: defaultRule.id
    })
    const task = new TaskRepo().create({
      folderPath: '/data/archive/pending',
      folderName: 'pending',
      legacyCloudMode: 'aliyun',
      destinations: [
        {
          provider: 'aliyun',
          connectionId: 'archive-oss',
          connectionName: 'Archive OSS',
          prefix: 'cold'
        }
      ],
      sourceType: 'manual',
      ruleId: defaultRule.id,
      ruleName: defaultRule.name,
      ruleSnapshot: defaultRule
    })

    assert.throws(
      () => store.delete('archive-oss'),
      /连接正在被未完成任务使用/
    )

    db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(task.id)
    store.delete('archive-oss')
    assert.equal(store.get('archive-oss'), null)
  } finally {
    closeDatabase(db)
  }
})

test('scanner restart detection tracks V3 rule and connection settings', () => {
  assert.equal(shouldRestartScannerAfterSettingsSave({ rules: [] }), true)
  assert.equal(shouldRestartScannerAfterSettingsSave({ activeRuleId: 'a' }), true)
  assert.equal(shouldRestartScannerAfterSettingsSave({ connections: [] }), true)
  assert.equal(
    shouldRestartScannerAfterSettingsSave({
      upload: {
        ...cloneDefaults().upload,
        maxConcurrentTasks: 8
      }
    }),
    false
  )
})

test('credential store refuses plaintext secrets when safe storage is unavailable', () => {
  const store = new CredentialStore()

  assert.throws(
    () => store.encryptSecret('plain-secret'),
    /系统安全存储不可用/
  )
  assert.equal(store.encryptSecret(''), '')
})
