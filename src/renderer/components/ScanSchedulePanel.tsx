import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Radar,
  ChevronDown,
  ChevronUp,
  FolderSearch,
  Clock,
  CheckCircle,
  AlertCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { PathTree } from "@/components/PathTree";
import { getScannerStatus } from "@/lib/ipc-client";
import { buildPathTreeFromPaths } from "@/lib/path-tree";
import type { ScannerStatus } from "@shared/types";
import { IPC } from "@shared/ipc-channels";

export function ScanSchedulePanel() {
  const [status, setStatus] = useState<ScannerStatus | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [countdown, setCountdown] = useState("");
  const watchedDirectoryTree = useMemo(
    () => buildPathTreeFromPaths(status?.watchedDirectories ?? []),
    [status?.watchedDirectories],
  );

  const loadStatus = useCallback(async () => {
    const s = await getScannerStatus();
    setStatus(s);
  }, []);

  useEffect(() => {
    loadStatus();

    // 监听扫描事件
    const off = window.api.on(
      IPC.SCANNER_EVENT,
      (_event: unknown, data: unknown) => {
        setStatus(data as ScannerStatus);
      }
    );

    return () => {
      off();
    };
  }, [loadStatus]);

  // 倒计时更新
  useEffect(() => {
    if (!status?.nextScanAt) {
      setCountdown("");
      return;
    }

    const timer = setInterval(() => {
      const next = new Date(status.nextScanAt!).getTime();
      const diff = Math.max(0, Math.floor((next - Date.now()) / 1000));
      if (diff <= 0) {
        setCountdown("即将扫描...");
      } else {
        const m = Math.floor(diff / 60);
        const s = diff % 60;
        setCountdown(m > 0 ? `${m}分${s}秒` : `${s}秒`);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [status?.nextScanAt]);

  if (!status) return null;

  return (
    <Card className="mb-4">
      <CardContent className="p-3">
        {/* 状态条 */}
        <div
          className="flex items-center justify-between cursor-pointer"
          onClick={() => setCollapsed(!collapsed)}
        >
          <div className="flex items-center gap-2">
            <Radar
              className={`h-4 w-4 ${
                status.running ? "text-green-500" : "text-muted-foreground"
              }`}
            />
            <span className="text-sm font-medium">扫描器</span>
            <Badge variant={status.running ? "default" : "outline"}>
              {status.running ? "运行中" : "已停止"}
            </Badge>
            {status.pendingStabilityChecks.length > 0 && (
              <Badge variant="secondary">
                {status.pendingStabilityChecks.length} 个待检查
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {countdown && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                下次: {countdown}
              </span>
            )}
            {status.lastScanAt && (
              <span>
                上次: {new Date(status.lastScanAt).toLocaleTimeString()}
              </span>
            )}
            {collapsed ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronUp className="h-4 w-4" />
            )}
          </div>
        </div>

        {/* 展开详情 */}
        {!collapsed && (
          <div className="mt-3 space-y-2">
            {/* 上次扫描结果 */}
            {status.lastScanResults && (
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <FolderSearch className="h-3 w-3" />
                  扫描 {status.lastScanResults.scannedDirs} 个目录
                </span>
                {status.lastScanResults.newDirsFound > 0 && (
                  <span className="flex items-center gap-1 text-blue-500">
                    <AlertCircle className="h-3 w-3" />
                    新发现 {status.lastScanResults.newDirsFound} 个
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <CheckCircle className="h-3 w-3" />
                  已注册 {status.lastScanResults.existingDirs} 个
                </span>
                {status.lastScanResults.ignoredDirectories > 0 && (
                  <span className="flex items-center gap-1 text-amber-600">
                    <AlertCircle className="h-3 w-3" />
                    已忽略目录 {status.lastScanResults.ignoredDirectories} 个
                  </span>
                )}
              </div>
            )}

            {/* 监控目录 */}
            {status.watchedDirectories.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  监控目录 ({status.watchedDirectories.length})
                </div>
                <div className="space-y-2">
                  <PathTree
                    nodes={watchedDirectoryTree}
                    className="rounded-md border bg-muted/20 p-1"
                    rowClassName="text-xs"
                  />
                </div>
              </div>
            )}

            {/* 稳定性检查队列 */}
            {status.pendingStabilityChecks.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  稳定性检查中
                </div>
                {status.pendingStabilityChecks.map((item) => {
                  const percent =
                    item.requiredChecks > 0
                      ? (item.checks / item.requiredChecks) * 100
                      : 0;
                  const dirName = item.path.split("/").pop() || item.path;
                  return (
                    <div
                      key={item.path}
                      className="flex items-center gap-2 text-xs mb-1"
                    >
                      <span className="truncate flex-1 text-muted-foreground">
                        {dirName}
                      </span>
                      <Progress value={percent} className="w-20 h-1.5" />
                      <span className="text-muted-foreground w-8 text-right">
                        {item.checks}/{item.requiredChecks}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
