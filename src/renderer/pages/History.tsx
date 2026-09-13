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
  fetchDayFolders,
  deleteDayFolderHistory,
  retryTask,
  fetchSettings,
} from "@/lib/ipc-client";
import type {
  CloudProvider,
  DayFolderSummary,
  HistoryItem,
} from "@shared/types";
import { providersForProfile } from "@shared/cloud-upload";
import { DayFolderCard } from "@/components/DayFolderCard";

type HistoryConfirmAction =
  | { kind: "clear" }
  | { kind: "delete-day"; item: DayFolderSummary }
  | { kind: "delete-item"; item: HistoryItem };

export default function History() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [dayFolders, setDayFolders] = useState<DayFolderSummary[]>([]);
  const [provider, setProvider] = useState<CloudProvider>("aliyun");
  const [providerReady, setProviderReady] = useState(false);
  const [confirmAction, setConfirmAction] =
    useState<HistoryConfirmAction | null>(null);
  const pageSize = 20;

  const load = useCallback(async () => {
    if (!providerReady) return;
    const result = await fetchHistory({ page, pageSize, provider });
    setItems(result.items);
    setTotal(result.total);
    const folders = await fetchDayFolders({
      includeCompleted: true,
      limit: 100,
      provider,
    });
    setDayFolders(
      folders.filter(
        (folder) =>
          folder.status === "completed" ||
          folder.status === "completed_with_skips",
      ),
    );
  }, [page, provider, providerReady]);

  useEffect(() => {
    fetchSettings()
      .then((settings) => {
        const activeProfile =
          settings.profiles.find((profile) => profile.id === settings.activeProfileId) ||
          settings.profiles[0];
        const providers = activeProfile ? providersForProfile(activeProfile) : [];
        setProvider(providers.includes("tencent") && !providers.includes("aliyun") ? "tencent" : "aliyun");
      })
      .catch(() => {})
      .finally(() => setProviderReady(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const performClear = useCallback(async () => {
    await clearHistory(undefined, provider);
    load();
  }, [load, provider]);

  const performDeleteDayFolder = useCallback(
    async (item: DayFolderSummary) => {
      setDeletingId(item.id);
      try {
        await deleteDayFolderHistory(item.id, provider);
        await load();
      } finally {
        setDeletingId(null);
      }
    },
    [load, provider]
  );

  const performDeleteItem = useCallback(
    async (item: HistoryItem) => {
      setDeletingId(item.id);
      try {
        await deleteHistoryItem(item.id, item.provider);
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
    } else if (confirmAction.kind === "delete-day") {
      await performDeleteDayFolder(confirmAction.item);
    } else {
      await performDeleteItem(confirmAction.item);
    }
    setConfirmAction(null);
  }, [
    confirmAction,
    performClear,
    performDeleteDayFolder,
    performDeleteItem,
  ]);

  const confirmDialog = (() => {
    if (!confirmAction) return null;
    if (confirmAction.kind === "clear") {
      return {
        title: "清空历史记录",
        description: "确认后会删除当前云端视图下的历史记录和日期目录汇总。",
        confirmText: "清空",
      };
    }
    if (confirmAction.kind === "delete-day") {
      return {
        title: "删除日期目录汇总",
        description: `确认删除日期目录汇总「${confirmAction.item.date}」吗？工作次历史记录不会被自动恢复。`,
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
      await retryTask(item.id, item.provider);
      await load();
    },
    [load]
  );

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="历史记录"
        description="查看已完成日期目录和工作次上传历史。"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmAction({ kind: "clear" })}
            disabled={items.length === 0 && dayFolders.length === 0}
          >
            <Trash2 className="h-4 w-4 mr-1" />
            清空历史
          </Button>
        }
      />

      <div className="inline-flex rounded-md border p-1 bg-muted/30">
        {(["aliyun", "tencent"] as CloudProvider[]).map((item) => (
          <Button
            key={item}
            variant={provider === item ? "default" : "ghost"}
            size="sm"
            onClick={() => {
              setProvider(item);
              setPage(1);
            }}
          >
            {item === "aliyun" ? "阿里云" : "腾讯云"}
          </Button>
        ))}
      </div>

      {dayFolders.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground mb-3">
            已完成日期目录
          </h2>
          {dayFolders.map((item) => (
            <div key={item.id} className="relative">
              <DayFolderCard dayFolder={item} />
              <Button
                variant="ghost"
                size="sm"
                className="absolute right-3 bottom-3 text-destructive hover:text-destructive"
                onClick={() => setConfirmAction({ kind: "delete-day", item })}
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
