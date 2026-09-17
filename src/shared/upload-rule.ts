import {
  DEFAULT_ALIYUN_CONNECTION_ID,
  DEFAULT_SETTINGS,
  DEFAULT_UPLOAD_RULE_ID
} from './constants'
import {
  connectionConfigPrefix,
  findConnection,
  legacyModeForConnections,
  legacyProviderForConnection
} from './cloud-upload'
import type {
  AppSettings,
  CleanupPolicy,
  CloudConnection,
  CloudConnectionConfig,
  CloudConnectionType,
  CloudProvider,
  CompletionPolicy,
  DiscoveryConfig,
  FilterRules,
  LegacyCloudMode,
  PathMappingConfig,
  PathVariables,
  UploadDestinationRef,
  UploadRule
} from './types'

export const DEFAULT_CLEANUP_POLICY: CleanupPolicy = {
  enabled: false,
  retentionDays: 7,
  onlyAfterSealed: true
}

export interface ActiveRuleScanRoot {
  directory: string
  ruleId: string
  ruleName: string
}

export interface ResolvedRuleDestination {
  connectionId: string
  connectionName: string
  connectionType: CloudConnectionType
  legacyProvider: CloudProvider
  prefix: string
}

export interface RuleUploadSnapshot {
  legacyCloudMode: LegacyCloudMode
  ruleId: string
  ruleName: string
  ruleSnapshot: UploadRule
  destinations: ResolvedRuleDestination[]
}

export function normalizeUploadRules(
  settings: Pick<AppSettings, 'rules' | 'activeRuleId'>
): { rules: UploadRule[]; activeRuleId: string } {
  const fallback = DEFAULT_SETTINGS.rules[0] as UploadRule
  const rawRules = Array.isArray(settings.rules) ? settings.rules : []
  const rules: UploadRule[] = []
  const seen = new Set<string>()

  for (const rawRule of rawRules) {
    const rule = normalizeUploadRule(rawRule, fallback)
    if (seen.has(rule.id)) continue
    seen.add(rule.id)
    rules.push(rule)
  }

  if (rules.length === 0) rules.push(fallback)

  let activeRuleId =
    typeof settings.activeRuleId === 'string' &&
    seen.has(settings.activeRuleId)
      ? settings.activeRuleId
      : rules[0].id

  if (!rules.some((rule) => rule.enabled && rule.id === activeRuleId)) {
    activeRuleId = rules.find((rule) => rule.enabled)?.id || rules[0].id
  }

  return { rules, activeRuleId }
}

export function normalizeUploadRule(
  value: unknown,
  fallback: UploadRule = DEFAULT_SETTINGS.rules[0] as UploadRule
): UploadRule {
  const raw = isRecord(value) ? value : {}
  const id = stringValue(raw.id, fallback.id || DEFAULT_UPLOAD_RULE_ID)
  const name = stringValue(raw.name, fallback.name || '默认归档')

  return {
    id,
    name,
    enabled:
      typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    source: {
      roots: normalizeStringArray(
        isRecord(raw.source) ? raw.source.roots : undefined,
        fallback.source.roots
      )
    },
    destinations: normalizeDestinationRefs(
      raw.destinations,
      fallback.destinations
    ),
    pathMapping: normalizePathMapping(raw.pathMapping, fallback.pathMapping),
    discovery: normalizeDiscovery(raw.discovery, fallback.discovery),
    completion: normalizeCompletion(raw.completion, fallback.completion),
    cleanup: normalizeCleanup(raw.cleanup, fallback.cleanup),
    filter: normalizeFilter(raw.filter, fallback.filter)
  }
}

export function normalizeCloudConnections(
  value: unknown,
  fallback: CloudConnection[] = DEFAULT_SETTINGS.connections as CloudConnection[]
): CloudConnection[] {
  const rawConnections = Array.isArray(value) ? value : []
  const connections: CloudConnection[] = []
  const seen = new Set<string>()

  for (const rawConnection of rawConnections) {
    const connection = normalizeCloudConnection(rawConnection)
    if (!connection || seen.has(connection.id)) continue
    seen.add(connection.id)
    connections.push(connection)
  }

  return connections.length > 0 ? connections : fallback.map(cloneConnection)
}

export function normalizeCloudConnection(value: unknown): CloudConnection | null {
  if (!isRecord(value)) return null
  const type =
    value.type === 'aliyun-oss' || value.type === 's3'
      ? value.type
      : null
  if (!type) return null
  const id = stringValue(value.id, '').trim()
  if (!id) return null
  const name = stringValue(value.name, id)
  return {
    id,
    name,
    type,
    config: normalizeConnectionConfig(type, value.config)
  }
}

export function getRuleById(
  settings: Pick<AppSettings, 'rules' | 'activeRuleId'>,
  ruleId?: string | null
): UploadRule {
  const normalized = normalizeUploadRules(settings)
  return (
    normalized.rules.find((rule) => rule.id === ruleId) ||
    normalized.rules.find((rule) => rule.id === normalized.activeRuleId) ||
    normalized.rules[0]
  )
}

export function getRuleSourceDirectories(rule: UploadRule): string[] {
  return normalizeStringArray(rule.source.roots)
}

export function getActiveRuleScanRoots(rules: UploadRule[]): ActiveRuleScanRoot[] {
  const roots: ActiveRuleScanRoot[] = []
  const seen = new Set<string>()
  for (const rule of rules) {
    if (!rule.enabled) continue
    for (const directory of getRuleSourceDirectories(rule)) {
      const key = `${rule.id}\0${directory}`
      if (seen.has(key)) continue
      seen.add(key)
      roots.push({
        directory,
        ruleId: rule.id,
        ruleName: rule.name
      })
    }
  }
  return roots
}

export function getRuleWatchedDirectories(rules: UploadRule[]): string[] {
  return Array.from(
    new Set(getActiveRuleScanRoots(rules).map((root) => root.directory))
  )
}

export function resolveRuleUploadSnapshot(
  rule: UploadRule,
  connections: CloudConnection[]
): RuleUploadSnapshot {
  const destinations = resolveRuleDestinations(rule, connections)
  return {
    legacyCloudMode: legacyModeForConnections(
      destinations.map((destination) => ({ type: destination.connectionType }))
    ),
    ruleId: rule.id,
    ruleName: rule.name,
    ruleSnapshot: rule,
    destinations
  }
}

export function resolveRuleDestinations(
  rule: UploadRule,
  connections: CloudConnection[]
): ResolvedRuleDestination[] {
  const destinations = rule.destinations.length > 0
    ? rule.destinations
    : [{ connectionId: DEFAULT_ALIYUN_CONNECTION_ID }]
  return destinations.map((destination) => {
    const connection = findConnection(connections, destination.connectionId)
    if (!connection) {
      throw new Error(`Destination Connection 不存在: ${destination.connectionId}`)
    }
    return {
      connectionId: connection.id,
      connectionName: connection.name,
      connectionType: connection.type,
      legacyProvider: legacyProviderForConnection(connection),
      prefix: connectionConfigPrefix(connection.config)
    }
  })
}

export function buildPathMappingVariables(
  variables: PathVariables,
  extra: PathVariables = {}
): PathVariables {
  return {
    ...variables,
    ...extra
  }
}

function normalizeConnectionConfig(
  type: CloudConnectionType,
  value: unknown
): CloudConnectionConfig {
  const raw = isRecord(value) ? value : {}
  const base = {
    endpoint: stringValue(raw.endpoint),
    bucket: stringValue(raw.bucket),
    region: stringValue(raw.region),
    prefix: stringValue(raw.prefix),
    accessKeyId: stringValue(raw.accessKeyId),
    accessKeySecret: stringValue(raw.accessKeySecret)
  }
  if (type === 'aliyun-oss') return base
  return {
    ...base,
    forcePathStyle:
      typeof raw.forcePathStyle === 'boolean' ? raw.forcePathStyle : true,
    allowInsecureTls:
      typeof raw.allowInsecureTls === 'boolean'
        ? raw.allowInsecureTls
        : false
  }
}

function normalizeDestinationRefs(
  value: unknown,
  fallback: UploadDestinationRef[]
): UploadDestinationRef[] {
  const rawItems = Array.isArray(value) ? value : fallback
  const refs: UploadDestinationRef[] = []
  const seen = new Set<string>()
  for (const item of rawItems) {
    const connectionId = isRecord(item)
      ? stringValue(item.connectionId)
      : stringValue(item)
    if (!connectionId || seen.has(connectionId)) continue
    seen.add(connectionId)
    refs.push({ connectionId })
  }
  return refs
}

function normalizePathMapping(
  value: unknown,
  fallback: PathMappingConfig
): PathMappingConfig {
  const raw = isRecord(value) ? value : {}
  const mode =
    raw.mode === 'flatten' || raw.mode === 'template' || raw.mode === 'keep-relative'
      ? raw.mode
      : fallback.mode
  return {
    mode,
    template: stringValue(raw.template, fallback.template || '')
  }
}

function normalizeDiscovery(
  value: unknown,
  fallback: DiscoveryConfig
): DiscoveryConfig {
  const raw = isRecord(value) ? value : {}
  return {
    groupPattern: stringValue(raw.groupPattern, fallback.groupPattern || ''),
    taskPattern: stringValue(raw.taskPattern, fallback.taskPattern || ''),
    groupRegex: stringValue(raw.groupRegex, fallback.groupRegex || ''),
    taskRegex: stringValue(raw.taskRegex, fallback.taskRegex || ''),
    recursive:
      typeof raw.recursive === 'boolean' ? raw.recursive : fallback.recursive
  }
}

function normalizeCompletion(
  value: unknown,
  fallback: CompletionPolicy
): CompletionPolicy {
  const raw = isRecord(value) ? value : {}
  if (raw.mode === 'inactivity') {
    const idleMinutes = Number(raw.idleMinutes)
    return {
      mode: 'inactivity',
      idleMinutes: Number.isFinite(idleMinutes)
        ? Math.max(1, Math.floor(idleMinutes))
        : 60
    }
  }
  if (raw.mode === 'marker-file') {
    return {
      mode: 'marker-file',
      markerFile: stringValue(raw.markerFile, 'COMPLETE')
    }
  }
  if (raw.mode === 'manual' || raw.mode === 'rollover' || raw.mode === 'none') {
    return { mode: raw.mode }
  }
  return fallback
}

function normalizeCleanup(
  value: unknown,
  fallback: CleanupPolicy
): CleanupPolicy {
  const raw = isRecord(value) ? value : {}
  const retentionDays = Number(raw.retentionDays)
  return {
    enabled:
      typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    retentionDays: Number.isFinite(retentionDays)
      ? Math.max(0, Math.floor(retentionDays))
      : fallback.retentionDays,
    onlyAfterSealed:
      typeof raw.onlyAfterSealed === 'boolean'
        ? raw.onlyAfterSealed
        : fallback.onlyAfterSealed
  }
}

function normalizeFilter(value: unknown, fallback: FilterRules): FilterRules {
  const raw = isRecord(value) ? value : {}
  return {
    whitelist: normalizeStringArray(raw.whitelist, fallback.whitelist),
    blacklist: normalizeStringArray(raw.blacklist, fallback.blacklist),
    regex: normalizeStringArray(raw.regex, fallback.regex),
    suffixes: normalizeSuffixes(normalizeStringArray(raw.suffixes, fallback.suffixes))
  }
}

function normalizeSuffixes(suffixes: string[]): string[] {
  return Array.from(
    new Set(
      suffixes
        .map((suffix) => suffix.trim().toLowerCase())
        .filter(Boolean)
        .map((suffix) => (suffix.startsWith('.') ? suffix : `.${suffix}`))
    )
  )
}

function normalizeStringArray(value: unknown, fallback: string[] = []): string[] {
  const rawItems = Array.isArray(value) ? value : fallback
  return Array.from(
    new Set(
      rawItems
        .map((item) => String(item).trim())
        .filter(Boolean)
    )
  )
}

function cloneConnection(connection: CloudConnection): CloudConnection {
  return {
    ...connection,
    config: { ...connection.config }
  }
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
