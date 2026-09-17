import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpFromLine,
  Pause,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/progress";
import { SideDrawer } from "@/components/ui/side-drawer";
import { fetchTaskDetail } from "@/lib/ipc-client";
import { formatBytes, formatSpeed } from "@/lib/utils";
import { CLOUD_PROVIDER_LABELS, TASK_STATUS_LABELS } from "@shared/constants";
import type {
  CloudProvider,
  Task,
  TaskDetail,
  TaskProgress,
} from "@shared/types";

interface TaskDetailDrawerProps {
  task: Task | null;
  provider: CloudProvider;
  open: boolean;
  progress?: TaskProgress;
  onOpenChange: (open: boolean) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRetry: (id: string, provider: CloudProvider) => void;
  onRestore: (id: string) => void;
  onCancel: (id: string) => void;
}

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "success" | "warning" | "outline"
> = {
  pending: "secondary",
  scanning: "warning",
  uploading: "default",
  synced: "success",
  retrying: "warning",
  completed: "success",
  failed: "destructive",
  paused: "outline",
  skipped: "outline",
};

export function TaskDetailDrawer({
  task,
  provider,
  open,
  progress,
  onOpenChange,
  onPause,
  onResume,
  onRetry,
  onRestore,
  onCancel,
}: TaskDetailDrawerProps) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const destination = task?.destinations.find(
    (item) => item.provider === provider,
  );
  const status = destination?.status ?? task?.status;
  const uploadedFiles = progress?.uploadedFiles ?? destination?.uploadedFiles ?? 0;
  const totalFiles = progress?.totalFiles ?? destination?.totalFiles ?? 0;
  const uploadedBytes = progress?.uploadedBytes ?? destination?.uploadedBytes ?? 0;
  const totalBytes = progress?.totalBytes ?? destination?.totalBytes ?? 0;
  const percent = totalFiles > 0 ? (uploadedFiles / totalFiles) * 100 : 0;
  const errorText = destination?.errorMessage || task?.errorMessage || null;

  useEffect(() => {
    if (!open || !task) return;
    let ignore = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    fetchTaskDetail(task.id)
      .then((nextDetail) => {
        if (!ignore) setDetail(nextDetail);
      })
      .catch((err) => {
        if (!ignore) setError(String(err));
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [open, task?.id, task]);

  const footer = useMemo(() => {
    if (!task || !status) return null;
    return (
      <div className="flex flex-wrap justify-end gap-2">
        {task.status === "uploading" && status === "uploading" && (
          <Button variant="outline" size="sm" onClick={() => onPause(task.id)}>
            <Pause className="mr-1 h-4 w-4" />
            暂停
          </Button>
        )}
        {task.status === "paused" && (
          <Button variant="outline" size="sm" onClick={() => onResume(task.id)}>
            <Play className="mr-1 h-4 w-4" />
            恢复
          </Button>
        )}
        {status === "failed" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRetry(task.id, provider)}
          >
            <RotateCcw className="mr-1 h-4 w-4" />
            重试此云端
          </Button>
        )}
        {task.status === "skipped" && (
          <Button variant="outline" size="sm" onClick={() => onRestore(task.id)}>
            <Play className="mr-1 h-4 w-4" />
            恢复监控
          </Button>
        )}
        {(task.status === "pending" ||
          task.status === "scanning" ||
          task.status === "uploading" ||
          task.status === "retrying" ||
          task.status === "paused" ||
          task.status === "failed") && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => onCancel(task.id)}
          >
            <X className="mr-1 h-4 w-4" />
            跳过工作次
          </Button>
        )}
      </div>
    );
  }, [
    onCancel,
    onPause,
    onRestore,
    onResume,
    onRetry,
    provider,
    status,
    task,
  ]);

  if (!task) return null;

  return (
    <SideDrawer
      open={open}
      title={task.folderName}
      description={task.folderPath}
      footer={footer}
      onOpenChange={onOpenChange}
    >
      <div className="space-y-4">
        <div className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge variant={STATUS_VARIANT[status || "pending"] || "secondary"}>
                {TASK_STATUS_LABELS[status || "pending"] || status}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {CLOUD_PROVIDER_LABELS[provider]}
              </span>
              {task.ruleName && (
                <span className="text-xs text-muted-foreground">
                  Rule: {task.ruleName}
                </span>
              )}
            </div>
            {status === "uploading" && progress?.speed ? (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <ArrowUpFromLine className="h-3 w-3" />
                {formatSpeed(progress.speed)}
              </div>
            ) : null}
          </div>
          <Progress value={percent} className="mt-3" />
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              文件 {uploadedFiles} / {totalFiles}
            </span>
            <span>
              大小 {formatBytes(uploadedBytes)} / {formatBytes(totalBytes)}
            </span>
            {progress && (
              <>
                <span>排队 {progress.queuedFiles}</span>
                <span>上传中 {progress.activeUploads}</span>
                <span>失败 {progress.failedFiles}</span>
                <span>跳过 {progress.skippedFiles}</span>
              </>
            )}
          </div>
          {progress?.currentFile && status === "uploading" && (
            <div className="mt-2 truncate text-xs text-muted-foreground">
              正在上传: {progress.currentFile}
            </div>
          )}
          {errorText && (
            <div className="mt-2 whitespace-pre-wrap break-all text-xs text-destructive">
              错误: {errorText}
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 text-sm font-medium">文件详情</div>
          {loading && (
            <div className="rounded-md border px-3 py-8 text-center text-sm text-muted-foreground">
              正在加载文件详情...
            </div>
          )}
          {!loading && error && (
            <EmptyState title="文件详情加载失败" description={error} />
          )}
          {!loading && !error && detail && detail.files.length === 0 && (
            <EmptyState title="尚未发现文件" description="扫描完成后会在这里显示文件状态。" />
          )}
          {!loading && !error && detail && detail.files.length > 0 && (
            <div className="max-h-[55vh] overflow-auto rounded-md border text-xs">
              {detail.files.map((file) => {
                const fileDestination = file.destinations.find(
                  (item) => item.provider === provider,
                );
                const fileStatus = fileDestination?.status || file.status;
                return (
                  <div
                    key={`${file.id}:${provider}`}
                    className="border-b p-2 last:border-b-0"
                  >
                    <div className="flex justify-between gap-3">
                      <span className="break-all">{file.relativePath}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {TASK_STATUS_LABELS[fileStatus] || fileStatus}
                      </span>
                    </div>
                    {(fileDestination?.errorMessage || file.errorMessage) && (
                      <div className="mt-1 break-all text-destructive">
                        {fileDestination?.errorMessage || file.errorMessage}
                      </div>
                    )}
                    {fileDestination?.plannedObjectKey && (
                      <div className="mt-1 break-all font-mono text-muted-foreground">
                        {fileDestination.plannedObjectKey}
                      </div>
                    )}
                    {file.nextRetryAt && (
                      <div className="mt-1 text-muted-foreground">
                        下次重试：
                        {new Date(file.nextRetryAt).toLocaleString("zh-CN")}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </SideDrawer>
  );
}
