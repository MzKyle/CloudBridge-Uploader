import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import { EXTENSION_IDS } from '../src/shared/plugins'
import {
  DEFAULT_GENERIC_CONVERTER_CONFIG,
  applyGenericConverterScanHandoff,
  normalizeGenericConverterConfig
} from '../src/shared/generic-converter'
import type { AppSettings, UploadProfile } from '../src/shared/types'
import { runMigrations, setDbForTests } from '../src/main/db/database'
import { SettingsRepo } from '../src/main/db/settings.repo'
import { GenericConverterService } from '../src/main/services/generic-converter.service'

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

function baseProfile(): UploadProfile {
  return cloneDefaults().profiles[0]
}

test('generic converter config normalization clamps numbers and falls back on invalid regex', () => {
  const config = normalizeGenericConverterConfig({
    enabled: true,
    pythonPath: '',
    stableSeconds: -1,
    pollIntervalSeconds: 0,
    retryFailed: true,
    env: { COVER_MCAP_WORKSPACE_SETUP: 123 },
    extraArgs: [' --once ', '', 5],
    outputBatchNamePattern: '['
  })

  assert.equal(config.enabled, true)
  assert.equal(config.pythonPath, DEFAULT_GENERIC_CONVERTER_CONFIG.pythonPath)
  assert.equal(config.stableSeconds, 0)
  assert.equal(config.pollIntervalSeconds, 1)
  assert.equal(config.retryFailed, true)
  assert.deepEqual(config.env, { COVER_MCAP_WORKSPACE_SETUP: '123' })
  assert.deepEqual(config.extraArgs, ['--once', '5'])
  assert.equal(
    config.outputBatchNamePattern,
    DEFAULT_GENERIC_CONVERTER_CONFIG.outputBatchNamePattern
  )
})

test('generic converter scan handoff adds output root and batch pattern to profile scan', () => {
  const profile: UploadProfile = {
    ...baseProfile(),
    targetMode: 'both',
    scan: {
      providerDirectories: {
        aliyun: ['/data/raw'],
        tencent: []
      },
      workDirNamePattern: '^\\d{2}-\\d{2}-\\d{2}$'
    }
  }

  const next = applyGenericConverterScanHandoff(profile, {
    ...DEFAULT_GENERIC_CONVERTER_CONFIG,
    enabled: true,
    outputRoot: '/data/mcap',
    outputBatchNamePattern: '^G\\d+_\\d+_\\d+$'
  })

  assert.deepEqual(next.scan.providerDirectories.aliyun, ['/data/raw', '/data/mcap'])
  assert.deepEqual(next.scan.providerDirectories.tencent, ['/data/mcap'])
  assert.match(next.scan.workDirNamePattern || '', /G\\d\+/)
})

test('generic converter service starts and stops an external monitor process', async () => {
  const db = createDatabase()
  const root = mkdtempSync(join(tmpdir(), 'generic-converter-'))
  const service = new GenericConverterService()
  try {
    const monitorScript = join(root, 'fake-monitor.js')
    const dataRoot = join(root, 'data')
    const outputRoot = join(root, 'output')
    mkdirSync(dataRoot)
    mkdirSync(outputRoot)
    writeFileSync(
      monitorScript,
      [
        "process.stdout.write('[monitor] scanning\\n')",
        "process.on('SIGTERM', () => {",
        "  process.stdout.write('[monitor] stopped\\n')",
        "  process.exit(0)",
        "})",
        "setInterval(() => {}, 1000)"
      ].join('\n')
    )

    const profile: UploadProfile = {
      ...baseProfile(),
      id: 'converter-profile',
      name: 'Converter Profile',
      extensions: {
        enabledIds: [EXTENSION_IDS.GENERIC_CONVERTER],
        configs: {
          [EXTENSION_IDS.GENERIC_CONVERTER]: {
            ...DEFAULT_GENERIC_CONVERTER_CONFIG,
            enabled: true,
            pythonPath: process.execPath,
            monitorScriptPath: monitorScript,
            dataRoot,
            outputRoot,
            pollIntervalSeconds: 1
          }
        }
      }
    }
    new SettingsRepo().saveAll({
      profiles: [profile],
      activeProfileId: profile.id
    })

    const started = service.syncWithSettings()
    let runtime = started.profiles.find((item) => item.profileId === profile.id)
    assert.equal(runtime?.state, 'running')
    assert.ok(runtime?.pid)

    await delay(300)
    runtime = service.getStatus().profiles.find((item) => item.profileId === profile.id)
    assert.ok(runtime?.recentLogs.some((line) => line.includes('[monitor] scanning')))

    const stopped = service.stopProfile(profile.id)
    runtime = stopped.profiles.find((item) => item.profileId === profile.id)
    assert.equal(runtime?.running, false)
    await delay(100)
  } finally {
    service.stopAll()
    await delay(100)
    rmSync(root, { recursive: true, force: true })
    closeDatabase(db)
  }
})
