import type { DiscoveryConfig, PathVariables } from './types'

const TEMPLATE_TOKEN_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]+))?\}/g

const FORMAT_TOKENS: Array<[string, string]> = [
  ['yyyy', '\\d{4}'],
  ['yy', '\\d{2}'],
  ['MM', '\\d{2}'],
  ['dd', '\\d{2}'],
  ['HH', '\\d{2}'],
  ['mm', '\\d{2}'],
  ['ss', '\\d{2}']
]

export interface DiscoveryMatch {
  variables: PathVariables
}

export function compileDiscoveryPattern(pattern: string): RegExp {
  const source = pattern.trim().replace(/\\/g, '/')
  if (!source) throw new Error('Discovery pattern 不能为空')

  let body = ''
  let cursor = 0
  for (const match of source.matchAll(TEMPLATE_TOKEN_PATTERN)) {
    body += escapeRegex(source.slice(cursor, match.index))
    const name = match[1]
    const format = match[2]
    body += `(?<${name}>${format ? compileFormat(format) : '[^/]+'})`
    cursor = (match.index || 0) + match[0].length
  }
  body += escapeRegex(source.slice(cursor))
  return new RegExp(`^${body}$`)
}

export function matchDiscoveryPattern(
  pattern: string,
  value: string
): DiscoveryMatch | null {
  return matchDiscoveryRegex(compileDiscoveryPattern(pattern), value)
}

export function matchDiscoveryRegex(
  regex: string | RegExp,
  value: string
): DiscoveryMatch | null {
  const compiled = typeof regex === 'string' ? new RegExp(regex) : regex
  const match = compiled.exec(normalizeDiscoveryPath(value))
  if (!match) return null
  return { variables: normalizeGroups(match.groups || {}) }
}

export function matchDiscoveryRule(
  config: DiscoveryConfig,
  kind: 'group' | 'task',
  value: string
): DiscoveryMatch | null {
  const regex = kind === 'group' ? config.groupRegex : config.taskRegex
  if (regex?.trim()) return matchDiscoveryRegex(regex.trim(), value)

  const pattern = kind === 'group' ? config.groupPattern : config.taskPattern
  if (pattern?.trim()) return matchDiscoveryPattern(pattern.trim(), value)

  return { variables: {} }
}

export function extractDiscoveryVariables(
  config: DiscoveryConfig,
  sourceRoot: string,
  taskPath: string
): PathVariables {
  const relativePath = relativeDiscoveryPath(taskPath, sourceRoot)
  if (!relativePath) return {}

  const segments = relativePath.split('/').filter(Boolean)
  const variables: PathVariables = {}
  const groupDepth = config.groupPattern
    ? discoveryPatternDepth(config.groupPattern)
    : config.groupRegex
      ? 1
      : 0
  if ((config.groupPattern || config.groupRegex) && groupDepth > 0) {
    const groupPath = segments.slice(0, groupDepth).join('/')
    const groupMatch = matchDiscoveryRule(config, 'group', groupPath)
    if (!groupMatch) return {}
    Object.assign(variables, groupMatch.variables)
  }

  const taskPathSegments = groupDepth > 0
    ? segments.slice(groupDepth)
    : segments
  if ((config.taskPattern || config.taskRegex) && taskPathSegments.length > 0) {
    const taskMatch = matchDiscoveryRule(config, 'task', taskPathSegments.join('/'))
    if (!taskMatch) return variables
    Object.assign(variables, taskMatch.variables)
  }

  return variables
}

export function discoveryPatternDepth(pattern?: string): number {
  const normalized = pattern?.trim().replace(/\\/g, '/') || ''
  if (!normalized) return 0
  return normalized.split('/').filter(Boolean).length
}

function relativeDiscoveryPath(path: string, basePath: string): string {
  const pathSegments = normalizeDiscoveryPath(path).split('/').filter(Boolean)
  const baseSegments = normalizeDiscoveryPath(basePath).split('/').filter(Boolean)
  let index = 0
  while (
    index < pathSegments.length &&
    index < baseSegments.length &&
    segmentEquals(pathSegments[index], baseSegments[index])
  ) {
    index++
  }
  if (index === baseSegments.length && index < pathSegments.length) {
    return pathSegments.slice(index).join('/')
  }
  return ''
}

function segmentEquals(a: string, b: string): boolean {
  if (a.endsWith(':') || b.endsWith(':')) return a.toLowerCase() === b.toLowerCase()
  return a === b
}

export function normalizeDiscoveryPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function compileFormat(format: string): string {
  let body = ''
  let cursor = 0
  while (cursor < format.length) {
    const token = FORMAT_TOKENS.find(([name]) => format.startsWith(name, cursor))
    if (token) {
      body += token[1]
      cursor += token[0].length
      continue
    }
    body += escapeRegex(format[cursor])
    cursor++
  }
  return body
}

function normalizeGroups(groups: Record<string, string | undefined>): PathVariables {
  return Object.fromEntries(
    Object.entries(groups)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
