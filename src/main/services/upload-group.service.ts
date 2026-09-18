import { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { UploadGroupSummary } from '@shared/types'
import { getUploadGroupRepo } from '../db/upload-group.repo'
import { getTaskRepo } from '../db/task.repo'

export class UploadGroupService {
  requestCloseUploadGroup(uploadGroupId: string): UploadGroupSummary | null {
    const repo = getUploadGroupRepo()
    const summary = repo.getById(uploadGroupId)
    if (!summary) return null
    if (summary.uploadGroupStatus === 'open') {
      repo.markClosing(uploadGroupId)
    } else if (summary.uploadGroupStatus !== 'closing') {
      throw new Error('只有打开中的归档组可以手动封账')
    }
    return this.refresh(uploadGroupId)
  }

  refresh(uploadGroupId: string, discoveredChildren?: string[]): UploadGroupSummary | null {
    const repo = getUploadGroupRepo()
    if (discoveredChildren) {
      repo.updateDiscovery(uploadGroupId, discoveredChildren)
    }

    const summary = repo.recalculate(uploadGroupId)
    if (!summary) return null
    this.broadcast(summary)
    return summary
  }

  refreshForTask(taskId: string): UploadGroupSummary | null {
    const task = getTaskRepo().getById(taskId)
    if (!task?.uploadGroupId) return null
    return this.refresh(task.uploadGroupId)
  }

  private broadcast(summary: UploadGroupSummary): void {
    for (const win of BrowserWindow?.getAllWindows?.() ?? []) {
      win.webContents.send(IPC.UPLOAD_GROUP_EVENT, summary)
    }
  }
}

let instance: UploadGroupService | null = null
export function getUploadGroupService(): UploadGroupService {
  if (!instance) instance = new UploadGroupService()
  return instance
}
