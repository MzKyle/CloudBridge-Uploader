import { isAbsolute, normalize, parse, relative } from 'path'

export function normalizeFolderPath(value: string): string {
  const normalized = normalize(value)
  return normalized === parse(normalized).root
    ? normalized
    : normalized.replace(/[\\/]+$/, '')
}

export function isPathWithinFolder(filePath: string, folderPath: string): boolean {
  const child = relative(folderPath, filePath)
  return child === '' || (
    child !== '..' &&
    !child.startsWith('../') &&
    !child.startsWith('..\\') &&
    !isAbsolute(child)
  )
}
