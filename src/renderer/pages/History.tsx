import { useEffect, useState, useCallback } from "react";
import { Clock, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatBytes, formatDuration } from "@/lib/utils";
import {
  fetchHistory,
  clearHistory,
  deleteHistoryItem,
  fetchUploadGroups,
  deleteUploadGroupHistory,
  retryTask,
  fetchSettings,
} from "@/lib/ipc-client";
import type {
  CloudConnection,
  UploadGroupSummary,
  HistoryItem,
} from "@shared/types";
import { UploadGroupCard } from "@/components/UploadGroupCard";

type ConnectionSelection = "all" | string;

interface HistoryConnectionOption {
  id: string;
  name: string;
}

type HistoryConfirmAction =
  | { kind: "clear" }
  | { kind: "delete-group"; item: UploadGroupSummary }
  | { kind: "delete-item"; item: HistoryItem };

function connectionOption(connection: CloudConnection): HistoryConnectionOption {
  return {
    id: connection.id,
    name: connection.name.trim() || connection.id,
  };
}

export default function History() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [uploadGroups, setUploadGroups] = useState<UploadGroupSummary[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] =
    useState<ConnectionSelection>("all");
  const [connections, setConnections] = useState<HistoryConnectionOption[]>([]);
  const [settingsReady, setSettingsReady] = useState(false);
  const [confirmAction, setConfirmAction] =
    useState<HistoryConfirmAction | null>(null);
  const pageSize = 20;
  const selectedConnectionQuery =
    selectedConnectionId === "all" ? undefined : selectedConnectionId;

  const load = useCallback(async () => {
    if (!settingsReady) return;
    const result = await fetchHistory({
      page,
      pageSize,
      connectionId: selectedConnectionQuery,
    });
    setItems(result.items);
    setTotal(result.total);
    const folders = await fetchUploadGroups({
      includeCompleted: true,
      limit: 100,
      connectionId: selectedConnectionQuery,
    });
    setUploadGroups(
      folders.filter(
        (folder) =>
          folder.status === "completed" ||
          folder.status === "completed_with_skips",
      ),
    );
  }, [page, selectedConnectionQuery, settingsReady]);

  useEffect(() => {
    fetchSettings()
      .then((settings) => {
        setConnections(settings.connections.map(connectionOption));
      })
      .catch(() => {})
      .finally(() => setSettingsReady(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const performClear = useCallback(async () => {
    await clearHistory(undefined, undefined, selectedConnectionQuery);
    load();
  }, [load, selectedConnectionQuery]);

  const performDeleteUploadGroup = useCallback(
    async (item: UploadGroupSummary) => {
      setDeletingId(item.id);
      try {
        await deleteUploadGroupHistory(item.id, undefined, selectedConnectionQuery);
        await load();
      } finally {
        setDeletingId(null);
      }
    },
    [load, selectedConnectionQuery]
  );

  const performDeleteItem = useCallback(
    async (item: HistoryItem) => {
      setDeletingId(item.id);
      try {
        await deleteHistoryItem(item.id, item.provider, item.connectionId);
        if (items.length === 1 && page > 1) {
          setPage((p) => p - 1);
          return;
        }
        await load();
      } finally {
        setDeletingId(null);
      }
    },
    [items.length, load, page]
  );

  const handleConfirm = useCallback(async () => {
    if (!confirmAction) return;
    if (confirmAction.kind === "clear") {
      await performClear();
    } else if (confirmAction.kind === "delete-group") {
      await performDeleteUploadGroup(confirmAction.item);
    } else {
      await performDeleteItem(confirmAction.item);
    }
    setConfirmAction(null);
  }, [
    confirmAction,
    performClear,
    performDeleteUploadGroup,
    performDeleteItem,
  ]);

  const confirmDialog = (() => {
    if (!confirmAction) return null;
    if (confirmAction.kind === "clear") {
      return {
        title: "清空历史记录",
        description: "确认后会删除当前连接视图下的历史记录和归档组汇总。",
        confirmText: "清空",
      };
    }
    if (confirmAction.kind === "delete-group") {
      return {
        title: "删除归档组汇总",
        description: `确认删除归档组汇总「${confirmAction.item.groupKey}」吗？工作次历史记录不会被自动恢复。`,
        confirmText: "删除汇总",
      };
    }
    return {
      title: "删除历史记录",
      description: `确认删除历史记录「${confirmAction.item.folderName}」吗？`,
      confirmText: "删除",
    };
  })();

  const handleRetry = useCallback(
    async (item: HistoryItem) => {
      await retryTask(item.id, item.connectionId);
      await load();
    },
    [load]
  );

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="历史记录"
        description="查看已完成归档组和工作次上传历史。"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmAction({ kind: "clear" })}
            disabled={items.length === 0 && uploadGroups.length === 0}
          >
            <Trash2 className="h-4 w-4 mr-1" />
            清空历史
          </Button>
        }
      />

      <div className="inline-flex rounded-md border p-1 bg-muted/30">
        <Button
          variant={selectedConnectionId === "all" ? "default" : "ghost"}
          size="sm"
          onClick={() => {
            setSelectedConnectionId("all");
            setPage(1);
          }}
        >
          全部
        </Button>
        {connections.map((item) => (
          <Button
            key={item.id}
            variant={selectedConnectionId === item.id ? "default" : "ghost"}
            size="sm"
            onClick={() => {
              setSelectedConnectionId(item.id);
              setPage(1);
            }}
          >
            {item.name}
          </Button>
        ))}
      </div>

      {uploadGroups.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground mb-3">
            已完成归档组
          </h2>
          {uploadGroups.map((item) => (
            <div key={item.id} className="relative">
              <UploadGroupCard uploadGroup={item} />
              <Button
                variant="ghost"
                size="sm"
                className="absolute right-3 bottom-3 text-destructive hover:text-destructive"
                onClick={() => setConfirmAction({ kind: "delete-group", item })}
                disabled={deletingId === item.id}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                删除汇总
              </Button>
            </div>
          ))}
        </section>
      )}

      <h2 className="text-sm font-semibold text-muted-foreground">
        工作次任务
      </h2>

      {items.length === 0 ? (
        <EmptyState
          icon={<Clock className="h-5 w-5" />}
          title="暂无历史记录"
          description="上传完成或失败后会在这里显示工作次历史。"
        />
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">文件夹</th>
                <th className="text-left p-3 font-medium">连接</th>
                <th className="text-left p-3 font-medium">文件数</th>
                <th className="text-left p-3 font-medium">大小</th>
                <th className="text-left p-3 font-medium">耗时</th>
                <th className="text-left p-3 font-medium">状态</th>
                <th className="text-left p-3 font-medium">完成时间</th>
                <th className="text-left p-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t">
                  <td className="p-3">{item.folderName}</td>
                  <td className="p-3 text-muted-foreground">
                    {item.connectionName || item.connectionId}
                  </td>
                  <td className="p-3">{item.fileCount}</td>
                  <td className="p-3">{formatBytes(item.totalBytes)}</td>
                  <td className="p-3">
                    {formatDuration(item.durationSeconds)}
                  </td>
                  <td className="p-3">
                    <Badge
                      variant={
                        item.status === "completed" ? "success" : "destructive"
                      }
                    >
                      {item.status === "completed" ? "成功" : "失败"}
                    </Badge>
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {new Date(item.completedAt).toLocaleString("zh-CN")}
                  </td>
                  <td className="p-3">
                    {item.status === "failed" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRetry(item)}
                      >
                        <RotateCcw className="h-4 w-4 mr-1" />
                        重试此云端
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setConfirmAction({ kind: "delete-item", item })}
                      disabled={deletingId === item.id}
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      {deletingId === item.id ? "删除中..." : "删除"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            上一页
          </Button>
          <span className="text-sm text-muted-foreground">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      )}

      {confirmDialog && (
        <ConfirmDialog
          open={Boolean(confirmDialog)}
          title={confirmDialog.title}
          description={confirmDialog.description}
          confirmText={confirmDialog.confirmText}
          cancelText="取消"
          variant="destructive"
          onConfirm={handleConfirm}
          onOpenChange={(open) => {
            if (!open) setConfirmAction(null);
          }}
        />
      )}
    </div>
  );
}
