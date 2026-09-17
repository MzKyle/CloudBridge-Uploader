import type {
  CloudConnection,
  CloudConnectionConfig,
  CloudConnectionType,
  CloudProvider,
  FileStatus,
  LegacyCloudMode,
  TaskStatus
} from './types'

export function legacyProviderForConnectionType(
  type: CloudConnectionType
): CloudProvider {
  return type === 'aliyun-oss' ? 'aliyun' : 'tencent'
}

export function legacyProviderForConnection(
  connection: Pick<CloudConnection, 'type'>
): CloudProvider {
  return legacyProviderForConnectionType(connection.type)
}

export function legacyModeForConnections(
  connections: Array<Pick<CloudConnection, 'type'>>
): LegacyCloudMode {
  const providers = new Set(connections.map(legacyProviderForConnection))
  if (providers.has('aliyun') && providers.has('tencent')) return 'both'
  if (providers.has('tencent')) return 'tencent'
  return 'aliyun'
}

export function connectionConfigPrefix(
  config: CloudConnectionConfig | undefined
): string {
  return typeof config?.prefix === 'string' ? config.prefix : ''
}

export function connectionDisplayName(connection: CloudConnection): string {
  return connection.name.trim() || connection.id
}

export function findConnection(
  connections: CloudConnection[],
  connectionId: string | undefined
): CloudConnection | null {
  const normalizedId = connectionId?.trim()
  if (!normalizedId) return null
  return connections.find((connection) => connection.id === normalizedId) || null
}

export function progressKey(taskId: string, provider: CloudProvider): string {
  return `${taskId}:${provider}`
}

export function deriveLogicalFileStatus(statuses: FileStatus[]): FileStatus {
  if (statuses.length === 0) return 'pending'
  if (statuses.every((status) => status === 'completed')) return 'completed'
  if (statuses.some((status) => status === 'failed')) return 'failed'
  if (statuses.some((status) => status === 'uploading')) return 'uploading'
  if (statuses.some((status) => status === 'pending')) return 'pending'
  if (statuses.every((status) => status === 'skipped')) return 'skipped'
  return 'pending'
}

export function deriveTaskStatus(statuses: TaskStatus[]): TaskStatus {
  if (statuses.length === 0) return 'pending'
  if (statuses.every((status) => status === 'synced')) return 'synced'
  if (statuses.every((status) => status === 'completed' || status === 'synced')) {
    return statuses.includes('synced') ? 'synced' : 'completed'
  }
  if (statuses.some((status) => status === 'failed')) return 'failed'
  if (statuses.some((status) => status === 'uploading')) return 'uploading'
  if (statuses.some((status) => status === 'retrying')) return 'retrying'
  if (statuses.some((status) => status === 'paused')) return 'paused'
  if (statuses.every((status) => status === 'skipped')) return 'skipped'
  return 'pending'
}
