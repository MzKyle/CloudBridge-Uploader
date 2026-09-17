import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { FolderSearch, Save, TestTube2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { showToast } from "@/components/ui/toast";
import { fetchSettings, saveSettings, testConnection as testCloudConnection } from "@/lib/ipc-client";
import type { AppSettings } from "@shared/types";
import { useNavigate } from "react-router-dom";

export default function CloudConnections() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetchSettings()
      .then(setSettings)
      .catch((error) => showToast(error instanceof Error ? error.message : String(error), "error"));
  }, []);

  const save = useCallback(async () => {
    if (!settings) return;
    try {
      await saveSettings({
        oss: settings.oss,
        tencentS3: settings.tencentS3,
      });
      showToast("云端连接已保存", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    }
  }, [settings]);

  const testConnection = useCallback(async (kind: "aliyun" | "s3") => {
    if (!settings) return;
    setTesting(kind);
    try {
      const result = kind === "aliyun"
        ? await testCloudConnection({
          connectionId: "aliyun-prod",
          type: "aliyun-oss",
          config: settings.oss,
        })
        : await testCloudConnection({
          connectionId: "s3-compatible",
          type: "s3",
          config: settings.tencentS3,
        });
      showToast(result.ok ? "连接测试通过" : result.error || "连接测试失败", result.ok ? "success" : "error");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setTesting(null);
    }
  }, [settings]);

  if (!settings) {
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
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate("/oss-browser")}>
              <FolderSearch className="mr-2 h-4 w-4" />
              浏览对象
            </Button>
            <Button onClick={save}>
              <Save className="mr-2 h-4 w-4" />
              保存
            </Button>
          </div>
        }
      />

      <div className="grid gap-5 xl:grid-cols-2">
        <ConnectionCard
          title="aliyun-prod"
          testing={testing === "aliyun"}
          onTest={() => testConnection("aliyun")}
        >
          <Field label="Endpoint" value={settings.oss.endpoint} onChange={(endpoint) => setSettings({
            ...settings,
            oss: { ...settings.oss, endpoint },
          })} />
          <Field label="Region" value={settings.oss.region} onChange={(region) => setSettings({
            ...settings,
            oss: { ...settings.oss, region },
          })} />
          <Field label="Bucket" value={settings.oss.bucket} onChange={(bucket) => setSettings({
            ...settings,
            oss: { ...settings.oss, bucket },
          })} />
          <Field label="Prefix" value={settings.oss.prefix} onChange={(prefix) => setSettings({
            ...settings,
            oss: { ...settings.oss, prefix },
          })} />
          <Field label="Access Key ID" value={settings.oss.accessKeyId} onChange={(accessKeyId) => setSettings({
            ...settings,
            oss: { ...settings.oss, accessKeyId },
          })} />
          <Field label="Access Key Secret" type="password" value={settings.oss.accessKeySecret} onChange={(accessKeySecret) => setSettings({
            ...settings,
            oss: { ...settings.oss, accessKeySecret },
          })} />
        </ConnectionCard>

        <ConnectionCard
          title="s3-compatible"
          testing={testing === "s3"}
          onTest={() => testConnection("s3")}
        >
          <Field label="Endpoint" value={settings.tencentS3.endpoint} onChange={(endpoint) => setSettings({
            ...settings,
            tencentS3: { ...settings.tencentS3, endpoint },
          })} />
          <Field label="Region" value={settings.tencentS3.region} onChange={(region) => setSettings({
            ...settings,
            tencentS3: { ...settings.tencentS3, region },
          })} />
          <Field label="Bucket" value={settings.tencentS3.bucket} onChange={(bucket) => setSettings({
            ...settings,
            tencentS3: { ...settings.tencentS3, bucket },
          })} />
          <Field label="Prefix" value={settings.tencentS3.prefix} onChange={(prefix) => setSettings({
            ...settings,
            tencentS3: { ...settings.tencentS3, prefix },
          })} />
          <Field label="Access Key ID" value={settings.tencentS3.accessKeyId} onChange={(accessKeyId) => setSettings({
            ...settings,
            tencentS3: { ...settings.tencentS3, accessKeyId },
          })} />
          <Field label="Access Key Secret" type="password" value={settings.tencentS3.accessKeySecret} onChange={(accessKeySecret) => setSettings({
            ...settings,
            tencentS3: { ...settings.tencentS3, accessKeySecret },
          })} />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.tencentS3.allowInsecureTls}
              onChange={(event) => setSettings({
                ...settings,
                tencentS3: { ...settings.tencentS3, allowInsecureTls: event.target.checked },
              })}
            />
            允许自签名 TLS
          </label>
        </ConnectionCard>
      </div>
    </div>
  );
}

function ConnectionCard({
  title,
  testing,
  onTest,
  children,
}: {
  title: string;
  testing: boolean;
  onTest: () => void;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>{title}</CardTitle>
        <Button variant="outline" onClick={onTest} disabled={testing}>
          <TestTube2 className="mr-2 h-4 w-4" />
          测试连接
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        {children}
      </CardContent>
    </Card>
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
