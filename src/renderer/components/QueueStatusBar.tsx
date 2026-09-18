import { Clock, PlayCircle, ShieldAlert, TimerReset } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { UploadQueueStatus } from "@shared/types";

interface QueueStatusBarProps {
  status: UploadQueueStatus | null;
  selectedConnectionName: string;
  taskCount: number;
  uploadGroupCount: number;
}

function formatWindow(status: UploadQueueStatus | null): string {
  if (!status) return "读取中";
  const { startAfterTime, endBeforeTime } = status.uploadWindow;
  if (!startAfterTime && !endBeforeTime) return "全天可上传";
  if (startAfterTime && endBeforeTime) {
    return `${startAfterTime} - ${endBeforeTime}`;
  }
  if (startAfterTime) return `${startAfterTime} 后`;
  return `${endBeforeTime} 前`;
}

export function QueueStatusBar({
  status,
  selectedConnectionName,
  taskCount,
  uploadGroupCount,
}: QueueStatusBarProps) {
  const runningCount = status?.runningTaskIds.length ?? 0;
  const gateOpen = status?.gateOpen ?? false;
  const priorityRemaining = status?.priorityRemaining ?? 0;

  return (
    <section className="grid gap-3 rounded-lg border bg-muted/20 p-3 md:grid-cols-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-background">
          <PlayCircle className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">上传队列</div>
          <div className="mt-0.5 flex items-center gap-2">
            <Badge variant={gateOpen ? "success" : "outline"}>
              {gateOpen ? "已开启" : "已停止"}
            </Badge>
            {status?.priorityActive && (
              <span className="text-xs text-muted-foreground">
                优先剩余 {priorityRemaining}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-background">
          <TimerReset className="h-4 w-4 text-muted-foreground" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">运行中</div>
          <div className="text-sm font-medium">{runningCount} 个任务</div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-background">
          <Clock className="h-4 w-4 text-muted-foreground" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">上传时间窗</div>
          <div className="text-sm font-medium">
            {formatWindow(status)}
            {status && !status.withinUploadWindow && (
              <span className="ml-2 text-xs text-yellow-700">时间窗外</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-background">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">当前视图</div>
          <div className="text-sm font-medium">
            {selectedConnectionName} · {uploadGroupCount} 组 / {taskCount} 任务
          </div>
        </div>
      </div>
    </section>
  );
}
