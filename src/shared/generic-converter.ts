import { providersForProfile } from './cloud-upload'
import type {
  GenericConverterConfig,
  ProfileExtensionConfig,
  UploadProfile
} from './types'

export type {
  GenericConverterConfig,
  GenericConverterProfileStatus,
  GenericConverterRuntimeState,
  GenericConverterStatus
} from './types'

export const GENERIC_CONVERTER_EXTENSION_ID = 'generic-converter'

export const DEFAULT_GENERIC_CONVERTER_CONFIG: GenericConverterConfig = {
  enabled: false,
  pythonPath: 'python3',
  monitorScriptPath: '',
  converterScriptPath: '',
  dataRoot: '',
  outputRoot: '',
  deviceCode: 'G26',
  stableSeconds: 300,
  pollIntervalSeconds: 30,
  retryFailed: false,
  env: {},
  extraArgs: [],
  outputDirectoryTemplate: '{outputRoot}/{date}',
  outputBatchNameTemplate: '{deviceCode}_{startTs}_{endTs}',
  outputFileNameTemplate: '{batchName}.mcap',
  outputBatchNamePattern: '^[^/]+_\\d{17}Z8_\\d{17}Z8$'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function normalizeNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, num))
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item).trim()).filter(Boolean)
}

function normalizeEnv(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, envValue]) => [key.trim(), String(envValue)])
      .filter(([key]) => key.length > 0)
  )
}

function validRegex(value: string): boolean {
  try {
    new RegExp(value)
    return true
  } catch {
    return false
  }
}

export function normalizeGenericConverterConfig(rawConfig: unknown): GenericConverterConfig {
  const raw = isRecord(rawConfig) ? rawConfig : {}
  const fallback = DEFAULT_GENERIC_CONVERTER_CONFIG
  const outputBatchNamePattern = normalizeString(
    raw.outputBatchNamePattern,
    fallback.outputBatchNamePattern
  )

  return {
    enabled: raw.enabled === true,
    pythonPath: normalizeString(raw.pythonPath, fallback.pythonPath) || fallback.pythonPath,
    monitorScriptPath: normalizeString(raw.monitorScriptPath),
    converterScriptPath: normalizeString(raw.converterScriptPath),
    dataRoot: normalizeString(raw.dataRoot),
    outputRoot: normalizeString(raw.outputRoot),
    deviceCode: normalizeString(raw.deviceCode, fallback.deviceCode) || fallback.deviceCode,
    stableSeconds: normalizeNumber(raw.stableSeconds, fallback.stableSeconds, 0, 86400),
    pollIntervalSeconds: normalizeNumber(
      raw.pollIntervalSeconds,
      fallback.pollIntervalSeconds,
      1,
      86400
    ),
    retryFailed: raw.retryFailed === true,
    env: normalizeEnv(raw.env),
    extraArgs: normalizeStringArray(raw.extraArgs),
    outputDirectoryTemplate: normalizeString(
      raw.outputDirectoryTemplate,
      fallback.outputDirectoryTemplate
    ) || fallback.outputDirectoryTemplate,
    outputBatchNameTemplate: normalizeString(
      raw.outputBatchNameTemplate,
      fallback.outputBatchNameTemplate
    ) || fallback.outputBatchNameTemplate,
    outputFileNameTemplate: normalizeString(
      raw.outputFileNameTemplate,
      fallback.outputFileNameTemplate
    ) || fallback.outputFileNameTemplate,
    outputBatchNamePattern: validRegex(outputBatchNamePattern)
      ? outputBatchNamePattern
      : fallback.outputBatchNamePattern
  }
}

export function genericConverterConfigFromExtensions(
  extensions: ProfileExtensionConfig | undefined
): GenericConverterConfig {
  return normalizeGenericConverterConfig(
    extensions?.configs?.[GENERIC_CONVERTER_EXTENSION_ID]
  )
}

export function mergeWorkDirNamePattern(
  currentPattern: string | undefined,
  outputBatchNamePattern: string
): string {
  const current = currentPattern?.trim()
  const output = outputBatchNamePattern.trim()
  if (!output) return current || ''
  if (!current) return output
  if (current === output || current.includes(output)) return current
  return `(?:${current})|(?:${output})`
}

export function applyGenericConverterScanHandoff(
  profile: UploadProfile,
  config: GenericConverterConfig
): UploadProfile {
  if (!config.enabled || !config.outputRoot) return profile

  const providers = providersForProfile(profile)
  const providerDirectories = {
    aliyun: [...(profile.scan.providerDirectories.aliyun || [])],
    tencent: [...(profile.scan.providerDirectories.tencent || [])]
  }
  const sourceRoots = profile.source?.roots?.length
    ? [...profile.source.roots]
    : profile.source?.root
      ? [profile.source.root]
      : []

  for (const provider of providers) {
    if (!providerDirectories[provider].includes(config.outputRoot)) {
      providerDirectories[provider].push(config.outputRoot)
    }
  }
  if (!sourceRoots.includes(config.outputRoot)) {
    sourceRoots.push(config.outputRoot)
  }

  return {
    ...profile,
    source: {
      root: sourceRoots[0] || '',
      roots: sourceRoots
    },
    scan: {
      ...profile.scan,
      providerDirectories,
      workDirNamePattern: mergeWorkDirNamePattern(
        profile.scan.workDirNamePattern,
        config.outputBatchNamePattern
      )
    },
    discovery: {
      ...profile.discovery,
      taskRegex: mergeWorkDirNamePattern(
        profile.discovery.taskRegex || profile.scan.workDirNamePattern,
        config.outputBatchNamePattern
      ),
      taskPattern: profile.discovery.taskRegex ? undefined : profile.discovery.taskPattern
    }
  }
}
