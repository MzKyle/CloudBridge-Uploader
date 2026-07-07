import { DEFAULT_SETTINGS, DEFAULT_UPLOAD_PROFILE_ID, DEFAULT_WORK_DIR_NAME_PATTERN } from './constants'
import { buildOssKey, joinOssPath } from './day-folder'
import { modeForProviders, providersForMode, type UploadTargetSnapshot } from './cloud-upload'
import {
  DEFAULT_PROFILE_EXTENSIONS,
  DEFAULT_PROFILE_PLUGINS,
  DEFAULT_PROFILE_UPLOAD_PIPELINE,
  EXTENSION_IDS,
  PLUGIN_IDS,
  UPLOAD_PIPELINE_IDS,
  isBuiltinExtensionId,
  isBuiltinPluginId,
  isBuiltinUploadPipelineId
} from './plugins'
import {
  applyGenericConverterScanHandoff,
  normalizeGenericConverterConfig
} from './generic-converter'
import {
  normalizeProviderDirectories,
  normalizeScanConfig
} from './scan-config'
import {
  DEFAULT_UPLOAD_PATH_SEGMENT_COUNT,
  normalizeUploadPathConfig,
  resolveUploadRelativePath,
  type UploadPathResolveContext
} from './upload-path'
import type {
  AppSettings,
  CloudProvider,
  FilterRules,
  ProfileExtensionConfig,
  ProfilePluginConfig,
  ProfileUploadPipelineConfig,
  UploadPipelineId,
  UploadPathMode,
  UploadProfile,
  UploadProfileProviderConfig,
  UploadTargetMode
} from './types'

export const DEFAULT_OBJECT_KEY_TEMPLATE = '{relativePath}'

const TEMPLATE_VARIABLES = new Set([
  'profile',
  'provider',
  'date',
  'yy',
  'yyyy',
  'MM',
  'dd',
  'workDir',
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

export function resolveProfileUploadSnapshot(
  profile: UploadProfile,
  context: UploadPathResolveContext,
  requestedProviders?: CloudProvider[]
): ProfileUploadTargetSnapshot {
  const providers = requestedProviders?.length
    ? requestedProviders
    : providersForMode(profile.targetMode)
  const uploadRelativePaths: Partial<Record<CloudProvider, string>> = {}
  const pathModes: Partial<Record<CloudProvider, UploadPathMode>> = {}
  const objectKeyTemplates: Partial<Record<CloudProvider, string | null>> = {}
  const prefixes: Record<CloudProvider, string> = {
    aliyun: profile.providers.aliyun.prefix,
    tencent: profile.providers.tencent.prefix
  }

  for (const provider of providers) {
    const providerConfig = profile.providers[provider]
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
  const templateErrors = validateObjectKeyTemplate(template)
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
  const dateParts = parseDateParts(context.dateName || '')
  const timeParts = parseTimeParts(context.workDirName || '')
  const sourceRelativePath = context.basePath
    ? relativePathFromBase(context.sourcePath, context.basePath)
    : folderName

  return {
    profile: context.profileName || '',
    provider,
    date: context.dateName || '',
    yy: dateParts.yy,
    yyyy: dateParts.yyyy,
    MM: dateParts.MM,
    dd: dateParts.dd,
    workDir: context.workDirName || folderName,
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

export function validateObjectKeyTemplate(template: string): string[] {
  const errors: string[] = []
  const trimmed = template.trim()
  if (!trimmed) errors.push('对象 Key 模板不能为空')
  if (isAbsolutePath(trimmed)) errors.push('对象 Key 模板不能使用绝对路径')

  const unknownVariables = Array.from(
    new Set(
      [...trimmed.matchAll(/\{([A-Za-z0-9_]+)\}/g)]
        .map((match) => match[1])
        .filter((name) => !TEMPLATE_VARIABLES.has(name))
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

  return {
    id: DEFAULT_UPLOAD_PROFILE_ID,
    name: '默认项目',
    enabled: true,
    targetMode,
    filter,
    scan: {
      providerDirectories,
      workDirNamePattern: scan.workDirNamePattern || DEFAULT_WORK_DIR_NAME_PATTERN
    },
    providers: {
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
    },
    uploadPipeline: DEFAULT_PROFILE_UPLOAD_PIPELINE,
    extensions: buildDefaultExtensionsFromSettings(settings)
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

  const uploadPipeline = normalizeProfileUploadPipeline(
    raw.uploadPipeline,
    raw.plugins,
    fallback.uploadPipeline
  )
  const extensions = normalizeProfileExtensions(
    raw.extensions,
    raw.plugins,
    fallback.extensions
  )
  const profile: UploadProfile = {
    id,
    name,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    targetMode: normalizeTargetMode(raw.targetMode, fallback.targetMode),
    filter: normalizeFilter(isRecord(raw.filter) ? raw.filter as unknown as FilterRules : fallback.filter),
    scan: {
      providerDirectories: normalizeProviderDirectories(
        isRecord(rawScan.providerDirectories)
          ? rawScan.providerDirectories as Partial<Record<CloudProvider, string[]>>
          : fallback.scan.providerDirectories
      ),
      workDirNamePattern:
        typeof rawScan.workDirNamePattern === 'string' && rawScan.workDirNamePattern.trim()
          ? rawScan.workDirNamePattern.trim()
          : fallback.scan.workDirNamePattern
    },
    providers: {
      aliyun: normalizeProfileProviderConfig(
        isRecord(rawProviders.aliyun) ? rawProviders.aliyun : {},
        fallback.providers.aliyun
      ),
      tencent: normalizeProfileProviderConfig(
        isRecord(rawProviders.tencent) ? rawProviders.tencent : {},
        fallback.providers.tencent
      )
    },
    uploadPipeline,
    extensions
  }

  const converterEnabled = extensions.enabledIds.includes(EXTENSION_IDS.GENERIC_CONVERTER)
  const converterConfig = normalizeGenericConverterConfig(
    extensions.configs[EXTENSION_IDS.GENERIC_CONVERTER]
  )
  return converterEnabled
    ? applyGenericConverterScanHandoff(profile, converterConfig)
    : profile
}

export function normalizeProfileUploadPipeline(
  rawUploadPipeline: unknown,
  legacyPlugins?: unknown,
  fallback: ProfileUploadPipelineConfig = DEFAULT_PROFILE_UPLOAD_PIPELINE
): ProfileUploadPipelineConfig {
  const raw = isRecord(rawUploadPipeline) ? rawUploadPipeline : {}
  const fallbackId = isBuiltinUploadPipelineId(fallback.id)
    ? fallback.id
    : DEFAULT_PROFILE_UPLOAD_PIPELINE.id
  const rawId =
    typeof raw.id === 'string' && isBuiltinUploadPipelineId(raw.id)
      ? raw.id as UploadPipelineId
      : null
  const hasLegacyPlugins = isRecord(legacyPlugins)
  const legacy = normalizeProfilePlugins(legacyPlugins)
  const legacyModule1Enabled = hasLegacyPlugins && legacy.enabledPluginIds.includes(
    PLUGIN_IDS.MODULE1_PREUPLOAD
  )
  const id = rawId || (legacyModule1Enabled ? UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD : fallbackId)
  const fallbackConfig = isRecord(fallback.config) ? fallback.config : {}
  const rawConfig = isRecord(raw.config) ? raw.config : {}
  const legacyModule1Config = hasLegacyPlugins
    ? pluginConfigRecord(legacy.configs[PLUGIN_IDS.MODULE1_PREUPLOAD])
    : {}

  return {
    id,
    config: {
      ...(id === UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD ? legacyModule1Config : {}),
      ...fallbackConfig,
      ...rawConfig
    }
  }
}

export function normalizeProfileExtensions(
  rawExtensions: unknown,
  legacyPlugins?: unknown,
  fallback: ProfileExtensionConfig = DEFAULT_PROFILE_EXTENSIONS
): ProfileExtensionConfig {
  const raw = isRecord(rawExtensions) ? rawExtensions : {}
  const fallbackEnabled = Array.isArray(fallback.enabledIds)
    ? fallback.enabledIds
    : []
  const rawEnabled = Array.isArray(raw.enabledIds) ? raw.enabledIds : null
  const hasLegacyPlugins = isRecord(legacyPlugins)
  const legacy = normalizeProfilePlugins(legacyPlugins)
  const legacyEnabled = hasLegacyPlugins
    ? legacy.enabledPluginIds.filter(isBuiltinExtensionId)
    : []
  const enabledIds = normalizeExtensionIdArray(rawEnabled || [
    ...fallbackEnabled,
    ...legacyEnabled
  ])
  const fallbackConfigs = isRecord(fallback.configs)
    ? fallback.configs
    : DEFAULT_PROFILE_EXTENSIONS.configs
  const rawConfigs = isRecord(raw.configs) ? raw.configs : {}

  return {
    enabledIds,
    configs: mergeExtensionConfigs(
      fallbackConfigs,
      hasLegacyPlugins ? legacy.configs : {},
      rawConfigs
    )
  }
}

export function normalizeProfilePlugins(
  rawPlugins: unknown,
  fallback: ProfilePluginConfig = DEFAULT_PROFILE_PLUGINS
): ProfilePluginConfig {
  const raw = isRecord(rawPlugins) ? rawPlugins : {}
  const fallbackEnabled = Array.isArray(fallback.enabledPluginIds)
    ? fallback.enabledPluginIds
    : []
  const rawEnabled = Array.isArray(raw.enabledPluginIds)
    ? raw.enabledPluginIds
    : fallbackEnabled
  const enabledPluginIds = normalizePluginIdArray(rawEnabled)

  const fallbackOrder = Array.isArray(fallback.order)
    ? fallback.order
    : DEFAULT_PROFILE_PLUGINS.order
  const rawOrder = Array.isArray(raw.order) ? raw.order : fallbackOrder
  const order = normalizePluginIdArray([
    ...rawOrder,
    ...DEFAULT_PROFILE_PLUGINS.order,
    ...enabledPluginIds
  ])

  const fallbackConfigs = isRecord(fallback.configs)
    ? fallback.configs
    : DEFAULT_PROFILE_PLUGINS.configs
  const rawConfigs = isRecord(raw.configs) ? raw.configs : {}

  return {
    enabledPluginIds,
    order,
    configs: mergePluginConfigs(fallbackConfigs, rawConfigs)
  }
}

function buildDefaultExtensionsFromSettings(settings: Partial<AppSettings>): ProfileExtensionConfig {
  const extensions = cloneProfileExtensions(DEFAULT_PROFILE_EXTENSIONS)
  if (settings.webhook?.enabled) {
    extensions.enabledIds = normalizeExtensionIdArray([
      ...extensions.enabledIds,
      EXTENSION_IDS.WEBHOOK_NOTIFIER
    ])
    extensions.configs[EXTENSION_IDS.WEBHOOK_NOTIFIER] = {
      ...pluginConfigRecord(extensions.configs[EXTENSION_IDS.WEBHOOK_NOTIFIER]),
      ...settings.webhook
    }
  }
  return extensions
}

function cloneProfileExtensions(value: ProfileExtensionConfig): ProfileExtensionConfig {
  return {
    enabledIds: [...value.enabledIds],
    configs: JSON.parse(JSON.stringify(value.configs)) as Record<string, unknown>
  }
}

function normalizePluginIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .map((item) => String(item).trim())
        .filter((item) => item && isBuiltinPluginId(item))
    )
  )
}

function normalizeExtensionIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .map((item) => String(item).trim())
        .filter((item) => item && isBuiltinExtensionId(item))
    )
  )
}

function mergePluginConfigs(
  fallbackConfigs: Record<string, unknown>,
  rawConfigs: Record<string, unknown>
): Record<string, unknown> {
  const configs: Record<string, unknown> = JSON.parse(
    JSON.stringify(DEFAULT_PROFILE_PLUGINS.configs)
  ) as Record<string, unknown>
  for (const id of DEFAULT_PROFILE_PLUGINS.order) {
    configs[id] = {
      ...pluginConfigRecord(configs[id]),
      ...pluginConfigRecord(fallbackConfigs[id]),
      ...pluginConfigRecord(rawConfigs[id])
    }
  }
  return configs
}

function mergeExtensionConfigs(
  fallbackConfigs: Record<string, unknown>,
  legacyConfigs: Record<string, unknown>,
  rawConfigs: Record<string, unknown>
): Record<string, unknown> {
  const configs: Record<string, unknown> = JSON.parse(
    JSON.stringify(DEFAULT_PROFILE_EXTENSIONS.configs)
  ) as Record<string, unknown>
  for (const id of Object.values(EXTENSION_IDS)) {
    configs[id] = {
      ...pluginConfigRecord(configs[id]),
      ...pluginConfigRecord(fallbackConfigs[id]),
      ...pluginConfigRecord(legacyConfigs[id]),
      ...pluginConfigRecord(rawConfigs[id])
    }
  }
  return configs
}

function pluginConfigRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
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
  const unique = Array.from(new Set(suffixes))
  if (!unique.includes('.csv')) unique.push('.csv')
  return unique
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

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
