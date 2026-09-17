import { IPC } from '@shared/ipc-channels'
import type {
  AppSettings,
  CloudProvider,
  ConnectionTestInput,
  ConnectionTestResult,
  DayFolderListQuery,
  DayFolderSummary,
  DiskUsageInfo,
  HistoryQuery,
  HistoryResult,
  OSSImageResult,
  OSSListQuery,
  OSSListResult,
  OSSObjectHead,
  Task,
  TaskDetail,
  TaskListQuery,
  TaskStatus,
  UploadPathPreview,
  UploadQueueStartInput,
  UploadQueueStatus,
  UploadQueueStopInput,
  ScannerStatus,
  UploadRuleDryRunInput,
  UploadRuleDryRunResult
} from '@shared/types'

const api = window.api

export async function fetchTasks(query?: TaskStatus | TaskListQuery): Promise<Task[]> {
  const args = typeof query === 'string' ? { status: query } : query
  return (await api.invoke(IPC.TASK_LIST, args)) as Task[]
}

export async function fetchTask(taskId: string): Promise<Task> {
  return (await api.invoke(IPC.TASK_GET, { taskId })) as Task
}

export async function fetchTaskDetail(taskId: string): Promise<TaskDetail> {
  return (await api.invoke(IPC.TASK_DETAIL, { taskId })) as TaskDetail
}

export async function addFolder(folderPath: string, ruleId?: string): Promise<Task> {
  return (await api.invoke(IPC.TASK_ADD_FOLDER, { folderPath, ruleId })) as Task
}

export async function pauseTask(taskId: string): Promise<void> {
  await api.invoke(IPC.TASK_PAUSE, { taskId })
}

export async function resumeTask(taskId: string): Promise<void> {
  await api.invoke(IPC.TASK_RESUME, { taskId })
}

export async function skipTask(taskId: string): Promise<void> {
  await api.invoke(IPC.TASK_SKIP, { taskId })
}

export async function restoreTask(taskId: string): Promise<void> {
  await api.invoke(IPC.TASK_RESTORE, { taskId })
}

export async function retryTask(taskId: string, connectionId?: string): Promise<void> {
  await api.invoke(IPC.TASK_RETRY, { taskId, connectionId })
}

export async function fetchUploadQueueStatus(): Promise<UploadQueueStatus> {
  return (await api.invoke(IPC.UPLOAD_QUEUE_STATUS)) as UploadQueueStatus
}

export async function startUploadQueue(input: UploadQueueStartInput): Promise<UploadQueueStatus> {
  return (await api.invoke(IPC.UPLOAD_QUEUE_START, input)) as UploadQueueStatus
}

export async function stopUploadQueue(input: UploadQueueStopInput): Promise<UploadQueueStatus> {
  return (await api.invoke(IPC.UPLOAD_QUEUE_STOP, input)) as UploadQueueStatus
}

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

export async function closeUploadGroup(id: string): Promise<DayFolderSummary> {
  return (await api.invoke(IPC.UPLOAD_GROUP_CLOSE, { id })) as DayFolderSummary
}

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

export async function fetchSettings(): Promise<AppSettings> {
  return (await api.invoke(IPC.SETTINGS_GET_ALL)) as AppSettings
}

export async function saveSettings(data: Partial<AppSettings>): Promise<void> {
  await api.invoke(IPC.SETTINGS_SAVE, data)
}

export async function testOSS(config: AppSettings['connections'][number]['config']): Promise<{ ok: boolean; error?: string }> {
  return (await api.invoke(IPC.SETTINGS_TEST_OSS, config)) as { ok: boolean; error?: string }
}

export async function testTencentS3(config: AppSettings['connections'][number]['config']): Promise<{ ok: boolean; error?: string }> {
  return (await api.invoke(IPC.SETTINGS_TEST_TENCENT_S3, config)) as { ok: boolean; error?: string }
}

export async function testConnection(input: ConnectionTestInput): Promise<ConnectionTestResult> {
  return (await api.invoke(IPC.CONNECTION_TEST, input)) as ConnectionTestResult
}

export async function dryRunUploadRule(input: UploadRuleDryRunInput): Promise<UploadRuleDryRunResult> {
  return (await api.invoke(IPC.UPLOAD_RULE_DRY_RUN, input)) as UploadRuleDryRunResult
}

export async function previewUploadPath(input: {
  ruleId?: string
  sourcePath: string
  sampleFiles?: string[]
}): Promise<UploadPathPreview> {
  return (await api.invoke(IPC.UPLOAD_PATH_PREVIEW, input)) as UploadPathPreview
}

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

export async function fetchHistory(query: HistoryQuery): Promise<HistoryResult> {
  return (await api.invoke(IPC.HISTORY_LIST, query)) as HistoryResult
}

export async function clearHistory(before?: string, provider?: CloudProvider): Promise<void> {
  await api.invoke(IPC.HISTORY_CLEAR, before || provider ? { before, provider } : undefined)
}

export async function deleteHistoryItem(id: string, provider?: CloudProvider): Promise<void> {
  await api.invoke(IPC.HISTORY_DELETE, { id, provider })
}

export async function selectFolder(): Promise<string | null> {
  return (await api.invoke(IPC.DIALOG_SELECT_FOLDER)) as string | null
}

export async function fetchDiskUsage(): Promise<DiskUsageInfo[]> {
  return (await api.invoke(IPC.DISK_USAGE)) as DiskUsageInfo[]
}
