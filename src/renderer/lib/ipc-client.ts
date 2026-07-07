import { IPC } from '@shared/ipc-channels'
import type {
  Task, TaskStatus, AppSettings, HistoryQuery, HistoryResult,
  SSHMachine, SSHMachineInput, ScannerStatus, DataCollectInfo, DiskUsageInfo,
  DayFolderSummary, DayFolderListQuery, CloudProvider, MultiCloudOperationResult,
  TaskDetail, TaskListQuery, UploadQueueStartInput, UploadQueueStatus,
  UploadQueueStopInput, PluginManifest, PluginProfileStatus, ProjectCapabilityStatus, TaskPluginRun,
  UploadPipelineManifest,
  OSSListQuery, OSSListResult, OSSObjectHead, OSSImageResult,
  GenericConverterStatus
} from '@shared/types'
import type { UploadPathPreview } from '@shared/upload-profile'

const api = window.api

// ---- 任务 ----
export async function fetchTasks(query?: TaskStatus | TaskListQuery): Promise<Task[]> {
  const args =
    typeof query === 'string'
      ? { status: query }
      : query
  return (await api.invoke(IPC.TASK_LIST, args)) as Task[]
}

export async function fetchTask(taskId: string): Promise<Task> {
  return (await api.invoke(IPC.TASK_GET, { taskId })) as Task
}

export async function fetchTaskDetail(taskId: string): Promise<TaskDetail> {
  return (await api.invoke(IPC.TASK_DETAIL, { taskId })) as TaskDetail
}

export async function addFolder(folderPath: string, profileId?: string): Promise<Task> {
  return (await api.invoke(IPC.TASK_ADD_FOLDER, { folderPath, profileId })) as Task
}

export async function pauseTask(taskId: string): Promise<void> {
  await api.invoke(IPC.TASK_PAUSE, { taskId })
}

export async function resumeTask(taskId: string): Promise<void> {
  await api.invoke(IPC.TASK_RESUME, { taskId })
}

export async function cancelTask(taskId: string): Promise<void> {
  await api.invoke(IPC.TASK_CANCEL, { taskId })
}

export async function skipTask(taskId: string): Promise<void> {
  await api.invoke(IPC.TASK_SKIP, { taskId })
}

export async function restoreTask(taskId: string): Promise<void> {
  await api.invoke(IPC.TASK_RESTORE, { taskId })
}

export async function retryTask(taskId: string, provider?: CloudProvider): Promise<void> {
  await api.invoke(IPC.TASK_RETRY, { taskId, provider })
}

// ---- 上传队列 ----
export async function fetchUploadQueueStatus(): Promise<UploadQueueStatus> {
  return (await api.invoke(IPC.UPLOAD_QUEUE_STATUS)) as UploadQueueStatus
}

export async function startUploadQueue(input: UploadQueueStartInput): Promise<UploadQueueStatus> {
  return (await api.invoke(IPC.UPLOAD_QUEUE_START, input)) as UploadQueueStatus
}

export async function stopUploadQueue(input: UploadQueueStopInput): Promise<UploadQueueStatus> {
  return (await api.invoke(IPC.UPLOAD_QUEUE_STOP, input)) as UploadQueueStatus
}

// ---- 日期目录汇总 ----
export async function fetchDayFolders(query?: DayFolderListQuery): Promise<DayFolderSummary[]> {
  return (await api.invoke(IPC.DAY_FOLDER_LIST, query)) as DayFolderSummary[]
}

export async function deleteDayFolderHistory(id: string, provider?: CloudProvider): Promise<void> {
  await api.invoke(IPC.DAY_FOLDER_DELETE, { id, provider })
}

export async function ignoreDayFolder(id: string): Promise<DayFolderSummary> {
  return (await api.invoke(IPC.DAY_FOLDER_IGNORE, { id })) as DayFolderSummary
}

export async function restoreDayFolder(id: string): Promise<DayFolderSummary> {
  return (await api.invoke(IPC.DAY_FOLDER_RESTORE, { id })) as DayFolderSummary
}

// ---- 扫描器 ----
export async function getScannerStatus(): Promise<ScannerStatus> {
  return (await api.invoke(IPC.SCANNER_STATUS)) as ScannerStatus
}

export async function triggerScan(): Promise<void> {
  await api.invoke(IPC.SCANNER_TRIGGER)
}

export async function startScanner(): Promise<void> {
  await api.invoke(IPC.SCANNER_START)
}

export async function stopScanner(): Promise<void> {
  await api.invoke(IPC.SCANNER_STOP)
}

// ---- 设置 ----
export async function fetchSettings(): Promise<AppSettings> {
  return (await api.invoke(IPC.SETTINGS_GET_ALL)) as AppSettings
}

export async function saveSettings(data: Partial<AppSettings>): Promise<void> {
  await api.invoke(IPC.SETTINGS_SAVE, data)
}

export async function testOSS(config: AppSettings['oss']): Promise<{ ok: boolean; error?: string }> {
  return (await api.invoke(IPC.SETTINGS_TEST_OSS, config)) as { ok: boolean; error?: string }
}

export async function testTencentS3(config: AppSettings['tencentS3']): Promise<{ ok: boolean; error?: string }> {
  return (await api.invoke(IPC.SETTINGS_TEST_TENCENT_S3, config)) as { ok: boolean; error?: string }
}

export async function previewUploadPath(input: {
  profileId?: string
  sourcePath: string
  provider?: CloudProvider
  sampleFiles?: string[]
}): Promise<UploadPathPreview> {
  return (await api.invoke(IPC.UPLOAD_PATH_PREVIEW, input)) as UploadPathPreview
}

// ---- 项目插件 ----
export async function fetchCapabilities(): Promise<{
  uploadPipelines: UploadPipelineManifest[]
  extensions: PluginManifest[]
}> {
  return (await api.invoke(IPC.CAPABILITY_LIST)) as {
    uploadPipelines: UploadPipelineManifest[]
    extensions: PluginManifest[]
  }
}

export async function fetchProjectCapabilityStatus(profileId?: string): Promise<ProjectCapabilityStatus> {
  return (await api.invoke(IPC.CAPABILITY_PROFILE_STATUS, { profileId })) as ProjectCapabilityStatus
}

export async function fetchCapabilityRuns(taskId: string): Promise<TaskPluginRun[]> {
  return (await api.invoke(IPC.CAPABILITY_TASK_RUNS, { taskId })) as TaskPluginRun[]
}

export async function fetchPlugins(): Promise<PluginManifest[]> {
  return (await api.invoke(IPC.PLUGIN_LIST)) as PluginManifest[]
}

export async function fetchPluginProfileStatus(profileId?: string): Promise<PluginProfileStatus> {
  return (await api.invoke(IPC.PLUGIN_PROFILE_STATUS, { profileId })) as PluginProfileStatus
}

export async function fetchTaskPluginRuns(taskId: string): Promise<TaskPluginRun[]> {
  return (await api.invoke(IPC.PLUGIN_TASK_RUNS, { taskId })) as TaskPluginRun[]
}

// ---- OSS 浏览（只读工具插件） ----
export async function listOSSObjects(query: OSSListQuery): Promise<OSSListResult> {
  return (await api.invoke(IPC.OSS_BROWSER_LIST, query)) as OSSListResult
}

export async function headOSSObject(key: string): Promise<OSSObjectHead> {
  return (await api.invoke(IPC.OSS_BROWSER_HEAD, { key })) as OSSObjectHead
}

export async function getOSSImagePreview(key: string, maxBytes?: number): Promise<OSSImageResult> {
  return (await api.invoke(IPC.OSS_BROWSER_GET_IMAGE, { key, maxBytes })) as OSSImageResult
}

export async function openOSSPreviewWindow(key: string): Promise<void> {
  await api.invoke(IPC.OSS_BROWSER_OPEN_PREVIEW_WINDOW, { key })
}

// ---- 通用转换工具 ----
export async function fetchGenericConverterStatus(): Promise<GenericConverterStatus> {
  return (await api.invoke(IPC.GENERIC_CONVERTER_STATUS)) as GenericConverterStatus
}

export async function startGenericConverter(profileId: string): Promise<GenericConverterStatus> {
  return (await api.invoke(IPC.GENERIC_CONVERTER_START, { profileId })) as GenericConverterStatus
}

export async function stopGenericConverter(profileId: string): Promise<GenericConverterStatus> {
  return (await api.invoke(IPC.GENERIC_CONVERTER_STOP, { profileId })) as GenericConverterStatus
}

export async function scanGenericConverterNow(profileId: string): Promise<GenericConverterStatus> {
  return (await api.invoke(IPC.GENERIC_CONVERTER_SCAN_NOW, { profileId })) as GenericConverterStatus
}

// ---- SSH ----
export async function fetchSSHMachines(): Promise<SSHMachine[]> {
  return (await api.invoke(IPC.SSH_LIST_MACHINES)) as SSHMachine[]
}

export async function addSSHMachine(input: SSHMachineInput): Promise<SSHMachine> {
  return (await api.invoke(IPC.SSH_ADD_MACHINE, input)) as SSHMachine
}

export async function updateSSHMachine(machine: SSHMachine): Promise<void> {
  await api.invoke(IPC.SSH_UPDATE_MACHINE, machine)
}

export async function deleteSSHMachine(id: string): Promise<void> {
  await api.invoke(IPC.SSH_DELETE_MACHINE, { id })
}

export async function testSSHConnection(id: string): Promise<{ ok: boolean; error?: string }> {
  return (await api.invoke(IPC.SSH_TEST_CONNECTION, { id })) as { ok: boolean; error?: string }
}

export async function startRsync(machineId: string): Promise<void> {
  await api.invoke(IPC.RSYNC_START, { machineId })
}

export async function stopRsync(machineId: string): Promise<void> {
  await api.invoke(IPC.RSYNC_STOP, { machineId })
}

export async function startSftp(machineId: string): Promise<MultiCloudOperationResult> {
  return (await api.invoke(IPC.SFTP_START, { machineId })) as MultiCloudOperationResult
}

export async function stopSftp(machineId: string): Promise<void> {
  await api.invoke(IPC.SFTP_STOP, { machineId })
}

// ---- 数采模式 ----
export async function fetchDataCollectList(): Promise<DataCollectInfo[]> {
  return (await api.invoke(IPC.DATA_COLLECT_LIST)) as DataCollectInfo[]
}

export async function runDataCollect(folderPath: string): Promise<DataCollectInfo | null> {
  return (await api.invoke(IPC.DATA_COLLECT_RUN, { folderPath })) as DataCollectInfo | null
}

// ---- 历史 ----
export async function fetchHistory(query: HistoryQuery): Promise<HistoryResult> {
  return (await api.invoke(IPC.HISTORY_LIST, query)) as HistoryResult
}

export async function clearHistory(before?: string, provider?: CloudProvider): Promise<void> {
  await api.invoke(IPC.HISTORY_CLEAR, before || provider ? { before, provider } : undefined)
}

export async function deleteHistoryItem(id: string, provider?: CloudProvider): Promise<void> {
  await api.invoke(IPC.HISTORY_DELETE, { id, provider })
}

// ---- 对话框 ----
export async function selectFolder(): Promise<string | null> {
  return (await api.invoke(IPC.DIALOG_SELECT_FOLDER)) as string | null
}

// ---- 磁盘用量 ----
export async function fetchDiskUsage(): Promise<DiskUsageInfo[]> {
  return (await api.invoke(IPC.DISK_USAGE)) as DiskUsageInfo[]
}
