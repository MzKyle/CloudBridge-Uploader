import { joinOssPath } from './day-folder'
import type { PathMappingConfig, PathVariables } from './types'

const BUILTIN_PATH_VARIABLES = new Set([
  'relativePath',
  'filename',
  'stem',
  'ext',
  'sourceFolder'
])

export interface PathMappingRenderContext {
  relativePath: string
  sourcePath: string
  variables?: PathVariables
}

export function renderPathMapping(
  config: PathMappingConfig,
  context: PathMappingRenderContext
): string {
  const variables = buildPathMappingVariables(context)
  if (config.mode === 'keep-relative') return variables.relativePath
  if (config.mode === 'flatten') return variables.filename

  const template = config.template || '{relativePath}'
  const errors = validatePathMappingTemplate(template, variables)
  if (errors.length > 0) throw new Error(errors.join('；'))

  return joinOssPath(
    template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
      return variables[name] ?? ''
    })
  )
}

export function validatePathMappingTemplate(
  template: string,
  variables: PathVariables = {}
): string[] {
  const errors: string[] = []
  const trimmed = template.trim()
  if (!trimmed) errors.push('路径映射模板不能为空')
  const unknownVariables = Array.from(
    new Set(
      [...trimmed.matchAll(/\{([A-Za-z0-9_]+)\}/g)]
        .map((match) => match[1])
        .filter((name) => !BUILTIN_PATH_VARIABLES.has(name) && !(name in variables))
    )
  )
  if (unknownVariables.length > 0) {
    errors.push(`未知路径变量: ${unknownVariables.join(', ')}`)
  }
  if (isAbsolutePath(trimmed)) errors.push('路径映射模板不能使用绝对路径')
  if (pathSegments(trimmed).includes('..')) {
    errors.push('路径映射模板不能包含 .. 路径段')
  }
  return errors
}

export function buildPathMappingVariables(
  context: PathMappingRenderContext
): PathVariables {
  const relativePath = joinOssPath(context.relativePath)
  const filename = pathSegments(relativePath).at(-1) || ''
  const dotIndex = filename.lastIndexOf('.')
  return {
    ...(context.variables || {}),
    relativePath,
    filename,
    stem: dotIndex > 0 ? filename.slice(0, dotIndex) : filename,
    ext: dotIndex > 0 ? filename.slice(dotIndex) : '',
    sourceFolder: pathSegments(context.sourcePath).at(-1) || ''
  }
}

function pathSegments(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '.')
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)
}
