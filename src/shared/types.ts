// ============================================
// 共享类型定义 — 主进程 & 渲染进程
// ============================================

// ---- 任务相关 ----
export type TaskStatus =
  | 'pending'
  | 'scanning'
  | 'uploading'
  | 'synced'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'skipped'
export type FileStatus = 'pending' | 'uploading' | 'completed' | 'failed' | 'skipped'
export type SourceType = 'local' | 'manual'
export type FileSourceStatus = 'present' | 'missing'
export type UploadGroupProcessingStatus =
  | 'collecting'
  | 'processing'
  | 'blocked'
  | 'completed'
  | 'completed_with_skips'
export type CloudProvider = 'aliyun' | 'tencent'
export type UploadPathMode =
  | 'target-root'
  | 'keep-source'
  | 'last-segments'
  | 'template'
export type PathVariables = Record<string, string>
export type PathMappingMode = 'keep-relative' | 'flatten' | 'template'
export type UploadGroupStatus =
  | 'open'
  | 'closing'
  | 'sealed'
  | 'cleanable'
  | 'cleaned'
  | 'error'

export interface UploadSourceConfig {
  roots: string[]
}

export interface UploadDestinationRef {
  connectionId: string
}

export interface PathMappingConfig {
  mode: PathMappingMode
  template?: string
}

export interface DiscoveryConfig {
  groupPattern?: string
  taskPattern?: string
  groupRegex?: string
  taskRegex?: string
  recursive?: boolean
}

export type CompletionPolicy =
  | { mode: 'manual' }
  | { mode: 'inactivity'; idleMinutes: number }
  | { mode: 'marker-file'; markerFile: string }
  | { mode: 'rollover' }
  | { mode: 'none' }

export interface CleanupPolicy {
  enabled: boolean
  retentionDays: number
  /** @deprecated 自动清理运行时始终强制 sealed/cleanable，保留字段仅用于旧配置兼容。 */
  onlyAfterSealed: boolean
}

export type CloudConnectionType = 'aliyun-oss' | 's3'

export interface AliyunOSSConnectionConfig {
  endpoint: string
  bucket: string
  region: string
  prefix?: string
  accessKeyId: string
  accessKeySecret: string
}

export interface S3ConnectionConfig {
  endpoint: string
  bucket: string
  region: string
  prefix?: string
  accessKeyId: string
  accessKeySecret: string
  forcePathStyle?: boolean
  allowInsecureTls?: boolean
}

export type CloudConnectionConfig = AliyunOSSConnectionConfig | S3ConnectionConfig

export interface CloudConnection {
  id: string
  name: string
  type: CloudConnectionType
  config: CloudConnectionConfig
}

export interface ConnectionTestInput {
  connectionId: string
  type: CloudConnectionType
  config: Partial<AliyunOSSConnectionConfig & S3ConnectionConfig>
}

export interface ConnectionTestResult {
  ok: boolean
  error?: string
}

export interface UploadRuleDryRunInput {
  ruleId?: string
  rule?: UploadRule
  sourceRoots?: string[]
  sourceRoot?: string
  sampleLimit?: number
}

export interface UploadRuleDryRunFilePreview {
  relativePath: string
  size: number
  objectKeys: Array<{
    connectionId: string
    key: string
  }>
}

export interface UploadRuleDryRunTaskPreview {
  taskKey: string
  folderPath: string
  variables: PathVariables
  ignored: boolean
  filesScanned: number
  sampleFiles: UploadRuleDryRunFilePreview[]
}

export interface UploadRuleDryRunGroupPreview {
  groupKey: string
  folderPath: string
  variables: PathVariables
  tasks: UploadRuleDryRunTaskPreview[]
}

export interface UploadRuleDryRunRootPreview {
  sourceRoot: string
  ok: boolean
  totals: {
    groups: number
    tasks: number
    ignoredTasks: number
    filesScanned: number
    sampledFiles: number
  }
  errors: string[]
  warnings: string[]
  groups: UploadRuleDryRunGroupPreview[]
}

export interface UploadRuleDryRunResult {
  ok: boolean
  ruleId: string
  ruleName: string
  totals: {
    roots: number
    groups: number
    tasks: number
    ignoredTasks: number
    filesScanned: number
    sampledFiles: number
  }
  errors: string[]
  warnings: string[]
  roots: UploadRuleDryRunRootPreview[]
}

export interface UploadPathPreview {
  ruleId: string
  ruleName: string
  sourcePath: string
  destinations: Array<{
    connectionId: string
    prefix: string
    variables: PathVariables
    keys: string[]
    errors: string[]
    warnings: string[]
  }>
}

export interface Task {
  id: string
  folderPath: string
  folderName: string
  status: TaskStatus
  totalFiles: number
  uploadedFiles: number
  totalBytes: number
  uploadedBytes: number
  ossPrefix: string
  destinations: TaskDestination[]
  uploadGroupId: string | null
  uploadRelativePath: string
  errorMessage: string | null
  sourceType: SourceType
  sourceMachineId: string | null
  ruleId: string | null
  ruleName: string | null
  ruleSnapshot: UploadRule | null
  groupVariables: PathVariables
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface TaskFile {
  id: string
  taskId: string
  relativePath: string
  fileSize: number
  status: FileStatus
  ossKey: string | null
  uploadId: string | null
  errorMessage: string | null
  mtimeMs: number
  lastSeenAt: string | null
  sourceStatus: FileSourceStatus
  stableCount: number
  retryCount: number
  nextRetryAt: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskFileDetail extends TaskFile {
  destinations: TaskFileDestination[]
}

export interface TaskDetail {
  task: Task
  files: TaskFileDetail[]
}

export interface TaskDestination {
  id: string
  taskId: string
  connectionId: string
  connectionName: string | null
  status: TaskStatus
  prefix: string
  uploadRelativePath: string
  pathMode: UploadPathMode
  objectKeyTemplate: string | null
  totalFiles: number
  uploadedFiles: number
  totalBytes: number
  uploadedBytes: number
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface TaskFileDestination {
  id: string
  taskFileId: string
  taskDestinationId: string
  connectionId: string
  status: FileStatus
  objectKey: string | null
  plannedObjectKey: string | null
  uploadId: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskProgress {
  taskId: string
  connectionId: string
  connectionName?: string | null
  uploadedFiles: number
  totalFiles: number
  uploadedBytes: number
  totalBytes: number
  speed: number // bytes per second
  currentFile: string | null
  queuedFiles: number
  activeUploads: number
  failedFiles: number
  skippedFiles: number
  transferredBytes: number
}

export interface TaskStatusEvent {
  taskId: string
  oldStatus: TaskStatus
  newStatus: TaskStatus
}

export interface TaskDestinationStatusEvent {
  taskId: string
  connectionId: string
  connectionName?: string | null
  status: TaskStatus
  errorMessage?: string
}

export type UploadQueueStartScope = 'selected' | 'all-pending'
export type UploadQueueStopMode = 'after-current' | 'pause-running'

export interface TaskListQuery {
  status?: TaskStatus
  statuses?: TaskStatus[]
}

export interface UploadQueueStartInput {
  scope: UploadQueueStartScope
  taskIds?: string[]
  uploadGroupIds?: string[]
  overrideWindow?: boolean
}

export interface UploadQueueStopInput {
  mode: UploadQueueStopMode
}

export interface UploadQueueStatus {
  gateOpen: boolean
  priorityActive: boolean
  priorityTaskIds: string[]
  priorityRemaining: number
  runningTaskIds: string[]
  overrideWindow: boolean
  withinUploadWindow: boolean
  uploadWindow: {
    startAfterTime: string | null
    endBeforeTime: string | null
  }
}

export interface UploadGroupSummary {
  id: string
  folderPath: string
  folderName: string
  legacyDate: string | null
  status: UploadGroupProcessingStatus
  ruleId: string | null
  groupKey: string
  variables: PathVariables
  uploadGroupStatus: UploadGroupStatus
  discoveredAt: string
  lastContentActivityAt: string
  sealedAt: string | null
  cleanableAt: string | null
  cleanedAt: string | null
  totalChildren: number
  completedChildren: number
  totalFiles: number
  uploadedFiles: number
  totalBytes: number
  uploadedBytes: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
  ignored: boolean
}

export interface UploadGroupListQuery {
  status?: UploadGroupProcessingStatus
  includeCompleted?: boolean
  includeIgnored?: boolean
  limit?: number
  connectionId?: string
}

// ---- 设置 ----
export interface FilterRules {
  whitelist: string[]   // 白名单文件/模式（最高优先级）
  blacklist: string[]   // 黑名单文件/模式
  regex: string[]       // 正则表达式模式
  suffixes: string[]    // 后缀（如 .jpg, .csv）
}

export interface UploadRule {
  id: string
  name: string
  enabled: boolean
  source: UploadSourceConfig
  destinations: UploadDestinationRef[]
  pathMapping: PathMappingConfig
  discovery: DiscoveryConfig
  completion: CompletionPolicy
  cleanup: CleanupPolicy
  filter: FilterRules
}

export interface WebhookConfig {
  url: string
  headers: Record<string, string>
  enabled: boolean
}

export interface ScanConfig {
  intervalSeconds: number
}

export interface UploadConfig {
  maxConcurrentTasks: number
  maxFilesPerTask: number
  maxConcurrentUploads: number // 全局并发上传文件数上限（跨任务）
  multipartThreshold: number // bytes, default 100MB
  startAfterTime: string | null // 每日最早开始上传时间，格式 HH:mm；null 表示不限制
  endBeforeTime: string | null // 每日最晚结束上传时间，格式 HH:mm；null 表示不限制
}

export interface StabilityConfig {
  checkIntervalMs: number
  checkCount: number
}

export interface LogConfig {
  directory: string    // 日志目录，默认 userData/logs
  maxDays: number      // 日志保留天数
}

export interface CleanupConfig {
  enabled: boolean
  retentionDays: number
  onlyAfterSealed: boolean
}

export interface AppSettings {
  schemaVersion: 3
  rules: UploadRule[]
  activeRuleId: string
  connections: CloudConnection[]
  scan: ScanConfig
  upload: UploadConfig
  filter: FilterRules
  webhook: WebhookConfig
  hotkey: string
  stability: StabilityConfig
  log: LogConfig
  cleanup: CleanupConfig
}

// ---- 扫描器 ----
export interface ScannerStatus {
  running: boolean
  lastScanAt: string | null
  nextScanAt: string | null
  watchedDirectories: string[]
  pendingStabilityChecks: Array<{
    path: string
    checks: number
    requiredChecks: number
    discoveredAt: string
  }>
  lastScanResults: {
    scannedDirs: number
    newDirsFound: number
    existingDirs: number
    ignoredDirectories: number
    skippedChildren: number
    timestamp: string
  } | null
}

// ---- 历史记录 ----
export interface HistoryItem {
  id: string
  connectionId: string
  connectionName: string | null
  folderName: string
  fileCount: number
  totalBytes: number
  durationSeconds: number
  status: 'completed' | 'failed'
  completedAt: string
}

export interface HistoryQuery {
  page: number
  pageSize: number
  connectionId?: string
  status?: 'completed' | 'failed'
}

export interface HistoryResult {
  items: HistoryItem[]
  total: number
}

export interface CloudOperationResult {
  provider: CloudProvider
  ok: boolean
  keys?: string[]
  error?: string
}

export interface MultiCloudOperationResult {
  ok: boolean
  results: CloudOperationResult[]
}

// ---- 磁盘用量 ----
export interface DiskUsageInfo {
  path: string
  totalBytes: number
  freeBytes: number
  usedBytes: number
  usagePercent: number
}

// ---- OSS 浏览（只读工具插件） ----
export interface OSSListQuery {
  prefix?: string
  continuationToken?: string
  maxKeys?: number
}

export interface OSSPrefixItem {
  prefix: string
  name: string
}

export interface OSSObjectItem {
  key: string
  name: string
  size: number
  lastModified: string
  contentType?: string
  isImage: boolean
}

export interface OSSListResult {
  effectivePrefix: string
  prefixes: OSSPrefixItem[]
  objects: OSSObjectItem[]
  nextContinuationToken?: string
  isTruncated: boolean
}

export interface OSSObjectHead {
  key: string
  size: number
  lastModified: string
  contentType?: string
  etag?: string
}

export interface OSSImageResult {
  dataUrl: string
  contentType: string
  size: number
}
