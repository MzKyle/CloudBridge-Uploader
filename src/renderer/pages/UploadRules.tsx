import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  Save,
  Trash2,
  Wand2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { showToast } from "@/components/ui/toast";
import { dryRunUploadRule, fetchSettings, saveSettings, selectFolder } from "@/lib/ipc-client";
import type {
  AppSettings,
  CompletionPolicy,
  UploadRule,
  UploadRuleDryRunResult,
  UploadRuleDryRunRootPreview,
  UploadRuleDryRunTaskPreview,
} from "@shared/types";

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
  const [dryRunResult, setDryRunResult] = useState<UploadRuleDryRunResult | null>(null);
  const [dryRunError, setDryRunError] = useState("");
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const selected = useMemo(
    () => settings?.rules.find((rule) => rule.id === selectedId) || settings?.rules[0],
    [settings, selectedId],
  );

  useEffect(() => {
    fetchSettings()
      .then((value) => {
        setSettings(value);
        setSelectedId(value.activeRuleId);
      })
      .catch((error) => showToast(error instanceof Error ? error.message : String(error), "error"));
  }, []);

  const updateRule = useCallback((rule: UploadRule) => {
    setDryRunResult(null);
    setDryRunError("");
    setSettings((current) => {
      if (!current) return current;
      return {
        ...current,
        rules: current.rules.map((item) => item.id === rule.id ? rule : item),
      };
    });
  }, []);

  const save = useCallback(async () => {
    if (!settings) return;
    const validationErrors = settings.rules.flatMap(validateCompletionPolicyForUi);
    if (validationErrors.length > 0) {
      showToast(validationErrors[0], "error");
      return;
    }
    try {
      await saveSettings({
        rules: settings.rules,
        activeRuleId: selected?.id || settings.activeRuleId,
      });
      showToast("上传规则已保存", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    }
  }, [settings, selected?.id]);

  const addRule = useCallback(() => {
    const id = `rule-${Date.now()}`;
    const base = settings?.rules[0];
    if (!settings || !base) return;
    const next: UploadRule = {
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
      rules: [...settings.rules, next],
      activeRuleId: id,
    });
    setSelectedId(id);
    setDryRunResult(null);
    setDryRunError("");
  }, [settings]);

  const deleteRule = useCallback(() => {
    if (!settings || !selected || settings.rules.length <= 1) return;
    const rules = settings.rules.filter((rule) => rule.id !== selected.id);
    setSettings({
      ...settings,
      rules,
      activeRuleId: rules[0].id,
    });
    setSelectedId(rules[0].id);
    setDryRunResult(null);
    setDryRunError("");
  }, [settings, selected]);

  const runDryRun = useCallback(async () => {
    if (!selected) return;
    setDryRunLoading(true);
    setDryRunError("");
    setDryRunResult(null);
    try {
      const result = await dryRunUploadRule({
        ruleId: selected.id,
        rule: selected,
        sampleLimit: 50,
      });
      setDryRunResult(result);
    } catch (error) {
      setDryRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setDryRunLoading(false);
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
            {settings.rules.map((rule) => (
              <button
                key={rule.id}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${
                  rule.id === selected.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
                onClick={() => {
                  setSelectedId(rule.id);
                  setDryRunResult(null);
                  setDryRunError("");
                }}
              >
                <div className="font-medium">{rule.name}</div>
                <div className="text-xs opacity-80">{rule.enabled ? "启用" : "停用"}</div>
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
                onChange={(name) => updateRule({ ...selected, name })}
              />
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.enabled}
                  onChange={(event) => updateRule({ ...selected, enabled: event.target.checked })}
                />
                启用规则
              </label>
              <TextField
                label="Source Roots"
                value={selected.source.roots.join("\n")}
                multiline
                onChange={(value) => {
                  const roots = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
                  updateRule({ ...selected, source: { roots } });
                }}
              />
              <div className="flex items-end">
                <Button
                  variant="outline"
                  onClick={async () => {
                    const folder = await selectFolder();
                    if (!folder) return;
                    const roots = Array.from(new Set([...selected.source.roots, folder]));
                    updateRule({ ...selected, source: { roots } });
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
                onChange={(groupPattern) => updateRule({
                  ...selected,
                  discovery: { ...selected.discovery, groupPattern },
                })}
              />
              <TextField
                label="Task Pattern"
                value={selected.discovery.taskPattern || ""}
                placeholder="{session:HH-mm-ss}"
                onChange={(taskPattern) => updateRule({
                  ...selected,
                  discovery: { ...selected.discovery, taskPattern },
                })}
              />
              <TextField
                label="Group Regex"
                value={selected.discovery.groupRegex || ""}
                onChange={(groupRegex) => updateRule({
                  ...selected,
                  discovery: { ...selected.discovery, groupRegex },
                })}
              />
              <TextField
                label="Task Regex"
                value={selected.discovery.taskRegex || ""}
                onChange={(taskRegex) => updateRule({
                  ...selected,
                  discovery: { ...selected.discovery, taskRegex },
                })}
              />
              <div className="space-y-2">
                <Label>Destinations</Label>
                <div className="rounded-md border p-2">
                  {settings.connections.map((connection) => {
                    const checked = selected.destinations.some((item) => item.connectionId === connection.id);
                    return (
                      <label key={connection.id} className="flex items-center gap-2 py-1 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            const destinations = event.target.checked
                              ? [...selected.destinations, { connectionId: connection.id }]
                              : selected.destinations.filter((item) => item.connectionId !== connection.id);
                            updateRule({ ...selected, destinations });
                          }}
                        />
                        {connection.name} <span className="text-xs text-muted-foreground">({connection.id})</span>
                      </label>
                    );
                  })}
                </div>
              </div>
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
                  onChange={(event) => updateRule({
                    ...selected,
                    pathMapping: { mode: event.target.value as UploadRule["pathMapping"]["mode"] },
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
                onChange={(template) => updateRule({
                  ...selected,
                  pathMapping: { ...selected.pathMapping, template },
                })}
              />
              <div className="space-y-2">
                <Label>Completion</Label>
                <select
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={selected.completion.mode}
                  onChange={(event) => updateRule({
                    ...selected,
                    completion: completionFor(event.target.value as CompletionPolicy["mode"], selected.completion),
                  })}
                >
                  {completionModes.map((mode) => (
                    <option key={mode} value={mode}>{mode}</option>
                  ))}
                </select>
              </div>
              {selected.completion.mode === "inactivity" && (
                <NumberField
                  label="Idle Minutes"
                  value={selected.completion.idleMinutes}
                  min={1}
                  onChange={(idleMinutes) => updateRule({
                    ...selected,
                    completion: { mode: "inactivity", idleMinutes },
                  })}
                />
              )}
              {selected.completion.mode === "marker-file" && (
                <TextField
                  label="Marker File"
                  value={selected.completion.markerFile}
                  placeholder="COMPLETE"
                  onChange={(markerFile) => updateRule({
                    ...selected,
                    completion: { mode: "marker-file", markerFile },
                  })}
                />
              )}
              <NumberField
                label="Cleanup Retention Days"
                value={selected.cleanup.retentionDays}
                min={0}
                onChange={(retentionDays) => updateRule({
                  ...selected,
                  cleanup: { ...selected.cleanup, retentionDays },
                })}
              />
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.cleanup.enabled}
                  onChange={(event) => updateRule({
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
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={runDryRun} disabled={dryRunLoading}>
                  {dryRunLoading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Wand2 className="mr-2 h-4 w-4" />
                  )}
                  Dry Run
                </Button>
                <Button
                  variant="destructive"
                  onClick={deleteRule}
                  disabled={settings.rules.length <= 1}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  删除规则
                </Button>
              </div>
              {dryRunError && (
                <MessageList title="Dry Run Failed" items={[dryRunError]} tone="error" />
              )}
              {dryRunResult && <DryRunResultView result={dryRunResult} />}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function DryRunResultView({ result }: { result: UploadRuleDryRunResult }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {result.ok ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-green-200 bg-green-50 px-2 py-1 text-sm text-green-700">
            <CheckCircle2 className="h-4 w-4" />
            Rule 可用
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-sm text-red-700">
            <XCircle className="h-4 w-4" />
            Dry Run Failed
          </span>
        )}
        <span className="text-sm text-muted-foreground">{result.ruleName}</span>
      </div>

      <div className="grid gap-2 sm:grid-cols-5">
        <Metric label="Roots" value={result.totals.roots} />
        <Metric label="Groups" value={result.totals.groups} />
        <Metric label="Tasks" value={result.totals.tasks} />
        <Metric label="Files" value={result.totals.filesScanned} />
        <Metric label="Samples" value={result.totals.sampledFiles} />
      </div>

      {result.errors.length > 0 && (
        <MessageList title="Errors" items={result.errors} tone="error" />
      )}
      {result.warnings.length > 0 && (
        <MessageList title="Warnings" items={result.warnings} tone="warning" />
      )}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-muted-foreground">Source Roots</h3>
        {result.roots.map((root) => (
          <RootPreview key={root.sourceRoot} root={root} />
        ))}
      </section>
    </div>
  );
}

function RootPreview({ root }: { root: UploadRuleDryRunRootPreview }) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {root.ok ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
          ) : (
            <XCircle className="h-4 w-4 shrink-0 text-red-600" />
          )}
          <span className="truncate font-mono text-sm">{root.sourceRoot}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {root.totals.groups} Groups / {root.totals.tasks} Tasks / {root.totals.filesScanned} Files
        </span>
      </div>

      {root.errors.length > 0 && (
        <MessageList title="Errors" items={root.errors} tone="error" compact />
      )}
      {root.warnings.length > 0 && (
        <MessageList title="Warnings" items={root.warnings} tone="warning" compact />
      )}

      <div className="mt-3 space-y-3">
        {root.groups.map((group) => (
          <div key={group.folderPath} className="rounded-md border bg-muted/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">{group.groupKey}</div>
                <div className="font-mono text-xs text-muted-foreground">{group.folderPath}</div>
              </div>
              <span className="text-xs text-muted-foreground">{group.tasks.length} Tasks</span>
            </div>
            {Object.keys(group.variables).length > 0 && (
              <VariableList variables={group.variables} />
            )}
            <div className="mt-3 space-y-2">
              {group.tasks.map((task) => (
                <TaskPreview key={task.folderPath} task={task} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TaskPreview({ task }: { task: UploadRuleDryRunTaskPreview }) {
  return (
    <div className="rounded-md border bg-background p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">
            {task.taskKey}
            {task.ignored && <span className="ml-2 text-xs text-muted-foreground">ignored</span>}
          </div>
          <div className="font-mono text-xs text-muted-foreground">{task.folderPath}</div>
        </div>
        <span className="text-xs text-muted-foreground">{task.filesScanned} Files</span>
      </div>
      {Object.keys(task.variables).length > 0 && (
        <VariableList variables={task.variables} />
      )}
      {task.sampleFiles.length > 0 && (
        <div className="mt-2 space-y-2">
          {task.sampleFiles.slice(0, 8).map((file) => (
            <div key={file.relativePath} className="rounded border px-2 py-1">
              <div className="font-mono text-xs">{file.relativePath}</div>
              <div className="mt-1 space-y-1">
                {file.objectKeys.map((objectKey) => (
                  <div
                    key={`${file.relativePath}:${objectKey.connectionId}:${objectKey.key}`}
                    className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-[160px_1fr]"
                  >
                    <span>{objectKey.connectionId}</span>
                    <span className="break-all font-mono">{objectKey.key}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function MessageList({
  title,
  items,
  tone,
  compact,
}: {
  title: string;
  items: string[];
  tone: "error" | "warning";
  compact?: boolean;
}) {
  const Icon = tone === "error" ? XCircle : AlertTriangle;
  const toneClass =
    tone === "error"
      ? "border-red-200 bg-red-50 text-red-800"
      : "border-yellow-200 bg-yellow-50 text-yellow-800";
  return (
    <div className={`rounded-md border ${toneClass} ${compact ? "mt-2 p-2" : "p-3"}`}>
      <div className="mb-1 flex items-center gap-1 text-sm font-medium">
        <Icon className="h-4 w-4" />
        {title}
      </div>
      <ul className="space-y-1 text-xs">
        {items.map((item) => (
          <li key={item} className="break-all">{item}</li>
        ))}
      </ul>
    </div>
  );
}

function VariableList({ variables }: { variables: Record<string, string> }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {Object.entries(variables).map(([key, value]) => (
        <span key={key} className="rounded border bg-background px-1.5 py-0.5 text-xs text-muted-foreground">
          {key}={value}
        </span>
      ))}
    </div>
  );
}

function completionFor(
  mode: CompletionPolicy["mode"],
  current: CompletionPolicy,
): CompletionPolicy {
  if (mode === "inactivity") {
    return {
      mode,
      idleMinutes: current.mode === "inactivity" ? current.idleMinutes : 60,
    };
  }
  if (mode === "marker-file") {
    return {
      mode,
      markerFile: current.mode === "marker-file" ? current.markerFile : "COMPLETE",
    };
  }
  return { mode };
}

function validateCompletionPolicyForUi(rule: UploadRule): string[] {
  const { completion } = rule;
  if (completion.mode === "inactivity" && completion.idleMinutes <= 0) {
    return [`${rule.name}: Idle Minutes 必须大于 0`];
  }
  if (completion.mode === "marker-file") {
    const markerFile = completion.markerFile.trim();
    if (!markerFile) return [`${rule.name}: Marker File 不能为空`];
    if (isAbsolutePath(markerFile)) return [`${rule.name}: Marker File 不能是绝对路径`];
    if (pathSegments(markerFile).includes("..")) {
      return [`${rule.name}: Marker File 不能包含 .. 路径段`];
    }
  }
  return [];
}

function NumberField({
  label,
  value,
  min = 0,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
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

function pathSegments(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== ".");
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}
