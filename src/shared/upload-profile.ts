import { DEFAULT_SETTINGS, DEFAULT_UPLOAD_PROFILE_ID, DEFAULT_WORK_DIR_NAME_PATTERN } from './constants'
import { buildOssKey, joinOssPath } from './day-folder'
import {
  destinationsForProviders,
  modeForProviders,
  providersForDestinations,
  providersForMode,
  providersForProfile,
  type UploadTargetSnapshot
} from './cloud-upload'
import { extractDiscoveryVariables } from './discovery'
import {
  getProfileSourceDirectories,
  normalizeProviderDirectories,
  normalizeScanConfig,
  normalizeSourceDirectories
} from './scan-config'
import {
  DEFAULT_UPLOAD_PATH_SEGMENT_COUNT,
  normalizeUploadPathConfig,
  resolveUploadRelativePath,
  type UploadPathResolveContext
} from './upload-path'
import type {
  AppSettings,
  CloudConnection,
  CloudProvider,
  CleanupPolicy,
  CompletionPolicy,
  DiscoveryConfig,
  FilterRules,
  PathMappingConfig,
  PathVariables,
  UploadDestinationRef,
  UploadPathMode,
  UploadProfile,
  UploadProfileProviderConfig,
  UploadSourceConfig,
  UploadTargetMode
} from './types'

export const DEFAULT_OBJECT_KEY_TEMPLATE = '{relativePath}'
export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  groupPattern: '{date:yyyy-MM-dd}',
  taskPattern: '{session:HH-mm-ss}',
  recursive: false
}
export const DEFAULT_COMPLETION_POLICY: CompletionPolicy = { mode: 'rollover' }
export const DEFAULT_CLEANUP_POLICY: CleanupPolicy = {
  enabled: false,
  retentionDays: 7,
  onlyAfterSealed: true
}

const BUILTIN_TEMPLATE_VARIABLES = new Set([
  'profile',
  'provider',
  'date',
  'yy',
  'yyyy',
  'MM',
  'dd',
  'workDir',
  'session',
  'HH',
  'mm',
  'ss',
  'folderName',
  'sourceRelativePath',
  'sourceLast1',
  'sourceLast2',
  'sourceLast3',
  'relativePath',
  'filename',
  'stem',
  'ext'
])

export interface NormalizedProfiles {
  profiles: UploadProfile[]
  activeProfileId: string
}

export interface ProfileUploadTargetSnapshot extends UploadTargetSnapshot {
  profileId: string
  profileName: string
  profileSnapshot: UploadProfile
  pathModes: Partial<Record<CloudProvider, UploadPathMode>>
  objectKeyTemplates: Partial<Record<CloudProvider, string | null>>
}

export interface ObjectKeyDestinationSnapshot {
  provider: CloudProvider
  prefix: string
  uploadRelativePath: string
  pathMode?: UploadPathMode
  objectKeyTemplate?: string | null
}

export interface ObjectKeyRenderContext extends UploadPathResolveContext {
  profileId?: string | null
  profileName?: string | null
  folderName?: string
  relativePath: string
  variables?: PathVariables
  createdAt?: string
}

export interface ObjectKeyPreviewResult {
  provider: CloudProvider
  prefix: string
  uploadRelativePath: string
  pathMode: UploadPathMode
  objectKeyTemplate: string | null
  variables: Record<string, string>
  keys: string[]
  errors: string[]
  warnings: string[]
}

export interface UploadPathPreview {
  profileId: string
  profileName: string
  sourcePath: string
  providers: ObjectKeyPreviewResult[]
}

export function normalizeProfiles(settings: Partial<AppSettings>): NormalizedProfiles {
  const fallbackProfile = createDefaultProfileFromSettings(settings)
  const rawProfiles = Array.isArray(settings.profiles) ? settings.profiles : []
  const profiles: UploadProfile[] = []
  const seen = new Set<string>()

  for (const rawProfile of rawProfiles) {
    const profile = normalizeProfile(rawProfile, fallbackProfile)
    if (seen.has(profile.id)) continue
    seen.add(profile.id)
    profiles.push(profile)
  }

  if (profiles.length === 0) {
    profiles.push(fallbackProfile)
    seen.add(fallbackProfile.id)
  }

  let activeProfileId =
    typeof settings.activeProfileId === 'string' && seen.has(settings.activeProfileId)
      ? settings.activeProfileId
      : profiles[0].id

  if (!profiles.some((profile) => profile.enabled && profile.id === activeProfileId)) {
    activeProfileId = profiles.find((profile) => profile.enabled)?.id || profiles[0].id
  }

  return { profiles, activeProfileId }
}

export function getProfileById(
  settings: Pick<AppSettings, 'profiles' | 'activeProfileId'>,
  profileId?: string | null
): UploadProfile {
  const normalized = normalizeProfiles(settings as Partial<AppSettings>)
  return (
    normalized.profiles.find((profile) => profile.id === profileId) ||
    normalized.profiles.find((profile) => profile.id === normalized.activeProfileId) ||
    normalized.profiles[0]
  )
}

export function extractProfilePathVariables(
  profile: UploadProfile,
  sourcePath: string,
  fallbackBasePath?: string
): PathVariables {
  const roots = getProfileSourceDirectories(profile)
    .sort((a, b) => b.length - a.length)
  for (const root of roots) {
    if (!isPathUnderRoot(sourcePath, root)) continue
    const variables = extractDiscoveryVariables(profile.discovery, root, sourcePath)
    if (Object.keys(variables).length > 0) return variables
  }
  return fallbackBasePath
    ? extractDiscoveryVariables(profile.discovery, fallbackBasePath, sourcePath)
    : {}
}

export function resolveProfileUploadSnapshot(
  profile: UploadProfile,
  context: UploadPathResolveContext,
  requestedProviders?: CloudProvider[]
): ProfileUploadTargetSnapshot {
  const providers = requestedProviders?.length
    ? requestedProviders
    : providersForProfile(profile)
  const uploadRelativePaths: Partial<Record<CloudProvider, string>> = {}
  const pathModes: Partial<Record<CloudProvider, UploadPathMode>> = {}
  const objectKeyTemplates: Partial<Record<CloudProvider, string | null>> = {}
  const legacyProviders = {
    aliyun: normalizeProfileProviderConfig(profile.providers?.aliyun),
    tencent: normalizeProfileProviderConfig(profile.providers?.tencent)
  }
  const prefixes: Record<CloudProvider, string> = {
    aliyun: legacyProviders.aliyun.prefix,
    tencent: legacyProviders.tencent.prefix
  }

  for (const provider of providers) {
    const providerConfig = legacyUploadPathConfigForSnapshot(
      profile.pathMapping,
      legacyProviders[provider]
    )
    const normalized = normalizeUploadPathConfig(
      providerConfig as unknown as Record<string, unknown>
    )
    uploadRelativePaths[provider] = resolveUploadRelativePath(
      providerConfig,
      context
    )
    pathModes[provider] = normalized.pathMode
    objectKeyTemplates[provider] =
      normalized.pathMode === 'template'
        ? providerConfig.objectKeyTemplate || ''
        : null
  }

  return {
    mode: modeForProviders(providers),
    prefixes,
    uploadRelativePaths,
    uploadRelativePath: firstResolvedPath(providers, uploadRelativePaths),
    profileId: profile.id,
    profileName: profile.name,
    profileSnapshot: profile,
    pathModes,
    objectKeyTemplates
  }
}

export function renderObjectKey(
  destination: ObjectKeyDestinationSnapshot,
  context: ObjectKeyRenderContext
): string {
  const pathMode = destination.pathMode || 'target-root'
  if (pathMode !== 'template') {
    return buildOssKey(
      destination.prefix,
      destination.uploadRelativePath,
      context.relativePath
    )
  }

  const template = destination.objectKeyTemplate || ''
  const templateErrors = validateObjectKeyTemplate(template, context.variables)
  if (templateErrors.length > 0) {
    throw new Error(templateErrors.join('；'))
  }

  const variables = buildObjectKeyVariables(destination.provider, context)
  const rendered = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
    return variables[name] ?? ''
  })
  const normalized = joinOssPath(rendered)
  const keyErrors = validateObjectKeyValue(normalized)
  if (keyErrors.length > 0) {
    throw new Error(keyErrors.join('；'))
  }
  return joinOssPath(destination.prefix, normalized)
}

export function buildObjectKeyVariables(
  provider: CloudProvider,
  context: ObjectKeyRenderContext
): Record<string, string> {
  const relativePath = normalizeObjectPath(context.relativePath)
  const fileName = pathSegments(relativePath).at(-1) || ''
  const dotIndex = fileName.lastIndexOf('.')
  const ext = dotIndex > 0 ? fileName.slice(dotIndex) : ''
  const stem = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
  const sourceSegments = pathSegments(context.sourcePath)
  const folderName = context.folderName || sourceSegments.at(-1) || ''
  const discoveryVariables = context.variables || {}
  const legacyDate = discoveryVariables.date || context.dateName || ''
  const legacyWorkDir =
    discoveryVariables.workDir ||
    discoveryVariables.session ||
    context.workDirName ||
    ''
  const dateParts = parseDateParts(legacyDate)
  const timeParts = parseTimeParts(legacyWorkDir)
  const sourceRelativePath = context.basePath
    ? relativePathFromBase(context.sourcePath, context.basePath)
    : folderName

  return {
    ...discoveryVariables,
    profile: context.profileName || '',
    provider,
    date: legacyDate,
    yy: dateParts.yy,
    yyyy: dateParts.yyyy,
    MM: dateParts.MM,
    dd: dateParts.dd,
    workDir: legacyWorkDir || folderName,
    session: discoveryVariables.session || legacyWorkDir,
    HH: timeParts.HH,
    mm: timeParts.mm,
    ss: timeParts.ss,
    folderName,
    sourceRelativePath,
    sourceLast1: sourceSegments.at(-1) || '',
    sourceLast2: sourceSegments.slice(-2).join('/'),
    sourceLast3: sourceSegments.slice(-3).join('/'),
    relativePath,
    filename: fileName,
    stem,
    ext
  }
}

export function validateObjectKeyTemplate(
  template: string,
  variables: PathVariables = {}
): string[] {
  const errors: string[] = []
  const trimmed = template.trim()
  if (!trimmed) errors.push('对象 Key 模板不能为空')
  if (isAbsolutePath(trimmed)) errors.push('对象 Key 模板不能使用绝对路径')

  const unknownVariables = Array.from(
    new Set(
      [...trimmed.matchAll(/\{([A-Za-z0-9_]+)\}/g)]
        .map((match) => match[1])
        .filter((name) => !BUILTIN_TEMPLATE_VARIABLES.has(name) && !(name in variables))
    )
  )
  if (unknownVariables.length > 0) {
    errors.push(`未知模板变量: ${unknownVariables.join(', ')}`)
  }

  if (pathSegments(trimmed).includes('..')) {
    errors.push('对象 Key 模板不能包含 .. 路径段')
  }

  return errors
}

export function validateObjectKeyValue(key: string): string[] {
  const errors: string[] = []
  const trimmed = key.trim()
  if (!trimmed) errors.push('对象 Key 渲染结果不能为空')
  if (isAbsolutePath(trimmed)) errors.push('对象 Key 渲染结果不能是绝对路径')
  if (pathSegments(trimmed).includes('..')) {
    errors.push('对象 Key 渲染结果不能包含 .. 路径段')
  }
  return errors
}

function createDefaultProfileFromSettings(settings: Partial<AppSettings>): UploadProfile {
  const defaultSettings = DEFAULT_SETTINGS as AppSettings
  const scan = settings.scan || defaultSettings.scan
  const filter = normalizeFilter(settings.filter || defaultSettings.filter)
  const targetMode = normalizeTargetMode(settings.cloud?.targetMode, defaultSettings.cloud.targetMode)
  const providerDirectories = normalizeScanConfig(
    {
      ...defaultSettings.scan,
      ...scan
    },
    targetMode
  ).providerDirectories
  const providers = {
    aliyun: normalizeProfileProviderConfig({
      prefix: settings.oss?.prefix || '',
      pathMode: settings.oss?.pathMode,
      pathSegmentCount: settings.oss?.pathSegmentCount,
      objectKeyTemplate: DEFAULT_OBJECT_KEY_TEMPLATE
    }),
    tencent: normalizeProfileProviderConfig({
      prefix: settings.tencentS3?.prefix || '',
      pathMode: settings.tencentS3?.pathMode,
      pathSegmentCount: settings.tencentS3?.pathSegmentCount,
      objectKeyTemplate: DEFAULT_OBJECT_KEY_TEMPLATE
    })
  }
  const activeProviders = providersForMode(targetMode)

  return {
    id: DEFAULT_UPLOAD_PROFILE_ID,
    name: '默认归档',
    enabled: true,
    source: sourceFromProviderDirectories(providerDirectories),
    destinations: destinationsForProviders(activeProviders),
    pathMapping: pathMappingFromLegacyProviderConfig(providers[activeProviders[0]]),
    discovery: discoveryFromLegacyScan(scan.workDirNamePattern),
    completion: DEFAULT_COMPLETION_POLICY,
    cleanup: normalizeCleanupPolicy(settings.cleanup, DEFAULT_CLEANUP_POLICY),
    targetMode,
    filter,
    scan: {
      providerDirectories,
      workDirNamePattern: scan.workDirNamePattern || DEFAULT_WORK_DIR_NAME_PATTERN
    },
    providers,
  }
}

function normalizeProfile(rawProfile: unknown, fallback: UploadProfile): UploadProfile {
  const raw = isRecord(rawProfile) ? rawProfile : {}
  const rawScan = isRecord(raw.scan) ? raw.scan : {}
  const rawProviders = isRecord(raw.providers) ? raw.providers : {}
  const id = typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim()
    : fallback.id
  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim()
    : fallback.name

  const targetMode = normalizeTargetMode(raw.targetMode, fallback.targetMode)
  const providerDirectories = normalizeProviderDirectories(
    isRecord(rawScan.providerDirectories)
      ? rawScan.providerDirectories as Partial<Record<CloudProvider, string[]>>
      : fallback.scan.providerDirectories
  )
  const scan = {
    providerDirectories,
    workDirNamePattern:
      typeof rawScan.workDirNamePattern === 'string' && rawScan.workDirNamePattern.trim()
        ? rawScan.workDirNamePattern.trim()
        : fallback.scan.workDirNamePattern
  }
  const providers = {
    aliyun: normalizeProfileProviderConfig(
      isRecord(rawProviders.aliyun) ? rawProviders.aliyun : {},
      fallback.providers.aliyun
    ),
    tencent: normalizeProfileProviderConfig(
      isRecord(rawProviders.tencent) ? rawProviders.tencent : {},
      fallback.providers.tencent
    )
  }
  const source = normalizeUploadSourceConfig(
    raw.source,
    sourceFromProviderDirectories(providerDirectories, fallback.source)
  )
  const destinationFallback = destinationsForProviders(providersForMode(targetMode))
  const rawDestinationRefs = parseUploadDestinationRefs(raw.destinations)
  const destinations =
    rawDestinationRefs.length > 0 &&
    !(targetMode !== fallback.targetMode && destinationsEqual(rawDestinationRefs, fallback.destinations))
      ? rawDestinationRefs
      : destinationFallback
  const activeProviders = providersForDestinations(destinations)
  const canonicalTargetMode = modeForProviders(
    activeProviders.length > 0 ? activeProviders : providersForMode(targetMode)
  )
  const legacyPathMapping = pathMappingFromLegacyProviderConfig(
    providers[providersForMode(canonicalTargetMode)[0]]
  )
  const rawPathMapping =
    pathMappingEquals(normalizePathMappingConfig(raw.pathMapping, fallback.pathMapping), fallback.pathMapping) &&
    !pathMappingEquals(legacyPathMapping, fallback.pathMapping)
      ? undefined
      : raw.pathMapping
  const pathMapping = normalizePathMappingConfig(rawPathMapping, legacyPathMapping)
  const profile: UploadProfile = {
    id,
    name,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    source,
    destinations,
    pathMapping,
    discovery: normalizeDiscoveryConfig(raw.discovery, discoveryFromLegacyScan(scan.workDirNamePattern)),
    completion: normalizeCompletionPolicy(raw.completion, fallback.completion),
    cleanup: normalizeCleanupPolicy(raw.cleanup, fallback.cleanup),
    cloudConnections: normalizeCloudConnections(raw.cloudConnections, fallback.cloudConnections),
    targetMode: canonicalTargetMode,
    filter: normalizeFilter(isRecord(raw.filter) ? raw.filter as unknown as FilterRules : fallback.filter),
    scan,
    providers
  }
  return profile
}

function normalizeProfileProviderConfig(
  rawConfig: unknown,
  fallback?: UploadProfileProviderConfig
): UploadProfileProviderConfig {
  const raw = isRecord(rawConfig) ? rawConfig : {}
  const normalized = normalizeUploadPathConfig({
    pathMode: raw.pathMode ?? fallback?.pathMode,
    pathSegmentCount: raw.pathSegmentCount ?? fallback?.pathSegmentCount
  })
  return {
    prefix: typeof raw.prefix === 'string' ? raw.prefix : fallback?.prefix || '',
    pathMode: normalized.pathMode,
    pathSegmentCount: normalized.pathSegmentCount ?? DEFAULT_UPLOAD_PATH_SEGMENT_COUNT,
    objectKeyTemplate:
      typeof raw.objectKeyTemplate === 'string'
        ? raw.objectKeyTemplate
        : fallback?.objectKeyTemplate || DEFAULT_OBJECT_KEY_TEMPLATE
  }
}

function normalizeUploadSourceConfig(
  rawSource: unknown,
  fallback: UploadSourceConfig
): UploadSourceConfig {
  const raw = isRecord(rawSource) ? rawSource : {}
  const roots = normalizeSourceDirectories(
    Array.isArray(raw.roots)
      ? raw.roots.map((item) => String(item))
      : typeof raw.root === 'string'
        ? [raw.root]
        : fallback.roots
  )
  const sourceRoots = roots.length > 0 ? roots : normalizeSourceDirectories(fallback.roots)
  return {
    roots: sourceRoots
  }
}

function sourceFromProviderDirectories(
  providerDirectories: Record<CloudProvider, string[]>,
  fallback?: UploadSourceConfig
): UploadSourceConfig {
  const roots = normalizeSourceDirectories([
    ...providerDirectories.aliyun,
    ...providerDirectories.tencent
  ])
  const fallbackRoots = fallback?.roots?.length
    ? fallback.roots
    : []
  const sourceRoots = roots.length > 0 ? roots : normalizeStringArray(fallbackRoots)
  return {
    roots: sourceRoots
  }
}

function parseUploadDestinationRefs(rawDestinations: unknown): UploadDestinationRef[] {
  if (!Array.isArray(rawDestinations)) return []
  return rawDestinations
    .map((item): UploadDestinationRef | null => {
      if (!isRecord(item) || typeof item.connectionId !== 'string') return null
      const connectionId = item.connectionId.trim()
      if (!connectionId) return null
      return {
        connectionId,
        required: typeof item.required === 'boolean' ? item.required : true
      }
    })
    .filter((item): item is UploadDestinationRef => Boolean(item))
}

function destinationsEqual(a: UploadDestinationRef[], b: UploadDestinationRef[]): boolean {
  if (a.length !== b.length) return false
  return a.every((destination, index) =>
    destination.connectionId === b[index]?.connectionId &&
    (destination.required ?? true) === (b[index]?.required ?? true)
  )
}

function normalizeCloudConnections(
  rawConnections: unknown,
  fallback: CloudConnection[] | undefined
): CloudConnection[] | undefined {
  if (!Array.isArray(rawConnections)) return fallback
  const connections = rawConnections
    .map((item): CloudConnection | null => {
      if (!isRecord(item)) return null
      if (typeof item.id !== 'string' || !item.id.trim()) return null
      if (typeof item.name !== 'string' || !item.name.trim()) return null
      if (item.type !== 'aliyun-oss' && item.type !== 's3') return null
      return {
        id: item.id.trim(),
        name: item.name.trim(),
        type: item.type,
        provider:
          item.provider === 'aliyun' || item.provider === 'tencent'
            ? item.provider
            : undefined,
        config: isRecord(item.config) ? item.config : {}
      }
    })
    .filter((item): item is CloudConnection => Boolean(item))
  return connections.length > 0 ? connections : fallback
}

function normalizePathMappingConfig(
  rawMapping: unknown,
  fallback: PathMappingConfig
): PathMappingConfig {
  const raw = isRecord(rawMapping) ? rawMapping : {}
  const rawMode = typeof raw.mode === 'string' ? raw.mode : fallback.mode
  const mode: PathMappingConfig['mode'] =
    rawMode === 'flatten' || rawMode === 'template' || rawMode === 'keep-relative'
      ? rawMode
      : fallback.mode
  const template =
    typeof raw.template === 'string'
      ? raw.template
      : fallback.template

  return mode === 'template'
    ? { mode, template: template || DEFAULT_OBJECT_KEY_TEMPLATE }
    : { mode }
}

function normalizeDiscoveryConfig(
  rawDiscovery: unknown,
  fallback: DiscoveryConfig
): DiscoveryConfig {
  const raw = isRecord(rawDiscovery) ? rawDiscovery : {}
  return {
    groupPattern: normalizeOptionalString(raw.groupPattern, fallback.groupPattern),
    taskPattern: normalizeOptionalString(raw.taskPattern, fallback.taskPattern),
    groupRegex: normalizeOptionalString(raw.groupRegex, fallback.groupRegex),
    taskRegex: normalizeOptionalString(raw.taskRegex, fallback.taskRegex),
    recursive:
      typeof raw.recursive === 'boolean'
        ? raw.recursive
        : fallback.recursive ?? false
  }
}

function discoveryFromLegacyScan(workDirNamePattern?: string): DiscoveryConfig {
  const normalizedWorkDirPattern = workDirNamePattern?.trim()
  if (normalizedWorkDirPattern && normalizedWorkDirPattern !== DEFAULT_WORK_DIR_NAME_PATTERN) {
    return {
      groupPattern: '{date:yyyy-MM-dd}',
      taskRegex: normalizedWorkDirPattern,
      recursive: false
    }
  }
  return { ...DEFAULT_DISCOVERY_CONFIG }
}

function normalizeCompletionPolicy(
  rawCompletion: unknown,
  fallback: CompletionPolicy
): CompletionPolicy {
  const raw = isRecord(rawCompletion) ? rawCompletion : {}
  if (raw.mode === 'manual') return { mode: 'manual' }
  if (raw.mode === 'none') return { mode: 'none' }
  if (raw.mode === 'rollover') return { mode: 'rollover' }
  if (raw.mode === 'marker-file') {
    return {
      mode: 'marker-file',
      markerFile:
        typeof raw.markerFile === 'string' && raw.markerFile.trim()
          ? raw.markerFile.trim()
          : 'COMPLETE'
    }
  }
  if (raw.mode === 'inactivity') {
    const idleMinutes = Number(raw.idleMinutes)
    return {
      mode: 'inactivity',
      idleMinutes: Number.isFinite(idleMinutes)
        ? Math.max(0, Math.floor(idleMinutes))
        : 60
    }
  }
  return fallback
}

function normalizeCleanupPolicy(
  rawCleanup: unknown,
  fallback: CleanupPolicy
): CleanupPolicy {
  const raw = isRecord(rawCleanup) ? rawCleanup : {}
  const retentionDays = Number(raw.retentionDays)
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    retentionDays: Number.isFinite(retentionDays)
      ? Math.max(0, Math.floor(retentionDays))
      : fallback.retentionDays,
    onlyAfterSealed:
      typeof raw.onlyAfterSealed === 'boolean'
        ? raw.onlyAfterSealed
        : fallback.onlyAfterSealed
  }
}

function pathMappingFromLegacyProviderConfig(
  provider?: UploadProfileProviderConfig
): PathMappingConfig {
  if (!provider) return { mode: 'keep-relative' }
  if (provider.pathMode === 'template') {
    return {
      mode: 'template',
      template: provider.objectKeyTemplate || DEFAULT_OBJECT_KEY_TEMPLATE
    }
  }
  if (provider.pathMode === 'target-root') return { mode: 'keep-relative' }
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
    const variable = `sourceLast${Math.max(1, Math.min(3, provider.pathSegmentCount || 1))}`
    return {
      mode: 'template',
      template: `{${variable}}/{relativePath}`
    }
  }
  return {
    mode: 'keep-relative'
  }
}

function legacyUploadPathConfigForSnapshot(
  pathMapping: PathMappingConfig | undefined,
  legacyProvider: UploadProfileProviderConfig
): Pick<UploadProfileProviderConfig, 'pathMode' | 'pathSegmentCount' | 'objectKeyTemplate'> {
  if (!pathMapping) return legacyProvider
  if (pathMapping.mode === 'keep-relative' && legacyProvider.pathMode !== 'target-root') {
    return legacyProvider
  }
  return pathMappingToLegacyProviderConfig(pathMapping)
}

function pathMappingToLegacyProviderConfig(
  pathMapping: PathMappingConfig
): Pick<UploadProfileProviderConfig, 'pathMode' | 'pathSegmentCount' | 'objectKeyTemplate'> {
  if (pathMapping.mode === 'flatten') {
    return {
      pathMode: 'template',
      pathSegmentCount: DEFAULT_UPLOAD_PATH_SEGMENT_COUNT,
      objectKeyTemplate: '{filename}'
    }
  }
  if (pathMapping.mode === 'template') {
    return {
      pathMode: 'template',
      pathSegmentCount: DEFAULT_UPLOAD_PATH_SEGMENT_COUNT,
      objectKeyTemplate: pathMapping.template || DEFAULT_OBJECT_KEY_TEMPLATE
    }
  }
  return {
    pathMode: 'target-root',
    pathSegmentCount: DEFAULT_UPLOAD_PATH_SEGMENT_COUNT,
    objectKeyTemplate: DEFAULT_OBJECT_KEY_TEMPLATE
  }
}

function pathMappingEquals(a: PathMappingConfig, b: PathMappingConfig): boolean {
  return a.mode === b.mode && (a.template || '') === (b.template || '')
}

function normalizeFilter(raw: FilterRules): FilterRules {
  const defaultFilter = (DEFAULT_SETTINGS as AppSettings).filter
  return {
    whitelist: normalizeStringArray(raw.whitelist ?? defaultFilter.whitelist),
    blacklist: normalizeStringArray(raw.blacklist ?? defaultFilter.blacklist),
    regex: normalizeStringArray(raw.regex ?? defaultFilter.regex),
    suffixes: normalizeSuffixes(raw.suffixes ?? defaultFilter.suffixes)
  }
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)))
    : []
}

function normalizeSuffixes(value: unknown): string[] {
  const suffixes = normalizeStringArray(value).map((suffix) =>
    suffix.startsWith('.') ? suffix.toLowerCase() : `.${suffix.toLowerCase()}`
  )
  return Array.from(new Set(suffixes))
}

function normalizeOptionalString(value: unknown, fallback?: string): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return fallback
}

function normalizeTargetMode(value: unknown, fallback: UploadTargetMode): UploadTargetMode {
  return value === 'aliyun' || value === 'tencent' || value === 'both'
    ? value
    : fallback
}

function firstResolvedPath(
  providers: CloudProvider[],
  paths: Partial<Record<CloudProvider, string>>
): string {
  for (const provider of providers) {
    const value = paths[provider]
    if (value !== undefined) return value
  }
  return ''
}

function parseDateParts(dateName: string): { yy: string; yyyy: string; MM: string; dd: string } {
  const match = dateName.match(/^(\d{2}|\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return { yy: '', yyyy: '', MM: '', dd: '' }
  const yyyy = match[1].length === 2 ? `20${match[1]}` : match[1]
  return {
    yy: yyyy.slice(-2),
    yyyy,
    MM: match[2],
    dd: match[3]
  }
}

function parseTimeParts(workDirName: string): { HH: string; mm: string; ss: string } {
  const match = workDirName.match(/(\d{2})[-_:](\d{2})[-_:](\d{2})/)
  if (!match) return { HH: '', mm: '', ss: '' }
  return {
    HH: match[1],
    mm: match[2],
    ss: match[3]
  }
}

function normalizeObjectPath(path: string): string {
  return joinOssPath(path)
}

function pathSegments(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '.')
}

function segmentEquals(a: string, b: string): boolean {
  if (a.endsWith(':') || b.endsWith(':')) return a.toLowerCase() === b.toLowerCase()
  return a === b
}

function relativePathFromBase(sourcePath: string, basePath: string): string {
  const source = pathSegments(sourcePath)
  const base = pathSegments(basePath)
  let index = 0
  while (
    index < source.length &&
    index < base.length &&
    source[index].toLowerCase() === base[index].toLowerCase()
  ) {
    index++
  }
  if (index === base.length && index < source.length) {
    return source.slice(index).join('/')
  }
  return source.at(-1) || ''
}

function isPathUnderRoot(sourcePath: string, rootPath: string): boolean {
  const source = pathSegments(sourcePath)
  const root = pathSegments(rootPath)
  if (root.length === 0 || source.length < root.length) return false
  return root.every((segment, index) =>
    source[index] && segmentEquals(source[index], segment)
  )
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
