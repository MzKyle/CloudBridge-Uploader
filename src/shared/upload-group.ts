import type {
  CompletionPolicy,
  DayFolderStatus,
  TaskStatus,
  UploadGroupStatus
} from './types'

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
  'completed',
  'synced',
  'skipped'
])

const PROBLEM_TASK_STATUSES = new Set<TaskStatus>([
  'failed',
  'paused'
])

const ALLOWED_UPLOAD_GROUP_TRANSITIONS: Record<UploadGroupStatus, UploadGroupStatus[]> = {
  open: ['open', 'closing', 'sealed', 'error'],
  closing: ['closing', 'sealed', 'error', 'open'],
  sealed: ['sealed', 'cleanable', 'error'],
  cleanable: ['cleanable', 'cleaned', 'sealed', 'error'],
  cleaned: ['cleaned'],
  error: ['error', 'open', 'closing']
}

export function assertUploadGroupTransition(
  current: UploadGroupStatus,
  next: UploadGroupStatus
): void {
  if (!ALLOWED_UPLOAD_GROUP_TRANSITIONS[current]?.includes(next)) {
    throw new Error(`非法 UploadGroup 状态跳转: ${current} -> ${next}`)
  }
}

export function canUploadGroupTransition(
  current: UploadGroupStatus,
  next: UploadGroupStatus
): boolean {
  return ALLOWED_UPLOAD_GROUP_TRANSITIONS[current]?.includes(next) ?? false
}

export function deriveUploadGroupStatus(input: {
  currentStatus: UploadGroupStatus
  completion: CompletionPolicy
  taskStatuses: Array<TaskStatus | null>
  hasNewerGroup?: boolean
  lastActivityAt?: string | null
  now?: Date
}): UploadGroupStatus {
  if (input.currentStatus === 'cleaned') return 'cleaned'
  if (input.taskStatuses.some((status) => status && PROBLEM_TASK_STATUSES.has(status))) {
    return 'error'
  }
  if (input.currentStatus === 'sealed' || input.currentStatus === 'cleanable') {
    return input.currentStatus
  }

  const hasTasks = input.taskStatuses.length > 0
  const allTerminal =
    hasTasks &&
    input.taskStatuses.every((status) => status !== null && TERMINAL_TASK_STATUSES.has(status))

  if (input.completion.mode === 'none') {
    return allTerminal ? 'sealed' : 'open'
  }

  if (input.completion.mode === 'manual') {
    if (input.currentStatus === 'closing' && allTerminal) return 'sealed'
    return input.currentStatus === 'error' ? 'open' : input.currentStatus
  }

  if (input.completion.mode === 'marker-file') {
    if (input.currentStatus === 'closing' && allTerminal) return 'sealed'
    return input.currentStatus === 'error' ? 'open' : input.currentStatus
  }

  if (input.completion.mode === 'rollover') {
    if (input.hasNewerGroup || input.currentStatus === 'closing') {
      return allTerminal ? 'sealed' : 'closing'
    }
    return input.currentStatus === 'error' ? 'open' : 'open'
  }

  if (!allTerminal) return input.currentStatus === 'closing' ? 'closing' : 'open'

  const lastActivityMs = input.lastActivityAt
    ? Date.parse(input.lastActivityAt)
    : Number.NaN
  const idleMs = Math.max(0, input.completion.idleMinutes || 0) * 60_000
  const nowMs = (input.now || new Date()).getTime()
  if (Number.isFinite(lastActivityMs) && nowMs - lastActivityMs >= idleMs) {
    return 'sealed'
  }
  return input.currentStatus === 'closing' ? 'closing' : 'open'
}

export function uploadGroupStatusToDayFolderStatus(
  status: UploadGroupStatus,
  taskStatuses: Array<TaskStatus | null>
): DayFolderStatus {
  if (status === 'error') return 'blocked'
  if (status === 'sealed' || status === 'cleanable' || status === 'cleaned') {
    return taskStatuses.some((taskStatus) => taskStatus === 'skipped')
      ? 'completed_with_skips'
      : 'completed'
  }
  if (
    taskStatuses.some(
      (taskStatus) =>
        taskStatus === null ||
        taskStatus === 'pending' ||
        taskStatus === 'scanning' ||
        taskStatus === 'uploading' ||
        taskStatus === 'retrying'
    )
  ) {
    return 'processing'
  }
  return 'collecting'
}

export function mapLegacyDayFolderStatus(status: DayFolderStatus): UploadGroupStatus {
  if (status === 'completed' || status === 'completed_with_skips') return 'sealed'
  if (status === 'blocked') return 'error'
  if (status === 'processing') return 'closing'
  return 'open'
}
