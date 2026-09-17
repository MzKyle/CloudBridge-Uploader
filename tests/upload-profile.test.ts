import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import {
  normalizeCloudConnections,
  normalizeUploadRules,
  resolveRuleUploadSnapshot
} from '../src/shared/upload-rule'
import { migrateSettingsToV3 } from '../src/main/migrations/v2-to-v3-settings'
import type { AppSettings, UploadRule } from '../src/shared/types'

function cloneDefaults(): AppSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings
}

function cloneDefaultRule(overrides: Partial<UploadRule> = {}): UploadRule {
  return {
    ...cloneDefaults().rules[0],
    ...overrides,
    source: {
      ...cloneDefaults().rules[0].source,
      ...overrides.source
    },
    destinations: overrides.destinations || cloneDefaults().rules[0].destinations,
    pathMapping: overrides.pathMapping || cloneDefaults().rules[0].pathMapping,
    discovery: {
      ...cloneDefaults().rules[0].discovery,
      ...overrides.discovery
    },
    completion: overrides.completion || cloneDefaults().rules[0].completion,
    cleanup: {
      ...cloneDefaults().rules[0].cleanup,
      ...overrides.cleanup
    },
    filter: {
      ...cloneDefaults().rules[0].filter,
      ...overrides.filter
    }
  }
}

test('normalizes V3 upload rules and active rule selection', () => {
  const disabled = cloneDefaultRule({
    id: 'disabled',
    name: 'Disabled',
    enabled: false,
    source: { roots: ['/disabled'] }
  })
  const enabled = cloneDefaultRule({
    id: 'enabled',
    name: 'Enabled',
    source: { roots: ['/enabled'] },
    pathMapping: {
      mode: 'template',
      template: 'archive/{relativePath}'
    }
  })

  const normalized = normalizeUploadRules({
    rules: [disabled, enabled, enabled],
    activeRuleId: 'disabled'
  })

  assert.deepEqual(normalized.rules.map((rule) => rule.id), ['disabled', 'enabled'])
  assert.equal(normalized.activeRuleId, 'enabled')
  assert.deepEqual(normalized.rules[1].source.roots, ['/enabled'])
  assert.deepEqual(normalized.rules[1].pathMapping, {
    mode: 'template',
    template: 'archive/{relativePath}'
  })
})

test('normalizes cloud connections and resolves rule upload snapshots', () => {
  const settings = cloneDefaults()
  const connections = normalizeCloudConnections([
    ...settings.connections,
    {
      id: 'archive-s3',
      name: 'Archive S3',
      type: 's3',
      config: {
        endpoint: 'https://s3.example.com',
        bucket: 'archive',
        region: 'us-east-1',
        prefix: 'cold',
        accessKeyId: '',
        accessKeySecret: ''
      }
    }
  ])
  const rule = cloneDefaultRule({
    id: 'multi-cloud',
    name: 'Multi Cloud',
    destinations: [
      { connectionId: 'aliyun-prod' },
      { connectionId: 'archive-s3' }
    ]
  })

  const snapshot = resolveRuleUploadSnapshot(rule, connections)

  assert.equal(snapshot.ruleId, 'multi-cloud')
  assert.deepEqual(
    snapshot.destinations.map((destination) => ({
      connectionId: destination.connectionId,
      connectionType: destination.connectionType,
      prefix: destination.prefix
    })),
    [
      { connectionId: 'aliyun-prod', connectionType: 'aliyun-oss', prefix: '' },
      { connectionId: 'archive-s3', connectionType: 's3', prefix: 'cold' }
    ]
  )
})

test('migrates legacy aliyun, tencent and both modes into V3 destinations', () => {
  const cases = [
    {
      mode: 'aliyun',
      expected: ['aliyun-prod']
    },
    {
      mode: 'tencent',
      expected: ['s3-compatible']
    },
    {
      mode: 'both',
      expected: ['aliyun-prod', 's3-compatible']
    }
  ] as const

  for (const item of cases) {
    const settings = migrateSettingsToV3({
      cloud: { targetMode: item.mode },
      scan: {
        directories: ['/data/root']
      },
      oss: {
        prefix: 'oss-prefix'
      },
      tencentS3: {
        prefix: 's3-prefix'
      }
    })

    assert.equal(settings.schemaVersion, 3)
    assert.deepEqual(settings.rules[0].source.roots, ['/data/root'])
    assert.deepEqual(
      settings.rules[0].destinations.map((destination) => destination.connectionId),
      item.expected
    )
  }
})

test('splits legacy provider-specific scan roots during migration', () => {
  const settings = migrateSettingsToV3({
    profiles: [
      {
        id: 'capture',
        name: 'Capture',
        enabled: true,
        targetMode: 'both',
        scan: {
          providerDirectories: {
            aliyun: ['/mnt/fast'],
            tencent: ['/mnt/archive']
          }
        }
      }
    ]
  })

  assert.deepEqual(
    settings.rules.map((rule) => ({
      id: rule.id,
      roots: rule.source.roots,
      destinations: rule.destinations.map((destination) => destination.connectionId)
    })),
    [
      {
        id: 'capture-aliyun',
        roots: ['/mnt/fast'],
        destinations: ['aliyun-prod']
      },
      {
        id: 'capture-s3',
        roots: ['/mnt/archive'],
        destinations: ['s3-compatible']
      }
    ]
  )
})
