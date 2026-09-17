import type { ScanConfig, UploadRule } from './types'
import {
  getActiveRuleScanRoots,
  getRuleSourceDirectories,
  getRuleWatchedDirectories,
  type ActiveRuleScanRoot
} from './upload-rule'

export type { ActiveRuleScanRoot }

export function normalizeScanDirectories(value: unknown): string[] {
  const items = Array.isArray(value) ? value : []
  return Array.from(
    new Set(
      items
        .map((item) => String(item).trim())
        .filter(Boolean)
    )
  )
}

export function normalizeScanConfig(scan: Partial<ScanConfig> | undefined): ScanConfig {
  const intervalSeconds = Number(scan?.intervalSeconds)
  return {
    intervalSeconds: Number.isFinite(intervalSeconds)
      ? Math.max(5, Math.floor(intervalSeconds))
      : 30
  }
}

export {
  getActiveRuleScanRoots,
  getRuleSourceDirectories,
  getRuleWatchedDirectories
}

export function getRuleScanDirectories(rules: UploadRule[]): string[] {
  return getRuleWatchedDirectories(rules)
}
