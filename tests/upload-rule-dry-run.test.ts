import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import { dryRunUploadRule } from '../src/main/services/upload-rule-dry-run.service'
import { runMigrations, setDbForTests } from '../src/main/db/database'
import type { AppSettings, UploadRule, UploadRuleDryRunResult } from '../src/shared/types'

test('dry run validates date/session upload rules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dry-run-date-session-'))
  try {
    mkdirSync(join(root, '2026-09-14', '10-20-30', 'camera'), { recursive: true })
    writeFileSync(join(root, '2026-09-14', '10-20-30', 'camera', '001.jpg'), 'image')

    const rule = makeRule(root, {
      discovery: {
        groupPattern: '{date:yyyy-MM-dd}',
        taskPattern: '{session:HH-mm-ss}',
        recursive: false
      },
      pathMapping: {
        mode: 'template',
        template: 'archive/{date}/{session}/{relativePath}'
      }
    })
    const result = await dryRunUploadRule(
      { rule, sampleLimit: 10 },
      makeSettings(rule)
    )

    assert.equal(result.ok, true)
    assert.equal(result.totals.groups, 1)
    assert.equal(result.totals.tasks, 1)
    assert.equal(firstTask(result).sampleFiles[0].objectKeys[0].key, 'prod/archive/2026-09-14/10-20-30/camera/001.jpg')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dry run validates machine/date upload rules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dry-run-machine-date-'))
  try {
    mkdirSync(join(root, 'machine-a', '20260914', 'run-1'), { recursive: true })
    writeFileSync(join(root, 'machine-a', '20260914', 'run-1', 'result.csv'), 'ok')

    const rule = makeRule(root, {
      discovery: {
        groupPattern: '{machine}/{date:yyyyMMdd}',
        taskRegex: '^run-(?<session>\\d+)$',
        recursive: false
      },
      pathMapping: {
        mode: 'template',
        template: '{machine}/{date}/{session}/{relativePath}'
      }
    })
    const result = await dryRunUploadRule(
      { rule, sampleLimit: 10 },
      makeSettings(rule)
    )

    assert.equal(result.ok, true)
    assert.deepEqual(result.roots[0].groups[0].variables, {
      machine: 'machine-a',
      date: '20260914'
    })
    assert.equal(firstTask(result).sampleFiles[0].objectKeys[0].key, 'prod/machine-a/20260914/1/result.csv')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dry run supports ordinary flat source roots without discovery patterns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dry-run-ordinary-photos-'))
  try {
    mkdirSync(join(root, 'Photos', 'trip'), { recursive: true })
    writeFileSync(join(root, 'Photos', 'trip', 'frame.jpg'), 'image')

    const rule = makeRule(join(root, 'Photos'), {
      discovery: {
        recursive: false
      },
      pathMapping: {
        mode: 'keep-relative'
      }
    })
    const result = await dryRunUploadRule(
      { rule, sampleLimit: 10 },
      makeSettings(rule)
    )

    assert.equal(result.ok, true)
    assert.equal(result.totals.roots, 1)
    assert.equal(result.totals.groups, 1)
    assert.equal(result.totals.tasks, 1)
    assert.equal(firstTask(result).sampleFiles[0].objectKeys[0].key, 'prod/trip/frame.jpg')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dry run validates all source roots in one rule', async () => {
  const rootA = mkdtempSync(join(tmpdir(), 'dry-run-root-a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'dry-run-root-b-'))
  try {
    writeFileSync(join(rootA, 'a.jpg'), 'a')
    writeFileSync(join(rootB, 'b.jpg'), 'b')
    const rule = makeRule(rootA, {
      source: { roots: [rootA, rootB] },
      pathMapping: { mode: 'flatten' }
    })

    const result = await dryRunUploadRule({ rule, sampleLimit: 10 }, makeSettings(rule))

    assert.equal(result.ok, true)
    assert.equal(result.totals.roots, 2)
    assert.equal(result.totals.groups, 2)
    assert.equal(result.totals.tasks, 2)
    assert.equal(result.totals.filesScanned, 2)
    assert.deepEqual(result.roots.map((item) => item.sourceRoot), [rootA, rootB])
  } finally {
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  }
})

test('dry run reports missing rule destinations before scanning files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dry-run-missing-connection-'))
  try {
    const rule = makeRule(root, {
      destinations: [
        {
          connectionId: 'missing-connection'
        }
      ]
    })
    const result = await dryRunUploadRule(
      { rule, sampleLimit: 10 },
      makeSettings(rule)
    )

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /Destination Connection 不存在/)
    assert.equal(result.totals.filesScanned, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dry run renders object keys for multiple connection destinations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dry-run-multiple-connections-'))
  try {
    mkdirSync(join(root, 'Photos', 'trip'), { recursive: true })
    writeFileSync(join(root, 'Photos', 'trip', 'frame.jpg'), 'image')

    const rule = makeRule(join(root, 'Photos'), {
      destinations: [
        {
          connectionId: 'aliyun-prod'
        },
        {
          connectionId: 's3-compatible'
        }
      ],
      discovery: {
        recursive: false
      },
      pathMapping: {
        mode: 'keep-relative'
      }
    })
    const settings = makeSettings(rule)
    settings.connections = settings.connections.map((connection) =>
      connection.id === 's3-compatible'
        ? {
            ...connection,
            config: {
              ...connection.config,
              prefix: 'mirror'
            }
          }
        : connection
    )
    const result = await dryRunUploadRule(
      { rule, sampleLimit: 10 },
      settings
    )

    assert.equal(result.ok, true)
    assert.deepEqual(
      firstTask(result).sampleFiles[0].objectKeys,
      [
        {
          connectionId: 'aliyun-prod',
          key: 'prod/trip/frame.jpg'
        },
        {
          connectionId: 's3-compatible',
          key: 'mirror/trip/frame.jpg'
        }
      ]
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dry run detects cross-root object key collisions per connection', async () => {
  const rootA = mkdtempSync(join(tmpdir(), 'dry-run-collision-a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'dry-run-collision-b-'))
  try {
    mkdirSync(join(rootA, 'a'), { recursive: true })
    mkdirSync(join(rootB, 'b'), { recursive: true })
    writeFileSync(join(rootA, 'a', '001.jpg'), 'a')
    writeFileSync(join(rootB, 'b', '001.jpg'), 'b')
    const rule = makeRule(rootA, {
      source: { roots: [rootA, rootB] },
      pathMapping: { mode: 'flatten' }
    })

    const result = await dryRunUploadRule({ rule, sampleLimit: 20 }, makeSettings(rule))

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /对象 Key 冲突/)
    assert.match(result.errors.join('\n'), /aliyun-prod:prod\/001\.jpg/)
  } finally {
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  }
})

test('dry run allows identical object keys across different connections', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dry-run-same-key-connections-'))
  try {
    writeFileSync(join(root, '001.jpg'), 'image')
    const rule = makeRule(root, {
      destinations: [
        { connectionId: 'aliyun-prod' },
        { connectionId: 's3-compatible' }
      ],
      pathMapping: { mode: 'flatten' }
    })
    const settings = makeSettings(rule)
    settings.connections = settings.connections.map((connection) => ({
      ...connection,
      config: { ...connection.config, prefix: 'archive' }
    }))

    const result = await dryRunUploadRule({ rule, sampleLimit: 10 }, settings)

    assert.equal(result.ok, true)
    assert.deepEqual(firstTask(result).sampleFiles[0].objectKeys, [
      { connectionId: 'aliyun-prod', key: 'archive/001.jpg' },
      { connectionId: 's3-compatible', key: 'archive/001.jpg' }
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dry run reports root-scoped errors and keeps valid roots visible', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dry-run-one-missing-'))
  const missing = join(root, 'missing')
  try {
    writeFileSync(join(root, 'ok.jpg'), 'ok')
    const rule = makeRule(root, {
      source: { roots: [root, missing] },
      pathMapping: { mode: 'flatten' }
    })

    const result = await dryRunUploadRule({ rule, sampleLimit: 10 }, makeSettings(rule))

    assert.equal(result.ok, false)
    assert.equal(result.roots.length, 2)
    assert.equal(result.roots[0].ok, true)
    assert.equal(result.roots[1].ok, false)
    assert.match(result.errors.join('\n'), new RegExp(escapeRegExp(missing)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dry run treats an empty root as a warning when other roots contain tasks', async () => {
  const rootA = mkdtempSync(join(tmpdir(), 'dry-run-non-empty-'))
  const rootB = mkdtempSync(join(tmpdir(), 'dry-run-empty-'))
  try {
    mkdirSync(join(rootA, 'batch-1', 'run-1'), { recursive: true })
    writeFileSync(join(rootA, 'batch-1', 'run-1', '001.jpg'), 'image')
    const rule = makeRule(rootA, {
      source: { roots: [rootA, rootB] },
      discovery: {
        groupPattern: '{batch}',
        taskPattern: '{session}'
      }
    })

    const result = await dryRunUploadRule({ rule, sampleLimit: 10 }, makeSettings(rule))

    assert.equal(result.ok, true)
    assert.equal(result.totals.tasks, 1)
    assert.match(result.warnings.join('\n'), new RegExp(escapeRegExp(rootB)))
    assert.match(result.warnings.join('\n'), /没有任何 Upload Group/)
  } finally {
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  }
})

test('dry run rejects unsafe templates and duplicate object keys inside a root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dry-run-errors-'))
  try {
    mkdirSync(join(root, '2026-09-14', '10-20-30', 'a'), { recursive: true })
    mkdirSync(join(root, '2026-09-14', '10-20-30', 'b'), { recursive: true })
    writeFileSync(join(root, '2026-09-14', '10-20-30', 'a', '001.jpg'), 'a')
    writeFileSync(join(root, '2026-09-14', '10-20-30', 'b', '002.jpg'), 'b')

    const duplicateRule = makeRule(root, {
      discovery: {
        groupPattern: '{date:yyyy-MM-dd}',
        taskPattern: '{session:HH-mm-ss}',
        recursive: false
      },
      pathMapping: {
        mode: 'flatten',
      }
    })
    writeFileSync(join(root, '2026-09-14', '10-20-30', 'b', '001.jpg'), 'duplicate')
    const duplicateResult = await dryRunUploadRule(
      { rule: duplicateRule, sampleLimit: 20 },
      makeSettings(duplicateRule)
    )

    assert.equal(duplicateResult.ok, false)
    assert.match(duplicateResult.errors.join('\n'), /对象 Key 冲突/)

    const unsafeRule = makeRule(root, {
      discovery: {
        groupPattern: '{date:yyyy-MM-dd}',
        taskPattern: '{session:HH-mm-ss}',
        recursive: false
      },
      pathMapping: {
        mode: 'template',
        template: '../{missing}/{relativePath}'
      }
    })
    const unsafeResult = await dryRunUploadRule(
      { rule: unsafeRule, sampleLimit: 10 },
      makeSettings(unsafeRule)
    )

    assert.equal(unsafeResult.ok, false)
    assert.match(unsafeResult.errors.join('\n'), /未知路径变量: missing/)
    assert.match(unsafeResult.errors.join('\n'), /路径映射模板不能包含/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dry run validates completion policy parameters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dry-run-completion-'))
  try {
    writeFileSync(join(root, '001.jpg'), 'image')
    const invalidInactivity = makeRule(root, {
      completion: { mode: 'inactivity', idleMinutes: 0 }
    })
    const invalidMarker = makeRule(root, {
      completion: { mode: 'marker-file', markerFile: '../COMPLETE' }
    })

    const inactivityResult = await dryRunUploadRule(
      { rule: invalidInactivity, sampleLimit: 10 },
      makeSettings(invalidInactivity)
    )
    const markerResult = await dryRunUploadRule(
      { rule: invalidMarker, sampleLimit: 10 },
      makeSettings(invalidMarker)
    )

    assert.equal(inactivityResult.ok, false)
    assert.match(inactivityResult.errors.join('\n'), /idleMinutes/)
    assert.equal(markerResult.ok, false)
    assert.match(markerResult.errors.join('\n'), /markerFile/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dry run is side-effect free for tasks, upload groups, and destinations', async () => {
  const db = new Database(':memory:')
  const root = mkdtempSync(join(tmpdir(), 'dry-run-side-effect-free-'))
  try {
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    setDbForTests(db)
    writeFileSync(join(root, '001.jpg'), 'image')
    const rule = makeRule(root, { pathMapping: { mode: 'flatten' } })
    const before = countRuntimeRecords(db)

    const result = await dryRunUploadRule({ rule, sampleLimit: 10 }, makeSettings(rule))

    assert.equal(result.ok, true)
    assert.deepEqual(countRuntimeRecords(db), before)
  } finally {
    setDbForTests(null)
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function firstTask(result: UploadRuleDryRunResult) {
  return result.roots[0].groups[0].tasks[0]
}

function countRuntimeRecords(db: Database.Database): Record<string, number> {
  return {
    tasks: countRows(db, 'tasks'),
    uploadGroups: countRows(db, 'day_folders'),
    taskDestinations: countRows(db, 'task_destinations')
  }
}

function countRows(db: Database.Database, tableName: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }).count
}

function makeRule(
  sourceRoot: string,
  overrides: Partial<UploadRule>
): UploadRule {
  return {
    id: 'test-rule',
    name: 'Test Rule',
    enabled: true,
    source: {
      roots: [sourceRoot]
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
    },
    ...overrides
  }
}

function makeSettings(rule: UploadRule): AppSettings {
  const settings = structuredClone(DEFAULT_SETTINGS) as AppSettings
  return {
    ...settings,
    rules: [rule],
    activeRuleId: rule.id,
    connections: settings.connections.map((connection) =>
      connection.id === 'aliyun-prod'
        ? {
            ...connection,
            config: {
              ...connection.config,
              prefix: 'prod'
            }
          }
        : connection
    )
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
