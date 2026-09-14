import { realpath } from 'fs/promises'
import { homedir } from 'os'
import {
  isAbsolute,
  parse,
  relative,
  resolve,
  win32
} from 'path'

export interface CleanupPathSafetyInput {
  targetPath: string
  sourceRoots: string[]
}

export interface SafeCleanupPath {
  targetPath: string
  sourceRoot: string
  realTargetPath: string
  realSourceRoot: string
}

export async function isSafeCleanupPath(
  input: CleanupPathSafetyInput
): Promise<boolean> {
  try {
    await assertSafeCleanupPath(input)
    return true
  } catch {
    return false
  }
}

export async function assertSafeCleanupPath(
  input: CleanupPathSafetyInput
): Promise<SafeCleanupPath> {
  const targetPath = normalizeInputPath(input.targetPath)
  const sourceRoots = input.sourceRoots.map(normalizeInputPath).filter(Boolean)
  if (!targetPath) throw new Error('Cleanup target path is empty')
  if (sourceRoots.length === 0) throw new Error('Cleanup source roots are empty')
  rejectDangerousRootPath(targetPath)

  const resolvedTarget = resolve(targetPath)
  rejectDangerousRootPath(resolvedTarget)

  const realTargetPath = await realpath(resolvedTarget)
  rejectDangerousRootPath(realTargetPath)

  for (const sourceRoot of sourceRoots) {
    const resolvedSourceRoot = resolve(sourceRoot)
    if (sameNativePath(resolvedTarget, resolvedSourceRoot)) continue
    if (!isNativeChildPath(resolvedTarget, resolvedSourceRoot)) continue

    const realSourceRoot = await realpath(resolvedSourceRoot)
    rejectDangerousRootPath(realSourceRoot)
    if (sameNativePath(realTargetPath, realSourceRoot)) continue
    if (!isNativeChildPath(realTargetPath, realSourceRoot)) continue

    return {
      targetPath: resolvedTarget,
      sourceRoot: resolvedSourceRoot,
      realTargetPath,
      realSourceRoot
    }
  }

  throw new Error('Cleanup target must be a real child directory of a source root')
}

function normalizeInputPath(value: string): string {
  return value.trim().replace(/[\\/]+$/, '') || value.trim()
}

function rejectDangerousRootPath(value: string): void {
  if (isNativeRootPath(value) || isWindowsRootLiteral(value)) {
    throw new Error(`Refusing to cleanup filesystem root: ${value}`)
  }
  if (sameNativePath(resolve(value), resolve(homedir()))) {
    throw new Error(`Refusing to cleanup user home root: ${value}`)
  }
}

function isNativeRootPath(value: string): boolean {
  const resolved = resolve(value)
  return sameNativePath(resolved, parse(resolved).root)
}

function isWindowsRootLiteral(value: string): boolean {
  if (/^[A-Za-z]:$/.test(value) || /^[A-Za-z]:[\\/]$/.test(value)) {
    return true
  }
  const normalized = win32.normalize(value.replace(/\//g, '\\'))
  const parsed = win32.parse(normalized)
  if (!parsed.root) return false
  return trimWindowsPath(parsed.root) === trimWindowsPath(normalized)
}

function isNativeChildPath(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function sameNativePath(a: string, b: string): boolean {
  const normalizedA = normalizeComparablePath(a)
  const normalizedB = normalizeComparablePath(b)
  return normalizedA === normalizedB
}

function normalizeComparablePath(value: string): string {
  const normalized = resolve(value).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function trimWindowsPath(value: string): string {
  return value.replace(/[\\/]+$/, '').toLowerCase()
}
