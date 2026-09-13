import { deriveDateScopedUploadRelativePath, joinOssPath } from './day-folder'
import type {
  AppSettings,
  CloudProvider,
  OSSConfig,
  PathVariables,
  TencentS3Config,
  UploadPathMode
} from './types'

export const DEFAULT_UPLOAD_PATH_MODE: UploadPathMode = 'target-root'
export const DEFAULT_UPLOAD_PATH_SEGMENT_COUNT = 2

const UPLOAD_PATH_MODES = new Set<UploadPathMode>([
  'target-root',
  'date-workdir',
  'keep-source',
  'last-segments',
  'template'
])

export interface UploadPathResolveContext {
  sourcePath: string
  basePath?: string
  fallbackDirectoryPath?: string
  dateName?: string
  workDirName?: string
  variables?: PathVariables
}

export interface NormalizedUploadPathConfig {
  pathMode: UploadPathMode
  pathSegmentCount: number
}

type ProviderPathSettings = Pick<
  OSSConfig | TencentS3Config,
  'pathMode' | 'pathSegmentCount'
>

export function normalizeUploadPathMode(value: unknown): UploadPathMode {
  return typeof value === 'string' && UPLOAD_PATH_MODES.has(value as UploadPathMode)
    ? value as UploadPathMode
    : DEFAULT_UPLOAD_PATH_MODE
}

export function normalizeUploadPathSegmentCount(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_UPLOAD_PATH_SEGMENT_COUNT
  return Math.max(0, Math.min(20, Math.floor(parsed)))
}

export function normalizeUploadPathConfig<T extends Record<string, unknown>>(
  config: T
): T & NormalizedUploadPathConfig {
  return {
    ...config,
    pathMode: normalizeUploadPathMode(config.pathMode),
    pathSegmentCount: normalizeUploadPathSegmentCount(config.pathSegmentCount)
  }
}

export function getProviderUploadPathConfig(
  settings: AppSettings,
  provider: CloudProvider
): NormalizedUploadPathConfig {
  const config: ProviderPathSettings =
    provider === 'aliyun' ? settings.oss : settings.tencentS3
  return normalizeUploadPathConfig(config as unknown as Record<string, unknown>)
}

export function resolveProviderUploadRelativePaths(
  settings: AppSettings,
  providers: CloudProvider[],
  context: UploadPathResolveContext
): Partial<Record<CloudProvider, string>> {
  const paths: Partial<Record<CloudProvider, string>> = {}
  for (const provider of providers) {
    paths[provider] = resolveUploadRelativePath(
      getProviderUploadPathConfig(settings, provider),
      context
    )
  }
  return paths
}

export function firstProviderUploadRelativePath(
  providers: CloudProvider[],
  paths: Partial<Record<CloudProvider, string>>,
  fallback = ''
): string {
  for (const provider of providers) {
    const path = paths[provider]
    if (path !== undefined) return path
  }
  return fallback
}

export function resolveUploadRelativePath(
  config: ProviderPathSettings,
  context: UploadPathResolveContext
): string {
  const normalized = normalizeUploadPathConfig(
    config as unknown as Record<string, unknown>
  )
  const sourcePath = context.sourcePath

  if (normalized.pathMode === 'target-root' || normalized.pathMode === 'template') return ''

  if (normalized.pathMode === 'date-workdir') {
    const dateName = context.variables?.date || context.dateName
    const workDirName =
      context.variables?.workDir ||
      context.variables?.session ||
      context.workDirName
    if (dateName && workDirName) {
      return joinOssPath(dateName, workDirName)
    }
    return (
      deriveDateScopedUploadRelativePath(sourcePath) ||
      (context.fallbackDirectoryPath
        ? deriveDateScopedUploadRelativePath(context.fallbackDirectoryPath)
        : null) ||
      lastPathSegment(sourcePath)
    )
  }

  if (normalized.pathMode === 'keep-source') {
    const basePath = context.basePath || parentDirectoryPath(sourcePath)
    return relativePathFromBase(sourcePath, basePath)
  }

  if (normalized.pathSegmentCount <= 0) return ''
  return joinOssPath(...pathSegments(sourcePath).slice(-normalized.pathSegmentCount))
}

function relativePathFromBase(sourcePath: string, basePath: string): string {
  const source = pathSegments(sourcePath)
  const base = pathSegments(basePath)
  if (source.length === 0) return ''

  let index = 0
  while (
    index < source.length &&
    index < base.length &&
    segmentEquals(source[index], base[index])
  ) {
    index++
  }

  if (index === base.length && index < source.length) {
    return joinOssPath(...source.slice(index))
  }

  return lastPathSegment(sourcePath)
}

function pathSegments(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '.')
}

function parentDirectoryPath(path: string): string {
  const segments = pathSegments(path)
  return joinOssPath(...segments.slice(0, -1))
}

function lastPathSegment(path: string): string {
  return pathSegments(path).at(-1) || ''
}

function segmentEquals(a: string, b: string): boolean {
  if (a.endsWith(':') || b.endsWith(':')) return a.toLowerCase() === b.toLowerCase()
  return a === b
}
