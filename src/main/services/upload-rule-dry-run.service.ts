import { stat } from 'fs/promises'
import { getSettingsRepo } from '../db/settings.repo'
import { assertSafeCleanupPath } from '../utils/cleanup-path-safety'
import { discoverUploadGroups } from './upload-group-discovery'
import { FileFilterService, type ScannedFile } from './file-filter.service'
import { compileDiscoveryPattern } from '@shared/discovery'
import { renderPathMapping, validatePathMappingTemplate } from '@shared/path-mapping'
import { getRuleById, resolveRuleDestinations } from '@shared/upload-rule'
import type {
  AppSettings,
  UploadRule,
  UploadRuleDryRunFilePreview,
  UploadRuleDryRunGroupPreview,
  UploadRuleDryRunInput,
  UploadRuleDryRunResult,
  UploadRuleDryRunRootPreview
} from '@shared/types'

interface ResolvedDestination {
  connectionId: string
  prefix: string
}

interface DryRunTotals {
  groups: number
  tasks: number
  ignoredTasks: number
  filesScanned: number
  sampledFiles: number
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
  const sourceRoots = resolveDryRunSourceRoots(input, rule)
  const errors: string[] = []
  const warnings: string[] = []
  const roots: UploadRuleDryRunRootPreview[] = []
  const totals = emptyTotals()
  const sampleLimit = normalizeSampleLimit(input.sampleLimit)

  if (sourceRoots.length === 0) {
    errors.push('Source Root 不能为空')
    return buildResult(rule, roots, errors, warnings, totals)
  }

  const destinations = resolveDestinations(settings, rule, errors)
  validateFilterRegex(rule, errors)
  validateDiscoveryConfig(rule, errors)
  validateCompletionPolicy(rule, errors)

  if (errors.length > 0) {
    return buildResult(rule, roots, errors, warnings, totals)
  }

  const duplicateKeyOwners = new Map<string, string>()

  for (const sourceRoot of sourceRoots) {
    const rootPreview = createRootPreview(sourceRoot)
    roots.push(rootPreview)

    const rootValid = await validateSourceRoot(rootPreview, errors)
    if (!rootValid) continue

    const groups = await discoverRootGroups(rootPreview, rule, errors)
    if (!groups) continue
    if (groups.length === 0) {
      pushRootWarning(rootPreview, warnings, '没有任何 Upload Group 匹配当前 Discovery 规则')
      continue
    }

    rootPreview.totals.groups = groups.length
    totals.groups += groups.length

    for (const group of groups) {
      const groupPreview: UploadRuleDryRunGroupPreview = {
        groupKey: group.groupKey,
        folderPath: group.folderPath,
        variables: group.variables,
        tasks: []
      }

      let matchedTasksInGroup = 0
      for (const task of group.taskDirectories) {
        if (task.ignored) {
          rootPreview.totals.ignoredTasks++
          totals.ignoredTasks++
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

        matchedTasksInGroup++
        rootPreview.totals.tasks++
        totals.tasks++

        if (rule.cleanup.enabled) {
          try {
            await assertSafeCleanupPath({
              targetPath: task.folderPath,
              sourceRoots
            })
          } catch (error) {
            pushRootError(
              rootPreview,
              errors,
              `清理路径不安全: ${task.folderPath} (${formatError(error)})`
            )
          }
        }

        const templateErrors = rule.pathMapping.mode === 'template'
          ? validatePathMappingTemplate(rule.pathMapping.template || '', task.variables)
          : []
        for (const templateError of templateErrors) {
          pushRootError(rootPreview, errors, `Path Mapping 无效: ${templateError}`)
        }

        const files = await sampleTaskFiles(task.folderPath, rule, sampleLimit)
        rootPreview.totals.filesScanned += files.length
        rootPreview.totals.sampledFiles += files.length
        totals.filesScanned += files.length
        totals.sampledFiles += files.length
        if (files.length === 0) {
          pushRootWarning(rootPreview, warnings, `没有匹配文件: ${task.folderPath}`)
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
              const owner = `${sourceRoot}:${task.taskKey}/${file.relativePath}`
              if (existingOwner && existingOwner !== owner) {
                pushRootError(
                  rootPreview,
                  errors,
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
              pushRootError(
                rootPreview,
                errors,
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

      if (matchedTasksInGroup === 0) {
        pushRootWarning(rootPreview, warnings, `Upload Group 没有匹配 Upload Task: ${group.folderPath}`)
      }
      groupPreview.tasks.sort((a, b) => a.taskKey.localeCompare(b.taskKey))
      rootPreview.groups.push(groupPreview)
    }

    rootPreview.groups.sort((a, b) => a.groupKey.localeCompare(b.groupKey))
  }

  if (totals.tasks === 0) {
    errors.push('没有任何 Upload Task 匹配当前 Discovery 规则')
  }

  return buildResult(rule, roots, errors, warnings, totals)
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

function resolveDryRunSourceRoots(input: UploadRuleDryRunInput, rule: UploadRule): string[] {
  const rawRoots = input.sourceRoots && input.sourceRoots.length > 0
    ? input.sourceRoots
    : input.sourceRoot
      ? [input.sourceRoot]
      : rule.source.roots
  return Array.from(
    new Set(rawRoots.map((root) => root.trim()).filter(Boolean))
  )
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

function validateDiscoveryConfig(rule: UploadRule, errors: string[]): void {
  const { discovery } = rule
  for (const [label, pattern] of [
    ['Group Pattern', discovery.groupPattern],
    ['Task Pattern', discovery.taskPattern]
  ] as const) {
    if (!pattern?.trim()) continue
    try {
      compileDiscoveryPattern(pattern)
    } catch (error) {
      errors.push(`Discovery ${label} 无效: ${formatError(error)}`)
    }
  }

  for (const [label, regex] of [
    ['Group Regex', discovery.groupRegex],
    ['Task Regex', discovery.taskRegex]
  ] as const) {
    if (!regex?.trim()) continue
    try {
      new RegExp(regex)
    } catch (error) {
      errors.push(`Discovery ${label} 无效: ${formatError(error)}`)
    }
  }
}

function validateCompletionPolicy(rule: UploadRule, errors: string[]): void {
  if (rule.completion.mode === 'inactivity') {
    if (!Number.isFinite(rule.completion.idleMinutes) || rule.completion.idleMinutes <= 0) {
      errors.push('Completion inactivity idleMinutes 必须大于 0')
    }
  }
  if (rule.completion.mode === 'marker-file') {
    const markerFile = rule.completion.markerFile.trim()
    if (!markerFile) errors.push('Completion marker-file markerFile 不能为空')
    if (isAbsolutePath(markerFile)) {
      errors.push('Completion marker-file markerFile 不能使用绝对路径')
    }
    if (pathSegments(markerFile).includes('..')) {
      errors.push('Completion marker-file markerFile 不能包含 .. 路径段')
    }
  }
}

async function validateSourceRoot(
  root: UploadRuleDryRunRootPreview,
  errors: string[]
): Promise<boolean> {
  try {
    const rootStat = await stat(root.sourceRoot)
    if (!rootStat.isDirectory()) {
      pushRootError(root, errors, 'Source Root 不是目录')
      return false
    }
    return true
  } catch (error) {
    pushRootError(root, errors, `Source Root 不存在或不可访问 (${formatError(error)})`)
    return false
  }
}

async function discoverRootGroups(
  root: UploadRuleDryRunRootPreview,
  rule: UploadRule,
  errors: string[]
): Promise<Awaited<ReturnType<typeof discoverUploadGroups>> | null> {
  try {
    return await discoverUploadGroups(root.sourceRoot, rule.discovery)
  } catch (error) {
    pushRootError(root, errors, `Discovery 规则无效: ${formatError(error)}`)
    return null
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

function createRootPreview(sourceRoot: string): UploadRuleDryRunRootPreview {
  return {
    sourceRoot,
    ok: true,
    totals: emptyTotals(),
    errors: [],
    warnings: [],
    groups: []
  }
}

function emptyTotals(): DryRunTotals {
  return {
    groups: 0,
    tasks: 0,
    ignoredTasks: 0,
    filesScanned: 0,
    sampledFiles: 0
  }
}

function pushRootError(
  root: UploadRuleDryRunRootPreview,
  allErrors: string[],
  message: string
): void {
  const scoped = `[${root.sourceRoot}] ${message}`
  root.ok = false
  root.errors.push(scoped)
  allErrors.push(scoped)
}

function pushRootWarning(
  root: UploadRuleDryRunRootPreview,
  allWarnings: string[],
  message: string
): void {
  const scoped = `[${root.sourceRoot}] ${message}`
  root.warnings.push(scoped)
  allWarnings.push(scoped)
}

function buildResult(
  rule: UploadRule,
  roots: UploadRuleDryRunRootPreview[],
  errors: string[],
  warnings: string[],
  totals: DryRunTotals
): UploadRuleDryRunResult {
  return {
    ok: errors.length === 0 && roots.every((root) => root.ok),
    ruleId: rule.id,
    ruleName: rule.name,
    totals: {
      roots: roots.length,
      groups: totals.groups,
      tasks: totals.tasks,
      ignoredTasks: totals.ignoredTasks,
      filesScanned: totals.filesScanned,
      sampledFiles: totals.sampledFiles
    },
    errors: dedupe(errors),
    warnings: dedupe(warnings),
    roots: roots.map((root) => ({
      ...root,
      errors: dedupe(root.errors),
      warnings: dedupe(root.warnings)
    }))
  }
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
