import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Save, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { showToast } from "@/components/ui/toast";
import { dryRunUploadRule, fetchSettings, saveSettings, selectFolder } from "@/lib/ipc-client";
import type { AppSettings, CompletionPolicy, UploadProfile } from "@shared/types";

const completionModes: CompletionPolicy["mode"][] = [
  "rollover",
  "inactivity",
  "manual",
  "marker-file",
  "none",
];

export default function UploadRules() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [dryRunText, setDryRunText] = useState("");
  const selected = useMemo(
    () => settings?.profiles.find((profile) => profile.id === selectedId) || settings?.profiles[0],
    [settings, selectedId],
  );

  useEffect(() => {
    fetchSettings()
      .then((value) => {
        setSettings(value);
        setSelectedId(value.activeProfileId);
      })
      .catch((error) => showToast(error instanceof Error ? error.message : String(error), "error"));
  }, []);

  const updateProfile = useCallback((profile: UploadProfile) => {
    setSettings((current) => {
      if (!current) return current;
      return {
        ...current,
        profiles: current.profiles.map((item) => item.id === profile.id ? profile : item),
      };
    });
  }, []);

  const save = useCallback(async () => {
    if (!settings) return;
    try {
      await saveSettings({
        profiles: settings.profiles,
        activeProfileId: selected?.id || settings.activeProfileId,
      });
      showToast("上传规则已保存", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    }
  }, [settings, selected?.id]);

  const addRule = useCallback(() => {
    const id = `rule-${Date.now()}`;
    const base = settings?.profiles[0];
    if (!settings || !base) return;
    const next: UploadProfile = {
      ...base,
      id,
      name: "新上传规则",
      enabled: true,
      source: { roots: [] },
      destinations: [],
      filter: { whitelist: [], blacklist: [], regex: [], suffixes: [] },
    };
    setSettings({
      ...settings,
      profiles: [...settings.profiles, next],
      activeProfileId: id,
    });
    setSelectedId(id);
  }, [settings]);

  const deleteRule = useCallback(() => {
    if (!settings || !selected || settings.profiles.length <= 1) return;
    const profiles = settings.profiles.filter((profile) => profile.id !== selected.id);
    setSettings({
      ...settings,
      profiles,
      activeProfileId: profiles[0].id,
    });
    setSelectedId(profiles[0].id);
  }, [settings, selected]);

  const runDryRun = useCallback(async () => {
    if (!selected) return;
    const root = selected.source.roots[0];
    if (!root) {
      setDryRunText("Source Root 为空");
      return;
    }
    try {
      const result = await dryRunUploadRule({
        profileId: selected.id,
        rule: selected,
        sourceRoot: root,
        sampleLimit: 50,
      });
      setDryRunText(JSON.stringify(result, null, 2));
    } catch (error) {
      setDryRunText(error instanceof Error ? error.message : String(error));
    }
  }, [selected]);

  if (!settings || !selected) {
    return (
      <div className="p-6">
        <PageHeader title="上传规则" description="加载中..." />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="上传规则"
        description="配置本地目录发现、对象路径映射、封账和清理策略。"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={addRule}>
              <Plus className="mr-2 h-4 w-4" />
              新建
            </Button>
            <Button onClick={save}>
              <Save className="mr-2 h-4 w-4" />
              保存
            </Button>
          </div>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[240px_1fr]">
        <Card>
          <CardContent className="p-3 space-y-2">
            {settings.profiles.map((profile) => (
              <button
                key={profile.id}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${
                  profile.id === selected.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
                onClick={() => setSelectedId(profile.id)}
              >
                <div className="font-medium">{profile.name}</div>
                <div className="text-xs opacity-80">{profile.enabled ? "启用" : "停用"}</div>
              </button>
            ))}
          </CardContent>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>规则</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <TextField
                label="名称"
                value={selected.name}
                onChange={(name) => updateProfile({ ...selected, name })}
              />
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.enabled}
                  onChange={(event) => updateProfile({ ...selected, enabled: event.target.checked })}
                />
                启用规则
              </label>
              <TextField
                label="Source Roots"
                value={selected.source.roots.join("\n")}
                multiline
                onChange={(value) => {
                  const roots = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
                  updateProfile({ ...selected, source: { roots } });
                }}
              />
              <div className="flex items-end">
                <Button
                  variant="outline"
                  onClick={async () => {
                    const folder = await selectFolder();
                    if (!folder) return;
                    const roots = Array.from(new Set([...selected.source.roots, folder]));
                    updateProfile({ ...selected, source: { roots } });
                  }}
                >
                  添加目录
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Discovery 与 Destination</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <TextField
                label="Group Pattern"
                value={selected.discovery.groupPattern || ""}
                placeholder="{machine}/{date:yyyyMMdd}"
                onChange={(groupPattern) => updateProfile({
                  ...selected,
                  discovery: { ...selected.discovery, groupPattern },
                })}
              />
              <TextField
                label="Task Pattern"
                value={selected.discovery.taskPattern || ""}
                placeholder="{session:HH-mm-ss}"
                onChange={(taskPattern) => updateProfile({
                  ...selected,
                  discovery: { ...selected.discovery, taskPattern },
                })}
              />
              <TextField
                label="Group Regex"
                value={selected.discovery.groupRegex || ""}
                onChange={(groupRegex) => updateProfile({
                  ...selected,
                  discovery: { ...selected.discovery, groupRegex },
                })}
              />
              <TextField
                label="Task Regex"
                value={selected.discovery.taskRegex || ""}
                onChange={(taskRegex) => updateProfile({
                  ...selected,
                  discovery: { ...selected.discovery, taskRegex },
                })}
              />
              <TextField
                label="Destination Connection IDs"
                value={selected.destinations.map((item) => item.connectionId).join("\n")}
                multiline
                onChange={(value) => {
                  const destinations = value.split(/\r?\n/)
                    .map((connectionId) => connectionId.trim())
                    .filter(Boolean)
                    .map((connectionId) => ({ connectionId, required: true }));
                  updateProfile({ ...selected, destinations });
                }}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Path Mapping 与策略</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label>模式</Label>
                <select
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={selected.pathMapping.mode}
                  onChange={(event) => updateProfile({
                    ...selected,
                    pathMapping: { mode: event.target.value as UploadProfile["pathMapping"]["mode"] },
                  })}
                >
                  <option value="keep-relative">keep-relative</option>
                  <option value="flatten">flatten</option>
                  <option value="template">template</option>
                </select>
              </div>
              <TextField
                label="Template"
                value={selected.pathMapping.template || ""}
                placeholder="archive/{machine}/{date}/{relativePath}"
                onChange={(template) => updateProfile({
                  ...selected,
                  pathMapping: { ...selected.pathMapping, template },
                })}
              />
              <div className="space-y-2">
                <Label>Completion</Label>
                <select
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={selected.completion.mode}
                  onChange={(event) => updateProfile({
                    ...selected,
                    completion: completionFor(event.target.value as CompletionPolicy["mode"]),
                  })}
                >
                  {completionModes.map((mode) => (
                    <option key={mode} value={mode}>{mode}</option>
                  ))}
                </select>
              </div>
              <NumberField
                label="Cleanup Retention Days"
                value={selected.cleanup.retentionDays}
                onChange={(retentionDays) => updateProfile({
                  ...selected,
                  cleanup: { ...selected.cleanup, retentionDays },
                })}
              />
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.cleanup.enabled}
                  onChange={(event) => updateProfile({
                    ...selected,
                    cleanup: { ...selected.cleanup, enabled: event.target.checked },
                  })}
                />
                自动清理
              </label>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>规则检测</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button variant="outline" onClick={runDryRun}>
                <Wand2 className="mr-2 h-4 w-4" />
                Dry Run
              </Button>
              {dryRunText && (
                <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
                  {dryRunText}
                </pre>
              )}
              <Button
                variant="destructive"
                onClick={deleteRule}
                disabled={settings.profiles.length <= 1}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                删除规则
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function completionFor(mode: CompletionPolicy["mode"]): CompletionPolicy {
  if (mode === "inactivity") return { mode, idleMinutes: 60 };
  if (mode === "marker-file") return { mode, markerFile: "COMPLETE" };
  return { mode };
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input
        type="number"
        min={0}
        value={value}
        onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))}
      />
    </div>
  );
}

function TextField({
  label,
  value,
  placeholder,
  multiline,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {multiline ? (
        <textarea
          className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}
