import type {
  CompletionPolicy,
  UploadGroupProcessingStatus,
  TaskStatus,
  UploadGroupStatus
} from './types'

export interface UploadGroupSequenceItem {
  relativePath: string
}

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
  cleanable: ['cleanable', 'cleaned', 'error'],
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

export function uploadGroupSiblingStreamKey(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!normalized) return ''
  const segments = normalized.split('/').filter(Boolean)
  segments.pop()
  return segments.join('/')
}

export function buildLastUploadGroupIndexByStream<T extends UploadGroupSequenceItem>(
  groups: T[]
): Map<string, number> {
  const result = new Map<string, number>()
  groups.forEach((group, index) => {
    result.set(uploadGroupSiblingStreamKey(group.relativePath), index)
  })
  return result
}

export function hasNewerSiblingUploadGroup<T extends UploadGroupSequenceItem>(
  groups: T[],
  index: number
): boolean {
  const current = groups[index]
  if (!current) return false
  const lastIndexByStream = buildLastUploadGroupIndexByStream(groups)
  return lastIndexByStream.get(uploadGroupSiblingStreamKey(current.relativePath)) !== index
}

export function deriveUploadGroupStatus(input: {
  currentStatus: UploadGroupStatus
  completion: CompletionPolicy
  taskStatuses: Array<TaskStatus | null>
  hasNewerGroup?: boolean
  lastContentActivityAt?: string | null
  now?: Date
}): UploadGroupStatus {
  if (input.currentStatus === 'cleaned') return 'cleaned'
  if (input.taskStatuses.some((status) => status && PROBLEM_TASK_STATUSES.has(status))) {
    return 'error'
  }
  if (input.currentStatus === 'sealed' || input.currentStatus === 'cleanable') {
    return input.currentStatus
  }

  const allTerminal = input.taskStatuses.every(
    (status) => status !== null && TERMINAL_TASK_STATUSES.has(status)
  )

  if (input.currentStatus === 'closing' && allTerminal) return 'sealed'

  if (input.completion.mode === 'none') {
    if (input.currentStatus === 'error') return 'open'
    return input.currentStatus === 'closing' ? 'closing' : 'open'
  }

  if (input.completion.mode === 'manual') {
    return input.currentStatus === 'error' ? 'open' : input.currentStatus
  }

  if (input.completion.mode === 'marker-file') {
    return input.currentStatus === 'error' ? 'open' : input.currentStatus
  }

  if (input.completion.mode === 'rollover') {
    if (input.hasNewerGroup || input.currentStatus === 'closing') {
      return allTerminal ? 'sealed' : 'closing'
    }
    return input.currentStatus === 'error' ? 'open' : 'open'
  }

  if (!allTerminal) return input.currentStatus === 'closing' ? 'closing' : 'open'

  const lastActivityMs = input.lastContentActivityAt
    ? Date.parse(input.lastContentActivityAt)
    : Number.NaN
  const idleMs = Math.max(0, input.completion.idleMinutes || 0) * 60_000
  const nowMs = (input.now || new Date()).getTime()
  if (Number.isFinite(lastActivityMs) && nowMs - lastActivityMs >= idleMs) {
    return 'sealed'
  }
  return input.currentStatus === 'closing' ? 'closing' : 'open'
}

export function uploadGroupStatusToUploadGroupProcessingStatus(
  status: UploadGroupStatus,
  taskStatuses: Array<TaskStatus | null>
): UploadGroupProcessingStatus {
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

export function mapLegacyUploadGroupProcessingStatus(status: UploadGroupProcessingStatus): UploadGroupStatus {
  if (status === 'completed' || status === 'completed_with_skips') return 'sealed'
  if (status === 'blocked') return 'error'
  if (status === 'processing') return 'closing'
  return 'open'
}
