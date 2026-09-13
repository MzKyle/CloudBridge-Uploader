import { readdir } from 'fs/promises'
import { basename, join } from 'path'
import { DEFAULT_WORK_DIR_NAME_PATTERN } from '@shared/constants'
import {
  discoveryPatternDepth,
  matchDiscoveryRule,
  normalizeDiscoveryPath
} from '@shared/discovery'
import type { DiscoveryConfig, PathVariables } from '@shared/types'
import { isDateFolderName } from '@shared/day-folder'

export interface DiscoveredDayDirectory {
  dateName: string
  folderPath: string
  childFolderNames: string[]
  ignoredChildFolderNames: string[]
}

export interface DiscoveredUploadTaskDirectory {
  taskKey: string
  folderName: string
  folderPath: string
  relativePath: string
  variables: PathVariables
  ignored: boolean
}

export interface DiscoveredUploadGroupDirectory {
  groupKey: string
  folderPath: string
  relativePath: string
  variables: PathVariables
  taskDirectories: DiscoveredUploadTaskDirectory[]
}

interface DirectoryCandidate {
  absolutePath: string
  relativePath: string
  name: string
}

export function createWorkDirNameRegex(pattern?: string): RegExp {
  try {
    return new RegExp(pattern?.trim() || DEFAULT_WORK_DIR_NAME_PATTERN)
  } catch {
    return new RegExp(DEFAULT_WORK_DIR_NAME_PATTERN)
  }
}

export function isWorkDirName(name: string, pattern?: string): boolean {
  return createWorkDirNameRegex(pattern).test(name)
}

export async function discoverUploadGroups(
  rootDir: string,
  config: DiscoveryConfig = {}
): Promise<DiscoveredUploadGroupDirectory[]> {
  const normalizedConfig = normalizeDiscoveryConfig(config)

  if (!hasGroupRule(normalizedConfig)) {
    return [
      {
        groupKey: basename(rootDir) || normalizeDiscoveryPath(rootDir),
        folderPath: rootDir,
        relativePath: '',
        variables: {},
        taskDirectories: await discoverTaskDirectories(rootDir, rootDir, {}, normalizedConfig)
      }
    ]
  }

  const groupDepth = normalizedConfig.recursive
    ? Number.POSITIVE_INFINITY
    : Math.max(1, discoveryPatternDepth(normalizedConfig.groupPattern))
  const candidates = await listDirectoryCandidates(rootDir, groupDepth)
  const groups: DiscoveredUploadGroupDirectory[] = []

  for (const candidate of candidates) {
    const match = matchDiscoveryRule(normalizedConfig, 'group', candidate.relativePath)
    if (!match) continue
    const variables = match.variables
    groups.push({
      groupKey: candidate.relativePath || candidate.name,
      folderPath: candidate.absolutePath,
      relativePath: candidate.relativePath,
      variables,
      taskDirectories: await discoverTaskDirectories(
        rootDir,
        candidate.absolutePath,
        variables,
        normalizedConfig
      )
    })
  }

  return groups.sort((a, b) => a.groupKey.localeCompare(b.groupKey))
}

export async function discoverCurrentDayDirectory(
  rootDir: string,
  dateName: string,
  workDirNamePattern?: string
): Promise<DiscoveredDayDirectory | null> {
  if (!isDateFolderName(dateName)) return null

  const folderPath = join(rootDir, dateName)
  let childEntries
  try {
    childEntries = await readdir(folderPath, { withFileTypes: true })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }

  const workDirRegex = createWorkDirNameRegex(workDirNamePattern)
  const childFolderNames: string[] = []
  const ignoredChildFolderNames: string[] = []

  for (const child of childEntries) {
    if (!child.isDirectory() || child.name.startsWith('.')) continue
    if (workDirRegex.test(child.name)) {
      childFolderNames.push(child.name)
    } else {
      ignoredChildFolderNames.push(child.name)
    }
  }

  return {
    dateName,
    folderPath,
    childFolderNames: childFolderNames.sort(),
    ignoredChildFolderNames: ignoredChildFolderNames.sort()
  }
}

async function discoverTaskDirectories(
  rootDir: string,
  groupPath: string,
  groupVariables: PathVariables,
  config: DiscoveryConfig
): Promise<DiscoveredUploadTaskDirectory[]> {
  if (!hasTaskRule(config)) {
    return [
      {
        taskKey: normalizeDiscoveryPath(groupPath.slice(rootDir.length)) || basename(groupPath),
        folderName: basename(groupPath),
        folderPath: groupPath,
        relativePath: normalizeDiscoveryPath(groupPath.slice(rootDir.length)),
        variables: {},
        ignored: false
      }
    ]
  }

  const taskDepth = config.recursive
    ? Number.POSITIVE_INFINITY
    : Math.max(1, discoveryPatternDepth(config.taskPattern))
  const candidates = await listDirectoryCandidates(groupPath, taskDepth)
  const result: DiscoveredUploadTaskDirectory[] = []
  for (const candidate of candidates) {
    const match = matchDiscoveryRule(config, 'task', candidate.relativePath)
    result.push({
      taskKey: candidate.relativePath || candidate.name,
      folderName: candidate.name,
      folderPath: candidate.absolutePath,
      relativePath: candidate.relativePath,
      variables: match ? { ...groupVariables, ...match.variables } : groupVariables,
      ignored: !match
    })
  }

  return result.sort((a, b) => a.taskKey.localeCompare(b.taskKey))
}

async function listDirectoryCandidates(
  rootDir: string,
  maxDepth: number
): Promise<DirectoryCandidate[]> {
  const candidates: DirectoryCandidate[] = []
  await visit(rootDir, '', 0, maxDepth, candidates)
  return candidates
}

async function visit(
  rootDir: string,
  relativePath: string,
  depth: number,
  maxDepth: number,
  candidates: DirectoryCandidate[]
): Promise<void> {
  if (depth >= maxDepth) return

  let entries
  try {
    entries = await readdir(join(rootDir, relativePath), { withFileTypes: true })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    throw error
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const childRelativePath = normalizeDiscoveryPath(join(relativePath, entry.name))
    candidates.push({
      absolutePath: join(rootDir, childRelativePath),
      relativePath: childRelativePath,
      name: entry.name
    })
    await visit(rootDir, childRelativePath, depth + 1, maxDepth, candidates)
  }
}

function normalizeDiscoveryConfig(config: DiscoveryConfig): DiscoveryConfig {
  return {
    groupPattern: normalizeOptionalString(config.groupPattern),
    taskPattern: normalizeOptionalString(config.taskPattern),
    groupRegex: normalizeOptionalString(config.groupRegex),
    taskRegex: normalizeOptionalString(config.taskRegex),
    recursive: config.recursive ?? false
  }
}

function hasGroupRule(config: DiscoveryConfig): boolean {
  return Boolean(config.groupPattern || config.groupRegex)
}

function hasTaskRule(config: DiscoveryConfig): boolean {
  return Boolean(config.taskPattern || config.taskRegex)
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}
