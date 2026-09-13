import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import {
  BUILTIN_EXTENSIONS,
  BUILTIN_UPLOAD_PIPELINES,
  DEFAULT_PROFILE_EXTENSIONS,
  DEFAULT_PROFILE_UPLOAD_PIPELINE,
  EXTENSION_IDS,
  PLUGIN_IDS,
  UPLOAD_PIPELINE_IDS
} from '../src/shared/plugins'
import { destinationsForProviders, providersForMode } from '../src/shared/cloud-upload'
import { normalizeProfiles } from '../src/shared/upload-profile'
import type { AppSettings, ProfileExtensionConfig, ProfilePluginConfig, Task, UploadProfile } from '../src/shared/types'
import { runMigrations, setDbForTests } from '../src/main/db/database'
import { TaskRepo } from '../src/main/db/task.repo'
import { getTaskDestinationRepo } from '../src/main/db/task-destination.repo'
import { getPluginRunRepo } from '../src/main/db/plugin-run.repo'
import { SettingsRepo } from '../src/main/db/settings.repo'
import { Module1PreUploadService } from '../src/main/services/module1-preupload.service'
import { ExtensionRuntimeService } from '../src/main/services/extension-runtime.service'
import { UploadPipelineRuntimeService } from '../src/main/services/upload-pipeline-runtime.service'
import { OSSBrowserService } from '../src/main/services/oss-browser.service'
import { TaskRunnerService } from '../src/main/services/task-runner.service'
import { getCloudUploadService } from '../src/main/services/cloud-upload.service'

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

function cloneExtensionDefaults(): ProfileExtensionConfig {
  return JSON.parse(JSON.stringify(DEFAULT_PROFILE_EXTENSIONS)) as ProfileExtensionConfig
}

function extensionsWith(
  enabledIds: string[],
  configs: Record<string, unknown> = {}
): ProfileExtensionConfig {
  const extensions = cloneExtensionDefaults()
  extensions.enabledIds = enabledIds
  extensions.configs = {
    ...extensions.configs,
    ...configs
  }
  return extensions
}

function createProfile(input: {
  id: string
  name?: string
  targetMode?: UploadProfile['targetMode']
  uploadPipeline?: UploadProfile['uploadPipeline']
  extensions?: ProfileExtensionConfig
  plugins?: ProfilePluginConfig
}): UploadProfile {
  const base = cloneDefaults().profiles[0]
  const targetMode = input.targetMode || 'aliyun'
  return {
    ...base,
    id: input.id,
    name: input.name || input.id,
    targetMode,
    destinations: destinationsForProviders(providersForMode(targetMode)),
    uploadPipeline: input.uploadPipeline || JSON.parse(JSON.stringify(DEFAULT_PROFILE_UPLOAD_PIPELINE)),
    extensions: input.extensions || cloneExtensionDefaults(),
    plugins: input.plugins
  }
}

function createModule1Source(root: string): void {
  const sample = join(root, 'sample')
  mkdirSync(join(sample, 'welding_state'), { recursive: true })
  mkdirSync(join(sample, 'camera_0'), { recursive: true })
  mkdirSync(join(sample, 'annotation'), { recursive: true })
  writeFileSync(
    join(sample, 'welding_state', 'weld_signal.csv'),
    '10000000 arc: true\n20000000 arc: false\n'
  )
  writeFileSync(join(sample, 'camera_0', '1.jpg'), 'outside')
  writeFileSync(join(sample, 'camera_0', '10000000.jpg'), 'inside')
  writeFileSync(join(sample, 'state_type'), 'state')
  writeFileSync(
    join(sample, 'annotation', 'segment_timestamps.xml'),
    [
      '<root>',
      '<data_spec_min>1</data_spec_min>',
      '<data_spec_max>1</data_spec_max>',
      '<data_type>teleop</data_type>',
      '<quality_type>good</quality_type>',
      '</root>'
    ].join('')
  )
}

function createTaskObject(root: string, profileSnapshot: UploadProfile | null = null): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    folderPath: root,
    folderName: 'root',
    status: 'pending',
    totalFiles: 0,
    uploadedFiles: 0,
    totalBytes: 0,
    uploadedBytes: 0,
    ossPrefix: '',
    uploadTargetMode: 'aliyun',
    destinations: [],
    dayFolderId: null,
    uploadRelativePath: '',
    errorMessage: null,
    sourceType: 'manual',
    sourceMachineId: null,
    profileId: profileSnapshot?.id || null,
    profileName: profileSnapshot?.name || null,
    profileSnapshot,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null
  }
}

async function waitForPluginRun(taskId: string, pluginId: string) {
  for (let i = 0; i < 50; i++) {
    const run = getPluginRunRepo()
      .listByTask(taskId)
      .find((item) => item.pluginId === pluginId && item.status !== 'running')
    if (run) return run
    await delay(20)
  }
  throw new Error(`插件运行记录未完成: ${pluginId}`)
}

test('builtin capability registries expose the fixed first-party capabilities', () => {
  assert.deepEqual(
    BUILTIN_UPLOAD_PIPELINES.map((pipeline) => pipeline.id),
    [
      UPLOAD_PIPELINE_IDS.STANDARD_UPLOAD,
      UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD
    ]
  )
  assert.deepEqual(
    BUILTIN_EXTENSIONS.map((extension) => extension.id),
    [
      EXTENSION_IDS.WEBHOOK_NOTIFIER,
      EXTENSION_IDS.OSS_BROWSER,
      EXTENSION_IDS.GENERIC_CONVERTER
    ]
  )
})

test('profile normalization fills pipeline and extension config and preserves legacy webhook enablement', () => {
  const settings = cloneDefaults()
  settings.webhook = {
    enabled: true,
    url: 'https://example.test/hook',
    headers: { 'X-Test': '1' }
  }
  settings.profiles = [
    {
      ...settings.profiles[0],
      uploadPipeline: undefined,
      extensions: undefined,
      plugins: undefined
    }
  ]

  const { profiles } = normalizeProfiles(settings)
  const profile = profiles[0]
  assert.equal(profile.uploadPipeline?.id, UPLOAD_PIPELINE_IDS.STANDARD_UPLOAD)
  assert.ok(profile.extensions?.enabledIds.includes(EXTENSION_IDS.WEBHOOK_NOTIFIER))
  assert.deepEqual(profile.extensions?.configs[EXTENSION_IDS.WEBHOOK_NOTIFIER], settings.webhook)
  assert.equal(profile.plugins, undefined)
})

test('profile normalization migrates legacy module1 plugin into the SANY upload pipeline', () => {
  const settings = cloneDefaults()
  settings.profiles = [
    {
      ...settings.profiles[0],
      uploadPipeline: undefined,
      extensions: undefined,
      plugins: {
        enabledPluginIds: [PLUGIN_IDS.MODULE1_PREUPLOAD, EXTENSION_IDS.OSS_BROWSER],
        order: [PLUGIN_IDS.MODULE1_PREUPLOAD, EXTENSION_IDS.OSS_BROWSER],
        configs: {
          [PLUGIN_IDS.MODULE1_PREUPLOAD]: { stationPrefix: 'legacyStation' },
          [EXTENSION_IDS.OSS_BROWSER]: { enabled: true }
        }
      }
    }
  ]

  const { profiles } = normalizeProfiles(settings)
  const profile = profiles[0]
  assert.equal(profile.uploadPipeline?.id, UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD)
  assert.equal(profile.uploadPipeline?.config.stationPrefix, 'legacyStation')
  assert.deepEqual(profile.extensions?.enabledIds, [EXTENSION_IDS.OSS_BROWSER])
})

test('reconcileFiles writes planned object keys onto destination targets', () => {
  const db = createDatabase()
  try {
    const taskRepo = new TaskRepo()
    const task = taskRepo.create({
      folderPath: '/tmp/source',
      folderName: 'source',
      uploadTargetMode: 'both',
      destinationPrefixes: { aliyun: '', tencent: '' },
      sourceType: 'manual'
    })

    taskRepo.reconcileFiles(
      task.id,
      [
        {
          relativePath: 'sample/camera_0/10000000.jpg',
          size: 10,
          mtimeMs: 1000,
          plannedObjectKey: 'station2/vla/1mm/2026-07-05/sample/camera_0/10000000.jpg'
        }
      ],
      1
    )

    const targets = getTaskDestinationRepo().listReadyFileTargets(task.id, 1)
    assert.equal(targets.length, 2)
    assert.ok(targets.every((target) => target.plannedObjectKey?.startsWith('station2/')))
  } finally {
    closeDatabase(db)
  }
})

test('Module1 pre-upload runs in staging and does not mutate the source directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'module1-source-'))
  try {
    createModule1Source(root)
    const sample = join(root, 'sample')
    const task = createTaskObject(root)

    const result = await new Module1PreUploadService().run(task, {
      stationPrefix: 'stationX'
    })

    assert.ok(existsSync(join(sample, 'camera_0', '1.jpg')))
    assert.ok(!existsSync(join(result.uploadRootPath, 'sample', 'camera_0', '1.jpg')))
    assert.equal(result.pipelineId, UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD)
    assert.ok(result.files.some((file) => file.plannedObjectKey?.startsWith('stationX/teleop/1mm/')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('upload pipeline runtime records SANY Module1 runs and exposes capability status', async () => {
  const db = createDatabase()
  const root = mkdtempSync(join(tmpdir(), 'module1-runtime-'))
  try {
    createModule1Source(root)
    const profile = createProfile({
      id: 'sany-profile',
      name: 'SANY Profile',
      uploadPipeline: {
        id: UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD,
        config: {
          stationPrefix: 'stationR'
        }
      }
    })
    new SettingsRepo().saveAll({
      profiles: [profile],
      activeProfileId: profile.id
    })

    const task = new TaskRepo().create({
      folderPath: root,
      folderName: 'root',
      uploadTargetMode: 'aliyun',
      sourceType: 'manual',
      profileId: profile.id,
      profileName: profile.name,
      profileSnapshot: profile
    })

    const runtime = new UploadPipelineRuntimeService()
    const result = await runtime.prepareUploadPlan(task, 1)
    assert.equal(result.pipelineId, UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD)

    const runs = getPluginRunRepo().listByTask(task.id)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].status, 'completed')
    assert.equal(runs[0].pluginId, UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD)
    assert.equal(runs[0].category, 'pipeline')
    assert.ok(runs[0].stagingPath?.includes('/plugin-workspaces/'))
    assert.ok(runs[0].artifacts?.manifestPath)

    const status = new ExtensionRuntimeService().getProjectCapabilityStatus(profile.id)
    assert.equal(status.uploadPipeline.manifest.id, UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD)
    assert.equal(status.uploadPipeline.lastRun?.id, runs[0].id)
    assert.match(status.uploadPipeline.configSummary, /stationPrefix=stationR/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    closeDatabase(db)
  }
})

test('TaskRunner uploads Module1 staging files with plugin planned object keys', async () => {
  const db = createDatabase()
  const root = mkdtempSync(join(tmpdir(), 'module1-runner-'))
  const uploads: Array<{ filePath: string; objectKey: string }> = []
  const cloud = getCloudUploadService()
  const originalValidateProvider = cloud.validateProvider.bind(cloud)
  const originalCreateTaskUploader = cloud.createTaskUploader.bind(cloud)

  try {
    createModule1Source(root)
    const profile = createProfile({
      id: 'runner-profile',
      uploadPipeline: {
        id: UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD,
        config: {
          stationPrefix: 'stationUpload'
        }
      }
    })

    new SettingsRepo().saveAll({
      profiles: [profile],
      activeProfileId: profile.id
    })

    const task = new TaskRepo().create({
      folderPath: root,
      folderName: 'root',
      uploadTargetMode: 'aliyun',
      destinationPrefixes: { aliyun: 'profile-prefix' },
      destinationUploadRelativePaths: { aliyun: 'profile-relative' },
      destinationPathModes: { aliyun: 'template' },
      destinationObjectKeyTemplates: { aliyun: 'template/{relativePath}' },
      sourceType: 'manual',
      profileId: profile.id,
      profileName: profile.name,
      profileSnapshot: profile
    })

    cloud.validateProvider = () => null
    cloud.createTaskUploader = async (provider) => ({
      provider,
      uploadFile: async (filePath, objectKey, _fileSize, onProgress) => {
        uploads.push({ filePath, objectKey })
        onProgress?.(1)
        return { objectKey, uploadId: `mock-${uploads.length}` }
      },
      uploadBuffer: async (_buffer, objectKey) => objectKey,
      abort: () => undefined,
      dispose: () => undefined
    })

    const status = await new TaskRunnerService().run(task)

    assert.equal(status, 'completed')
    assert.ok(uploads.length > 0)
    assert.ok(uploads.every((upload) => upload.filePath.includes('/plugin-workspaces/')))
    assert.ok(uploads.every((upload) => !upload.objectKey.startsWith('profile-prefix/template/')))
    assert.ok(uploads.some((upload) => upload.objectKey.startsWith('stationUpload/teleop/1mm/')))
    assert.ok(existsSync(join(root, 'sample', 'camera_0', '1.jpg')))
    assert.ok(getPluginRunRepo().listByTask(task.id).some((run) => run.status === 'completed'))
  } finally {
    cloud.validateProvider = originalValidateProvider
    cloud.createTaskUploader = originalCreateTaskUploader
    rmSync(root, { recursive: true, force: true })
    closeDatabase(db)
  }
})

test('webhook notifier uses profile plugin config and does not block task event handling', async () => {
  const db = createDatabase()
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; headers: HeadersInit | undefined; body: unknown }> = []

  try {
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        headers: init?.headers,
        body: init?.body
      })
      return {
        ok: true,
        status: 200,
        statusText: 'OK'
      } as Response
    }) as typeof fetch

    const profile = createProfile({
      id: 'webhook-profile',
      extensions: extensionsWith([EXTENSION_IDS.WEBHOOK_NOTIFIER], {
        [EXTENSION_IDS.WEBHOOK_NOTIFIER]: {
          enabled: true,
          url: 'https://webhook.example.test/task',
          headers: { 'X-Project': 'sany' }
        }
      })
    })
    const task = new TaskRepo().create({
      folderPath: '/tmp/webhook-task',
      folderName: 'webhook-task',
      uploadTargetMode: 'aliyun',
      sourceType: 'manual',
      profileId: profile.id,
      profileName: profile.name,
      profileSnapshot: profile
    })

    new ExtensionRuntimeService().notifyTaskEvent(task, 'task_completed')
    const run = await waitForPluginRun(task.id, EXTENSION_IDS.WEBHOOK_NOTIFIER)

    assert.equal(run.status, 'completed')
    assert.equal(run.summary?.event, 'task_completed')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'https://webhook.example.test/task')
    assert.match(String(requests[0].body), /"taskId"/)
  } finally {
    globalThis.fetch = originalFetch
    closeDatabase(db)
  }
})

test('OSS browser plugin rejects unavailable profile configurations before creating clients', async () => {
  const db = createDatabase()
  try {
    const disabledProfile = createProfile({
      id: 'oss-disabled',
      targetMode: 'aliyun',
      extensions: extensionsWith([])
    })
    new SettingsRepo().saveAll({
      profiles: [disabledProfile],
      activeProfileId: disabledProfile.id
    })
    await assert.rejects(
      () => new OSSBrowserService().list(),
      /未启用 OSS 浏览器插件/
    )

    const tencentOnlyProfile = createProfile({
      id: 'oss-tencent-only',
      targetMode: 'tencent',
      extensions: extensionsWith([EXTENSION_IDS.OSS_BROWSER])
    })
    new SettingsRepo().saveAll({
      profiles: [tencentOnlyProfile],
      activeProfileId: tencentOnlyProfile.id
    })
    await assert.rejects(
      () => new OSSBrowserService().list(),
      /仅支持包含阿里云目标/
    )
  } finally {
    closeDatabase(db)
  }
})
