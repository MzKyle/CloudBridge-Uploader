import { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { DayFolderSummary } from '@shared/types'
import { getDayFolderRepo } from '../db/day-folder.repo'
import { getTaskRepo } from '../db/task.repo'

export class DayFolderService {
  requestCloseUploadGroup(dayFolderId: string): DayFolderSummary | null {
    const repo = getDayFolderRepo()
    const summary = repo.getById(dayFolderId)
    if (!summary) return null
    if (summary.uploadGroupStatus === 'open') {
      repo.markClosing(dayFolderId)
    } else if (summary.uploadGroupStatus !== 'closing') {
      throw new Error('只有打开中的归档组可以手动封账')
    }
    return this.refresh(dayFolderId)
  }

  refresh(dayFolderId: string, discoveredChildren?: string[]): DayFolderSummary | null {
    const repo = getDayFolderRepo()
    if (discoveredChildren) {
      repo.updateDiscovery(dayFolderId, discoveredChildren)
    }

    const summary = repo.recalculate(dayFolderId)
    if (!summary) return null
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
