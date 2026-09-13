import { BrowserWindow } from 'electron'
import log from 'electron-log'
import { IPC } from '@shared/ipc-channels'
import type { DayFolderSummary, DayUploadMarker } from '@shared/types'
import { getDayFolderRepo } from '../db/day-folder.repo'
import { getTaskRepo } from '../db/task.repo'
import { removeDayUpload, writeDayUpload } from '../utils/marker-file'

export class DayFolderService {
  refresh(dayFolderId: string, discoveredChildren?: string[]): DayFolderSummary | null {
    const repo = getDayFolderRepo()
    if (discoveredChildren) {
      repo.updateDiscovery(dayFolderId, discoveredChildren)
    }

    const summary = repo.recalculate(dayFolderId)
    if (!summary) return null

    try {
      if (
        (summary.status === 'completed' ||
          summary.status === 'completed_with_skips') &&
        summary.completedAt
      ) {
        const children = repo.getChildTasks(dayFolderId)
        const marker: DayUploadMarker = {
          version: 1,
          dayFolderId: summary.id,
          date: summary.date,
          folderPath: summary.folderPath,
          status: summary.status,
          totalChildren: summary.totalChildren,
          totalFiles: summary.totalFiles,
          uploadedFiles: summary.uploadedFiles,
          totalBytes: summary.totalBytes,
          uploadedBytes: summary.uploadedBytes,
          children: children.map((task) => ({
            folderName: task.folderName,
            folderPath: task.folderPath,
            taskId: task.id,
            completedAt: task.completedAt,
            destinations: task.destinations.map((destination) => ({
              provider: destination.provider,
              status: destination.status,
              completedAt: destination.completedAt
            }))
          })),
          completedAt: summary.completedAt
        }
        writeDayUpload(summary.folderPath, marker)
      } else {
        removeDayUpload(summary.folderPath)
      }
    } catch (err) {
      log.error('更新 legacy 归档组标记失败:', summary.folderPath, err)
    }

    this.broadcast(summary)
    return summary
  }

  refreshForTask(taskId: string): DayFolderSummary | null {
    const task = getTaskRepo().getById(taskId)
    if (!task?.dayFolderId) return null
    return this.refresh(task.dayFolderId)
  }

  private broadcast(summary: DayFolderSummary): void {
    for (const win of BrowserWindow?.getAllWindows?.() ?? []) {
      win.webContents.send(IPC.DAY_FOLDER_EVENT, summary)
    }
  }
}

let instance: DayFolderService | null = null
export function getDayFolderService(): DayFolderService {
  if (!instance) instance = new DayFolderService()
  return instance
}
