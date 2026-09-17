import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderSearch, Plus, Save, TestTube2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { showToast } from "@/components/ui/toast";
import { fetchSettings, saveSettings, testConnection as testCloudConnection } from "@/lib/ipc-client";
import type { AppSettings, CloudConnection, CloudConnectionType } from "@shared/types";
import { CLOUD_CONNECTION_TYPE_LABELS } from "@shared/constants";
import { useNavigate } from "react-router-dom";

const blankConfig = {
  endpoint: "",
  bucket: "",
  region: "",
  prefix: "",
  accessKeyId: "",
  accessKeySecret: "",
};

export default function CloudConnections() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [testing, setTesting] = useState(false);
  const navigate = useNavigate();

  const selected = useMemo(
    () => settings?.connections.find((connection) => connection.id === selectedId) || settings?.connections[0],
    [settings, selectedId],
  );

  useEffect(() => {
    fetchSettings()
      .then((value) => {
        setSettings(value);
        setSelectedId(value.connections[0]?.id || "");
      })
      .catch((error) => showToast(error instanceof Error ? error.message : String(error), "error"));
  }, []);

  const updateConnection = useCallback((connection: CloudConnection) => {
    setSettings((current) => current
      ? {
        ...current,
        connections: current.connections.map((item) => item.id === connection.id ? connection : item),
      }
      : current);
  }, []);

  const save = useCallback(async () => {
    if (!settings) return;
    try {
      await saveSettings({ connections: settings.connections });
      showToast("云端连接已保存", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    }
  }, [settings]);

  const addConnection = useCallback((type: CloudConnectionType) => {
    if (!settings) return;
    const id = `${type}-${Date.now()}`;
    const connection: CloudConnection = {
      id,
      name: CLOUD_CONNECTION_TYPE_LABELS[type],
      type,
      config: type === "s3"
        ? { ...blankConfig, forcePathStyle: true, allowInsecureTls: false }
        : { ...blankConfig },
    };
    setSettings({
      ...settings,
      connections: [...settings.connections, connection],
    });
    setSelectedId(id);
  }, [settings]);

  const deleteConnection = useCallback(() => {
    if (!settings || !selected) return;
    const referencedRule = settings.rules.find((rule) =>
      rule.destinations.some((destination) => destination.connectionId === selected.id),
    );
    if (referencedRule) {
      showToast(`连接正在被上传规则使用: ${referencedRule.name}`, "error");
      return;
    }
    const connections = settings.connections.filter((connection) => connection.id !== selected.id);
    setSettings({ ...settings, connections });
    setSelectedId(connections[0]?.id || "");
  }, [settings, selected]);

  const testConnection = useCallback(async () => {
    if (!selected) return;
    setTesting(true);
    try {
      const result = await testCloudConnection({
        connectionId: selected.id,
        type: selected.type,
        config: selected.config,
      });
      showToast(result.ok ? "连接测试通过" : result.error || "连接测试失败", result.ok ? "success" : "error");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setTesting(false);
    }
  }, [selected]);

  if (!settings || !selected) {
    return (
      <div className="p-6">
        <PageHeader title="云端连接" description="加载中..." />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="云端连接"
        description="管理对象存储连接并测试 Endpoint、认证和 Bucket 权限。"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => navigate("/oss-browser")}>
              <FolderSearch className="mr-2 h-4 w-4" />
              浏览对象
            </Button>
            <Button variant="outline" onClick={() => addConnection("aliyun-oss")}>
              <Plus className="mr-2 h-4 w-4" />
              Aliyun
            </Button>
            <Button variant="outline" onClick={() => addConnection("s3")}>
              <Plus className="mr-2 h-4 w-4" />
              S3
            </Button>
            <Button onClick={save}>
              <Save className="mr-2 h-4 w-4" />
              保存
            </Button>
          </div>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        <Card>
          <CardContent className="p-3 space-y-2">
            {settings.connections.map((connection) => (
              <button
                key={connection.id}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${
                  connection.id === selected.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
                onClick={() => setSelectedId(connection.id)}
              >
                <div className="font-medium">{connection.name}</div>
                <div className="text-xs opacity-80">{connection.id}</div>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="grid gap-4 p-5 md:grid-cols-2">
            <Field label="ID" value={selected.id} onChange={(id) => updateConnection({ ...selected, id })} />
            <Field label="名称" value={selected.name} onChange={(name) => updateConnection({ ...selected, name })} />
            <div className="space-y-2">
              <Label>类型</Label>
              <select
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={selected.type}
                onChange={(event) => updateConnection({
                  ...selected,
                  type: event.target.value as CloudConnectionType,
                })}
              >
                <option value="aliyun-oss">aliyun-oss</option>
                <option value="s3">s3</option>
              </select>
            </div>
            <Field label="Endpoint" value={selected.config.endpoint} onChange={(endpoint) => updateConnection({
              ...selected,
              config: { ...selected.config, endpoint },
            })} />
            <Field label="Region" value={selected.config.region} onChange={(region) => updateConnection({
              ...selected,
              config: { ...selected.config, region },
            })} />
            <Field label="Bucket" value={selected.config.bucket} onChange={(bucket) => updateConnection({
              ...selected,
              config: { ...selected.config, bucket },
            })} />
            <Field label="Prefix" value={selected.config.prefix || ""} onChange={(prefix) => updateConnection({
              ...selected,
              config: { ...selected.config, prefix },
            })} />
            <Field label="Access Key ID" value={selected.config.accessKeyId} onChange={(accessKeyId) => updateConnection({
              ...selected,
              config: { ...selected.config, accessKeyId },
            })} />
            <Field label="Access Key Secret" type="password" value={selected.config.accessKeySecret} onChange={(accessKeySecret) => updateConnection({
              ...selected,
              config: { ...selected.config, accessKeySecret },
            })} />
            {selected.type === "s3" && (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={Boolean("forcePathStyle" in selected.config ? selected.config.forcePathStyle : true)}
                    onChange={(event) => updateConnection({
                      ...selected,
                      config: { ...selected.config, forcePathStyle: event.target.checked },
                    })}
                  />
                  Force Path Style
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={Boolean("allowInsecureTls" in selected.config ? selected.config.allowInsecureTls : false)}
                    onChange={(event) => updateConnection({
                      ...selected,
                      config: { ...selected.config, allowInsecureTls: event.target.checked },
                    })}
                  />
                  允许自签名 TLS
                </label>
              </>
            )}
            <div className="flex flex-wrap gap-2 md:col-span-2">
              <Button variant="outline" onClick={testConnection} disabled={testing}>
                <TestTube2 className="mr-2 h-4 w-4" />
                测试连接
              </Button>
              <Button variant="destructive" onClick={deleteConnection}>
                <Trash2 className="mr-2 h-4 w-4" />
                删除连接
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  type = "text",
  onChange,
}: {
  label: string;
  value: string;
  type?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
