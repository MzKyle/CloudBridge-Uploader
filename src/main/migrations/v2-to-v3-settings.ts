import {
  DEFAULT_ALIYUN_CONNECTION_ID,
  DEFAULT_S3_CONNECTION_ID,
  DEFAULT_SETTINGS
} from '@shared/constants'
import {
  normalizeCloudConnections,
  normalizeUploadRule,
  normalizeUploadRules
} from '@shared/upload-rule'
import type {
  AppSettings,
  CloudConnection,
  CloudProvider,
  PathMappingConfig,
  UploadDestinationRef,
  UploadRule
} from '@shared/types'

type LegacyMode = 'aliyun' | 'tencent' | 'both'

const PROVIDERS: CloudProvider[] = ['aliyun', 'tencent']

export function migrateSettingsToV3(raw: Record<string, unknown>): AppSettings {
  const defaults = DEFAULT_SETTINGS as AppSettings
  const connections = normalizeCloudConnections(
    raw.connections || legacyConnections(raw),
    defaults.connections
  )
  const rules = migrateRules(raw)
  const normalizedRules = normalizeUploadRules({
    rules,
    activeRuleId: stringValue(raw.activeRuleId, stringValue(raw.activeProfileId, defaults.activeRuleId))
  })

  return {
    ...defaults,
    schemaVersion: 3,
    rules: normalizedRules.rules,
    activeRuleId: normalizedRules.activeRuleId,
    connections,
    scan: normalizeScan(raw.scan, defaults.scan),
    upload: {
      ...defaults.upload,
      ...(isRecord(raw.upload) ? raw.upload : {})
    },
    filter: normalizeFilter(raw.filter, defaults.filter),
    webhook: {
      ...defaults.webhook,
      ...(isRecord(raw.webhook) ? raw.webhook : {})
    },
    hotkey: stringValue(raw.hotkey, defaults.hotkey),
    stability: {
      ...defaults.stability,
      ...(isRecord(raw.stability) ? raw.stability : {})
    },
    log: {
      ...defaults.log,
      ...(isRecord(raw.log) ? raw.log : {})
    },
    cleanup: {
      ...defaults.cleanup,
      ...(isRecord(raw.cleanup) ? raw.cleanup : {})
    }
  }
}

export function shouldPersistV3Settings(raw: Record<string, unknown>): boolean {
  return raw.schemaVersion !== 3 || !Array.isArray(raw.rules) || !Array.isArray(raw.connections)
}

function migrateRules(raw: Record<string, unknown>): UploadRule[] {
  if (Array.isArray(raw.rules)) {
    return raw.rules.map((rule) => normalizeUploadRule(rule))
  }

  const legacyProfiles = Array.isArray(raw.profiles) ? raw.profiles : []
  if (legacyProfiles.length > 0) {
    return legacyProfiles.flatMap((legacyProfile) => migrateLegacyProfile(raw, legacyProfile))
  }

  return migrateLegacyProfile(raw, defaultLegacyProfile(raw))
}

function migrateLegacyProfile(rawSettings: Record<string, unknown>, value: unknown): UploadRule[] {
  const raw = isRecord(value) ? value : {}
  const base = DEFAULT_SETTINGS.rules[0] as UploadRule
  const mode = legacyMode(raw.targetMode, legacyMode(isRecord(rawSettings.cloud) ? rawSettings.cloud.targetMode : undefined, 'aliyun'))
  const activeProviders = providersForLegacyMode(mode)
  const sourceRootsByProvider = legacySourceRootsByProvider(rawSettings, raw, activeProviders)
  const mappingByProvider = legacyPathMappingByProvider(raw, rawSettings, activeProviders)
  const needsSplit =
    activeProviders.length > 1 &&
    (!arraysEqual(sourceRootsByProvider.aliyun, sourceRootsByProvider.tencent) ||
      !pathMappingsEqual(mappingByProvider.aliyun, mappingByProvider.tencent))

  if (needsSplit) {
    return activeProviders.map((provider) =>
      normalizeUploadRule({
        ...baseRuleFields(raw, base),
        id: `${stringValue(raw.id, base.id)}-${provider === 'aliyun' ? 'aliyun' : 's3'}`,
        name: `${stringValue(raw.name, base.name)} / ${provider === 'aliyun' ? 'Aliyun' : 'S3'}`,
        source: { roots: sourceRootsByProvider[provider] },
        destinations: destinationsForProviders([provider]),
        pathMapping: mappingByProvider[provider]
      })
    )
  }

  const roots = unique(activeProviders.flatMap((provider) => sourceRootsByProvider[provider]))
  const firstProvider = activeProviders[0] || 'aliyun'
  return [
    normalizeUploadRule({
      ...baseRuleFields(raw, base),
      source: { roots },
      destinations: legacyDestinations(raw, activeProviders),
      pathMapping: mappingByProvider[firstProvider]
    })
  ]
}

function baseRuleFields(raw: Record<string, unknown>, base: UploadRule): Partial<UploadRule> {
  return {
    id: stringValue(raw.id, base.id),
    name: stringValue(raw.name, base.name),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
    discovery: isRecord(raw.discovery) ? raw.discovery as UploadRule['discovery'] : base.discovery,
    completion: isRecord(raw.completion) ? raw.completion as UploadRule['completion'] : base.completion,
    cleanup: isRecord(raw.cleanup) ? raw.cleanup as unknown as UploadRule['cleanup'] : base.cleanup,
    filter: isRecord(raw.filter) ? raw.filter as unknown as UploadRule['filter'] : base.filter
  }
}

function legacyConnections(raw: Record<string, unknown>): CloudConnection[] {
  const oss = isRecord(raw.oss) ? raw.oss : {}
  const s3 = isRecord(raw.tencentS3) ? raw.tencentS3 : {}
  return [
    {
      id: DEFAULT_ALIYUN_CONNECTION_ID,
      name: '阿里云 OSS',
      type: 'aliyun-oss',
      config: {
        endpoint: stringValue(oss.endpoint),
        bucket: stringValue(oss.bucket),
        region: stringValue(oss.region),
        prefix: stringValue(oss.prefix),
        accessKeyId: stringValue(oss.accessKeyId),
        accessKeySecret: stringValue(oss.accessKeySecret)
      }
    },
    {
      id: DEFAULT_S3_CONNECTION_ID,
      name: 'S3 兼容存储',
      type: 's3',
      config: {
        endpoint: stringValue(s3.endpoint),
        bucket: stringValue(s3.bucket),
        region: stringValue(s3.region),
        prefix: stringValue(s3.prefix),
        accessKeyId: stringValue(s3.accessKeyId),
        accessKeySecret: stringValue(s3.accessKeySecret),
        forcePathStyle: true,
        allowInsecureTls:
          typeof s3.allowInsecureTls === 'boolean' ? s3.allowInsecureTls : false
      }
    }
  ]
}

function defaultLegacyProfile(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    id: DEFAULT_SETTINGS.activeRuleId,
    name: '默认归档',
    enabled: true,
    targetMode: isRecord(raw.cloud) ? raw.cloud.targetMode : 'aliyun',
    source: {
      roots: legacyScanDirectories(raw)
    },
    discovery: (DEFAULT_SETTINGS.rules[0] as UploadRule).discovery,
    completion: (DEFAULT_SETTINGS.rules[0] as UploadRule).completion,
    cleanup: (DEFAULT_SETTINGS.rules[0] as UploadRule).cleanup,
    filter: raw.filter || (DEFAULT_SETTINGS.rules[0] as UploadRule).filter
  }
}

function legacyDestinations(
  raw: Record<string, unknown>,
  providers: CloudProvider[]
): UploadDestinationRef[] {
  if (Array.isArray(raw.destinations)) {
    const refs = raw.destinations
      .map((item) => {
        if (!isRecord(item)) return null
        const connectionId = stringValue(item.connectionId)
        return connectionId ? { connectionId } : null
      })
      .filter((item): item is UploadDestinationRef => Boolean(item))
    if (refs.length > 0) return refs
  }
  return destinationsForProviders(providers)
}

function destinationsForProviders(providers: CloudProvider[]): UploadDestinationRef[] {
  return providers.map((provider) => ({
    connectionId:
      provider === 'aliyun'
        ? DEFAULT_ALIYUN_CONNECTION_ID
        : DEFAULT_S3_CONNECTION_ID
  }))
}

function legacySourceRootsByProvider(
  rawSettings: Record<string, unknown>,
  rawRule: Record<string, unknown>,
  activeProviders: CloudProvider[]
): Record<CloudProvider, string[]> {
  const sourceRoots = isRecord(rawRule.source)
    ? normalizeDirectories(rawRule.source.roots)
    : []
  const scan = isRecord(rawRule.scan)
    ? rawRule.scan
    : isRecord(rawSettings.scan)
      ? rawSettings.scan
      : {}
  const providerDirectories = isRecord(scan.providerDirectories)
    ? scan.providerDirectories
    : {}
  const fallback = sourceRoots.length > 0 ? sourceRoots : legacyScanDirectories(rawSettings)
  return {
    aliyun: activeProviders.includes('aliyun')
      ? normalizeDirectories(providerDirectories.aliyun, fallback)
      : [],
    tencent: activeProviders.includes('tencent')
      ? normalizeDirectories(providerDirectories.tencent, fallback)
      : []
  }
}

function legacyPathMappingByProvider(
  rawRule: Record<string, unknown>,
  rawSettings: Record<string, unknown>,
  activeProviders: CloudProvider[]
): Record<CloudProvider, PathMappingConfig> {
  const explicit = normalizePathMapping(rawRule.pathMapping)
  if (explicit) {
    return { aliyun: explicit, tencent: explicit }
  }
  const rawProviders = isRecord(rawRule.providers) ? rawRule.providers : {}
  return {
    aliyun: activeProviders.includes('aliyun')
      ? legacyProviderPathMapping(isRecord(rawProviders.aliyun) ? rawProviders.aliyun : rawSettings.oss)
      : { mode: 'keep-relative' },
    tencent: activeProviders.includes('tencent')
      ? legacyProviderPathMapping(isRecord(rawProviders.tencent) ? rawProviders.tencent : rawSettings.tencentS3)
      : { mode: 'keep-relative' }
  }
}

function legacyProviderPathMapping(value: unknown): PathMappingConfig {
  const raw = isRecord(value) ? value : {}
  if (raw.pathMode === 'template' && typeof raw.objectKeyTemplate === 'string') {
    return {
      mode: 'template',
      template: raw.objectKeyTemplate
    }
  }
  if (raw.pathMode === 'last-segments') return { mode: 'flatten' }
  return { mode: 'keep-relative' }
}

function normalizePathMapping(value: unknown): PathMappingConfig | null {
  if (!isRecord(value)) return null
  if (value.mode === 'keep-relative' || value.mode === 'flatten') {
    return { mode: value.mode }
  }
  if (value.mode === 'template') {
    return { mode: 'template', template: stringValue(value.template, '{relativePath}') }
  }
  return null
}

function normalizeScan(value: unknown, fallback: AppSettings['scan']): AppSettings['scan'] {
  const raw = isRecord(value) ? value : {}
  const intervalSeconds = Number(raw.intervalSeconds)
  return {
    intervalSeconds: Number.isFinite(intervalSeconds)
      ? Math.max(5, Math.floor(intervalSeconds))
      : fallback.intervalSeconds
  }
}

function normalizeFilter(value: unknown, fallback: AppSettings['filter']): AppSettings['filter'] {
  const raw = isRecord(value) ? value : {}
  return {
    whitelist: normalizeStrings(raw.whitelist, fallback.whitelist),
    blacklist: normalizeStrings(raw.blacklist, fallback.blacklist),
    regex: normalizeStrings(raw.regex, fallback.regex),
    suffixes: normalizeStrings(raw.suffixes, fallback.suffixes).map((suffix) =>
      suffix.startsWith('.') ? suffix : `.${suffix}`
    )
  }
}

function legacyScanDirectories(raw: Record<string, unknown>): string[] {
  const scan = isRecord(raw.scan) ? raw.scan : {}
  return normalizeDirectories(scan.directories)
}

function providersForLegacyMode(mode: LegacyMode): CloudProvider[] {
  if (mode === 'both') return PROVIDERS
  return [mode]
}

function legacyMode(value: unknown, fallback: LegacyMode): LegacyMode {
  return value === 'aliyun' || value === 'tencent' || value === 'both'
    ? value
    : fallback
}

function normalizeDirectories(value: unknown, fallback: string[] = []): string[] {
  const normalized = normalizeStrings(value)
  return normalized.length > 0 ? normalized : fallback
}

function normalizeStrings(value: unknown, fallback: string[] = []): string[] {
  const rawItems = Array.isArray(value) ? value : fallback
  return unique(rawItems.map((item) => String(item).trim()).filter(Boolean))
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values))
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function pathMappingsEqual(a: PathMappingConfig, b: PathMappingConfig): boolean {
  return a.mode === b.mode && (a.template || '') === (b.template || '')
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
