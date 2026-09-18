import { readdir } from 'fs/promises'
import { join } from 'path'
import { DEFAULT_WORK_DIR_NAME_PATTERN } from '@shared/constants'
import { isDateFolderName } from '@shared/legacy-date-folder'

export interface DiscoveredDayDirectory {
  dateName: string
  folderPath: string
  childFolderNames: string[]
  ignoredChildFolderNames: string[]
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
