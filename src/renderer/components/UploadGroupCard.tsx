import { Archive, Ban, CalendarDays, Undo2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { formatBytes, formatSpeed } from "@/lib/utils";
import type { UploadGroupSummary, Task } from "@shared/types";
import { UPLOAD_GROUP_PROCESSING_STATUS_LABELS } from "@shared/constants";

const STATUS_VARIANT: Record<
  UploadGroupSummary["status"],
  "default" | "secondary" | "destructive" | "success" | "warning" | "outline"
> = {
  collecting: "secondary",
  processing: "default",
  blocked: "destructive",
  completed: "success",
  completed_with_skips: "warning",
};

export function UploadGroupCard({
  uploadGroup,
  tasks = [],
  speed = 0,
  onIgnore,
  onRestore,
  onClose,
  canCloseManually = false,
}: {
  uploadGroup: UploadGroupSummary;
  tasks?: Task[];
  speed?: number;
  onIgnore?: (id: string) => void;
  onRestore?: (id: string) => void;
  onClose?: (id: string) => void;
  canCloseManually?: boolean;
}) {
  const percent =
    uploadGroup.totalChildren > 0
      ? (uploadGroup.completedChildren / uploadGroup.totalChildren) * 100
      : 0;
  const count = (statuses: Task["status"][]) =>
    tasks.filter((task) => statuses.includes(task.status)).length;
  const ignoredDirectoryCount = tasks.filter(
    (task) => task.status === "skipped" && task.errorMessage === "非任务目录",
  ).length;
  const skippedCount = count(["skipped"]) - ignoredDirectoryCount;

  return (
    <Card className="mb-3">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-sm">{uploadGroup.groupKey}</span>
            <Badge variant={STATUS_VARIANT[uploadGroup.status]}>
              {UPLOAD_GROUP_PROCESSING_STATUS_LABELS[uploadGroup.status]}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            {uploadGroup.completedAt && (
              <span className="text-xs text-muted-foreground">
                {new Date(uploadGroup.completedAt).toLocaleString("zh-CN")}
              </span>
            )}
            {canCloseManually && onClose && !uploadGroup.ignored && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onClose(uploadGroup.id)}
              >
                <Archive className="h-3.5 w-3.5 mr-1" />
                封账
              </Button>
            )}
            {uploadGroup.ignored ? (
              onRestore && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRestore(uploadGroup.id)}
                >
                  <Undo2 className="h-3.5 w-3.5 mr-1" />
                  恢复归档组
                </Button>
              )
            ) : (
              onIgnore && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => onIgnore(uploadGroup.id)}
                >
                  <Ban className="h-3.5 w-3.5 mr-1" />
                  忽略归档组
                </Button>
              )
            )}
          </div>
        </div>

        <Progress value={percent} className="mb-2" />
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            任务目录 {uploadGroup.completedChildren} / {uploadGroup.totalChildren}
          </span>
          <span>
            文件 {uploadGroup.uploadedFiles} / {uploadGroup.totalFiles}
          </span>
          <span>
            {formatBytes(uploadGroup.uploadedBytes)} / {formatBytes(uploadGroup.totalBytes)}
          </span>
          {tasks.length > 0 && (
            <>
              <span>已同步 {count(["synced", "completed"])}</span>
              <span>上传中 {count(["uploading", "scanning", "pending"])}</span>
              <span>重试 {count(["retrying"])}</span>
              <span>需处理 {count(["failed", "paused"])}</span>
              {ignoredDirectoryCount > 0 && (
                <span>已忽略目录 {ignoredDirectoryCount}</span>
              )}
              <span>跳过 {Math.max(0, skippedCount)}</span>
            </>
          )}
          {speed > 0 && <span>总速度 {formatSpeed(speed)}</span>}
        </div>
        <div className="text-xs text-muted-foreground mt-1 truncate">
          {uploadGroup.folderPath}
        </div>
      </CardContent>
    </Card>
  );
}
