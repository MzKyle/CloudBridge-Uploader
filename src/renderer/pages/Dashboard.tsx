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
import { UploadGroupCard } from "@/components/UploadGroupCard";
import { PathTree } from "@/components/PathTree";
import { QueueStatusBar } from "@/components/QueueStatusBar";
import { useTaskStore } from "@/stores/task.store";
import { useTaskProgress } from "@/hooks/useTaskProgress";
import { showToast } from "@/components/ui/toast";
import { buildPathTree } from "@/lib/path-tree";
import {
  selectFolder,
  addFolder as addFolderApi,
  pauseTask,
  resumeTask,
  skipTask,
  restoreTask,
  retryTask,
  triggerScan,
  fetchUploadGroups,
  ignoreUploadGroup,
  restoreUploadGroup,
  closeUploadGroup,
  fetchSettings,
  fetchUploadQueueStatus,
  previewUploadPath,
  startUploadQueue,
  stopUploadQueue,
} from "@/lib/ipc-client";
import { IPC } from "@shared/ipc-channels";
import type {
  CloudConnection,
  UploadGroupSummary,
  Task,
  UploadPathPreview,
  UploadQueueStatus,
} from "@shared/types";
import { progressKey } from "@shared/cloud-upload";

type DashboardTreeItem =
  | { kind: "uploadGroup"; uploadGroup: UploadGroupSummary }
  | { kind: "task"; task: Task };

type ConfirmAction =
  | { kind: "upload-window"; scope: "selected" | "all-pending" }
  | { kind: "stop-upload" }
  | { kind: "ignore-group"; id: string }
  | { kind: "close-upload-group"; id: string }
  | { kind: "skip-task"; id: string };

interface DashboardRuleOption {
  id: string;
  name: string;
  enabled: boolean;
  completionMode: string;
}

type ConnectionSelection = "all" | string;

interface DashboardConnectionOption {
  id: string;
  name: string;
}

function connectionOption(connection: CloudConnection): DashboardConnectionOption {
  return {
    id: connection.id,
    name: connection.name.trim() || connection.id,
  };
}

export default function Dashboard() {
  const tasks = useTaskStore((state) => state.tasks);
  const loading = useTaskStore((state) => state.loading);
  const loadTasks = useTaskStore((state) => state.loadTasks);
  const [uploadGroups, setUploadGroups] = useState<UploadGroupSummary[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] =
    useState<ConnectionSelection>("all");
  const [settingsReady, setSettingsReady] = useState(false);
  const [connections, setConnections] = useState<DashboardConnectionOption[]>([]);
  const [rules, setRules] = useState<DashboardRuleOption[]>([]);
  const [pendingFolder, setPendingFolder] = useState<string | null>(null);
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [pathPreview, setPathPreview] = useState<UploadPathPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedUploadGroupIds, setSelectedUploadGroupIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [uploadQueueStatus, setUploadQueueStatus] =
    useState<UploadQueueStatus | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [pathPreviewError, setPathPreviewError] = useState<string | null>(null);

  useTaskProgress();

  const selectedConnectionQuery =
    selectedConnectionId === "all" ? undefined : selectedConnectionId;
  const selectedConnectionName =
    selectedConnectionId === "all"
      ? "全部连接"
      : connections.find((connection) => connection.id === selectedConnectionId)?.name ||
        selectedConnectionId;

  useEffect(() => {
    fetchSettings()
      .then((settings) => {
        setConnections(settings.connections.map(connectionOption));
        setRules(settings.rules.map((rule) => ({
          id: rule.id,
          name: rule.name,
          enabled: rule.enabled,
          completionMode: rule.completion.mode,
        })));
        setSelectedRuleId(settings.activeRuleId);
      })
      .catch(() => {})
      .finally(() => setSettingsReady(true));
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    loadTasks();
    fetchUploadGroups({
      limit: 30,
      connectionId: selectedConnectionQuery,
      includeCompleted: false,
    })
      .then(setUploadGroups)
      .catch(() => {});
    fetchUploadQueueStatus()
      .then(setUploadQueueStatus)
      .catch(() => {});
  }, [loadTasks, selectedConnectionQuery, settingsReady]);

  useEffect(() => {
    const off = window.api.on(
      IPC.UPLOAD_GROUP_EVENT,
      () => {
        fetchUploadGroups({
          limit: 30,
          connectionId: selectedConnectionQuery,
          includeCompleted: false,
        })
          .then(setUploadGroups)
          .catch(() => {});
      }
    );
    return () => off();
  }, [selectedConnectionQuery]);

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
      const nextRules = settings.rules.map((rule) => ({
        id: rule.id,
        name: rule.name,
        enabled: rule.enabled,
        completionMode: rule.completion.mode,
      }));
      const enabledRule =
        nextRules.find((rule) => rule.id === settings.activeRuleId && rule.enabled) ??
        nextRules.find((rule) => rule.enabled);
      setRules(nextRules);
      setSelectedRuleId(enabledRule?.id ?? "");
      setPendingFolder(folder);
    }
  }, []);

  useEffect(() => {
    if (!pendingFolder || !selectedRuleId) return;
    setPreviewLoading(true);
    setPathPreviewError(null);
    previewUploadPath({
      sourcePath: pendingFolder,
      ruleId: selectedRuleId,
    })
      .then(setPathPreview)
      .catch((err) => {
        setPathPreview(null);
        const message = String(err);
        setPathPreviewError(message);
        showToast(`路径预览失败: ${message}`, "error");
      })
      .finally(() => setPreviewLoading(false));
  }, [pendingFolder, selectedRuleId]);

  const handleConfirmAddFolder = useCallback(async () => {
    if (!pendingFolder) return;
    await addFolderApi(pendingFolder, selectedRuleId);
    setPendingFolder(null);
    setPathPreview(null);
    loadTasks();
  }, [loadTasks, pendingFolder, selectedRuleId]);

  const handleScan = useCallback(async () => {
    await triggerScan();
    await Promise.all([
      loadTasks(),
      fetchUploadGroups({
        limit: 30,
        connectionId: selectedConnectionQuery,
        includeCompleted: false,
      }).then(setUploadGroups),
    ]);
  }, [loadTasks, selectedConnectionQuery]);

  const handleRefresh = useCallback(async () => {
    await Promise.all([
      loadTasks(),
      fetchUploadGroups({
        limit: 30,
        connectionId: selectedConnectionQuery,
        includeCompleted: false,
      }).then(setUploadGroups),
    ]);
  }, [loadTasks, selectedConnectionQuery]);

  const refreshDashboard = useCallback(async () => {
    await Promise.all([
      loadTasks(),
      fetchUploadGroups({
        limit: 30,
        connectionId: selectedConnectionQuery,
        includeCompleted: false,
      }).then(setUploadGroups),
      fetchUploadQueueStatus().then(setUploadQueueStatus),
    ]);
  }, [loadTasks, selectedConnectionQuery]);

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

  const performIgnoreUploadGroup = useCallback(async (id: string) => {
    await ignoreUploadGroup(id);
    await Promise.all([
      loadTasks(),
      fetchUploadGroups({
        limit: 30,
        connectionId: selectedConnectionQuery,
        includeCompleted: false,
      }).then(setUploadGroups),
    ]);
  }, [loadTasks, selectedConnectionQuery]);

  const handleIgnoreUploadGroup = useCallback((id: string) => {
    setConfirmAction({ kind: "ignore-group", id });
  }, []);

  const handleRestoreUploadGroup = useCallback(async (id: string) => {
    await restoreUploadGroup(id);
    await Promise.all([
      loadTasks(),
      fetchUploadGroups({
        limit: 30,
        connectionId: selectedConnectionQuery,
        includeCompleted: false,
      }).then(setUploadGroups),
    ]);
  }, [loadTasks, selectedConnectionQuery]);

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
    connectionId: string
  ) => {
    try {
      await retryTask(taskId, connectionId);
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

  const toggleUploadGroupSelection = useCallback((uploadGroupId: string) => {
    setSelectedUploadGroupIds((current) => {
      const next = new Set(current);
      if (next.has(uploadGroupId)) next.delete(uploadGroupId);
      else next.add(uploadGroupId);
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
      uploadGroupIds:
        scope === "selected" ? Array.from(selectedUploadGroupIds) : [],
      overrideWindow,
    });
    setUploadQueueStatus(status);
    setSelectedTaskIds(new Set());
    setSelectedUploadGroupIds(new Set());
    await refreshDashboard();
    showToast(
      status.priorityRemaining > 0
        ? `已开始上传，优先任务 ${status.priorityRemaining} 个`
        : "已开启上传队列",
      "success",
    );
  }, [refreshDashboard, selectedUploadGroupIds, selectedTaskIds]);

  const handleStartUpload = useCallback(async (
    scope: "selected" | "all-pending",
  ) => {
    if (scope === "selected" && selectedTaskIds.size + selectedUploadGroupIds.size === 0) {
      return;
    }
    const latestStatus = await fetchUploadQueueStatus();
    if (!latestStatus.withinUploadWindow) {
      setConfirmAction({ kind: "upload-window", scope });
      return;
    }
    await performStartUpload(scope, false);
  }, [performStartUpload, selectedUploadGroupIds.size, selectedTaskIds.size]);

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

  const visibleTasks = useMemo(
    () =>
      selectedConnectionId === "all"
        ? tasks
        : tasks.filter((task) =>
            task.destinations.some(
              (destination) => destination.connectionId === selectedConnectionId,
            ),
          ),
    [selectedConnectionId, tasks],
  );
  const independentTasks = useMemo(
    () => visibleTasks.filter((task) => !task.uploadGroupId),
    [visibleTasks],
  );
  const tasksByUploadGroupId = useMemo(() => {
    const grouped = new Map<string, Task[]>();
    for (const task of visibleTasks) {
      if (!task.uploadGroupId) continue;
      const current = grouped.get(task.uploadGroupId) ?? [];
      current.push(task);
      grouped.set(task.uploadGroupId, current);
    }
    return grouped;
  }, [visibleTasks]);
  const taskDirectoryTree = useMemo(
    () =>
      buildPathTree<DashboardTreeItem>([
        ...uploadGroups.map((uploadGroup) => ({
          id: `group:${uploadGroup.id}`,
          path: uploadGroup.folderPath,
          value: { kind: "uploadGroup" as const, uploadGroup },
        })),
        ...visibleTasks.map((task) => ({
          id: `task:${task.id}`,
          path: task.folderPath,
          value: { kind: "task" as const, task },
        })),
      ]),
    [uploadGroups, visibleTasks],
  );
  const hasTaskDirectories = taskDirectoryTree.length > 0;
  const selectedTaskCount = selectedTaskIds.size;
  const selectedUploadGroupCount = selectedUploadGroupIds.size;
  const selectedCount = selectedTaskCount + selectedUploadGroupCount;
  const enabledRules = useMemo(
    () => rules.filter((rule) => rule.enabled),
    [rules],
  );
  const ruleCompletionModeById = useMemo(
    () => new Map(rules.map((rule) => [rule.id, rule.completionMode])),
    [rules],
  );
  const detailTask = useMemo(
    () => visibleTasks.find((task) => task.id === detailTaskId) ?? null,
    [detailTaskId, visibleTasks],
  );
  const detailConnectionId = useMemo(
    () => (selectedConnectionId === "all" ? undefined : selectedConnectionId),
    [selectedConnectionId],
  );
  const detailProgress = useTaskStore(
    useCallback(
      (state) =>
        detailTaskId && detailConnectionId
          ? state.progress[progressKey(detailTaskId, detailConnectionId)]
          : undefined,
      [detailConnectionId, detailTaskId],
    ),
  );

  const clearSelection = useCallback(() => {
    setSelectedTaskIds(new Set());
    setSelectedUploadGroupIds(new Set());
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
      } else if (confirmAction.kind === "ignore-group") {
        await performIgnoreUploadGroup(confirmAction.id);
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
    performIgnoreUploadGroup,
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
    if (confirmAction.kind === "ignore-group") {
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
    enabledRules.length > 0 &&
    Boolean(selectedRuleId) &&
    Boolean(pathPreview) &&
    !previewLoading &&
    !pathPreviewError;

  useEffect(() => {
    const visibleTaskIds = new Set(visibleTasks.map((task) => task.id));
    setSelectedTaskIds((current) => {
      const next = new Set(
        Array.from(current).filter((taskId) => visibleTaskIds.has(taskId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [visibleTasks]);

  useEffect(() => {
    const visibleUploadGroupIds = new Set(uploadGroups.map((item) => item.id));
    setSelectedUploadGroupIds((current) => {
      const next = new Set(
        Array.from(current).filter((id) => visibleUploadGroupIds.has(id)),
      );
      return next.size === current.size ? current : next;
    });
  }, [uploadGroups]);

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
        selectedConnectionName={selectedConnectionName}
        taskCount={visibleTasks.length}
        uploadGroupCount={uploadGroups.length}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md border p-1 bg-muted/30">
          <Button
            variant={selectedConnectionId === "all" ? "default" : "ghost"}
            size="sm"
            onClick={() => setSelectedConnectionId("all")}
          >
            全部
          </Button>
          {connections.map((item) => (
            <Button
              key={item.id}
              variant={selectedConnectionId === item.id ? "default" : "ghost"}
              size="sm"
              onClick={() => setSelectedConnectionId(item.id)}
            >
              {item.name}
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
        selectedUploadGroupCount={selectedUploadGroupCount}
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
            任务目录 ({uploadGroups.length} 组 / {visibleTasks.length} 任务)
          </h2>
          <PathTree
            nodes={taskDirectoryTree}
            className="rounded-md border bg-muted/10 p-2"
            renderNodeBody={({ node }) => {
              const uploadGroupItems = node.items.filter(
                (item) => item.value.kind === "uploadGroup",
              );
              const taskItems = node.items.filter(
                (item) => item.value.kind === "task",
              );

              if (uploadGroupItems.length === 0 && taskItems.length === 0) {
                return null;
              }

              return (
                <div className="space-y-3">
                  {uploadGroupItems.map((item) => {
                    if (item.value.kind !== "uploadGroup") return null;
                    const uploadGroup = item.value.uploadGroup;
                    const childTasks = tasksByUploadGroupId.get(uploadGroup.id) ?? [];

                    return (
                      <div key={uploadGroup.id} className="flex gap-3">
                        <input
                          type="checkbox"
                          checked={selectedUploadGroupIds.has(uploadGroup.id)}
                          onChange={() => toggleUploadGroupSelection(uploadGroup.id)}
                          className="mt-5 h-4 w-4 shrink-0 rounded"
                          aria-label={`选择归档组 ${uploadGroup.groupKey}`}
                        />
                        <div className="min-w-0 flex-1">
                          <UploadGroupCardWithSpeed
                            uploadGroup={uploadGroup}
                            tasks={childTasks}
                            selectedConnectionId={selectedConnectionId}
                            onIgnore={handleIgnoreUploadGroup}
                            onRestore={handleRestoreUploadGroup}
                            onClose={handleCloseUploadGroup}
                            canCloseManually={
                              uploadGroup.uploadGroupStatus === "open" &&
                              ruleCompletionModeById.get(uploadGroup.ruleId || "") === "manual"
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
                            selectedConnectionId={selectedConnectionId}
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
              <label className="text-sm font-medium">上传规则</label>
              {enabledRules.length === 0 ? (
                <EmptyState
                  title="没有可用规则"
                  description="请先启用至少一个上传规则，再创建上传任务。"
                  className="mt-2 py-8"
                />
              ) : (
                <select
                  value={selectedRuleId}
                  onChange={(event) => setSelectedRuleId(event.target.value)}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  {enabledRules.map((rule) => (
                    <option key={rule.id} value={rule.id}>
                      {rule.name}
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
                enabledRules.length > 0 &&
                !pathPreview && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    选择规则后会显示上传对象 Key 预览。
                  </div>
                )}
              {!previewLoading && pathPreview && (
                <div className="mt-3 space-y-3">
                  {pathPreview.destinations.map((item) => (
                    <div key={item.connectionId} className="rounded-md border bg-background p-3">
                      <div className="flex items-center justify-between text-sm">
                        <span>{item.connectionId}</span>
                        <span className="text-xs text-muted-foreground">{item.prefix || "no prefix"}</span>
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
        selectedConnectionId={selectedConnectionId}
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
  selectedConnectionId,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onRestore,
  onOpenDetail,
}: {
  task: Task;
  selectedConnectionId: ConnectionSelection;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string, connectionId: string) => void;
  onRestore: (id: string) => void;
  onOpenDetail: (task: Task) => void;
}) {
  const connectionId =
    selectedConnectionId === "all" ? undefined : selectedConnectionId;
  const progress = useTaskStore(
    useCallback(
      (state) =>
        connectionId
          ? state.progress[progressKey(task.id, connectionId)]
          : undefined,
      [connectionId, task.id],
    ),
  );

  return (
    <TaskCard
      task={task}
      selectedConnectionId={selectedConnectionId}
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

const UploadGroupCardWithSpeed = memo(function UploadGroupCardWithSpeed({
  uploadGroup,
  tasks,
  selectedConnectionId,
  onIgnore,
  onRestore,
  onClose,
  canCloseManually,
}: {
  uploadGroup: UploadGroupSummary;
  tasks: Task[];
  selectedConnectionId: ConnectionSelection;
  onIgnore: (id: string) => void;
  onRestore: (id: string) => void;
  onClose: (id: string) => void;
  canCloseManually: boolean;
}) {
  const speed = useTaskStore(
    useCallback(
      (state) =>
        tasks.reduce(
          (sum, task) => {
            const speed = task.destinations
              .filter(
                (destination) =>
                  selectedConnectionId === "all" ||
                  destination.connectionId === selectedConnectionId,
              )
              .reduce(
                (total, destination) =>
                  total +
                  (state.progress[progressKey(task.id, destination.connectionId)]?.speed || 0),
                0,
              );
            return sum + speed;
          },
          0,
        ),
      [selectedConnectionId, tasks],
    ),
  );

  return (
    <UploadGroupCard
      uploadGroup={uploadGroup}
      tasks={tasks}
      speed={speed}
      onIgnore={onIgnore}
      onRestore={onRestore}
      onClose={onClose}
      canCloseManually={canCloseManually}
    />
  );
});
