import log from 'electron-log'
import {
  BUILTIN_EXTENSIONS,
  BUILTIN_UPLOAD_PIPELINES,
  EXTENSION_IDS,
  UPLOAD_PIPELINE_IDS
} from '@shared/plugins'
import {
  normalizeProfileExtensions,
  normalizeProfileUploadPipeline
} from '@shared/upload-profile'
import { normalizeGenericConverterConfig } from '@shared/generic-converter'
import type {
  ExtensionManifest,
  PluginProfileStatus,
  ProfileExtensionConfig,
  ProjectCapabilityStatus,
  Task,
  TaskPluginRun,
  WebhookConfig
} from '@shared/types'
import { getPluginRunRepo } from '../db/plugin-run.repo'
import { getSettingsRepo } from '../db/settings.repo'
import { getWebhookService } from './webhook.service'

type TaskEventName = 'task_completed' | 'task_failed'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizedTaskExtensions(task: Task): ProfileExtensionConfig {
  return normalizeProfileExtensions(
    task.profileSnapshot?.extensions,
    task.profileSnapshot?.plugins
  )
}

function configForExtension(extensions: ProfileExtensionConfig, extensionId: string): unknown {
  return extensions.configs[extensionId]
}

function webhookConfigFromExtension(rawConfig: unknown): WebhookConfig | null {
  if (!isRecord(rawConfig)) return null
  return {
    enabled: rawConfig.enabled === true,
    url: typeof rawConfig.url === 'string' ? rawConfig.url : '',
    headers: isRecord(rawConfig.headers)
      ? Object.fromEntries(
        Object.entries(rawConfig.headers).map(([key, value]) => [key, String(value)])
      )
      : {}
  }
}

function summarizeExtensionConfig(extension: ExtensionManifest, rawConfig: unknown): string {
  if (extension.id === EXTENSION_IDS.WEBHOOK_NOTIFIER) {
    const config = webhookConfigFromExtension(rawConfig)
    return config?.enabled && config.url ? `已配置 ${config.url}` : '未配置'
  }
  if (extension.id === EXTENSION_IDS.OSS_BROWSER) {
    return '使用当前 Profile 的阿里云 OSS 配置'
  }
  if (extension.id === EXTENSION_IDS.GENERIC_CONVERTER) {
    const config = normalizeGenericConverterConfig(rawConfig)
    if (!config.enabled) return '未启用'
    const dataRoot = config.dataRoot || '-'
    const outputRoot = config.outputRoot || '-'
    return `输入=${dataRoot}; 输出=${outputRoot}`
  }
  return ''
}

function summarizePipelineConfig(pipelineId: string, rawConfig: unknown): string {
  if (pipelineId === UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD) {
    const stationPrefix =
      isRecord(rawConfig) && typeof rawConfig.stationPrefix === 'string'
        ? rawConfig.stationPrefix
        : 'station2'
    return `stationPrefix=${stationPrefix}`
  }
  return '使用原始源目录和 Profile 路径规则'
}

export class ExtensionRuntimeService {
  listManifests(): ExtensionManifest[] {
    return BUILTIN_EXTENSIONS
  }

  listCapabilities(): {
    uploadPipelines: typeof BUILTIN_UPLOAD_PIPELINES
    extensions: typeof BUILTIN_EXTENSIONS
  } {
    return {
      uploadPipelines: BUILTIN_UPLOAD_PIPELINES,
      extensions: BUILTIN_EXTENSIONS
    }
  }

  notifyTaskEvent(task: Task, event: TaskEventName): void {
    const settings = getSettingsRepo()
    const extensions = normalizedTaskExtensions(task)
    const webhookExtensionEnabled = extensions.enabledIds.includes(
      EXTENSION_IDS.WEBHOOK_NOTIFIER
    )
    const extensionConfig = webhookConfigFromExtension(
      configForExtension(extensions, EXTENSION_IDS.WEBHOOK_NOTIFIER)
    )
    const legacyConfig = settings.get<WebhookConfig>('webhook')
    const config = webhookExtensionEnabled ? extensionConfig : legacyConfig
    if (!config?.enabled || !config.url) return

    const run = getPluginRunRepo().start(task.id, EXTENSION_IDS.WEBHOOK_NOTIFIER, 'notification')
    const createdAt = new Date(task.createdAt).getTime()
    const durationSeconds = Number.isFinite(createdAt)
      ? Math.max(0, Math.round((Date.now() - createdAt) / 1000))
      : 0

    void getWebhookService()
      .notify(config, {
        event,
        taskId: task.id,
        folderName: task.folderName,
        fileCount: task.totalFiles,
        totalBytes: task.totalBytes,
        durationSeconds,
        status: event === 'task_completed' ? 'completed' : 'failed',
        timestamp: new Date().toISOString()
      })
      .then(() => {
        getPluginRunRepo().complete(run.id, {
          summary: {
            event,
            url: config.url
          }
        })
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        getPluginRunRepo().fail(run.id, message)
        log.warn('Webhook 扩展通知失败:', message)
      })
  }

  getProjectCapabilityStatus(profileId?: string | null): ProjectCapabilityStatus {
    const settings = getSettingsRepo().getAll()
    const profile =
      settings.profiles.find((item) => item.id === profileId) ||
      settings.profiles.find((item) => item.id === settings.activeProfileId) ||
      settings.profiles[0]
    const pipeline = normalizeProfileUploadPipeline(
      profile.uploadPipeline,
      profile.plugins
    )
    const extensions = normalizeProfileExtensions(
      profile.extensions,
      profile.plugins
    )
    const enabled = new Set(extensions.enabledIds)
    const recentRuns = getPluginRunRepo().listRecent(100)
    const pipelineManifest =
      BUILTIN_UPLOAD_PIPELINES.find((item) => item.id === pipeline.id) ||
      BUILTIN_UPLOAD_PIPELINES[0]

    return {
      profileId: profile.id,
      profileName: profile.name,
      uploadPipeline: {
        manifest: pipelineManifest,
        configSummary: summarizePipelineConfig(pipeline.id, pipeline.config),
        lastRun: this.findLastRun(recentRuns, pipeline.id)
      },
      extensions: BUILTIN_EXTENSIONS.map((manifest) => ({
        manifest,
        enabled: enabled.has(manifest.id),
        configSummary: summarizeExtensionConfig(manifest, extensions.configs[manifest.id]),
        lastRun: this.findLastRun(recentRuns, manifest.id)
      }))
    }
  }

  getProfileStatus(profileId?: string | null): PluginProfileStatus {
    const status = this.getProjectCapabilityStatus(profileId)
    return {
      profileId: status.profileId,
      profileName: status.profileName,
      plugins: status.extensions
    }
  }

  listTaskRuns(taskId: string): TaskPluginRun[] {
    return getPluginRunRepo().listByTask(taskId)
  }

  private findLastRun(runs: TaskPluginRun[], pluginId: string): TaskPluginRun | null {
    return runs.find((run) => run.pluginId === pluginId) || null
  }
}

let instance: ExtensionRuntimeService | null = null
export function getExtensionRuntimeService(): ExtensionRuntimeService {
  if (!instance) instance = new ExtensionRuntimeService()
  return instance
}
