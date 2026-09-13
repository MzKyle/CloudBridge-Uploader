import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import { getActiveProfileScanRoots } from '../src/shared/scan-config'
import { destinationsForProviders, providersForMode } from '../src/shared/cloud-upload'
import {
  resolveProfileUploadSnapshot
} from '../src/shared/upload-profile'
import { shouldRestartScannerAfterSettingsSave } from '../src/shared/settings-effects'
import type {
  AppSettings,
  CloudProvider,
  PathMappingConfig,
  UploadPathMode,
  UploadProfile
} from '../src/shared/types'
import {
  runMigrations,
  setDbForTests
} from '../src/main/db/database'
import { SettingsRepo } from '../src/main/db/settings.repo'
import { TaskRepo } from '../src/main/db/task.repo'
import { TaskRunnerService } from '../src/main/services/task-runner.service'
import { ScannerService } from '../src/main/services/scanner.service'

const TEST_DATE = '2026-06-29'

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

function createProfile(input: {
  id: string
  name: string
  targetMode: AppSettings['cloud']['targetMode']
  directories: Partial<Record<CloudProvider, string[]>>
  suffixes: string[]
  aliyun?: Partial<UploadProfile['providers']['aliyun']>
  tencent?: Partial<UploadProfile['providers']['tencent']>
  enabled?: boolean
}): UploadProfile {
  const base = cloneDefaults().profiles[0]
  const targetMode = input.targetMode
  const activeProviders = providersForMode(targetMode)
  const providerDirectories = {
    aliyun: input.directories.aliyun ?? [],
    tencent: input.directories.tencent ?? []
  }
  const providers = {
    aliyun: {
      ...base.providers.aliyun,
      ...input.aliyun
    },
    tencent: {
      ...base.providers.tencent,
      ...input.tencent
    }
  }
  const sourceRoots = Array.from(
    new Set(activeProviders.flatMap((provider) => providerDirectories[provider]))
  )
  return {
    ...base,
    id: input.id,
    name: input.name,
    enabled: input.enabled ?? true,
    targetMode,
    source: {
      root: sourceRoots[0] || '',
      roots: sourceRoots
    },
    destinations: destinationsForProviders(activeProviders),
    pathMapping: pathMappingFromProviderConfig(providers[activeProviders[0]]),
    filter: {
      whitelist: [],
      blacklist: [],
      regex: [],
      suffixes: input.suffixes
    },
    scan: {
      providerDirectories,
      workDirNamePattern: '^\\d{2}-\\d{2}-\\d{2}$'
    },
    providers
  }
}

function pathMappingFromProviderConfig(
  provider: UploadProfile['providers']['aliyun']
): PathMappingConfig {
  if (provider.pathMode === 'template') {
    return {
      mode: 'template',
      template: provider.objectKeyTemplate || '{relativePath}'
    }
  }
  if (provider.pathMode === 'date-workdir') {
    return {
      mode: 'template',
      template: '{date}/{session}/{relativePath}'
    }
  }
  if (provider.pathMode === 'keep-source') {
    return {
      mode: 'template',
      template: '{sourceRelativePath}/{relativePath}'
    }
  }
  if (provider.pathMode === 'last-segments') {
    const count = Math.max(1, Math.min(3, provider.pathSegmentCount || 1))
    return {
      mode: 'template',
      template: `{sourceLast${count}}/{relativePath}`
    }
  }
  return { mode: 'keep-relative' }
}

function saveProfiles(profiles: UploadProfile[], activeProfileId = profiles[0].id): void {
  new SettingsRepo().saveAll({
    profiles,
    activeProfileId,
    scan: {
      ...cloneDefaults().scan,
      intervalSeconds: 30
    }
  })
}

function mkdirWithFiles(
  root: string,
  workDirName: string,
  files: Record<string, string>
): string {
  const workDir = join(root, TEST_DATE, workDirName)
  mkdirSync(workDir, { recursive: true })
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(workDir, relativePath)
    mkdirSync(join(filePath, '..'), { recursive: true })
    writeFileSync(filePath, content)
  }
  return workDir
}

async function flushTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('profile scan roots use enabled profile provider scopes', () => {
  const profileA = createProfile({
    id: 'profile-a',
    name: 'Profile A',
    targetMode: 'aliyun',
    directories: { aliyun: ['/roots/a'], tencent: ['/ignored/tencent'] },
    suffixes: ['.jpg']
  })
  const profileB = createProfile({
    id: 'profile-b',
    name: 'Profile B',
    targetMode: 'tencent',
    directories: { tencent: ['/roots/b'] },
    suffixes: ['.csv'],
    enabled: false
  })
  const profileC = createProfile({
    id: 'profile-c',
    name: 'Profile C',
    targetMode: 'both',
    directories: { aliyun: ['/roots/c'], tencent: ['/roots/c'] },
    suffixes: ['.txt']
  })

  assert.deepEqual(getActiveProfileScanRoots([profileA, profileB, profileC]), [
    {
      directory: '/roots/a',
      providers: ['aliyun'],
      profileId: 'profile-a',
      profileName: 'Profile A'
    },
    {
      directory: '/roots/c',
      providers: ['aliyun', 'tencent'],
      profileId: 'profile-c',
      profileName: 'Profile C'
    }
  ])
})

test('manual task creation freezes profile snapshot and destination path config', () => {
  const db = createDatabase()
  try {
    const profile = createProfile({
      id: 'manual-profile',
      name: 'Manual Profile',
      targetMode: 'aliyun',
      directories: {},
      suffixes: ['.jpg'],
      aliyun: {
        prefix: 'qa/manual',
        pathMode: 'template',
        objectKeyTemplate: '{profile}/{relativePath}'
      }
    })
    saveProfiles([profile])

    const snapshot = resolveProfileUploadSnapshot(
      profile,
      {
        sourcePath: '/data/manual/10-00-01',
        basePath: '/data/manual',
        workDirName: '10-00-01'
      }
    )
    const task = new TaskRepo().create({
      folderPath: '/data/manual/10-00-01',
      folderName: '10-00-01',
      ossPrefix: snapshot.prefixes.aliyun,
      uploadTargetMode: snapshot.mode,
      destinationPrefixes: snapshot.prefixes,
      destinationUploadRelativePaths: snapshot.uploadRelativePaths,
      destinationPathModes: snapshot.pathModes,
      destinationObjectKeyTemplates: snapshot.objectKeyTemplates,
      uploadRelativePath: snapshot.uploadRelativePath,
      sourceType: 'manual',
      profileId: snapshot.profileId,
      profileName: snapshot.profileName,
      profileSnapshot: snapshot.profileSnapshot
    })

    const changedProfile = {
      ...profile,
      filter: { ...profile.filter, suffixes: ['.csv'] },
      providers: {
        ...profile.providers,
        aliyun: {
          ...profile.providers.aliyun,
          prefix: 'qa/changed',
          objectKeyTemplate: 'changed/{relativePath}'
        }
      }
    }
    saveProfiles([changedProfile])

    const stored = new TaskRepo().getById(task.id)
    assert.ok(stored)
    assert.equal(stored.profileId, 'manual-profile')
    assert.equal(stored.profileName, 'Manual Profile')
    assert.equal(stored.profileSnapshot?.providers.aliyun.prefix, 'qa/manual')
    assert.deepEqual(stored.profileSnapshot?.filter.suffixes, ['.jpg'])
    assert.deepEqual(
      stored.destinations.map((destination) => ({
        provider: destination.provider,
        prefix: destination.prefix,
        pathMode: destination.pathMode,
        objectKeyTemplate: destination.objectKeyTemplate
      })),
      [
        {
          provider: 'aliyun',
          prefix: 'qa/manual',
          pathMode: 'template' as UploadPathMode,
          objectKeyTemplate: '{profile}/{relativePath}'
        }
      ]
    )
  } finally {
    closeDatabase(db)
  }
})

test('settings repo preserves persisted upload profile arrays', () => {
  const db = createDatabase()
  try {
    const profileA = createProfile({
      id: 'profile-a',
      name: 'Profile A',
      targetMode: 'aliyun',
      directories: { aliyun: ['/data/a'] },
      suffixes: ['.jpg'],
      aliyun: {
        prefix: 'qa/a',
        pathMode: 'template',
        objectKeyTemplate: 'a/{relativePath}'
      }
    })
    const profileB = createProfile({
      id: 'profile-b',
      name: 'Profile B',
      targetMode: 'tencent',
      directories: { tencent: ['/data/b'] },
      suffixes: ['.csv'],
      tencent: {
        prefix: 'qa/b',
        pathMode: 'date-workdir'
      }
    })

    saveProfiles([profileA, profileB], profileB.id)

    const stored = new SettingsRepo().getAll()
    assert.equal(stored.activeProfileId, 'profile-b')
    assert.deepEqual(stored.profiles.map((profile) => profile.id), [
      'profile-a',
      'profile-b'
    ])
    assert.equal(stored.profiles[0].providers.aliyun.prefix, 'qa/a')
    assert.equal(stored.profiles[1].providers.tencent.pathMode, 'date-workdir')
  } finally {
    closeDatabase(db)
  }
})

test('scanner creates isolated profile tasks and profile filters do not leak', async () => {
  const db = createDatabase()
  const root = mkdtempSync(join(tmpdir(), 'profile-scan-'))
  try {
    const rootA = join(root, 'root-a')
    const rootB = join(root, 'root-b')
    const rootC = join(root, 'root-c')
    mkdirWithFiles(rootA, '10-00-01', {
      'camera/a.jpg': 'jpg',
      'data/a.bmp': 'bmp'
    })
    mkdirWithFiles(rootB, '10-00-02', {
      'data/b.csv': 'csv',
      'camera/b.jpg': 'jpg'
    })
    mkdirWithFiles(rootC, '10-00-03', {
      'note.txt': 'txt',
      'meta.json': 'json'
    })

    const profileA = createProfile({
      id: 'profile-a',
      name: 'Profile A',
      targetMode: 'aliyun',
      directories: { aliyun: [rootA] },
      suffixes: ['.jpg'],
      aliyun: {
        prefix: 'qa/a',
        pathMode: 'template',
        objectKeyTemplate: 'a/{relativePath}'
      }
    })
    const profileB = createProfile({
      id: 'profile-b',
      name: 'Profile B',
      targetMode: 'tencent',
      directories: { tencent: [rootB] },
      suffixes: ['.csv'],
      tencent: {
        prefix: 'qa/b',
        pathMode: 'date-workdir'
      }
    })
    const profileC = createProfile({
      id: 'profile-c',
      name: 'Profile C',
      targetMode: 'both',
      directories: { aliyun: [rootC], tencent: [rootC] },
      suffixes: ['.txt'],
      aliyun: {
        prefix: 'qa/c-ali',
        pathMode: 'target-root'
      },
      tencent: {
        prefix: 'qa/c-ten',
        pathMode: 'last-segments',
        pathSegmentCount: 2
      }
    })
    saveProfiles([profileA, profileB, profileC])

    const scanner = new ScannerService() as unknown as ScannerService & {
	      scanRootDirectory: (
	        root: {
	          directory: string
	          providers: CloudProvider[]
	          profileId: string
	          profileName: string
	        },
	        seenChildPaths: Set<string>,
	        profile?: UploadProfile
	      ) => Promise<unknown>
      queueReconcileTask: (task: unknown) => void
    }
    scanner.queueReconcileTask = () => {}

    for (const profile of [profileA, profileB, profileC]) {
      const providerDirectories = profile.scan.providerDirectories
      const directory = providerDirectories.aliyun[0] || providerDirectories.tencent[0]
      await scanner.scanRootDirectory(
        {
          directory,
          providers: providersForMode(profile.targetMode),
	          profileId: profile.id,
	          profileName: profile.name
	        },
	        new Set(),
	        profile
	      )
    }

    const repo = new TaskRepo()
    const tasks = repo.listByStatus()
    assert.equal(tasks.length, 3)

    const taskA = repo.getByFolderPath(join(rootA, TEST_DATE, '10-00-01'))
    const taskB = repo.getByFolderPath(join(rootB, TEST_DATE, '10-00-02'))
    const taskC = repo.getByFolderPath(join(rootC, TEST_DATE, '10-00-03'))
    assert.ok(taskA)
    assert.ok(taskB)
    assert.ok(taskC)

    assert.deepEqual(taskA.destinations.map((item) => item.provider), ['aliyun'])
    assert.equal(taskA.destinations[0].prefix, 'qa/a')
    assert.equal(taskA.destinations[0].pathMode, 'template')
    assert.equal(taskA.destinations[0].objectKeyTemplate, 'a/{relativePath}')

	    assert.deepEqual(taskB.destinations.map((item) => item.provider), ['tencent'])
	    assert.equal(taskB.destinations[0].prefix, 'qa/b')
	    assert.equal(taskB.destinations[0].pathMode, 'template')
	    assert.equal(taskB.destinations[0].objectKeyTemplate, '{date}/{session}/{relativePath}')
	    assert.equal(taskB.destinations[0].uploadRelativePath, '')

    assert.deepEqual(
      taskC.destinations.map((item) => ({
        provider: item.provider,
        prefix: item.prefix,
        pathMode: item.pathMode,
        uploadRelativePath: item.uploadRelativePath
      })),
      [
        {
          provider: 'aliyun',
          prefix: 'qa/c-ali',
          pathMode: 'target-root',
          uploadRelativePath: ''
        },
        {
          provider: 'tencent',
          prefix: 'qa/c-ten',
          pathMode: 'last-segments',
          uploadRelativePath: `${TEST_DATE}/10-00-03`
        }
      ]
    )

    await scanner.reconcileTask(taskA)
    await scanner.reconcileTask(taskB)
    await scanner.reconcileTask(taskC)

    assert.deepEqual(repo.listFiles(taskA.id).map((file) => file.relativePath), [
      'camera/a.jpg'
    ])
    assert.deepEqual(repo.listFiles(taskB.id).map((file) => file.relativePath), [
      'data/b.csv'
    ])
    assert.deepEqual(repo.listFiles(taskC.id).map((file) => file.relativePath), [
      'note.txt'
    ])
    await flushTimers()
  } finally {
    rmSync(root, { recursive: true, force: true })
    closeDatabase(db)
  }
})

test('template duplicate object keys fail before cloud upload', async () => {
  const db = createDatabase()
  const root = mkdtempSync(join(tmpdir(), 'profile-dup-key-'))
  try {
    mkdirSync(join(root, 'a'), { recursive: true })
    mkdirSync(join(root, 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'same.jpg'), 'a')
    writeFileSync(join(root, 'b', 'same.jpg'), 'b')

    const profile = createProfile({
      id: 'dup-profile',
      name: 'Duplicate Key Profile',
      targetMode: 'aliyun',
      directories: {},
      suffixes: ['.jpg'],
      aliyun: {
        prefix: 'qa/dup',
        pathMode: 'template',
        objectKeyTemplate: '{filename}'
      }
    })
    saveProfiles([profile])
    const snapshot = resolveProfileUploadSnapshot(profile, { sourcePath: root })
    const task = new TaskRepo().create({
      folderPath: root,
      folderName: 'manual',
      ossPrefix: snapshot.prefixes.aliyun,
      uploadTargetMode: snapshot.mode,
      destinationPrefixes: snapshot.prefixes,
      destinationUploadRelativePaths: snapshot.uploadRelativePaths,
      destinationPathModes: snapshot.pathModes,
      destinationObjectKeyTemplates: snapshot.objectKeyTemplates,
      uploadRelativePath: snapshot.uploadRelativePath,
      sourceType: 'manual',
      profileId: snapshot.profileId,
      profileName: snapshot.profileName,
      profileSnapshot: snapshot.profileSnapshot
    })

    await assert.rejects(
      () => new TaskRunnerService().run(task),
      /对象 Key 重复: qa\/dup\/same\.jpg/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    closeDatabase(db)
  }
})

test('legacy tasks without profile snapshots fall back to global filter rules', async () => {
  const db = createDatabase()
  const root = mkdtempSync(join(tmpdir(), 'profile-legacy-filter-'))
  try {
    writeFileSync(join(root, 'keep.csv'), 'csv')
    writeFileSync(join(root, 'drop.jpg'), 'jpg')
    new SettingsRepo().saveAll({
      filter: {
        whitelist: [],
        blacklist: [],
        regex: [],
        suffixes: ['.csv']
      }
    })
    const task = new TaskRepo().create({
      folderPath: root,
      folderName: 'legacy',
      uploadRelativePath: 'legacy',
      sourceType: 'manual'
    })

    await new ScannerService().reconcileTask(task)

    assert.deepEqual(new TaskRepo().listFiles(task.id).map((file) => file.relativePath), [
      'keep.csv'
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
    closeDatabase(db)
  }
})

test('saving profile settings restarts scanner watchers', () => {
  assert.equal(shouldRestartScannerAfterSettingsSave({ profiles: [] }), true)
  assert.equal(shouldRestartScannerAfterSettingsSave({ activeProfileId: 'a' }), true)
  assert.equal(shouldRestartScannerAfterSettingsSave({ scan: cloneDefaults().scan }), true)
  assert.equal(
    shouldRestartScannerAfterSettingsSave({ stability: cloneDefaults().stability }),
    true
  )
  assert.equal(shouldRestartScannerAfterSettingsSave({}), false)
})
