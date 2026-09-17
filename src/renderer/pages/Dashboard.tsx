import { memo, useEffect, useCallback, useMemo, useState } from "react";
import {
  CheckSquare,
  FolderOpen,
  FolderPlus,
  PauseCircle,
  RefreshCw,
  PlayCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Tooltip } from "@/components/ui/tooltip";
import { BulkActionBar } from "@/components/BulkActionBar";
import { TaskCard } from "@/components/TaskCard";
import { TaskDetailDrawer } from "@/components/TaskDetailDrawer";
import { ScanSchedulePanel } from "@/components/ScanSchedulePanel";
import { DiskUsagePanel } from "@/components/DiskUsagePanel";
import { DayFolderCard } from "@/components/DayFolderCard";
import { PathTree } from "@/components/PathTree";
import { QueueStatusBar } from "@/components/QueueStatusBar";
import { useTaskStore } from "@/stores/task.store";
import { useTaskProgress } from "@/hooks/useTaskProgress";
import { showToast } from "@/components/ui/toast";
import { buildPathTree } from "@/lib/path-tree";
import { providersForProfile } from "@shared/cloud-upload";
import {
  selectFolder,
  addFolder as addFolderApi,
  pauseTask,
  resumeTask,
  skipTask,
  restoreTask,
  retryTask,
  triggerScan,
  fetchDayFolders,
  ignoreDayFolder,
  restoreDayFolder,
  closeUploadGroup,
  fetchSettings,
  fetchUploadQueueStatus,
  previewUploadPath,
  startUploadQueue,
  stopUploadQueue,
} from "@/lib/ipc-client";
import { IPC } from "@shared/ipc-channels";
import type {
  CloudProvider,
  DayFolderSummary,
  Task,
  UploadQueueStatus,
} from "@shared/types";
import type { UploadPathPreview } from "@shared/upload-profile";
import { progressKey } from "@shared/cloud-upload";

type DashboardTreeItem =
  | { kind: "dayFolder"; dayFolder: DayFolderSummary }
  | { kind: "task"; task: Task };

type ConfirmAction =
  | { kind: "upload-window"; scope: "selected" | "all-pending" }
  | { kind: "stop-upload" }
  | { kind: "ignore-day"; id: string }
  | { kind: "close-upload-group"; id: string }
  | { kind: "skip-task"; id: string };

interface DashboardProfileOption {
  id: string;
  name: string;
  enabled: boolean;
  completionMode: string;
}

export default function Dashboard() {
  const tasks = useTaskStore((state) => state.tasks);
  const loading = useTaskStore((state) => state.loading);
  const loadTasks = useTaskStore((state) => state.loadTasks);
  const [dayFolders, setDayFolders] = useState<DayFolderSummary[]>([]);
  const [provider, setProvider] = useState<CloudProvider>("aliyun");
  const [providerReady, setProviderReady] = useState(false);
  const [profiles, setProfiles] = useState<DashboardProfileOption[]>([]);
  const [pendingFolder, setPendingFolder] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [pathPreview, setPathPreview] = useState<UploadPathPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedDayFolderIds, setSelectedDayFolderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [uploadQueueStatus, setUploadQueueStatus] =
    useState<UploadQueueStatus | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [pathPreviewError, setPathPreviewError] = useState<string | null>(null);

  useTaskProgress();

  useEffect(() => {
    fetchSettings()
      .then((settings) => {
        const activeProfile =
          settings.profiles.find((profile) => profile.id === settings.activeProfileId) ||
          settings.profiles[0];
        const providers = activeProfile ? providersForProfile(activeProfile) : [];
        setProvider(providers.includes("tencent") && !providers.includes("aliyun") ? "tencent" : "aliyun");
        setProfiles(settings.profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          enabled: profile.enabled,
          completionMode: profile.completion.mode,
        })));
        setSelectedProfileId(settings.activeProfileId);
      })
      .catch(() => {})
      .finally(() => setProviderReady(true));
  }, []);

  useEffect(() => {
    if (!providerReady) return;
    loadTasks();
    fetchDayFolders({ limit: 30, provider, includeCompleted: false })
      .then(setDayFolders)
      .catch(() => {});
    fetchUploadQueueStatus()
      .then(setUploadQueueStatus)
      .catch(() => {});
  }, [loadTasks, provider, providerReady]);

  useEffect(() => {
    const off = window.api.on(
      IPC.DAY_FOLDER_EVENT,
      () => {
        fetchDayFolders({ limit: 30, provider, includeCompleted: false })
          .then(setDayFolders)
          .catch(() => {});
      }
    );
    return () => off();
  }, [provider]);

  useEffect(() => {
    const off = window.api.on(
      IPC.UPLOAD_QUEUE_EVENT,
      (_event: unknown, data: unknown) => {
        setUploadQueueStatus(data as UploadQueueStatus);
      },
    );
    return () => off();
  }, []);

  const handleAddFolder = useCallback(async () => {
    const folder = await selectFolder();
    if (folder) {
      const settings = await fetchSettings();
      const nextProfiles = settings.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        enabled: profile.enabled,
        completionMode: profile.completion.mode,
      }));
      const enabledProfile =
        nextProfiles.find((profile) => profile.id === settings.activeProfileId && profile.enabled) ??
        nextProfiles.find((profile) => profile.enabled);
      setProfiles(nextProfiles);
      setSelectedProfileId(enabledProfile?.id ?? "");
      setPendingFolder(folder);
    }
  }, []);

  useEffect(() => {
    if (!pendingFolder || !selectedProfileId) return;
    setPreviewLoading(true);
    setPathPreviewError(null);
    previewUploadPath({
      sourcePath: pendingFolder,
      profileId: selectedProfileId,
    })
      .then(setPathPreview)
      .catch((err) => {
        setPathPreview(null);
        const message = String(err);
        setPathPreviewError(message);
        showToast(`路径预览失败: ${message}`, "error");
      })
      .finally(() => setPreviewLoading(false));
  }, [pendingFolder, selectedProfileId]);

  const handleConfirmAddFolder = useCallback(async () => {
    if (!pendingFolder) return;
    await addFolderApi(pendingFolder, selectedProfileId);
    setPendingFolder(null);
    setPathPreview(null);
    loadTasks();
  }, [loadTasks, pendingFolder, selectedProfileId]);

  const handleScan = useCallback(async () => {
    await triggerScan();
    await Promise.all([
      loadTasks(),
      fetchDayFolders({ limit: 30, provider, includeCompleted: false }).then(setDayFolders),
    ]);
  }, [loadTasks, provider]);

  const handleRefresh = useCallback(async () => {
    await Promise.all([
      loadTasks(),
      fetchDayFolders({ limit: 30, provider, includeCompleted: false }).then(setDayFolders),
    ]);
  }, [loadTasks, provider]);

  const refreshDashboard = useCallback(async () => {
    await Promise.all([
      loadTasks(),
      fetchDayFolders({ limit: 30, provider, includeCompleted: false }).then(setDayFolders),
      fetchUploadQueueStatus().then(setUploadQueueStatus),
    ]);
  }, [loadTasks, provider]);

  const handlePause = useCallback(async (taskId: string) => {
    try {
      await pauseTask(taskId);
      showToast("任务已暂停", "success");
    } catch (err) {
      showToast(`暂停失败: ${err}`, "error");
    }
  }, []);

  const handleResume = useCallback(async (taskId: string) => {
    try {
      await resumeTask(taskId);
      showToast("任务已恢复", "success");
    } catch (err) {
      showToast(`恢复失败: ${err}`, "error");
    }
  }, []);

  const performCancel = useCallback(async (taskId: string) => {
    try {
      await skipTask(taskId);
      await refreshDashboard();
      showToast("任务目录已跳过", "warning");
    } catch (err) {
      showToast(`跳过失败: ${err}`, "error");
    }
  }, [refreshDashboard]);

  const handleCancel = useCallback((taskId: string) => {
    setConfirmAction({ kind: "skip-task", id: taskId });
  }, []);

  const handleRestore = useCallback(async (taskId: string) => {
    try {
      await restoreTask(taskId);
      await loadTasks();
      showToast("已恢复监控", "success");
    } catch (err) {
      showToast(`恢复失败: ${err}`, "error");
    }
  }, [loadTasks]);

  const performIgnoreDay = useCallback(async (id: string) => {
    await ignoreDayFolder(id);
    await Promise.all([
      loadTasks(),
      fetchDayFolders({ limit: 30, provider, includeCompleted: false }).then(setDayFolders),
    ]);
  }, [loadTasks, provider]);

  const handleIgnoreDay = useCallback((id: string) => {
    setConfirmAction({ kind: "ignore-day", id });
  }, []);

  const handleRestoreDay = useCallback(async (id: string) => {
    await restoreDayFolder(id);
    await Promise.all([
      loadTasks(),
      fetchDayFolders({ limit: 30, provider, includeCompleted: false }).then(setDayFolders),
    ]);
  }, [loadTasks, provider]);

  const performCloseUploadGroup = useCallback(async (id: string) => {
    const summary = await closeUploadGroup(id);
    await refreshDashboard();
    showToast(
      summary?.uploadGroupStatus === "sealed"
        ? "归档组已封账"
        : "归档组已进入封账流程",
      "success",
    );
  }, [refreshDashboard]);

  const handleCloseUploadGroup = useCallback((id: string) => {
    setConfirmAction({ kind: "close-upload-group", id });
  }, []);

  const handleRetry = useCallback(async (
    taskId: string,
    retryProvider: CloudProvider
  ) => {
    try {
      await retryTask(taskId, retryProvider);
      showToast("任务已重新排队", "success");
    } catch (err) {
      showToast(`重试失败: ${err}`, "error");
    }
  }, []);

  const toggleTaskSelection = useCallback((taskId: string) => {
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const toggleDaySelection = useCallback((dayFolderId: string) => {
    setSelectedDayFolderIds((current) => {
      const next = new Set(current);
      if (next.has(dayFolderId)) next.delete(dayFolderId);
      else next.add(dayFolderId);
      return next;
    });
  }, []);

  const performStartUpload = useCallback(async (
    scope: "selected" | "all-pending",
    overrideWindow: boolean,
  ) => {
    const status = await startUploadQueue({
      scope,
      taskIds: scope === "selected" ? Array.from(selectedTaskIds) : [],
      dayFolderIds:
        scope === "selected" ? Array.from(selectedDayFolderIds) : [],
      overrideWindow,
    });
    setUploadQueueStatus(status);
    setSelectedTaskIds(new Set());
    setSelectedDayFolderIds(new Set());
    await refreshDashboard();
    showToast(
      status.priorityRemaining > 0
        ? `已开始上传，优先任务 ${status.priorityRemaining} 个`
        : "已开启上传队列",
      "success",
    );
  }, [refreshDashboard, selectedDayFolderIds, selectedTaskIds]);

  const handleStartUpload = useCallback(async (
    scope: "selected" | "all-pending",
  ) => {
    if (scope === "selected" && selectedTaskIds.size + selectedDayFolderIds.size === 0) {
      return;
    }
    const latestStatus = await fetchUploadQueueStatus();
    if (!latestStatus.withinUploadWindow) {
      setConfirmAction({ kind: "upload-window", scope });
      return;
    }
    await performStartUpload(scope, false);
  }, [performStartUpload, selectedDayFolderIds.size, selectedTaskIds.size]);

  const performStopUpload = useCallback(async () => {
    const status = await stopUploadQueue({ mode: "after-current" });
    setUploadQueueStatus(status);
    await refreshDashboard();
    showToast("已停止启动新上传", "warning");
  }, [refreshDashboard]);

  const handleStopUpload = useCallback(async () => {
    const latestStatus = await fetchUploadQueueStatus();
    if (latestStatus.runningTaskIds.length > 0) {
      setConfirmAction({ kind: "stop-upload" });
      return;
    }
    await performStopUpload();
  }, [performStopUpload]);

  const providerTasks = useMemo(
    () =>
      tasks.filter((task) =>
        task.destinations.some((destination) => destination.provider === provider),
      ),
    [tasks, provider],
  );
  const independentTasks = useMemo(
    () => providerTasks.filter((task) => !task.dayFolderId),
    [providerTasks],
  );
  const tasksByDayFolderId = useMemo(() => {
    const grouped = new Map<string, Task[]>();
    for (const task of providerTasks) {
      if (!task.dayFolderId) continue;
      const current = grouped.get(task.dayFolderId) ?? [];
      current.push(task);
      grouped.set(task.dayFolderId, current);
    }
    return grouped;
  }, [providerTasks]);
  const taskDirectoryTree = useMemo(
    () =>
      buildPathTree<DashboardTreeItem>([
        ...dayFolders.map((dayFolder) => ({
          id: `day:${dayFolder.id}`,
          path: dayFolder.folderPath,
          value: { kind: "dayFolder" as const, dayFolder },
        })),
        ...providerTasks.map((task) => ({
          id: `task:${task.id}`,
          path: task.folderPath,
          value: { kind: "task" as const, task },
        })),
      ]),
    [dayFolders, providerTasks],
  );
  const hasTaskDirectories = taskDirectoryTree.length > 0;
  const selectedTaskCount = selectedTaskIds.size;
  const selectedDayFolderCount = selectedDayFolderIds.size;
  const selectedCount = selectedTaskCount + selectedDayFolderCount;
  const enabledProfiles = useMemo(
    () => profiles.filter((profile) => profile.enabled),
    [profiles],
  );
  const profileCompletionModeById = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile.completionMode])),
    [profiles],
  );
  const detailTask = useMemo(
    () => providerTasks.find((task) => task.id === detailTaskId) ?? null,
    [detailTaskId, providerTasks],
  );
  const detailProgress = useTaskStore(
    useCallback(
      (state) =>
        detailTaskId
          ? state.progress[progressKey(detailTaskId, provider)]
          : undefined,
      [detailTaskId, provider],
    ),
  );

  const clearSelection = useCallback(() => {
    setSelectedTaskIds(new Set());
    setSelectedDayFolderIds(new Set());
  }, []);

  const openTaskDetail = useCallback((task: Task) => {
    setDetailTaskId(task.id);
  }, []);

  const closeAddTaskDialog = useCallback(() => {
    setPendingFolder(null);
    setPathPreview(null);
    setPathPreviewError(null);
  }, []);

  useEffect(() => {
    if (!pendingFolder) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAddTaskDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeAddTaskDialog, pendingFolder]);

  const handleConfirmAction = useCallback(async () => {
    if (!confirmAction) return;
    setConfirmLoading(true);
    try {
      if (confirmAction.kind === "upload-window") {
        await performStartUpload(confirmAction.scope, true);
      } else if (confirmAction.kind === "stop-upload") {
        await performStopUpload();
      } else if (confirmAction.kind === "ignore-day") {
        await performIgnoreDay(confirmAction.id);
      } else if (confirmAction.kind === "close-upload-group") {
        await performCloseUploadGroup(confirmAction.id);
      } else if (confirmAction.kind === "skip-task") {
        await performCancel(confirmAction.id);
      }
      setConfirmAction(null);
    } finally {
      setConfirmLoading(false);
    }
  }, [
    confirmAction,
    performCancel,
    performCloseUploadGroup,
    performIgnoreDay,
    performStartUpload,
    performStopUpload,
  ]);

  const confirmDialog = useMemo(() => {
    if (!confirmAction) return null;
    if (confirmAction.kind === "upload-window") {
      return {
        title: "当前不在上传时间窗内",
        description:
          "确认后会立即上传本次任务，并临时覆盖上传时间窗限制。\n取消后不会启动上传。",
        confirmText: "立即上传",
        cancelText: "取消",
        variant: "warning" as const,
      };
    }
    if (confirmAction.kind === "stop-upload") {
      return {
        title: "停止上传队列",
        description:
          "当前有任务正在上传。确认后将停止启动新的上传任务，正在上传的任务会继续跑完。",
        confirmText: "停止新上传",
        cancelText: "取消",
        variant: "warning" as const,
      };
    }
    if (confirmAction.kind === "ignore-day") {
      return {
        title: "忽略该归档组",
        description:
          "确认后，该组下未完成的任务目录会被忽略，不再参与本轮自动上传。之后仍可从归档组卡片恢复。",
        confirmText: "确认忽略",
        cancelText: "取消",
        variant: "destructive" as const,
      };
    }
    if (confirmAction.kind === "close-upload-group") {
      return {
        title: "封账归档组",
        description:
          "确认后，该归档组会停止继续收集新任务；已有任务全部完成后才会封账。",
        confirmText: "封账",
        cancelText: "取消",
        variant: "warning" as const,
      };
    }
    return {
      title: "跳过此任务目录",
      description:
        "确认后，该任务目录会从待处理上传中跳过。需要重新监控时可在任务详情中恢复。",
      confirmText: "确认跳过",
      cancelText: "取消",
      variant: "destructive" as const,
    };
  }, [confirmAction]);
  const canCreatePendingTask =
    Boolean(pendingFolder) &&
    enabledProfiles.length > 0 &&
    Boolean(selectedProfileId) &&
    Boolean(pathPreview) &&
    !previewLoading &&
    !pathPreviewError;

  useEffect(() => {
    const visibleTaskIds = new Set(providerTasks.map((task) => task.id));
    setSelectedTaskIds((current) => {
      const next = new Set(
        Array.from(current).filter((taskId) => visibleTaskIds.has(taskId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [providerTasks]);

  useEffect(() => {
    const visibleDayFolderIds = new Set(dayFolders.map((item) => item.id));
    setSelectedDayFolderIds((current) => {
      const next = new Set(
        Array.from(current).filter((id) => visibleDayFolderIds.has(id)),
      );
      return next.size === current.size ? current : next;
    });
  }, [dayFolders]);

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="任务面板"
        description="查看上传队列、选择任务目录并处理异常任务。"
        actions={
          <>
          <Button
            variant="default"
            size="sm"
            onClick={() => handleStartUpload("selected")}
            disabled={selectedCount === 0}
          >
            <PlayCircle className="h-4 w-4 mr-1" />
            开始选中 ({selectedCount})
          </Button>
          <Button size="sm" onClick={handleAddFolder}>
            <FolderPlus className="h-4 w-4 mr-1" />
            添加文件夹
          </Button>
          <Tooltip content="刷新任务和归档组">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={handleRefresh}
              title="刷新任务和归档组"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </Tooltip>
          </>
        }
      />

      <QueueStatusBar
        status={uploadQueueStatus}
        provider={provider}
        taskCount={providerTasks.length}
        dayFolderCount={dayFolders.length}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md border p-1 bg-muted/30">
          {(["aliyun", "tencent"] as CloudProvider[]).map((item) => (
            <Button
              key={item}
              variant={provider === item ? "default" : "ghost"}
              size="sm"
              onClick={() => setProvider(item)}
            >
              {item === "aliyun" ? "阿里云" : "腾讯云"}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleStartUpload("all-pending")}
          >
            <CheckSquare className="h-4 w-4 mr-1" />
            开始全部待处理
          </Button>
          <Button variant="outline" size="sm" onClick={handleStopUpload}>
            <PauseCircle className="h-4 w-4 mr-1" />
            停止上传
          </Button>
          <Button variant="outline" size="sm" onClick={handleScan}>
            <PlayCircle className="h-4 w-4 mr-1" />
            触发扫描
          </Button>
        </div>
      </div>

      <BulkActionBar
        selectedTaskCount={selectedTaskCount}
        selectedDayFolderCount={selectedDayFolderCount}
        onStartSelected={() => handleStartUpload("selected")}
        onClearSelection={clearSelection}
      />

      {/* 扫描计划面板 */}
      <ScanSchedulePanel />

      {/* 磁盘用量 */}
      <DiskUsagePanel />

      {hasTaskDirectories && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground mb-3">
            任务目录 ({dayFolders.length} 组 / {providerTasks.length} 任务)
          </h2>
          <PathTree
            nodes={taskDirectoryTree}
            className="rounded-md border bg-muted/10 p-2"
            renderNodeBody={({ node }) => {
              const dayItems = node.items.filter(
                (item) => item.value.kind === "dayFolder",
              );
              const taskItems = node.items.filter(
                (item) => item.value.kind === "task",
              );

              if (dayItems.length === 0 && taskItems.length === 0) {
                return null;
              }

              return (
                <div className="space-y-3">
                  {dayItems.map((item) => {
                    if (item.value.kind !== "dayFolder") return null;
                    const dayFolder = item.value.dayFolder;
                    const childTasks = tasksByDayFolderId.get(dayFolder.id) ?? [];

                    return (
                      <div key={dayFolder.id} className="flex gap-3">
                        <input
                          type="checkbox"
                          checked={selectedDayFolderIds.has(dayFolder.id)}
                          onChange={() => toggleDaySelection(dayFolder.id)}
                          className="mt-5 h-4 w-4 shrink-0 rounded"
                          aria-label={`选择归档组 ${dayFolder.groupKey}`}
                        />
                        <div className="min-w-0 flex-1">
                          <DayFolderCardWithSpeed
                            dayFolder={dayFolder}
                            tasks={childTasks}
                            provider={provider}
                            onIgnore={handleIgnoreDay}
                            onRestore={handleRestoreDay}
                            onClose={handleCloseUploadGroup}
                            canCloseManually={
                              dayFolder.uploadGroupStatus === "open" &&
                              profileCompletionModeById.get(dayFolder.profileId || "") === "manual"
                            }
                          />
                        {childTasks.length === 0 && (
                          <div className="ml-5 border-l pl-4 text-xs text-muted-foreground py-2">
                            尚未发现任务目录
                          </div>
                        )}
                        </div>
                      </div>
                    );
                  })}

                  {taskItems.map((item) => {
                    if (item.value.kind !== "task") return null;
                    const task = item.value.task;

                    return (
                      <div key={task.id} className="flex gap-3">
                        <input
                          type="checkbox"
                          checked={selectedTaskIds.has(task.id)}
                          onChange={() => toggleTaskSelection(task.id)}
                          className="mt-5 h-4 w-4 shrink-0 rounded"
                          aria-label={`选择任务 ${task.folderName}`}
                        />
                        <div className="min-w-0 flex-1">
                          <TaskCardWithProgress
                            task={task}
                            provider={provider}
                            onPause={handlePause}
                            onResume={handleResume}
                            onCancel={handleCancel}
                            onRetry={handleRetry}
                            onRestore={handleRestore}
                            onOpenDetail={openTaskDetail}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            }}
          />
          {independentTasks.length > 0 && (
            <div className="text-xs text-muted-foreground mt-2">
              独立任务 {independentTasks.length} 个
            </div>
          )}
        </section>
      )}

      {!hasTaskDirectories && (
        <EmptyState
          icon={<FolderOpen className="h-5 w-5" />}
          title="暂无待处理任务"
          description="可以手动添加文件夹，或等待扫描器发现任务目录。"
          action={
            <Button size="sm" onClick={handleAddFolder}>
              <FolderPlus className="mr-1 h-4 w-4" />
              添加文件夹
            </Button>
          }
        />
      )}

      {pendingFolder && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          role="presentation"
          onMouseDown={closeAddTaskDialog}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-task-dialog-title"
            className="w-full max-w-2xl rounded-lg border bg-background p-5 shadow-lg"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="add-task-dialog-title" className="text-base font-semibold">
                  添加上传任务
                </h2>
                <p className="mt-1 text-xs text-muted-foreground break-all">
                  {pendingFolder}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={closeAddTaskDialog}
              >
                取消
              </Button>
            </div>

            <div className="mt-4">
              <label className="text-sm font-medium">项目 Profile</label>
              {enabledProfiles.length === 0 ? (
                <EmptyState
                  title="没有可用 Profile"
                  description="请先在设置中启用至少一个项目 Profile，再创建上传任务。"
                  className="mt-2 py-8"
                />
              ) : (
                <select
                  value={selectedProfileId}
                  onChange={(event) => setSelectedProfileId(event.target.value)}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  {enabledProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="mt-4 rounded-md border bg-muted/20 p-3">
              <div className="text-sm font-medium">上传路径预览</div>
              {previewLoading && (
                <div className="mt-2 text-xs text-muted-foreground">生成预览中...</div>
              )}
              {!previewLoading && pathPreviewError && (
                <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {pathPreviewError}
                </div>
              )}
              {!previewLoading &&
                !pathPreviewError &&
                enabledProfiles.length > 0 &&
                !pathPreview && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    选择 Profile 后会显示上传对象 Key 预览。
                  </div>
                )}
              {!previewLoading && pathPreview && (
                <div className="mt-3 space-y-3">
                  {pathPreview.providers.map((item) => (
                    <div key={item.provider} className="rounded-md border bg-background p-3">
                      <div className="flex items-center justify-between text-sm">
                        <span>{item.provider === "aliyun" ? "阿里云" : "腾讯云"}</span>
                        <span className="text-xs text-muted-foreground">{item.pathMode}</span>
                      </div>
                      <div className="mt-2 space-y-1">
                        {item.keys.slice(0, 5).map((key) => (
                          <div key={key} className="break-all font-mono text-xs">
                            {key}
                          </div>
                        ))}
                      </div>
                      {[...item.errors, ...item.warnings].length > 0 && (
                        <div className="mt-2 text-xs text-destructive">
                          {[...item.errors, ...item.warnings].join("；")}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={closeAddTaskDialog}>
                取消
              </Button>
              <Button
                onClick={handleConfirmAddFolder}
                disabled={!canCreatePendingTask}
              >
                创建任务
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirmDialog && (
        <ConfirmDialog
          open={Boolean(confirmDialog)}
          title={confirmDialog.title}
          description={confirmDialog.description}
          confirmText={confirmDialog.confirmText}
          cancelText={confirmDialog.cancelText}
          variant={confirmDialog.variant}
          loading={confirmLoading}
          onConfirm={handleConfirmAction}
          onOpenChange={(open) => {
            if (!open) setConfirmAction(null);
          }}
        />
      )}

      <TaskDetailDrawer
        task={detailTask}
        provider={provider}
        open={Boolean(detailTask)}
        progress={detailProgress}
        onOpenChange={(open) => {
          if (!open) setDetailTaskId(null);
        }}
        onPause={handlePause}
        onResume={handleResume}
        onCancel={handleCancel}
        onRetry={handleRetry}
        onRestore={handleRestore}
      />

    </div>
  );
}

const TaskCardWithProgress = memo(function TaskCardWithProgress({
  task,
  provider,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onRestore,
  onOpenDetail,
}: {
  task: Task;
  provider: CloudProvider;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string, provider: CloudProvider) => void;
  onRestore: (id: string) => void;
  onOpenDetail: (task: Task) => void;
}) {
  const progress = useTaskStore(
    useCallback(
      (state) => state.progress[progressKey(task.id, provider)],
      [provider, task.id],
    ),
  );

  return (
    <TaskCard
      task={task}
      provider={provider}
      progress={progress}
      onPause={onPause}
      onResume={onResume}
      onCancel={onCancel}
      onRetry={onRetry}
      onRestore={onRestore}
      onOpenDetail={onOpenDetail}
    />
  );
});

const DayFolderCardWithSpeed = memo(function DayFolderCardWithSpeed({
  dayFolder,
  tasks,
  provider,
  onIgnore,
  onRestore,
  onClose,
  canCloseManually,
}: {
  dayFolder: DayFolderSummary;
  tasks: Task[];
  provider: CloudProvider;
  onIgnore: (id: string) => void;
  onRestore: (id: string) => void;
  onClose: (id: string) => void;
  canCloseManually: boolean;
}) {
  const speed = useTaskStore(
    useCallback(
      (state) =>
        tasks.reduce(
          (sum, task) =>
            sum + (state.progress[progressKey(task.id, provider)]?.speed || 0),
          0,
        ),
      [provider, tasks],
    ),
  );

  return (
    <DayFolderCard
      dayFolder={dayFolder}
      tasks={tasks}
      speed={speed}
      onIgnore={onIgnore}
      onRestore={onRestore}
      onClose={onClose}
      canCloseManually={canCloseManually}
    />
  );
});
