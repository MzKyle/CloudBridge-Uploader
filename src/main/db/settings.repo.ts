import { getDb } from './database'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { normalizeScanConfig } from '@shared/scan-config'
import {
  normalizeCloudConnections,
  normalizeUploadRules
} from '@shared/upload-rule'
import type { AppSettings, CloudConnection } from '@shared/types'
import { getCredentialStore } from '../services/credential-store.service'
import {
  migrateSettingsToV3,
  shouldPersistV3Settings
} from '../migrations/v2-to-v3-settings'

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
    let parsed: unknown
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      return value
    }
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
    if (key === 'connections') {
      return normalizeCloudConnections(parsed).map((connection) => ({
        ...connection,
        config: getCredentialStore().decryptConfig(connection.config)
      }))
    }
    return parsed
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
    if (key === 'scan' && typeof value === 'object' && value !== null) {
      persistedValue = normalizeScanConfig(value as Partial<AppSettings['scan']>)
    }
    if (key === 'rules' && Array.isArray(value)) {
      persistedValue = normalizeUploadRules({
        rules: value as AppSettings['rules'],
        activeRuleId: this.get<string>('activeRuleId') || DEFAULT_SETTINGS.activeRuleId
      }).rules
    }
    if (key === 'connections' && Array.isArray(value)) {
      const connections = normalizeCloudConnections(value)
      this.assertConnectionDeletesAllowed(connections)
      persistedValue = connections.map((connection) => ({
        ...connection,
        config: getCredentialStore().encryptConfig(connection.config)
      }))
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

    const rows = db
      .prepare('SELECT key, value FROM settings')
      .all() as Array<{ key: string; value: string }>
    const raw: Record<string, unknown> = {}
    for (const row of rows) {
      const value = this.decodeValue(row.key, row.value)
      SettingsRepo.valueCache.set(row.key, value)
      if (value !== null) raw[row.key] = value
    }

    const settings = migrateSettingsToV3(raw)
    if (shouldPersistV3Settings(raw)) {
      this.persistV3Settings(settings)
    }

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

  private persistV3Settings(settings: AppSettings): void {
    const sections: Partial<AppSettings> = {
      schemaVersion: settings.schemaVersion,
      rules: settings.rules,
      activeRuleId: settings.activeRuleId,
      connections: settings.connections,
      scan: settings.scan,
      upload: settings.upload,
      filter: settings.filter,
      webhook: settings.webhook,
      hotkey: settings.hotkey,
      stability: settings.stability,
      log: settings.log,
      cleanup: settings.cleanup
    }
    const db = this.db()
    const transaction = db.transaction(() => {
      for (const [key, value] of Object.entries(sections)) {
        if (value !== undefined) this.set(key, value)
      }
      db.prepare(
        `DELETE FROM settings
         WHERE key IN ('profiles', 'activeProfileId', 'cloud', 'oss', 'tencentS3')`
      ).run()
      for (const key of ['profiles', 'activeProfileId', 'cloud', 'oss', 'tencentS3']) {
        SettingsRepo.valueCache.delete(key)
      }
    })
    transaction()
  }

  private assertConnectionDeletesAllowed(nextConnections: CloudConnection[]): void {
    const currentConnections = this.get<CloudConnection[]>('connections')
    if (!currentConnections || currentConnections.length === 0) return

    const nextIds = new Set(nextConnections.map((connection) => connection.id))
    const deletedIds = currentConnections
      .map((connection) => connection.id)
      .filter((id) => !nextIds.has(id))
    if (deletedIds.length === 0) return

    const rules = this.get<AppSettings['rules']>('rules') || DEFAULT_SETTINGS.rules
    for (const id of deletedIds) {
      const referencingRule = rules.find((rule) =>
        rule.destinations.some((destination) => destination.connectionId === id)
      )
      if (referencingRule) {
        throw new Error(`连接正在被上传规则使用: ${referencingRule.name}`)
      }

      const unfinishedTask = this.db().prepare(
        `SELECT t.folder_name
         FROM tasks t
         INNER JOIN task_destinations td ON td.task_id = t.id
         WHERE td.connection_id = ?
           AND t.status NOT IN ('completed', 'synced', 'skipped')
         LIMIT 1`
      ).get(id) as { folder_name: string } | undefined
      if (unfinishedTask) {
        throw new Error(`连接正在被未完成任务使用: ${unfinishedTask.folder_name}`)
      }
    }
  }
}

let instance: SettingsRepo | null = null
export function getSettingsRepo(): SettingsRepo {
  if (!instance) instance = new SettingsRepo()
  return instance
}
