import type {
  ExtensionManifest,
  ProfileExtensionConfig,
  ProfilePluginConfig,
  ProfileUploadPipelineConfig,
  UploadPipelineManifest
} from './types'
import { DEFAULT_GENERIC_CONVERTER_CONFIG } from './generic-converter'

export const UPLOAD_PIPELINE_IDS = {
  STANDARD_UPLOAD: 'standard-upload',
  SANY_MODULE1_UPLOAD: 'sany-module1-upload'
} as const

export const EXTENSION_IDS = {
  WEBHOOK_NOTIFIER: 'webhook-notifier',
  OSS_BROWSER: 'oss-browser',
  GENERIC_CONVERTER: 'generic-converter'
} as const

export const PLUGIN_IDS = {
  MODULE1_PREUPLOAD: 'module1-preupload',
  WEBHOOK_NOTIFIER: EXTENSION_IDS.WEBHOOK_NOTIFIER,
  OSS_BROWSER: EXTENSION_IDS.OSS_BROWSER,
  GENERIC_CONVERTER: EXTENSION_IDS.GENERIC_CONVERTER
} as const

export const BUILTIN_UPLOAD_PIPELINES: UploadPipelineManifest[] = [
  {
    id: UPLOAD_PIPELINE_IDS.STANDARD_UPLOAD,
    name: '通用上传',
    version: '1.0.0',
    category: 'pipeline',
    description: '扫描原始源目录，并使用当前 Profile 的路径规则生成对象 Key。'
  },
  {
    id: UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD,
    name: 'SANY Module1 数据采集上传',
    version: '1.0.0',
    category: 'pipeline',
    description: '复制到 staging 后按 SANY Module1 规则清理、分类、生成 manifest 和对象 Key。'
  }
]

export const BUILTIN_EXTENSIONS: ExtensionManifest[] = [
  {
    id: EXTENSION_IDS.WEBHOOK_NOTIFIER,
    name: 'Webhook 通知',
    version: '1.0.0',
    category: 'notification',
    description: '任务完成或失败后向配置的 HTTP Webhook 发送通知。'
  },
  {
    id: EXTENSION_IDS.OSS_BROWSER,
    name: 'OSS 浏览器',
    version: '1.0.0',
    category: 'tool',
    description: '使用当前 Profile 的阿里云 OSS 配置只读浏览对象并预览图片。'
  },
  {
    id: EXTENSION_IDS.GENERIC_CONVERTER,
    name: '通用转换工具',
    version: '1.0.0',
    category: 'tool',
    description: '按 Profile 启动外部监控转换脚本，转换产物继续由现有上传配置处理。'
  }
]

export const BUILTIN_PLUGINS = BUILTIN_EXTENSIONS

export const DEFAULT_PROFILE_UPLOAD_PIPELINE: ProfileUploadPipelineConfig = {
  id: UPLOAD_PIPELINE_IDS.STANDARD_UPLOAD,
  config: {}
}

export const DEFAULT_PROFILE_EXTENSIONS: ProfileExtensionConfig = {
  enabledIds: [],
  configs: {
    [EXTENSION_IDS.WEBHOOK_NOTIFIER]: {
      url: '',
      headers: {},
      enabled: false
    },
    [EXTENSION_IDS.OSS_BROWSER]: {
      enabled: false
    },
    [EXTENSION_IDS.GENERIC_CONVERTER]: {
      ...DEFAULT_GENERIC_CONVERTER_CONFIG
    }
  }
}

export const DEFAULT_PROFILE_PLUGINS: ProfilePluginConfig = {
  enabledPluginIds: [],
  order: [
    PLUGIN_IDS.MODULE1_PREUPLOAD,
    PLUGIN_IDS.WEBHOOK_NOTIFIER,
    PLUGIN_IDS.OSS_BROWSER,
    PLUGIN_IDS.GENERIC_CONVERTER
  ],
  configs: {
    [PLUGIN_IDS.MODULE1_PREUPLOAD]: {
      stationPrefix: 'station2'
    },
    [PLUGIN_IDS.WEBHOOK_NOTIFIER]: {
      url: '',
      headers: {},
      enabled: false
    },
    [PLUGIN_IDS.OSS_BROWSER]: {
      enabled: false
    },
    [PLUGIN_IDS.GENERIC_CONVERTER]: {
      ...DEFAULT_GENERIC_CONVERTER_CONFIG
    }
  }
}

const BUILTIN_UPLOAD_PIPELINE_ID_SET = new Set<string>(BUILTIN_UPLOAD_PIPELINES.map((pipeline) => pipeline.id))
const BUILTIN_EXTENSION_ID_SET = new Set<string>(BUILTIN_EXTENSIONS.map((extension) => extension.id))
const LEGACY_PLUGIN_ID_SET = new Set<string>([
  PLUGIN_IDS.MODULE1_PREUPLOAD,
  ...BUILTIN_EXTENSIONS.map((extension) => extension.id)
])

export function isBuiltinUploadPipelineId(id: string): boolean {
  return BUILTIN_UPLOAD_PIPELINE_ID_SET.has(id)
}

export function isBuiltinExtensionId(id: string): boolean {
  return BUILTIN_EXTENSION_ID_SET.has(id)
}

export function isBuiltinPluginId(id: string): boolean {
  return LEGACY_PLUGIN_ID_SET.has(id)
}
