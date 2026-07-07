import { spawn, type ChildProcessByStdio } from 'child_process'
import { EventEmitter } from 'events'
import { dirname } from 'path'
import type { Readable } from 'stream'
import log from 'electron-log'
import {
  genericConverterConfigFromExtensions,
  normalizeGenericConverterConfig,
  type GenericConverterConfig,
  type GenericConverterProfileStatus,
  type GenericConverterStatus
} from '@shared/generic-converter'
import { EXTENSION_IDS } from '@shared/plugins'
import type { UploadProfile } from '@shared/types'
import { getSettingsRepo } from '../db/settings.repo'
import { getScannerService } from './scanner.service'

interface RuntimeState {
  profileId: string
  profileName: string
  signature: string
  child: ChildProcessByStdio<null, Readable, Readable> | null
  pid: number | null
  startedAt: string | null
  stoppedAt: string | null
  exitCode: number | null
  lastError: string | null
  recentLogs: string[]
  stopping: boolean
}

interface ProfileConverterTarget {
  profile: UploadProfile
  config: GenericConverterConfig
  extensionEnabled: boolean
  enabled: boolean
  configured: boolean
}

const MAX_LOG_LINES = 80

function configSignature(config: GenericConverterConfig): string {
  return JSON.stringify(config)
}

function createRuntime(
  profileId: string,
  profileName: string,
  signature: string
): RuntimeState {
  return {
    profileId,
    profileName,
    signature,
    child: null,
    pid: null,
    startedAt: null,
    stoppedAt: null,
    exitCode: null,
    lastError: null,
    recentLogs: [],
    stopping: false
  }
}

export class GenericConverterService extends EventEmitter {
  private runtimes = new Map<string, RuntimeState>()

  syncWithSettings(): GenericConverterStatus {
    const targets = this.listTargets()
    const targetIds = new Set(targets.map((target) => target.profile.id))

    for (const profileId of Array.from(this.runtimes.keys())) {
      if (!targetIds.has(profileId)) {
        this.stopProfile(profileId)
        this.runtimes.delete(profileId)
      }
    }

    for (const target of targets) {
      const signature = configSignature(target.config)
      const runtime = this.ensureRuntime(target.profile, signature)
      const previousSignature = runtime.signature
      runtime.profileName = target.profile.name

      if (!target.enabled || !target.configured) {
        runtime.signature = signature
        this.stopProfile(target.profile.id)
        continue
      }

      if (runtime.child && previousSignature === signature) continue
      if (runtime.child && previousSignature !== signature) {
        this.stopProfile(target.profile.id)
      }
      runtime.signature = signature
      this.startTarget(target, false)
    }

    return this.emitStatus()
  }

  getStatus(): GenericConverterStatus {
    const targets = this.listTargets()
    const profiles = targets.map((target) => this.statusForTarget(target))
    return { profiles }
  }

  startProfile(profileId: string): GenericConverterStatus {
    const target = this.findTarget(profileId)
    if (!target) throw new Error('Profile 不存在')
    if (!target.extensionEnabled || !target.config.enabled) {
      throw new Error('通用转换工具未启用')
    }
    if (!target.configured) {
      throw new Error('通用转换工具配置不完整')
    }
    this.startTarget(target, false)
    return this.emitStatus()
  }

  stopProfile(profileId: string): GenericConverterStatus {
    const runtime = this.runtimes.get(profileId)
    if (!runtime?.child) return this.emitStatus()
    runtime.stopping = true
    this.appendLog(runtime, '[app] stopping converter monitor')
    this.terminateChild(runtime.child)
    runtime.child = null
    runtime.pid = null
    runtime.stoppedAt = new Date().toISOString()
    return this.emitStatus()
  }

  scanNow(profileId: string): GenericConverterStatus {
    const target = this.findTarget(profileId)
    if (!target) throw new Error('Profile 不存在')
    if (!target.extensionEnabled || !target.config.enabled) {
      throw new Error('通用转换工具未启用')
    }
    if (!target.configured) {
      throw new Error('通用转换工具配置不完整')
    }

    const runtime = this.ensureRuntime(target.profile, configSignature(target.config))
    if (runtime.child) {
      this.appendLog(runtime, '[app] monitor is already running; skip parallel scan-now')
      return this.emitStatus()
    }

    this.startTarget(target, true)
    return this.emitStatus()
  }

  stopAll(): void {
    for (const profileId of Array.from(this.runtimes.keys())) {
      this.stopProfile(profileId)
    }
  }

  private listTargets(): ProfileConverterTarget[] {
    const settings = getSettingsRepo().getAll()
    return settings.profiles.map((profile) => {
      const extensions = profile.extensions
      const extensionEnabled = Boolean(
        extensions?.enabledIds?.includes(EXTENSION_IDS.GENERIC_CONVERTER)
      )
      const config = genericConverterConfigFromExtensions(extensions)
      const enabled = profile.enabled && extensionEnabled && config.enabled
      const configured = Boolean(
        config.monitorScriptPath &&
        config.dataRoot &&
        config.outputRoot
      )
      return {
        profile,
        config,
        extensionEnabled,
        enabled,
        configured
      }
    })
  }

  private findTarget(profileId: string): ProfileConverterTarget | null {
    return this.listTargets().find((target) => target.profile.id === profileId) || null
  }

  private ensureRuntime(profile: UploadProfile, signature: string): RuntimeState {
    const existing = this.runtimes.get(profile.id)
    if (existing) return existing
    const runtime = createRuntime(profile.id, profile.name, signature)
    this.runtimes.set(profile.id, runtime)
    return runtime
  }

  private startTarget(target: ProfileConverterTarget, once: boolean): void {
    const runtime = this.ensureRuntime(
      target.profile,
      configSignature(target.config)
    )
    if (runtime.child) return

    const command = this.buildCommand(target.config, once)
    runtime.startedAt = new Date().toISOString()
    runtime.stoppedAt = null
    runtime.exitCode = null
    runtime.lastError = null
    runtime.stopping = false
    this.appendLog(runtime, `[app] starting ${command.command} ${command.args.join(' ')}`)

    const child = spawn(command.command, command.args, {
      cwd: dirname(target.config.monitorScriptPath),
      env: command.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    runtime.child = child
    runtime.pid = child.pid ?? null

    child.stdout.on('data', (chunk) => {
      if (runtime.child !== child) return
      this.appendLog(runtime, String(chunk))
      if (String(chunk).includes('[monitor] converted')) {
        getScannerService().triggerScan()
      }
      this.emitStatus()
    })
    child.stderr.on('data', (chunk) => {
      if (runtime.child !== child) return
      this.appendLog(runtime, String(chunk))
      this.emitStatus()
    })
    child.on('error', (error) => {
      if (runtime.child !== child) return
      runtime.lastError = error.message
      this.appendLog(runtime, `[error] ${error.message}`)
      log.error('通用转换工具启动失败:', error)
      this.emitStatus()
    })
    child.on('exit', (code, signal) => {
      if (runtime.child !== child) return
      runtime.child = null
      runtime.pid = null
      runtime.exitCode = code
      runtime.stoppedAt = new Date().toISOString()
      if (!runtime.stopping && code !== 0) {
        runtime.lastError = signal
          ? `进程被信号 ${signal} 结束`
          : `进程退出码 ${code}`
      }
      this.appendLog(runtime, `[app] exited code=${code ?? '-'} signal=${signal ?? '-'}`)
      this.emitStatus()
    })
  }

  private buildCommand(
    rawConfig: GenericConverterConfig,
    once: boolean
  ): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    const config = normalizeGenericConverterConfig(rawConfig)
    const args = [
      config.monitorScriptPath,
      '--data-root',
      config.dataRoot,
      '--output-root',
      config.outputRoot,
      '--device-code',
      config.deviceCode,
      '--stable-seconds',
      String(config.stableSeconds),
      '--poll-interval',
      String(config.pollIntervalSeconds)
    ]
    if (config.retryFailed) args.push('--retry-failed')
    if (once) args.push('--once')
    args.push(...config.extraArgs.map((arg) => this.expandTemplate(arg, config)))

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...config.env,
      GENERIC_CONVERTER_SCRIPT_PATH: config.converterScriptPath,
      GENERIC_CONVERTER_OUTPUT_DIRECTORY_TEMPLATE: config.outputDirectoryTemplate,
      GENERIC_CONVERTER_OUTPUT_BATCH_NAME_TEMPLATE: config.outputBatchNameTemplate,
      GENERIC_CONVERTER_OUTPUT_FILE_NAME_TEMPLATE: config.outputFileNameTemplate,
      GENERIC_CONVERTER_OUTPUT_BATCH_NAME_PATTERN: config.outputBatchNamePattern
    }
    if (config.converterScriptPath) {
      env.COVER_MCAP_CONVERTER_SCRIPT = config.converterScriptPath
    }

    return {
      command: config.pythonPath || 'python3',
      args,
      env
    }
  }

  private expandTemplate(arg: string, config: GenericConverterConfig): string {
    return arg
      .replace(/\{dataRoot\}/g, config.dataRoot)
      .replace(/\{outputRoot\}/g, config.outputRoot)
      .replace(/\{deviceCode\}/g, config.deviceCode)
      .replace(/\{stableSeconds\}/g, String(config.stableSeconds))
      .replace(/\{pollIntervalSeconds\}/g, String(config.pollIntervalSeconds))
      .replace(/\{monitorScriptPath\}/g, config.monitorScriptPath)
      .replace(/\{converterScriptPath\}/g, config.converterScriptPath)
      .replace(/\{outputDirectoryTemplate\}/g, config.outputDirectoryTemplate)
      .replace(/\{outputBatchNameTemplate\}/g, config.outputBatchNameTemplate)
      .replace(/\{outputFileNameTemplate\}/g, config.outputFileNameTemplate)
      .replace(/\{outputBatchNamePattern\}/g, config.outputBatchNamePattern)
  }

  private statusForTarget(target: ProfileConverterTarget): GenericConverterProfileStatus {
    const runtime = this.runtimes.get(target.profile.id)
    const child = runtime?.child || null
    const state =
      !target.extensionEnabled || !target.config.enabled
        ? 'disabled'
        : child
          ? 'running'
          : runtime?.lastError
            ? 'failed'
            : 'stopped'

    return {
      profileId: target.profile.id,
      profileName: target.profile.name,
      enabled: target.enabled,
      configured: target.configured,
      running: Boolean(child),
      pid: runtime?.pid || null,
      startedAt: runtime?.startedAt || null,
      stoppedAt: runtime?.stoppedAt || null,
      exitCode: runtime?.exitCode ?? null,
      lastError: runtime?.lastError || null,
      dataRoot: target.config.dataRoot,
      outputRoot: target.config.outputRoot,
      monitorScriptPath: target.config.monitorScriptPath,
      recentLogs: runtime?.recentLogs || [],
      state
    }
  }

  private appendLog(runtime: RuntimeState, text: string): void {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
    runtime.recentLogs.push(...lines)
    if (runtime.recentLogs.length > MAX_LOG_LINES) {
      runtime.recentLogs.splice(0, runtime.recentLogs.length - MAX_LOG_LINES)
    }
  }

  private terminateChild(child: ChildProcessByStdio<null, Readable, Readable>): void {
    try {
      if (process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, 'SIGTERM')
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      child.kill('SIGTERM')
    }
  }

  private emitStatus(): GenericConverterStatus {
    const status = this.getStatus()
    this.emit('generic-converter:event', status)
    this.emit('status', status)
    return status
  }
}

let instance: GenericConverterService | null = null
export function getGenericConverterService(): GenericConverterService {
  if (!instance) instance = new GenericConverterService()
  return instance
}
