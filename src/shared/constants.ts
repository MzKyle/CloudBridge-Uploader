// ============================================
// 共享常量
// ============================================

export const APP_NAME = '云桥上传器'
export const DEFAULT_WORK_DIR_NAME_PATTERN = '^\\d{2}-\\d{2}-\\d{2}$'
export const DEFAULT_UPLOAD_PROFILE_ID = 'default'

export const DEFAULT_SETTINGS = {
  scan: {
    directories: [],
    providerDirectories: {
      aliyun: [],
      tencent: []
    },
    intervalSeconds: 30,
    workDirNamePattern: DEFAULT_WORK_DIR_NAME_PATTERN
  },
  upload: {
    maxConcurrentTasks: 4,
    maxFilesPerTask: 12,
    maxConcurrentUploads: 12,
    multipartThreshold: 100 * 1024 * 1024, // 100MB
    startAfterTime: '20:30',
    endBeforeTime: '23:59'
  },
  cloud: {
    targetMode: 'aliyun' as const
  },
  oss: {
    endpoint: '',
    bucket: '',
    region: '',
    prefix: '',
    pathMode: 'target-root' as const,
    pathSegmentCount: 2,
    accessKeyId: '',
    accessKeySecret: ''
  },
  tencentS3: {
    endpoint: '',
    bucket: '',
    region: '',
    prefix: '',
    pathMode: 'target-root' as const,
    pathSegmentCount: 2,
    accessKeyId: '',
    accessKeySecret: '',
    allowInsecureTls: false
  },
  profiles: [
    {
      id: DEFAULT_UPLOAD_PROFILE_ID,
      name: '默认归档',
      enabled: true,
      source: {
        roots: []
      },
      destinations: [
        {
          connectionId: 'aliyun',
          required: true
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
      targetMode: 'aliyun' as const,
      filter: {
        whitelist: [],
        blacklist: [],
        regex: [],
        suffixes: []
      },
      scan: {
        providerDirectories: {
          aliyun: [],
          tencent: []
        },
        workDirNamePattern: DEFAULT_WORK_DIR_NAME_PATTERN
      },
      providers: {
        aliyun: {
          prefix: '',
          pathMode: 'target-root' as const,
          pathSegmentCount: 2,
          objectKeyTemplate: '{relativePath}'
        },
        tencent: {
          prefix: '',
          pathMode: 'target-root' as const,
          pathSegmentCount: 2,
          objectKeyTemplate: '{relativePath}'
        }
      },
    }
  ],
  activeProfileId: DEFAULT_UPLOAD_PROFILE_ID,
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
