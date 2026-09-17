import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import { dryRunUploadRule } from '../src/main/services/upload-rule-dry-run.service'
import type { AppSettings, UploadProfile } from '../src/shared/types'

test('dry run validates date/session upload rules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dry-run-date-session-'))
  try {
    mkdirSync(join(root, '2026-09-14', '10-20-30', 'camera'), { recursive: true })
    writeFileSync(join(root, '2026-09-14', '10-20-30', 'camera', '001.jpg'), 'image')

    const profile = makeProfile(root, {
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
      { rule: profile, sourceRoot: root, sampleLimit: 10 },
      makeSettings(profile)
    )

    assert.equal(result.ok, true)
    assert.equal(result.totals.groups, 1)
    assert.equal(result.totals.tasks, 1)
    assert.equal(result.groups[0].tasks[0].sampleFiles[0].objectKeys[0].key, 'prod/archive/2026-09-14/10-20-30/camera/001.jpg')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dry run validates machine/date upload rules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dry-run-machine-date-'))
  try {
    mkdirSync(join(root, 'machine-a', '20260914', 'run-1'), { recursive: true })
    writeFileSync(join(root, 'machine-a', '20260914', 'run-1', 'result.csv'), 'ok')

    const profile = makeProfile(root, {
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
      { rule: profile, sourceRoot: root, sampleLimit: 10 },
      makeSettings(profile)
    )

    assert.equal(result.ok, true)
    assert.deepEqual(result.groups[0].variables, {
      machine: 'machine-a',
      date: '20260914'
    })
    assert.equal(result.groups[0].tasks[0].sampleFiles[0].objectKeys[0].key, 'prod/machine-a/20260914/1/result.csv')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dry run supports ordinary flat source roots without discovery patterns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dry-run-ordinary-photos-'))
  try {
    mkdirSync(join(root, 'Photos', 'trip'), { recursive: true })
    writeFileSync(join(root, 'Photos', 'trip', 'frame.jpg'), 'image')

    const profile = makeProfile(join(root, 'Photos'), {
      discovery: {
        recursive: false
      },
      pathMapping: {
        mode: 'keep-relative'
      }
    })
    const result = await dryRunUploadRule(
      { rule: profile, sourceRoot: join(root, 'Photos'), sampleLimit: 10 },
      makeSettings(profile)
    )

    assert.equal(result.ok, true)
    assert.equal(result.totals.groups, 1)
    assert.equal(result.totals.tasks, 1)
    assert.equal(result.groups[0].tasks[0].sampleFiles[0].objectKeys[0].key, 'prod/trip/frame.jpg')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dry run rejects unsafe templates and duplicate object keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dry-run-errors-'))
  try {
    mkdirSync(join(root, '2026-09-14', '10-20-30', 'a'), { recursive: true })
    mkdirSync(join(root, '2026-09-14', '10-20-30', 'b'), { recursive: true })
    writeFileSync(join(root, '2026-09-14', '10-20-30', 'a', '001.jpg'), 'a')
    writeFileSync(join(root, '2026-09-14', '10-20-30', 'b', '002.jpg'), 'b')

    const duplicateProfile = makeProfile(root, {
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
      { rule: duplicateProfile, sourceRoot: root, sampleLimit: 20 },
      makeSettings(duplicateProfile)
    )

    assert.equal(duplicateResult.ok, false)
    assert.match(duplicateResult.errors.join('\n'), /对象 Key 冲突/)

    const unsafeProfile = makeProfile(root, {
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
      { rule: unsafeProfile, sourceRoot: root, sampleLimit: 10 },
      makeSettings(unsafeProfile)
    )

    assert.equal(unsafeResult.ok, false)
    assert.match(unsafeResult.errors.join('\n'), /未知路径变量: missing/)
    assert.match(unsafeResult.errors.join('\n'), /路径映射模板不能包含/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeProfile(
  sourceRoot: string,
  overrides: Partial<UploadProfile>
): UploadProfile {
  return {
    id: 'test-rule',
    name: 'Test Rule',
    enabled: true,
    source: {
      roots: [sourceRoot]
    },
    destinations: [
      {
        connectionId: 'aliyun-prod',
        required: true
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
    cloudConnections: [
      {
        id: 'aliyun-prod',
        name: 'Aliyun Production',
        type: 'aliyun-oss',
        provider: 'aliyun',
        config: {
          prefix: 'prod'
        }
      }
    ],
    targetMode: 'aliyun',
    filter: {
      whitelist: [],
      blacklist: [],
      regex: [],
      suffixes: []
    },
    scan: {
      providerDirectories: {
        aliyun: [sourceRoot],
        tencent: []
      }
    },
    providers: {
      aliyun: {
        prefix: 'prod',
        pathMode: 'target-root',
        pathSegmentCount: 2,
        objectKeyTemplate: '{relativePath}'
      },
      tencent: {
        prefix: '',
        pathMode: 'target-root',
        pathSegmentCount: 2,
        objectKeyTemplate: '{relativePath}'
      }
    },
    ...overrides
  }
}

function makeSettings(profile: UploadProfile): AppSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    oss: {
      ...structuredClone(DEFAULT_SETTINGS.oss),
      prefix: 'prod'
    },
    profiles: [profile],
    activeProfileId: profile.id
  } as AppSettings
}
