import { getDb } from '../db/database'
import { getSettingsRepo } from '../db/settings.repo'
import {
  normalizeCloudConnection,
  normalizeCloudConnections
} from '@shared/upload-rule'
import type { CloudConnection } from '@shared/types'

export class CloudConnectionStore {
  list(): CloudConnection[] {
    return getSettingsRepo().getAll().connections
  }

  get(id: string): CloudConnection | null {
    return this.list().find((connection) => connection.id === id) || null
  }

  resolve(id: string): CloudConnection {
    const connection = this.get(id)
    if (!connection) throw new Error(`云端连接不存在: ${id}`)
    return connection
  }

  save(connection: CloudConnection): CloudConnection {
    const normalized = normalizeCloudConnection(connection)
    if (!normalized) throw new Error('云端连接配置无效')
    const settings = getSettingsRepo().getAll()
    const exists = settings.connections.some((item) => item.id === normalized.id)
    const connections = exists
      ? settings.connections.map((item) => item.id === normalized.id ? normalized : item)
      : [...settings.connections, normalized]
    getSettingsRepo().saveAll({ connections: normalizeCloudConnections(connections) })
    return normalized
  }

  delete(id: string): void {
    const settings = getSettingsRepo().getAll()
    if (!settings.connections.some((connection) => connection.id === id)) return

    const referencingRule = settings.rules.find((rule) =>
      rule.destinations.some((destination) => destination.connectionId === id)
    )
    if (referencingRule) {
      throw new Error(`连接正在被上传规则使用: ${referencingRule.name}`)
    }

    const unfinishedTask = getDb().prepare(
      `SELECT t.id, t.folder_name
       FROM tasks t
       INNER JOIN task_destinations td ON td.task_id = t.id
       WHERE td.connection_id = ?
         AND t.status NOT IN ('completed', 'synced', 'skipped')
       LIMIT 1`
    ).get(id) as { id: string; folder_name: string } | undefined
    if (unfinishedTask) {
      throw new Error(`连接正在被未完成任务使用: ${unfinishedTask.folder_name}`)
    }

    getSettingsRepo().saveAll({
      connections: settings.connections.filter((connection) => connection.id !== id)
    })
  }
}

let instance: CloudConnectionStore | null = null
export function getCloudConnectionStore(): CloudConnectionStore {
  if (!instance) instance = new CloudConnectionStore()
  return instance
}
