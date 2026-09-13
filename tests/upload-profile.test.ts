import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import {
  normalizeProfiles,
  renderObjectKey,
  resolveProfileUploadSnapshot,
  validateObjectKeyTemplate
} from '../src/shared/upload-profile'
import type { AppSettings } from '../src/shared/types'

function cloneDefaults(): AppSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings
}

test('normalizes legacy settings into a default upload profile', () => {
  const settings = cloneDefaults()
  settings.cloud.targetMode = 'both'
  settings.scan = {
    ...settings.scan,
    directories: ['/data/root'],
    providerDirectories: { aliyun: [], tencent: [] }
  }
  settings.oss.prefix = 'oss-prefix'
  settings.oss.pathMode = 'date-workdir'
  settings.tencentS3.prefix = 'tencent-prefix'
  settings.tencentS3.pathMode = 'last-segments'
  settings.tencentS3.pathSegmentCount = 3
  settings.profiles = []

  const normalized = normalizeProfiles(settings)

  assert.equal(normalized.activeProfileId, 'default')
  assert.equal(normalized.profiles.length, 1)
  const profile = normalized.profiles[0]
  assert.equal(profile.targetMode, 'both')
  assert.deepEqual(profile.scan.providerDirectories.aliyun, ['/data/root'])
  assert.deepEqual(profile.scan.providerDirectories.tencent, ['/data/root'])
  assert.equal(profile.providers.aliyun.prefix, 'oss-prefix')
  assert.equal(profile.providers.aliyun.pathMode, 'date-workdir')
  assert.equal(profile.providers.tencent.prefix, 'tencent-prefix')
  assert.equal(profile.providers.tencent.pathMode, 'last-segments')
  assert.equal(profile.providers.tencent.pathSegmentCount, 3)
})

test('renders template object keys with task and file variables', () => {
  const settings = cloneDefaults()
  const profile = {
    ...settings.profiles[0],
    providers: {
      ...settings.profiles[0].providers,
      aliyun: {
        ...settings.profiles[0].providers.aliyun,
        prefix: 'root',
        pathMode: 'template' as const,
        objectKeyTemplate: '{profile}/{date}/{workDir}/{relativePath}'
      }
    }
  }

  const snapshot = resolveProfileUploadSnapshot(
    profile,
    {
      sourcePath: '/data/2026-06-27/20-46-05',
      basePath: '/data',
      dateName: '2026-06-27',
      workDirName: '20-46-05'
    },
    ['aliyun']
  )
  const key = renderObjectKey(
    {
      provider: 'aliyun',
      prefix: snapshot.prefixes.aliyun,
      uploadRelativePath: snapshot.uploadRelativePaths.aliyun ?? '',
      pathMode: snapshot.pathModes.aliyun,
      objectKeyTemplate: snapshot.objectKeyTemplates.aliyun
    },
    {
      sourcePath: '/data/2026-06-27/20-46-05',
      basePath: '/data',
      dateName: '2026-06-27',
      workDirName: '20-46-05',
      profileName: profile.name,
      folderName: '20-46-05',
      relativePath: 'camera/a.jpg'
    }
  )

  assert.equal(key, 'root/默认归档/2026-06-27/20-46-05/camera/a.jpg')
})

test('renders Windows-style paths and filename variables', () => {
  const key = renderObjectKey(
    {
      provider: 'tencent',
      prefix: '',
      uploadRelativePath: '',
      pathMode: 'template',
      objectKeyTemplate: '{sourceLast2}/{stem}{ext}'
    },
    {
      sourcePath: 'C:\\data\\2026-06-27\\20-46-05',
      dateName: '2026-06-27',
      workDirName: '20-46-05',
      relativePath: 'camera\\frame001.png'
    }
  )

  assert.equal(key, '2026-06-27/20-46-05/frame001.png')
})

test('rejects unsafe or unknown template expressions', () => {
  assert.deepEqual(validateObjectKeyTemplate(''), ['对象 Key 模板不能为空'])
  assert.deepEqual(
    validateObjectKeyTemplate('{relativePath}/{unknown}'),
    ['未知模板变量: unknown']
  )
  assert.deepEqual(
    validateObjectKeyTemplate('/absolute/{relativePath}'),
    ['对象 Key 模板不能使用绝对路径']
  )
  assert.deepEqual(
    validateObjectKeyTemplate('../{relativePath}'),
    ['对象 Key 模板不能包含 .. 路径段']
  )
})
