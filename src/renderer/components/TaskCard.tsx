import {
  Folder,
  Pause,
  Play,
  RotateCcw,
  X,
  ArrowUpFromLine,
  ListTree,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { formatBytes, formatSpeed } from "@/lib/utils";
import type {
  Task,
  TaskProgress,
} from "@shared/types";
import { TASK_STATUS_LABELS } from "@shared/constants";

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

interface TaskCardProps {
  task: Task;
  selectedConnectionId: "all" | string;
  progress?: TaskProgress;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string, connectionId: string) => void;
  onRestore: (id: string) => void;
  onOpenDetail: (task: Task) => void;
}

export function TaskCard({
  task,
  selectedConnectionId,
  progress,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onRestore,
  onOpenDetail,
}: TaskCardProps) {
  const destinations =
    selectedConnectionId === "all"
      ? task.destinations
      : task.destinations.filter((item) => item.connectionId === selectedConnectionId);
  if (destinations.length === 0) return null;
  const destination =
    selectedConnectionId === "all" ? undefined : destinations[0];
  const retryDestination =
    destination?.status === "failed"
      ? destination
      : destinations.find((item) => item.status === "failed");
  const status = destination?.status ?? task.status;
  const uploadedFiles = progress?.uploadedFiles ?? destination?.uploadedFiles ?? task.uploadedFiles;
  const totalFiles = progress?.totalFiles ?? destination?.totalFiles ?? task.totalFiles;
  const uploadedBytes = progress?.uploadedBytes ?? destination?.uploadedBytes ?? task.uploadedBytes;
  const totalBytes = progress?.totalBytes ?? destination?.totalBytes ?? task.totalBytes;
  const speed = progress?.speed ?? 0;
  const percent = totalFiles > 0 ? (uploadedFiles / totalFiles) * 100 : 0;
  const isIgnoredDirectory =
    task.status === "skipped" && task.errorMessage === "非任务目录";
  const errorText = destination?.errorMessage || task.errorMessage;
  const canSkip =
    task.status === "pending" ||
    task.status === "scanning" ||
    task.status === "uploading" ||
    task.status === "retrying" ||
    task.status === "paused" ||
    task.status === "failed";

  return (
    <Card
      className="mb-3 cursor-pointer transition-colors hover:border-primary/60 hover:bg-muted/20"
      role="button"
      tabIndex={0}
      onClick={() => onOpenDetail(task)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetail(task);
        }
      }}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <Folder className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <span className="font-medium text-sm truncate">
              {task.folderName}
            </span>
            <Badge variant={STATUS_VARIANT[status] || "secondary"}>
              {isIgnoredDirectory
                ? "已忽略目录"
                : TASK_STATUS_LABELS[status] || status}
            </Badge>
            {destination && (
              <span className="text-xs text-muted-foreground">
                {destination.connectionName || destination.connectionId}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {task.status === "uploading" && status === "uploading" && (
              <Tooltip content="暂停任务">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="暂停任务"
                  onClick={(event) => {
                    event.stopPropagation();
                    onPause(task.id);
                  }}
                >
                  <Pause className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            )}
            {task.status === "paused" && (
              <Tooltip content="恢复任务">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="恢复任务"
                  onClick={(event) => {
                    event.stopPropagation();
                    onResume(task.id);
                  }}
                >
                  <Play className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            )}
            {retryDestination && (
              <Tooltip content="重试此云端">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="重试此云端"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRetry(task.id, retryDestination.connectionId);
                  }}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            )}
            {task.status === "skipped" && (
              <Tooltip content="恢复监控">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="恢复监控"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRestore(task.id);
                  }}
                >
                  <Play className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            )}
            {canSkip && (
              <Tooltip content="跳过此任务目录">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancel(task.id);
                  }}
                  title="跳过此任务目录"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            )}
          </div>
        </div>

        <Progress value={percent} className="mb-2" />

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <span>
              {uploadedFiles} / {totalFiles} 文件
            </span>
            <span>
              {formatBytes(uploadedBytes)} / {formatBytes(totalBytes)}
            </span>
          </div>
          {status === "uploading" && speed > 0 && (
            <div className="flex items-center gap-1">
              <ArrowUpFromLine className="h-3 w-3" />
              <span>{formatSpeed(speed)}</span>
            </div>
          )}
        </div>

        {progress && (
          <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-3">
            <span>排队 {progress.queuedFiles}</span>
            <span>上传中 {progress.activeUploads}</span>
            <span>失败 {progress.failedFiles}</span>
            <span>跳过 {progress.skippedFiles}</span>
            <span>本轮传输 {formatBytes(progress.transferredBytes)}</span>
          </div>
        )}

        {progress?.currentFile && status === "uploading" && (
          <div className="text-xs text-muted-foreground mt-1 truncate">
            正在上传: {progress.currentFile}
          </div>
        )}

        {errorText && (
          <div
            className={`text-xs mt-1 whitespace-pre-wrap break-all ${
              isIgnoredDirectory ? "text-muted-foreground" : "text-destructive"
            }`}
          >
            {isIgnoredDirectory ? "说明" : "错误"}: {errorText}
          </div>
        )}

        {selectedConnectionId === "all" && destinations.length > 1 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {destinations.map((item) => (
              <Badge
                key={item.connectionId}
                variant={STATUS_VARIANT[item.status] || "secondary"}
              >
                {(item.connectionName || item.connectionId)} · {TASK_STATUS_LABELS[item.status] || item.status}
              </Badge>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between mt-1 gap-2">
          <div className="text-xs text-muted-foreground break-all">
            {task.folderPath}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onOpenDetail(task);
            }}
          >
            <ListTree className="h-3.5 w-3.5 mr-1" />
            文件详情
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
