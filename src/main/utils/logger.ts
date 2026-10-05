import { join } from 'path'
import { app } from 'electron'
import {
  readdirSync,
  statSync,
  rmSync,
  mkdirSync,
  existsSync,
  appendFileSync,
  renameSync
} from 'fs'
import log from 'electron-log'
import type { LogConfig } from '@shared/types'

let logDir = ''
let levelFileHookInstalled = false
const LEVEL_LOG_MAX_SIZE = 10 * 1024 * 1024
const LEVEL_LOG_DISCARD_SIZE = 50 * 1024 * 1024

export function getLogDirectory(): string {
  return logDir || join(app.getPath('userData'), 'logs')
}

/**
 * 初始化日志系统
 * - 按天分目录: {logDir}/YYYY-MM-DD/
 * - 主日志 info.log 记录所有 info 级别及以上
 * - 额外写入 error.log 和 warn.log 分级文件
 * - 自动清理过期日志
 */
export function initLogger(config?: LogConfig): void {
  logDir = config?.directory || join(app.getPath('userData'), 'logs')

  // 确保日志目录存在
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true })
  }

  // 配置主 file transport — 写入 {date}/info.log
  log.transports.file.resolvePathFn = () => {
    const date = new Date().toISOString().slice(0, 10)
    const dir = join(logDir, date)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return join(dir, 'info.log')
  }
  log.transports.file.level = 'info'
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
  log.transports.file.maxSize = 10 * 1024 * 1024 // 10MB

  prepareCurrentLevelLogs()

  // 通过 hook 额外写入 error.log 和 warn.log
  if (!levelFileHookInstalled) {
    log.hooks.push((message) => {
      if (!logDir) return message

      const level = message.level
      if (level === 'error' || level === 'warn') {
        try {
          const date = new Date().toISOString().slice(0, 10)
          const dir = join(logDir, date)
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
          }
          const fileName = level === 'error' ? 'error.log' : 'warn.log'
          const text = message.data?.map((d: unknown) => String(d)).join(' ') || ''
          const ts = new Date().toISOString().replace('T', ' ').slice(0, 23)
          const line = `[${ts}] [${level}] ${text}\n`
          const filePath = join(dir, fileName)
          rotateLevelLog(filePath)
          appendFileSync(filePath, line)
        } catch {
          // 忽略写入失败
        }
      }
      return message
    })
    levelFileHookInstalled = true
  }

  // 清理旧日志
  const maxDays = config?.maxDays || 30
  cleanOldLogs(logDir, maxDays)

  log.info('日志系统初始化完成, 目录:', logDir)
}

function prepareCurrentLevelLogs(): void {
  const date = new Date().toISOString().slice(0, 10)
  const dir = join(logDir, date)
  if (!existsSync(dir)) return

  rotateLevelLog(join(dir, 'warn.log'))
  rotateLevelLog(join(dir, 'error.log'))
}

function rotateLevelLog(filePath: string): void {
  if (!existsSync(filePath)) {
    return
  }

  const size = statSync(filePath).size
  if (size < LEVEL_LOG_MAX_SIZE) return

  if (size >= LEVEL_LOG_DISCARD_SIZE) {
    rmSync(filePath, { force: true })
    return
  }

  const oldPath = filePath.replace(/\.log$/, '.old.log')
  rmSync(oldPath, { force: true })
  renameSync(filePath, oldPath)
}

function cleanOldLogs(dir: string, maxDays: number): void {
  try {
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000
    const entries = readdirSync(dir)

    for (const entry of entries) {
      const entryPath = join(dir, entry)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue

      try {
        const stat = statSync(entryPath)
        if (stat.isDirectory() && stat.mtimeMs < cutoff) {
          rmSync(entryPath, { recursive: true, force: true })
          log.info('已清理过期日志目录:', entry)
        }
      } catch {
        // 忽略
      }
    }
  } catch {
    // 忽略
  }
}
