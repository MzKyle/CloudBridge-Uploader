import { useEffect, useCallback, useRef } from 'react'
import { IPC } from '@shared/ipc-channels'
import type {
  TaskDestinationStatusEvent,
  TaskProgress,
  TaskStatusEvent
} from '@shared/types'
import { useTaskStore } from '@/stores/task.store'
import { progressKey } from '@shared/cloud-upload'

const PROGRESS_FLUSH_MS = 150
const TASK_REFRESH_DEBOUNCE_MS = 1000

export function useTaskProgress(): void {
  const setProgressBatch = useTaskStore((s) => s.setProgressBatch)
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus)
  const loadTasks = useTaskStore((s) => s.loadTasks)
  const updateDestinationStatus = useTaskStore((s) => s.updateDestinationStatus)
  const progressBufferRef = useRef<Map<string, TaskProgress>>(new Map())
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushProgress = useCallback(() => {
    progressTimerRef.current = null
    const items = Array.from(progressBufferRef.current.values())
    progressBufferRef.current.clear()
    setProgressBatch(items)
  }, [setProgressBatch])

  const scheduleTaskRefresh = useCallback(() => {
    if (refreshTimerRef.current) return
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      void loadTasks()
    }, TASK_REFRESH_DEBOUNCE_MS)
  }, [loadTasks])

  const handleProgress = useCallback(
    (_event: unknown, data: unknown) => {
      const progress = data as TaskProgress
      progressBufferRef.current.set(
        progressKey(progress.taskId, progress.connectionId),
        progress
      )
      if (!progressTimerRef.current) {
        progressTimerRef.current = setTimeout(flushProgress, PROGRESS_FLUSH_MS)
      }
    },
    [flushProgress]
  )

  const handleStatusChange = useCallback(
    (_event: unknown, data: unknown) => {
      const ev = data as TaskStatusEvent
      updateTaskStatus(ev.taskId, ev.newStatus)
      scheduleTaskRefresh()
    },
    [updateTaskStatus, scheduleTaskRefresh]
  )

  useEffect(() => {
    const offProgress = window.api.on(IPC.TASK_PROGRESS, handleProgress as never)
    const offStatus = window.api.on(IPC.TASK_STATUS_CHANGE, handleStatusChange as never)
    const offDestination = window.api.on(
      IPC.TASK_DESTINATION_CHANGE,
      (_event: unknown, data: unknown) => {
        updateDestinationStatus(data as TaskDestinationStatusEvent)
      }
    )
    return () => {
      offProgress()
      offStatus()
      offDestination()
      if (progressTimerRef.current) {
        clearTimeout(progressTimerRef.current)
        progressTimerRef.current = null
      }
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
      const items = Array.from(progressBufferRef.current.values())
      progressBufferRef.current.clear()
      setProgressBatch(items)
    }
  }, [handleProgress, handleStatusChange, setProgressBatch, updateDestinationStatus])
}
