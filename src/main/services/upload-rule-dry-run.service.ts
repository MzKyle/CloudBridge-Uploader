import { stat } from 'fs/promises'
import { getSettingsRepo } from '../db/settings.repo'
import { assertSafeCleanupPath } from '../utils/cleanup-path-safety'
import { discoverUploadGroups } from './date-directory-discovery'
import { FileFilterService, type ScannedFile } from './file-filter.service'
import { renderPathMapping, validatePathMappingTemplate } from '@shared/path-mapping'
import { getRuleById, resolveRuleDestinations } from '@shared/upload-rule'
import type {
  AppSettings,
  UploadRule,
  UploadRuleDryRunFilePreview,
  UploadRuleDryRunGroupPreview,
  UploadRuleDryRunInput,
  UploadRuleDryRunResult
} from '@shared/types'

interface ResolvedDestination {
  connectionId: string
  prefix: string
}

const DEFAULT_SAMPLE_LIMIT = 50
const MAX_SAMPLE_LIMIT = 500

export class UploadRuleDryRunService {
  async run(input: UploadRuleDryRunInput): Promise<UploadRuleDryRunResult> {
    return dryRunUploadRule(input, getSettingsRepo().getAll())
  }
}

let instance: UploadRuleDryRunService | null = null
export function getUploadRuleDryRunService(): UploadRuleDryRunService {
  if (!instance) instance = new UploadRuleDryRunService()
  return instance
}

export async function dryRunUploadRule(
  input: UploadRuleDryRunInput,
  baseSettings: AppSettings
): Promise<UploadRuleDryRunResult> {
  const settings = mergeRuleIntoSettings(baseSettings, input.rule)
  const rule = input.rule || getRuleById(settings, input.ruleId)
  const sourceRoot = (
    input.sourceRoot ||
    rule.source.roots[0] ||
    ''
  ).trim()
  const errors: string[] = []
  const warnings: string[] = []
  const groupPreviews: UploadRuleDryRunGroupPreview[] = []
  const sampleLimit = normalizeSampleLimit(input.sampleLimit)
  let filesScanned = 0
  let sampledFiles = 0
  let taskCount = 0
  let ignoredTaskCount = 0

  if (!sourceRoot) {
    errors.push('Source Root 不能为空')
    return buildResult(rule, sourceRoot, errors, warnings, groupPreviews, {
      filesScanned,
      sampledFiles,
      taskCount,
      ignoredTaskCount
    })
  }

  try {
    const rootStat = await stat(sourceRoot)
    if (!rootStat.isDirectory()) {
      errors.push(`Source Root 不是目录: ${sourceRoot}`)
    }
  } catch (error) {
    errors.push(`Source Root 不存在或不可访问: ${sourceRoot} (${formatError(error)})`)
  }

  const destinations = resolveDestinations(settings, rule, errors)
  validateFilterRegex(rule, errors)

  if (errors.length > 0) {
    return buildResult(rule, sourceRoot, errors, warnings, groupPreviews, {
      filesScanned,
      sampledFiles,
      taskCount,
      ignoredTaskCount
    })
  }

  let groups
  try {
    groups = await discoverUploadGroups(sourceRoot, rule.discovery)
  } catch (error) {
    errors.push(`Discovery 规则无效: ${formatError(error)}`)
    return buildResult(rule, sourceRoot, errors, warnings, groupPreviews, {
      filesScanned,
      sampledFiles,
      taskCount,
      ignoredTaskCount
    })
  }

  if (groups.length === 0) {
    errors.push('没有任何 Upload Group 匹配当前 Discovery 规则')
  }

  const duplicateKeyOwners = new Map<string, string>()
  const sourceRoots = rule.source.roots.length > 0 ? rule.source.roots : [sourceRoot]

  for (const group of groups) {
    const groupPreview: UploadRuleDryRunGroupPreview = {
      groupKey: group.groupKey,
      folderPath: group.folderPath,
      variables: group.variables,
      tasks: []
    }

    for (const task of group.taskDirectories) {
      if (task.ignored) {
        ignoredTaskCount++
        groupPreview.tasks.push({
          taskKey: task.taskKey,
          folderPath: task.folderPath,
          variables: task.variables,
          ignored: true,
          filesScanned: 0,
          sampleFiles: []
        })
        continue
      }

      taskCount++
      if (rule.cleanup.enabled) {
        try {
          await assertSafeCleanupPath({
            targetPath: task.folderPath,
            sourceRoots
          })
        } catch (error) {
          errors.push(
            `清理路径不安全: ${task.folderPath} (${formatError(error)})`
          )
        }
      }

      const templateErrors = rule.pathMapping.mode === 'template'
        ? validatePathMappingTemplate(rule.pathMapping.template || '', task.variables)
        : []
      for (const templateError of templateErrors) {
        errors.push(`Path Mapping 无效: ${templateError}`)
      }

      const files = await sampleTaskFiles(task.folderPath, rule, sampleLimit)
      filesScanned += files.length
      sampledFiles += files.length
      if (files.length === 0) {
        warnings.push(`没有匹配文件: ${task.folderPath}`)
      }

      const filePreviews: UploadRuleDryRunFilePreview[] = []
      for (const file of files) {
        const objectKeys: UploadRuleDryRunFilePreview['objectKeys'] = []
        for (const destination of destinations) {
          try {
            const mappedPath = renderPathMapping(rule.pathMapping, {
              sourcePath: task.folderPath,
              relativePath: file.relativePath,
              variables: task.variables
            })
            validateObjectPath(mappedPath)
            const key = joinObjectPath(destination.prefix, mappedPath)
            validateObjectPath(key)
            const duplicateKey = `${destination.connectionId}\0${key}`
            const existingOwner = duplicateKeyOwners.get(duplicateKey)
            const owner = `${task.taskKey}/${file.relativePath}`
            if (existingOwner && existingOwner !== owner) {
              errors.push(
                `对象 Key 冲突: ${destination.connectionId}:${key} ` +
                `(${existingOwner} 与 ${owner})`
              )
            } else {
              duplicateKeyOwners.set(duplicateKey, owner)
            }
            objectKeys.push({
              connectionId: destination.connectionId,
              key
            })
          } catch (error) {
            errors.push(
              `对象 Key 渲染失败: ${task.taskKey}/${file.relativePath} ` +
              `(${formatError(error)})`
            )
          }
        }

        filePreviews.push({
          relativePath: normalizeObjectPath(file.relativePath),
          size: file.size,
          objectKeys
        })
      }

      groupPreview.tasks.push({
        taskKey: task.taskKey,
        folderPath: task.folderPath,
        variables: task.variables,
        ignored: false,
        filesScanned: files.length,
        sampleFiles: filePreviews
      })
    }

    groupPreviews.push(groupPreview)
  }

  if (taskCount === 0) {
    errors.push('没有任何 Upload Task 匹配当前 Discovery 规则')
  }

  return buildResult(rule, sourceRoot, dedupe(errors), dedupe(warnings), groupPreviews, {
    filesScanned,
    sampledFiles,
    taskCount,
    ignoredTaskCount
  })
}

function mergeRuleIntoSettings(
  settings: AppSettings,
  rule: UploadRule | undefined
): AppSettings {
  if (!rule) return settings
  const rules = settings.rules.some((item) => item.id === rule.id)
    ? settings.rules.map((item) => item.id === rule.id ? rule : item)
    : [...settings.rules, rule]
  return {
    ...settings,
    rules,
    activeRuleId: rule.id
  }
}

function resolveDestinations(
  settings: AppSettings,
  rule: UploadRule,
  errors: string[]
): ResolvedDestination[] {
  try {
    const resolved = resolveRuleDestinations(rule, settings.connections)
    return resolved.map((destination) => ({
      connectionId: destination.connectionId,
      prefix: destination.prefix
    }))
  } catch (error) {
    errors.push(formatError(error))
    return []
  }
}

function validateFilterRegex(rule: UploadRule, errors: string[]): void {
  for (const pattern of rule.filter.regex) {
    try {
      new RegExp(pattern)
    } catch (error) {
      errors.push(`Filter Regex 无效: ${pattern} (${formatError(error)})`)
    }
  }
}

async function sampleTaskFiles(
  folderPath: string,
  rule: UploadRule,
  sampleLimit: number
): Promise<ScannedFile[]> {
  const files: ScannedFile[] = []
  const filter = new FileFilterService(rule.filter)
  for await (const batch of filter.scanFolderBatches(folderPath, sampleLimit)) {
    for (const file of batch) {
      files.push(file)
      if (files.length >= sampleLimit) return files
    }
  }
  return files
}

function validateObjectPath(path: string): void {
  const normalized = normalizeObjectPath(path)
  if (!normalized.trim()) throw new Error('对象 Key 渲染结果不能为空')
  if (isAbsolutePath(normalized)) throw new Error('对象 Key 不能使用绝对路径')
  if (pathSegments(normalized).includes('..')) {
    throw new Error('对象 Key 不能包含 .. 路径段')
  }
}

function joinObjectPath(...parts: string[]): string {
  return parts
    .flatMap((part) => normalizeObjectPath(part).split('/'))
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '.')
    .join('/')
}

function normalizeObjectPath(path: string): string {
  return path.replace(/\\/g, '/')
}

function pathSegments(path: string): string[] {
  return normalizeObjectPath(path)
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '.')
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)
}

function normalizeSampleLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_SAMPLE_LIMIT
  return Math.max(1, Math.min(MAX_SAMPLE_LIMIT, Math.floor(value || DEFAULT_SAMPLE_LIMIT)))
}

function buildResult(
  rule: UploadRule,
  sourceRoot: string,
  errors: string[],
  warnings: string[],
  groups: UploadRuleDryRunGroupPreview[],
  totals: {
    filesScanned: number
    sampledFiles: number
    taskCount: number
    ignoredTaskCount: number
  }
): UploadRuleDryRunResult {
  return {
    ok: errors.length === 0,
    ruleId: rule.id,
    ruleName: rule.name,
    sourceRoot,
    totals: {
      groups: groups.length,
      tasks: totals.taskCount,
      ignoredTasks: totals.ignoredTaskCount,
      filesScanned: totals.filesScanned,
      sampledFiles: totals.sampledFiles
    },
    errors: dedupe(errors),
    warnings: dedupe(warnings),
    groups
  }
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
