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
export type SourceType = 'local' | 'rsync' | 'manual'
export type FileSourceStatus = 'present' | 'missing'
export type DayFolderStatus =
  | 'collecting'
  | 'processing'
  | 'blocked'
  | 'completed'
  | 'completed_with_skips'
export type SSHAuthType = 'key' | 'password'
export type TransferMode = 'rsync' | 'sftp'
export type CloudProvider = 'aliyun' | 'tencent'
export type UploadTargetMode = 'aliyun' | 'tencent' | 'both'
export type UploadPathMode =
  | 'target-root'
  | 'date-workdir'
  | 'keep-source'
  | 'last-segments'
  | 'template'

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
  uploadTargetMode: UploadTargetMode
  destinations: TaskDestination[]
  dayFolderId: string | null
  uploadRelativePath: string
  errorMessage: string | null
  sourceType: SourceType
  sourceMachineId: string | null
  profileId: string | null
  profileName: string | null
  profileSnapshot: UploadProfile | null
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
  provider: CloudProvider
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
  provider: CloudProvider
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
  provider: CloudProvider
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
  provider: CloudProvider
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
  dayFolderIds?: string[]
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

export interface DayFolderSummary {
  id: string
  folderPath: string
  folderName: string
  date: string
  status: DayFolderStatus
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

export interface DayFolderListQuery {
  status?: DayFolderStatus
  includeCompleted?: boolean
  limit?: number
  provider?: CloudProvider
}

// ---- SSH 机器 ----
export interface SSHMachine {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: SSHAuthType
  privateKeyPath: string | null
  remoteDir: string
  localDir: string
  bwLimit: number
  cpuNice: number
  transferMode: TransferMode
  profileId: string | null
  enabled: boolean
  lastSyncAt: string | null
  createdAt: string
}

export interface SSHMachineInput {
  name: string
  host: string
  port: number
  username: string
  authType: SSHAuthType
  privateKeyPath?: string
  password?: string
  remoteDir: string
  localDir: string
  bwLimit: number
  cpuNice: number
  transferMode: TransferMode
  profileId?: string | null
  enabled: boolean
}

export interface RsyncProgress {
  machineId: string
  percent: number
  speed: string
  file: string
}

// ---- 设置 ----
export interface FilterRules {
  whitelist: string[]   // 白名单文件/模式（最高优先级）
  blacklist: string[]   // 黑名单文件/模式
  regex: string[]       // 正则表达式模式
  suffixes: string[]    // 后缀（如 .jpg, .csv）
}

export interface OSSConfig {
  endpoint: string
  bucket: string
  region: string
  prefix: string
  pathMode: UploadPathMode
  pathSegmentCount: number
  accessKeyId: string
  accessKeySecret: string
}

export interface TencentS3Config {
  endpoint: string
  bucket: string
  region: string
  prefix: string
  pathMode: UploadPathMode
  pathSegmentCount: number
  accessKeyId: string
  accessKeySecret: string
  allowInsecureTls: boolean
}

export interface CloudConfig {
  targetMode: UploadTargetMode
}

export interface UploadProfileProviderConfig {
  prefix: string
  pathMode: UploadPathMode
  pathSegmentCount: number
  objectKeyTemplate: string
}

export interface UploadProfileScanConfig {
  providerDirectories: Record<CloudProvider, string[]>
  workDirNamePattern?: string
}

export interface UploadProfile {
  id: string
  name: string
  enabled: boolean
  targetMode: UploadTargetMode
  filter: FilterRules
  scan: UploadProfileScanConfig
  providers: Record<CloudProvider, UploadProfileProviderConfig>
  uploadPipeline?: ProfileUploadPipelineConfig
  extensions?: ProfileExtensionConfig
  plugins?: ProfilePluginConfig
}

export interface WebhookConfig {
  url: string
  headers: Record<string, string>
  enabled: boolean
}

export interface GenericConverterConfig {
  enabled: boolean
  pythonPath: string
  monitorScriptPath: string
  converterScriptPath: string
  dataRoot: string
  outputRoot: string
  deviceCode: string
  stableSeconds: number
  pollIntervalSeconds: number
  retryFailed: boolean
  env: Record<string, string>
  extraArgs: string[]
  outputDirectoryTemplate: string
  outputBatchNameTemplate: string
  outputFileNameTemplate: string
  outputBatchNamePattern: string
}

export type GenericConverterRuntimeState =
  | 'disabled'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'failed'

export interface GenericConverterProfileStatus {
  profileId: string
  profileName: string
  enabled: boolean
  configured: boolean
  state: GenericConverterRuntimeState
  running: boolean
  pid: number | null
  startedAt: string | null
  stoppedAt: string | null
  exitCode: number | null
  lastError: string | null
  dataRoot: string
  outputRoot: string
  monitorScriptPath: string
  recentLogs: string[]
}

export interface GenericConverterStatus {
  profiles: GenericConverterProfileStatus[]
}

export type UploadPipelineId = 'standard-upload' | 'sany-module1-upload'
export type ExtensionId = 'webhook-notifier' | 'oss-browser' | 'generic-converter'
export type PluginCategory = 'pipeline' | 'preUpload' | 'notification' | 'tool'
export type PluginRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface UploadPipelineManifest {
  id: UploadPipelineId
  name: string
  version: string
  category: 'pipeline'
  description: string
}

export interface ExtensionManifest {
  id: ExtensionId
  name: string
  version: string
  category: 'notification' | 'tool'
  description: string
}

export type PluginManifest = ExtensionManifest

export interface ProfileUploadPipelineConfig {
  id: UploadPipelineId
  config: Record<string, unknown>
}

export interface ProfileExtensionConfig {
  enabledIds: string[]
  configs: Record<string, unknown>
}

export interface ProfilePluginConfig {
  enabledPluginIds: string[]
  order: string[]
  configs: Record<string, unknown>
}

export interface PreUploadFilePlan {
  relativePath: string
  fileSize: number
  mtimeMs: number
  plannedObjectKey?: string
}

export interface UploadPipelineResult {
  pipelineId: UploadPipelineId
  uploadRootPath: string
  files: PreUploadFilePlan[]
  requiredStableChecks: number
  summary?: Record<string, unknown>
  artifacts?: Record<string, unknown>
}

export type PreUploadResult = UploadPipelineResult

export interface TaskPluginRun {
  id: string
  taskId: string
  pluginId: string
  category: PluginCategory
  status: PluginRunStatus
  startedAt: string
  completedAt: string | null
  errorMessage: string | null
  summary: Record<string, unknown> | null
  stagingPath: string | null
  artifacts: Record<string, unknown> | null
}

export interface PluginProfileStatusItem {
  manifest: PluginManifest
  enabled: boolean
  configSummary: string
  lastRun: TaskPluginRun | null
}

export interface PluginProfileStatus {
  profileId: string
  profileName: string
  plugins: PluginProfileStatusItem[]
}

export interface ProjectCapabilityStatus {
  profileId: string
  profileName: string
  uploadPipeline: {
    manifest: UploadPipelineManifest
    configSummary: string
    lastRun: TaskPluginRun | null
  }
  extensions: PluginProfileStatusItem[]
}

export interface ScanConfig {
  directories: string[]
  providerDirectories: Record<CloudProvider, string[]>
  intervalSeconds: number
  workDirNamePattern?: string
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

export interface DataCollectConfig {
  enabled: boolean
}

export interface CleanupConfig {
  enabled: boolean
  retentionDays: number
}

export interface AppSettings {
  scan: ScanConfig
  upload: UploadConfig
  cloud: CloudConfig
  oss: OSSConfig
  tencentS3: TencentS3Config
  profiles: UploadProfile[]
  activeProfileId: string
  filter: FilterRules
  webhook: WebhookConfig
  hotkey: string
  stability: StabilityConfig
  log: LogConfig
  dataCollect: DataCollectConfig
  cleanup: CleanupConfig
}

// ---- 扫描器 ----
export interface ScannerStatus {
  running: boolean
  lastScanAt: string | null
  nextScanAt: string | null
  watchedDirectories: string[]
  watchedDirectoriesByProvider: Record<CloudProvider, string[]>
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

// ---- 数采模式 ----
export interface DataCollectInfo {
  folderPath: string
  folderName: string
  date: string | null
  sessionTime: string | null
  weldSignal: {
    arcStartUs: number | null
    arcEndUs: number | null
    arcStartTime: string | null
    arcEndTime: string | null
    durationSeconds: number | null
  }
  cameras: Array<{
    name: string
    imageCount: number
    tsMinUs: number | null
    tsMaxUs: number | null
    tsMinTime: string | null
    tsMaxTime: string | null
  }>
  robotState: { jointStateRows: number; toolPoseRows: number; hasCalibration: boolean }
  controlCmd: { speedRows: number; freqRows: number }
  pointCloudCount: number
  depthImageCount: number
  annotation: {
    hasXml: boolean
    dataType: string | null
    qualityType: string | null
    specMin: number | null
    specMax: number | null
  }
  totalFileCount: number
  totalSizeBytes: number
  collectedAt: string
}

export interface SftpProgress {
  machineId: string
  totalFiles: number
  uploadedFiles: number
  currentFile: string
  speed: string
}

// ---- 历史记录 ----
export interface HistoryItem {
  id: string
  provider: CloudProvider
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
  provider?: CloudProvider
  status?: 'completed' | 'failed'
}

export interface HistoryResult {
  items: HistoryItem[]
  total: number
}

// ---- 标记文件 ----
export interface TmpUploadMarker {
  version: number
  createdAt: string
  folderPath: string
  metadata: {
    source: SourceType
    machineId?: string
    dayFolderId?: string
    date?: string
    uploadRelativePath?: string
    uploadTargetMode?: UploadTargetMode
    profileId?: string
    profileName?: string
    profileSnapshot?: UploadProfile
    destinationPrefixes?: Partial<Record<CloudProvider, string>>
    destinationUploadRelativePaths?: Partial<Record<CloudProvider, string>>
    destinationPathModes?: Partial<Record<CloudProvider, UploadPathMode>>
    destinationObjectKeyTemplates?: Partial<Record<CloudProvider, string | null>>
  }
}

export interface ProcessTaskDestinationMarker {
  status: TaskStatus
  uploadRelativePath?: string
  pathMode?: UploadPathMode
  objectKeyTemplate?: string | null
  totalFiles: number
  uploadedFiles: number
  files?: Record<string, FileStatus>
  failedFiles?: number
  skippedFiles?: number
  error: string | null
}

export interface ProcessTaskMarker {
  version: number
  taskId: string
  status: TaskStatus
  totalFiles: number
  uploadedFiles: number
  files?: Record<string, FileStatus>
  failedFiles?: number
  skippedFiles?: number
  lastUpdated: string
  error: string | null
  uploadTargetMode?: UploadTargetMode
  destinations?: Partial<Record<CloudProvider, ProcessTaskDestinationMarker>>
}

export interface DayUploadMarker {
  version: number
  dayFolderId: string
  date: string
  folderPath: string
  status: 'completed' | 'completed_with_skips'
  totalChildren: number
  totalFiles: number
  uploadedFiles: number
  totalBytes: number
  uploadedBytes: number
  children: Array<{
    folderName: string
    folderPath: string
    taskId: string
    completedAt: string | null
    destinations?: Array<{
      provider: CloudProvider
      status: TaskStatus
      completedAt: string | null
    }>
  }>
  completedAt: string
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
