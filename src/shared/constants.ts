// ============================================
// 共享常量
// ============================================

export const APP_NAME = '云桥上传器'
export const DEFAULT_WORK_DIR_NAME_PATTERN = '^\\d{2}-\\d{2}-\\d{2}$'
export const DEFAULT_UPLOAD_RULE_ID = 'default'
export const DEFAULT_ALIYUN_CONNECTION_ID = 'aliyun-prod'
export const DEFAULT_S3_CONNECTION_ID = 's3-compatible'

export const DEFAULT_SETTINGS = {
  schemaVersion: 3 as const,
  rules: [
    {
      id: DEFAULT_UPLOAD_RULE_ID,
      name: '默认归档',
      enabled: true,
      source: {
        roots: []
      },
      destinations: [
        {
          connectionId: DEFAULT_ALIYUN_CONNECTION_ID
        }
      ],
      pathMapping: {
        mode: 'keep-relative' as const
      },
      discovery: {
        groupPattern: '{date:yyyy-MM-dd}',
        taskPattern: '{session:HH-mm-ss}',
        recursive: false
      },
      completion: {
        mode: 'rollover' as const
      },
      cleanup: {
        enabled: false,
        retentionDays: 7,
        onlyAfterSealed: true
      },
      filter: {
        whitelist: [],
        blacklist: [],
        regex: [],
        suffixes: []
      }
    }
  ],
  activeRuleId: DEFAULT_UPLOAD_RULE_ID,
  connections: [
    {
      id: DEFAULT_ALIYUN_CONNECTION_ID,
      name: '阿里云 OSS',
      type: 'aliyun-oss' as const,
      config: {
        endpoint: '',
        bucket: '',
        region: '',
        prefix: '',
        accessKeyId: '',
        accessKeySecret: ''
      }
    },
    {
      id: DEFAULT_S3_CONNECTION_ID,
      name: 'S3 兼容存储',
      type: 's3' as const,
      config: {
        endpoint: '',
        bucket: '',
        region: '',
        prefix: '',
        accessKeyId: '',
        accessKeySecret: '',
        forcePathStyle: true,
        allowInsecureTls: false
      }
    }
  ],
  scan: {
    intervalSeconds: 30
  },
  upload: {
    maxConcurrentTasks: 4,
    maxFilesPerTask: 12,
    maxConcurrentUploads: 12,
    multipartThreshold: 100 * 1024 * 1024, // 100MB
    startAfterTime: '20:30',
    endBeforeTime: '23:59'
  },
  filter: {
    whitelist: [],
    blacklist: [],
    regex: [],
    suffixes: []
  },
  webhook: {
    url: '',
    headers: {},
    enabled: false
  },
  hotkey: 'CommandOrControl+Shift+U',
  stability: {
    checkIntervalMs: 5000,
    checkCount: 2
  },
  log: {
    directory: '',  // 空字符串表示使用默认 userData/logs
    maxDays: 30
  },
  cleanup: {
    enabled: false,
    retentionDays: 7,
    onlyAfterSealed: true
  }
}

export const TASK_STATUS_LABELS: Record<string, string> = {
  pending: '等待中',
  scanning: '扫描中',
  uploading: '上传中',
  synced: '已同步',
  retrying: '自动重试中',
  completed: '已完成',
  failed: '失败',
  paused: '已暂停',
  skipped: '已跳过'
}

export const DAY_FOLDER_STATUS_LABELS: Record<string, string> = {
  collecting: '采集中',
  processing: '处理中',
  blocked: '有阻塞',
  completed: '已完成',
  completed_with_skips: '已完成（含跳过）'
}

export const CLOUD_PROVIDER_LABELS = {
  aliyun: '阿里云',
  tencent: '腾讯云'
} as const

export const CLOUD_CONNECTION_TYPE_LABELS = {
  'aliyun-oss': '阿里云 OSS',
  s3: 'S3 兼容存储'
} as const
