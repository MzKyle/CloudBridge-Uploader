import { isDateFolderName } from './day-folder'
import { modeForProviders, providersForMode, providersForProfile } from './cloud-upload'
import type { CloudProvider, ScanConfig, UploadProfile, UploadTargetMode } from './types'

export interface ActiveScanRoot {
  directory: string
  providers: CloudProvider[]
}

export interface ActiveProfileScanRoot extends ActiveScanRoot {
  profileId: string
  profileName: string
}

export const CLOUD_PROVIDERS: CloudProvider[] = ['aliyun', 'tencent']

export function emptyProviderDirectories(): Record<CloudProvider, string[]> {
  return {
    aliyun: [],
    tencent: []
  }
}

export function normalizeScanDirectory(directory: string): string {
  const trimmed = directory.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return ''

  const parts = trimmed.split(/[\\/]+/)
  const last = parts[parts.length - 1]
  if (last && isDateFolderName(last) && parts.length > 1) {
    return trimmed.slice(0, trimmed.length - last.length).replace(/[\\/]+$/, '')
  }

  return trimmed
}

export function normalizeScanDirectories(directories: string[]): string[] {
  return Array.from(
    new Set(
      directories
        .map(normalizeScanDirectory)
        .filter(Boolean)
    )
  )
}

export function normalizeSourceDirectory(directory: string): string {
  return directory.trim().replace(/[\\/]+$/, '')
}

export function normalizeSourceDirectories(directories: string[]): string[] {
  return Array.from(
    new Set(
      directories
        .map(normalizeSourceDirectory)
        .filter(Boolean)
    )
  )
}

export function normalizeProviderDirectories(
  providerDirectories?: Partial<Record<CloudProvider, string[]>>,
): Record<CloudProvider, string[]> {
  return {
    aliyun: normalizeScanDirectories(providerDirectories?.aliyun ?? []),
    tencent: normalizeScanDirectories(providerDirectories?.tencent ?? [])
  }
}

export function migrateLegacyScanDirectories(
  legacyDirectories: string[],
  targetMode: UploadTargetMode,
): Record<CloudProvider, string[]> {
  const normalized = normalizeScanDirectories(legacyDirectories)
  const providerDirectories = emptyProviderDirectories()
  for (const provider of providersForMode(targetMode)) {
    providerDirectories[provider] = normalized
  }
  return providerDirectories
}

export function normalizeScanConfig(
  scan: ScanConfig,
  targetMode: UploadTargetMode,
): ScanConfig {
  const hasProviderDirectories = Boolean(
    scan.providerDirectories &&
      CLOUD_PROVIDERS.some(
        (provider) => scan.providerDirectories[provider]?.length > 0,
      ),
  )
  const providerDirectories = hasProviderDirectories
    ? normalizeProviderDirectories(scan.providerDirectories)
    : migrateLegacyScanDirectories(scan.directories ?? [], targetMode)
  const directories = normalizeScanDirectories([
    ...providerDirectories.aliyun,
    ...providerDirectories.tencent
  ])

  return {
    ...scan,
    directories,
    providerDirectories
  }
}

export function getActiveScanRoots(
  scan: ScanConfig,
  targetMode: UploadTargetMode,
): ActiveScanRoot[] {
  const activeProviders = new Set(providersForMode(targetMode))
  const roots = new Map<string, ActiveScanRoot>()
  const providerDirectories = normalizeProviderDirectories(scan.providerDirectories)

  for (const provider of CLOUD_PROVIDERS) {
    if (!activeProviders.has(provider)) continue
    for (const directory of providerDirectories[provider]) {
      const key = sourceDirectoryKey(directory)
      const current = roots.get(key)
      if (current) {
        if (!current.providers.includes(provider)) {
          current.providers.push(provider)
          current.providers = providersForMode(modeForProviders(current.providers))
        }
      } else {
        roots.set(key, { directory, providers: [provider] })
      }
    }
  }

  return Array.from(roots.values())
}

export function getWatchedDirectoriesByProvider(
  scan: ScanConfig,
  targetMode: UploadTargetMode,
): Record<CloudProvider, string[]> {
  const activeProviders = new Set(providersForMode(targetMode))
  const providerDirectories = normalizeProviderDirectories(scan.providerDirectories)

  return {
    aliyun: activeProviders.has('aliyun') ? providerDirectories.aliyun : [],
    tencent: activeProviders.has('tencent') ? providerDirectories.tencent : []
  }
}

export function getActiveProfileScanRoots(
  profiles: UploadProfile[],
): ActiveProfileScanRoot[] {
  const roots = new Map<string, ActiveProfileScanRoot>()

  for (const profile of profiles) {
    if (!profile.enabled) continue
    const activeProviders = providersForProfile(profile)
    const sourceRoots = getProfileSourceDirectoriesForProviders(profile, activeProviders)

    for (const directory of sourceRoots) {
      const key = scanDirectoryKey(directory)
      const current = roots.get(key)
      if (current) {
        if (current.profileId === profile.id) {
          current.providers = providersForMode(modeForProviders([
            ...current.providers,
            ...activeProviders
          ]))
        }
        continue
      }
      roots.set(key, {
        directory,
        providers: activeProviders,
        profileId: profile.id,
        profileName: profile.name
      })
    }
  }

  return Array.from(roots.values())
}

export function getProfileWatchedDirectoriesByProvider(
  profiles: UploadProfile[],
): Record<CloudProvider, string[]> {
  const result = emptyProviderDirectories()
  for (const root of getActiveProfileScanRoots(profiles)) {
    for (const provider of root.providers) {
      if (!result[provider].includes(root.directory)) {
        result[provider].push(root.directory)
      }
    }
  }
  return result
}

export function scanDirectoryKey(directory: string): string {
  return normalizeScanDirectory(directory).replace(/\\/g, '/')
}

export function getProfileSourceDirectories(profile: UploadProfile): string[] {
  const sourceRoots = normalizeSourceDirectories(
    profile.source?.roots?.length
      ? profile.source.roots
      : profile.source?.root
        ? [profile.source.root]
        : []
  )
  if (sourceRoots.length > 0) return sourceRoots

  const providerDirectories = normalizeProviderDirectories(
    profile.scan?.providerDirectories
  )
  return normalizeScanDirectories([
    ...providerDirectories.aliyun,
    ...providerDirectories.tencent
  ])
}

function getProfileSourceDirectoriesForProviders(
  profile: UploadProfile,
  activeProviders: CloudProvider[]
): string[] {
  const sourceRoots = normalizeSourceDirectories(
    profile.source?.roots?.length
      ? profile.source.roots
      : profile.source?.root
        ? [profile.source.root]
        : []
  )
  if (sourceRoots.length > 0) return sourceRoots

  const providerDirectories = normalizeProviderDirectories(
    profile.scan?.providerDirectories
  )
  return normalizeSourceDirectories(
    activeProviders.flatMap((provider) => providerDirectories[provider])
  )
}

function sourceDirectoryKey(directory: string): string {
  return normalizeSourceDirectory(directory).replace(/\\/g, '/')
}
