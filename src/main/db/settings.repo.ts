import { getDb } from './database'
import { DEFAULT_SETTINGS } from '@shared/constants'
import {
  normalizeScanConfig,
  normalizeScanDirectories,
  normalizeProviderDirectories
} from '@shared/scan-config'
import { normalizeUploadPathConfig } from '@shared/upload-path'
import { normalizeProfiles } from '@shared/upload-profile'
import type { AppSettings, CloudConfig, ScanConfig } from '@shared/types'
import { getCredentialStore } from '../services/credential-store.service'

function normalizeSuffixes(suffixes: string[]): string[] {
  const normalized = suffixes
    .map((suffix) => suffix.trim().toLowerCase())
    .filter(Boolean)
    .map((suffix) => (suffix.startsWith('.') ? suffix : `.${suffix}`))

  return Array.from(new Set(normalized))
}

export class SettingsRepo {
  private static valueCache = new Map<string, unknown>()
  private static allCache: AppSettings | null = null
  private static dbIdentity: unknown = null

  private db(): ReturnType<typeof getDb> {
    const db = getDb()
    if (SettingsRepo.dbIdentity !== db) {
      SettingsRepo.valueCache.clear()
      SettingsRepo.allCache = null
      SettingsRepo.dbIdentity = db
    }
    return db
  }

  get<T>(key: string): T | null {
    const db = this.db()
    if (SettingsRepo.valueCache.has(key)) {
      return SettingsRepo.valueCache.get(key) as T | null
    }

    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (!row) {
      SettingsRepo.valueCache.set(key, null)
      return null
    }

    const value = this.decodeValue(key, row.value) as T
    SettingsRepo.valueCache.set(key, value)
    return value
  }

  private decodeValue(key: string, value: string): unknown {
    try {
      const parsed = JSON.parse(value) as unknown
      if (
        key === 'filter' &&
        typeof parsed === 'object' &&
        parsed !== null &&
        'suffixes' in (parsed as Record<string, unknown>) &&
        Array.isArray((parsed as Record<string, unknown>).suffixes)
      ) {
        const filter = parsed as Record<string, unknown>
        filter.suffixes = normalizeSuffixes(filter.suffixes as string[])
      }
      if (
        key === 'scan' &&
        typeof parsed === 'object' &&
        parsed !== null &&
        'directories' in (parsed as Record<string, unknown>) &&
        Array.isArray((parsed as Record<string, unknown>).directories)
      ) {
        const scan = parsed as Record<string, unknown>
        scan.directories = normalizeScanDirectories(scan.directories as string[])
        if (
          'providerDirectories' in scan &&
          typeof scan.providerDirectories === 'object' &&
          scan.providerDirectories !== null
        ) {
          scan.providerDirectories = normalizeProviderDirectories(
            scan.providerDirectories as Partial<ScanConfig['providerDirectories']>
          )
        }
      }
      if (
        (key === 'oss' || key === 'tencentS3') &&
        typeof parsed === 'object' &&
        parsed !== null
      ) {
        const normalized = normalizeUploadPathConfig(
          parsed as unknown as Record<string, unknown>
        )
        return getCredentialStore().decryptConfig(normalized)
      }
      return parsed
    } catch {
      return value
    }
  }

  set(key: string, value: unknown): void {
    const db = this.db()
    const now = new Date().toISOString()
    let persistedValue = value

    if (
      key === 'filter' &&
      typeof value === 'object' &&
      value !== null &&
      'suffixes' in (value as Record<string, unknown>) &&
      Array.isArray((value as Record<string, unknown>).suffixes)
    ) {
      const filter = value as Record<string, unknown>
      persistedValue = {
        ...filter,
        suffixes: normalizeSuffixes(filter.suffixes as string[])
      }
    }
    if (
      key === 'scan' &&
      typeof value === 'object' &&
      value !== null &&
      'directories' in (value as Record<string, unknown>) &&
      Array.isArray((value as Record<string, unknown>).directories)
    ) {
      const scan = value as Record<string, unknown>
      const cloud = this.get<CloudConfig>('cloud')
      persistedValue = {
        ...scan,
        ...normalizeScanConfig(
          {
            ...(DEFAULT_SETTINGS.scan as ScanConfig),
            ...(scan as Partial<ScanConfig>)
          },
          cloud?.targetMode || DEFAULT_SETTINGS.cloud.targetMode
        )
      }
    }
    if (
      (key === 'oss' || key === 'tencentS3') &&
      typeof value === 'object' &&
      value !== null
    ) {
      const normalized = normalizeUploadPathConfig(
        value as unknown as Record<string, unknown>
      )
      persistedValue = getCredentialStore().encryptConfig(normalized)
    }

    const serialized = typeof persistedValue === 'string' ? persistedValue : JSON.stringify(persistedValue)
    db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?'
    ).run(key, serialized, now, serialized, now)
    SettingsRepo.valueCache.delete(key)
    SettingsRepo.allCache = null
  }

  getAll(): AppSettings {
    const db = this.db()
    if (SettingsRepo.allCache) return SettingsRepo.allCache

    const settings = { ...DEFAULT_SETTINGS, profiles: [] } as AppSettings
    const settingsRecord = settings as unknown as Record<string, unknown>

    const keys: Array<{ section: keyof AppSettings; key: string }> = [
      { section: 'scan', key: 'scan' },
      { section: 'upload', key: 'upload' },
      { section: 'cloud', key: 'cloud' },
      { section: 'oss', key: 'oss' },
      { section: 'tencentS3', key: 'tencentS3' },
      { section: 'profiles', key: 'profiles' },
      { section: 'activeProfileId', key: 'activeProfileId' },
      { section: 'filter', key: 'filter' },
      { section: 'webhook', key: 'webhook' },
      { section: 'stability', key: 'stability' },
      { section: 'log', key: 'log' },
      { section: 'dataCollect', key: 'dataCollect' },
      { section: 'cleanup', key: 'cleanup' }
    ]

    const rows = db
      .prepare('SELECT key, value FROM settings')
      .all() as Array<{ key: string; value: string }>
    const stored = new Map(rows.map((row) => [row.key, row.value]))

    for (const { section, key } of keys) {
      const serialized = stored.get(key)
      const val =
        serialized === undefined
          ? null
          : this.decodeValue(key, serialized)
      if (serialized !== undefined) {
        SettingsRepo.valueCache.set(key, val)
      }
      if (val !== null) {
        const defaultSection = settingsRecord[section]
        if (
          typeof defaultSection === 'object' &&
          defaultSection !== null &&
          typeof val === 'object' &&
          val !== null &&
          !Array.isArray(defaultSection) &&
          !Array.isArray(val)
        ) {
          ; settingsRecord[section] = {
            ...(defaultSection as Record<string, unknown>),
            ...(val as Record<string, unknown>)
          }
        } else {
          ; settingsRecord[section] = val
        }
      }
    }

    const hotkeySerialized = stored.get('hotkey')
    const hotkey = hotkeySerialized === undefined
      ? null
      : this.decodeValue('hotkey', hotkeySerialized)
    if (hotkeySerialized !== undefined) {
      SettingsRepo.valueCache.set('hotkey', hotkey)
    }
    if (typeof hotkey === 'string' && hotkey) settings.hotkey = hotkey

    if (settings.filter && Array.isArray(settings.filter.suffixes)) {
      settings.filter.suffixes = normalizeSuffixes(settings.filter.suffixes)
    }
    settings.oss = normalizeUploadPathConfig(
      settings.oss as unknown as Record<string, unknown>
    ) as unknown as AppSettings['oss']
    settings.tencentS3 = normalizeUploadPathConfig(
      settings.tencentS3 as unknown as Record<string, unknown>
    ) as unknown as AppSettings['tencentS3']
    settings.scan = normalizeScanConfig(
      settings.scan,
      settings.cloud.targetMode
    )
    const normalizedProfiles = normalizeProfiles(settings)
    settings.profiles = normalizedProfiles.profiles
    settings.activeProfileId = normalizedProfiles.activeProfileId

    SettingsRepo.allCache = settings
    return settings
  }

  saveAll(partial: Partial<AppSettings>): void {
    const db = this.db()
    const transaction = db.transaction(() => {
      for (const [key, value] of Object.entries(partial)) {
        if (value !== undefined) {
          this.set(key, value)
        }
      }
    })
    transaction()
  }
}

let instance: SettingsRepo | null = null
export function getSettingsRepo(): SettingsRepo {
  if (!instance) instance = new SettingsRepo()
  return instance
}
