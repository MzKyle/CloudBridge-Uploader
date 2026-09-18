import { getDb } from './database'
import type { HistoryQuery, HistoryResult, HistoryItem } from '@shared/types'

function rowToHistory(row: Record<string, unknown>): HistoryItem {
  return {
    id: row.id as string,
    connectionId: row.connection_id as string,
    connectionName: (row.connection_name as string) || null,
    folderName: row.folder_name as string,
    fileCount: row.total_files as number,
    totalBytes: row.total_bytes as number,
    durationSeconds: row.duration_seconds as number,
    status: row.status as 'completed' | 'failed',
    completedAt: row.completed_at as string
  }
}

export class HistoryRepo {
  list(query: HistoryQuery): HistoryResult {
    const db = getDb()
    const { page, pageSize, status, connectionId } = query
    const offset = (page - 1) * pageSize

    let where =
      "WHERE td.status IN ('completed', 'failed') AND td.completed_at IS NOT NULL"
    const params: unknown[] = []
    if (connectionId) {
      where += ' AND td.connection_id = ?'
      params.push(connectionId)
    }
    if (status) {
      where += ' AND td.status = ?'
      params.push(status)
    }

    const countRow = db
      .prepare(
        `SELECT COUNT(*) as cnt
         FROM task_destinations td
         INNER JOIN tasks t ON t.id = td.task_id ${where}`
      )
      .get(...params) as { cnt: number }
    const total = countRow.cnt

    const rows = db
      .prepare(
        `SELECT t.id, td.connection_id, td.connection_name,
          t.folder_name, td.total_files, td.total_bytes,
          td.status, td.completed_at,
          CAST((julianday(td.completed_at) - julianday(td.created_at)) * 86400 AS INTEGER)
            as duration_seconds
         FROM task_destinations td
         INNER JOIN tasks t ON t.id = td.task_id
         ${where}
         ORDER BY td.completed_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset) as Record<string, unknown>[]

    return { items: rows.map(rowToHistory), total }
  }

  clear(before?: string, connectionId?: string): void {
    const db = getDb()
    const transaction = db.transaction(() => {
      if (connectionId) {
        const params: unknown[] = [connectionId]
        let beforeCondition = ''
        if (before) {
          beforeCondition = ' AND completed_at < ?'
          params.push(before)
        }
        db.prepare(
          `DELETE FROM task_destinations
           WHERE connection_id = ?
             AND status IN ('completed', 'failed')
             AND completed_at IS NOT NULL${beforeCondition}`
        ).run(...params)
        db.prepare(
          `DELETE FROM tasks
           WHERE NOT EXISTS (
             SELECT 1 FROM task_destinations td WHERE td.task_id = tasks.id
           )`
        ).run()
      } else if (before) {
        db.prepare("DELETE FROM tasks WHERE status IN ('completed', 'failed') AND completed_at < ?").run(before)
      } else {
        db.prepare("DELETE FROM tasks WHERE status IN ('completed', 'failed')").run()
      }
    })
    transaction()
  }

  deleteById(id: string, connectionId?: string): void {
    const db = getDb()
    const transaction = db.transaction(() => {
      if (connectionId) {
        db.prepare(
          `DELETE FROM task_destinations
           WHERE task_id = ? AND connection_id = ? AND status IN ('completed', 'failed')`
        ).run(id, connectionId)
        db.prepare(
          `DELETE FROM tasks
           WHERE id = ?
             AND NOT EXISTS (
               SELECT 1 FROM task_destinations td WHERE td.task_id = tasks.id
             )`
        ).run(id)
      } else {
        db.prepare("DELETE FROM tasks WHERE id = ? AND status IN ('completed', 'failed')").run(id)
      }
    })
    transaction()
  }
}

let instance: HistoryRepo | null = null
export function getHistoryRepo(): HistoryRepo {
  if (!instance) instance = new HistoryRepo()
  return instance
}
