import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compileDiscoveryPattern,
  extractDiscoveryVariables,
  matchDiscoveryPattern,
  matchDiscoveryRegex
} from '../src/shared/discovery'
import {
  renderPathMapping,
  validatePathMappingTemplate
} from '../src/shared/path-mapping'
import {
  assertUploadGroupTransition,
  canUploadGroupTransition,
  deriveUploadGroupStatus
} from '../src/shared/upload-group'
import { discoverUploadGroups } from '../src/main/services/date-directory-discovery'

test('discovery patterns and regexes extract named variables', () => {
  const regex = compileDiscoveryPattern('{machine}/{date:yyyyMMdd}')

  assert.deepEqual({ ...regex.exec('robot-7/20260913')?.groups }, {
    machine: 'robot-7',
    date: '20260913'
  })
  assert.deepEqual(
    matchDiscoveryPattern('{date:yyyy-MM-dd}', '2026-09-13')?.variables,
    { date: '2026-09-13' }
  )
  assert.equal(matchDiscoveryPattern('{date:yyyy-MM-dd}', '2026-9-13'), null)
  assert.deepEqual(
    matchDiscoveryRegex('^(?<machine>[^_]+)_(?<date>\\d{8})$', 'M1_20260913')?.variables,
    { machine: 'M1', date: '20260913' }
  )
})

test('directory discovery finds generic groups and task variables', async () => {
  const root = mkdtempSync(join(tmpdir(), 'generic-discovery-'))
  try {
    mkdirSync(join(root, 'machine-a', '20260913', 'session-1'), { recursive: true })
    mkdirSync(join(root, 'machine-a', '20260913', 'ignore-me'), { recursive: true })
    mkdirSync(join(root, 'machine-b', '20260914', 'session-2'), { recursive: true })

    const groups = await discoverUploadGroups(root, {
      groupPattern: '{machine}/{date:yyyyMMdd}',
      taskRegex: '^session-(?<session>\\d+)$',
      recursive: false
    })

    assert.deepEqual(
      groups.map((group) => ({
        key: group.groupKey,
        variables: group.variables,
        tasks: group.taskDirectories.map((task) => ({
          key: task.taskKey,
          ignored: task.ignored,
          variables: task.variables
        }))
      })),
      [
        {
          key: 'machine-a/20260913',
          variables: { machine: 'machine-a', date: '20260913' },
          tasks: [
            {
              key: 'ignore-me',
              ignored: true,
              variables: { machine: 'machine-a', date: '20260913' }
            },
            {
              key: 'session-1',
              ignored: false,
              variables: { machine: 'machine-a', date: '20260913', session: '1' }
            }
          ]
        },
        {
          key: 'machine-b/20260914',
          variables: { machine: 'machine-b', date: '20260914' },
          tasks: [
            {
              key: 'session-2',
              ignored: false,
              variables: { machine: 'machine-b', date: '20260914', session: '2' }
            }
          ]
        }
      ]
    )
    assert.deepEqual(
      extractDiscoveryVariables(
        {
          groupPattern: '{machine}/{date:yyyyMMdd}',
          taskRegex: '^session-(?<session>\\d+)$'
        },
        root,
        join(root, 'machine-a', '20260913', 'session-1')
      ),
      { machine: 'machine-a', date: '20260913', session: '1' }
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('path mapping renders generic templates and rejects unsafe variables', () => {
  assert.equal(
    renderPathMapping(
      {
        mode: 'template',
        template: 'archive/{machine}/{date}/{session}/{relativePath}'
      },
      {
        sourcePath: '/data/machine-a/20260913/session-1',
        relativePath: 'camera/frame001.jpg',
        variables: {
          machine: 'machine-a',
          date: '20260913',
          session: 'session-1'
        }
      }
    ),
    'archive/machine-a/20260913/session-1/camera/frame001.jpg'
  )
  assert.equal(
    renderPathMapping(
      { mode: 'flatten' },
      {
        sourcePath: '/data/machine-a/20260913/session-1',
        relativePath: 'camera/frame001.jpg'
      }
    ),
    'frame001.jpg'
  )
  assert.deepEqual(
    validatePathMappingTemplate('archive/{missing}/{relativePath}'),
    ['未知路径变量: missing']
  )
  assert.deepEqual(
    validatePathMappingTemplate('../{relativePath}', { date: '20260913' }),
    ['路径映射模板不能包含 .. 路径段']
  )
})

test('upload group transitions and completion policies stay explicit', () => {
  assert.equal(canUploadGroupTransition('open', 'closing'), true)
  assert.equal(canUploadGroupTransition('open', 'cleaned'), false)
  assert.doesNotThrow(() => assertUploadGroupTransition('sealed', 'cleanable'))
  assert.throws(
    () => assertUploadGroupTransition('open', 'cleaned'),
    /非法 UploadGroup 状态跳转/
  )

  assert.equal(
    deriveUploadGroupStatus({
      currentStatus: 'open',
      completion: { mode: 'manual' },
      taskStatuses: ['completed']
    }),
    'open'
  )
  assert.equal(
    deriveUploadGroupStatus({
      currentStatus: 'closing',
      completion: { mode: 'manual' },
      taskStatuses: ['completed']
    }),
    'sealed'
  )
  assert.equal(
    deriveUploadGroupStatus({
      currentStatus: 'open',
      completion: { mode: 'rollover' },
      taskStatuses: ['pending'],
      hasNewerGroup: true
    }),
    'closing'
  )
  assert.equal(
    deriveUploadGroupStatus({
      currentStatus: 'open',
      completion: { mode: 'none' },
      taskStatuses: ['completed']
    }),
    'open'
  )
  assert.equal(
    deriveUploadGroupStatus({
      currentStatus: 'open',
      completion: { mode: 'inactivity', idleMinutes: 5 },
      taskStatuses: ['completed'],
      lastContentActivityAt: '2026-09-13T10:00:00.000Z',
      now: new Date('2026-09-13T10:06:00.000Z')
    }),
    'sealed'
  )
  assert.equal(
    deriveUploadGroupStatus({
      currentStatus: 'open',
      completion: { mode: 'inactivity', idleMinutes: 5 },
      taskStatuses: ['completed'],
      lastContentActivityAt: '2026-09-13T10:04:00.000Z',
      now: new Date('2026-09-13T10:06:00.000Z')
    }),
    'open'
  )
  assert.equal(
    deriveUploadGroupStatus({
      currentStatus: 'open',
      completion: { mode: 'rollover' },
      taskStatuses: ['failed']
    }),
    'error'
  )
})
