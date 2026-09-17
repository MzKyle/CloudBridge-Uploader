import { useCallback, useEffect, useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { showToast } from "@/components/ui/toast";
import { fetchSettings, saveSettings, selectFolder } from "@/lib/ipc-client";
import type { AppSettings } from "@shared/types";

type SettingsDraft = Pick<AppSettings, "scan" | "upload" | "stability" | "cleanup" | "log">;

export default function SettingsPage() {
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSettings()
      .then((settings) => {
        setDraft({
          scan: settings.scan,
          upload: settings.upload,
          stability: settings.stability,
          cleanup: settings.cleanup,
          log: settings.log,
        });
      })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : String(error), "error");
      });
  }, []);

  const update = useCallback(<K extends keyof SettingsDraft>(
    section: K,
    value: SettingsDraft[K],
  ) => {
    setDraft((current) => current ? { ...current, [section]: value } : current);
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await saveSettings(draft);
      showToast("设置已保存", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving(false);
    }
  }, [draft]);

  if (!draft) {
    return (
      <div className="p-6">
        <PageHeader title="设置" description="加载中..." />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="设置"
        description="配置扫描、上传、稳定性检测、自动清理和日志。"
        actions={
          <Button onClick={save} disabled={saving}>
            <Save className="mr-2 h-4 w-4" />
            保存
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>扫描</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <NumberField
            label="扫描间隔（秒）"
            value={draft.scan.intervalSeconds}
            min={5}
            onChange={(value) => update("scan", { ...draft.scan, intervalSeconds: value })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>上传</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <NumberField
            label="最大任务并发"
            value={draft.upload.maxConcurrentTasks}
            min={1}
            onChange={(value) => update("upload", { ...draft.upload, maxConcurrentTasks: value })}
          />
          <NumberField
            label="单任务文件并发"
            value={draft.upload.maxFilesPerTask}
            min={1}
            onChange={(value) => update("upload", { ...draft.upload, maxFilesPerTask: value })}
          />
          <NumberField
            label="全局上传并发"
            value={draft.upload.maxConcurrentUploads}
            min={1}
            onChange={(value) => update("upload", { ...draft.upload, maxConcurrentUploads: value })}
          />
          <NumberField
            label="分片阈值（MB）"
            value={Math.round(draft.upload.multipartThreshold / 1024 / 1024)}
            min={5}
            onChange={(value) => update("upload", {
              ...draft.upload,
              multipartThreshold: value * 1024 * 1024,
            })}
          />
          <TextField
            label="开始时间"
            value={draft.upload.startAfterTime || ""}
            placeholder="20:30"
            onChange={(value) => update("upload", {
              ...draft.upload,
              startAfterTime: value || null,
            })}
          />
          <TextField
            label="结束时间"
            value={draft.upload.endBeforeTime || ""}
            placeholder="23:59"
            onChange={(value) => update("upload", {
              ...draft.upload,
              endBeforeTime: value || null,
            })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>稳定性与清理</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <NumberField
            label="稳定检查间隔（毫秒）"
            value={draft.stability.checkIntervalMs}
            min={500}
            onChange={(value) => update("stability", { ...draft.stability, checkIntervalMs: value })}
          />
          <NumberField
            label="稳定检查次数"
            value={draft.stability.checkCount}
            min={1}
            onChange={(value) => update("stability", { ...draft.stability, checkCount: value })}
          />
          <NumberField
            label="清理保留天数"
            value={draft.cleanup.retentionDays}
            min={0}
            onChange={(value) => update("cleanup", { ...draft.cleanup, retentionDays: value })}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.cleanup.enabled}
              onChange={(event) => update("cleanup", {
                ...draft.cleanup,
                enabled: event.target.checked,
              })}
            />
            启用自动清理
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>日志</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-[1fr_auto_180px]">
          <TextField
            label="日志目录"
            value={draft.log.directory}
            placeholder="默认 userData/logs"
            onChange={(value) => update("log", { ...draft.log, directory: value })}
          />
          <div className="flex items-end">
            <Button
              variant="outline"
              onClick={async () => {
                const folder = await selectFolder();
                if (folder) update("log", { ...draft.log, directory: folder });
              }}
            >
              选择
            </Button>
          </div>
          <NumberField
            label="日志保留天数"
            value={draft.log.maxDays}
            min={1}
            onChange={(value) => update("log", { ...draft.log, maxDays: value })}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input
        type="number"
        min={min}
        value={value}
        onChange={(event) => onChange(Math.max(min, Number(event.target.value) || min))}
      />
    </div>
  );
}

function TextField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
