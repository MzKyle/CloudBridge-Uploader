import { useEffect, useState, useCallback } from "react";
import { Plus, Trash2, Wifi, Play, X, Save, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingBlock } from "@/components/ui/loading-block";
import { PageError } from "@/components/ui/page-error";
import { PageHeader } from "@/components/ui/page-header";
import { InlineFieldError } from "@/components/settings/InlineFieldError";
import { showToast } from "@/components/ui/toast";
import {
  fetchSSHMachines,
  addSSHMachine,
  deleteSSHMachine,
  testSSHConnection,
  startRsync,
  startSftp,
  fetchSettings,
} from "@/lib/ipc-client";
import type { SSHMachine, SSHMachineInput, TransferMode } from "@shared/types";

type SSHFormErrors = Partial<
  Record<
    "name" | "host" | "username" | "privateKeyPath" | "password" | "remoteDir" | "localDir",
    string
  >
>;

const EMPTY_FORM: SSHMachineInput = {
  name: "",
  host: "",
  port: 22,
  username: "root",
  authType: "key",
  privateKeyPath: "",
  password: "",
  remoteDir: "",
  localDir: "",
  bwLimit: 5000,
  cpuNice: 19,
  transferMode: "rsync",
  profileId: null,
  enabled: true,
};

export default function SSHMachines() {
  const [machines, setMachines] = useState<SSHMachine[]>([]);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; error?: string }>
  >({});
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState<SSHMachineInput>({ ...EMPTY_FORM });
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string }>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testingMachineId, setTestingMachineId] = useState<string | null>(null);
  const [transferringMachineId, setTransferringMachineId] = useState<string | null>(null);
  const [deleteMachineId, setDeleteMachineId] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<SSHFormErrors>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await fetchSSHMachines();
      setMachines(list);
    } catch (err) {
      setLoadError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    fetchSettings()
      .then((settings) => {
        setProfiles(settings.profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
        })));
        setFormData((prev) => ({
          ...prev,
          profileId: prev.profileId || settings.activeProfileId,
        }));
      })
      .catch(() => {});
  }, [load]);

  const handleTest = useCallback(async (id: string) => {
    setTestingMachineId(id);
    try {
      const result = await testSSHConnection(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
      showToast(
        result.ok ? "连接成功" : `连接失败: ${result.error}`,
        result.ok ? "success" : "error"
      );
    } finally {
      setTestingMachineId(null);
    }
  }, []);

  const handleTransfer = useCallback(
    async (machine: SSHMachine) => {
      setTransferringMachineId(machine.id);
      try {
        if (machine.transferMode === "sftp") {
          const result = await startSftp(machine.id);
          if (result.ok) {
            showToast("SFTP 直传完成", "success");
          } else {
            const errors = result.results
              .filter((item) => !item.ok)
              .map(
                (item) =>
                  `${item.provider === "aliyun" ? "阿里云" : "腾讯云"}: ${
                    item.error || "上传失败"
                  }`
              )
              .join("；");
            showToast(`SFTP 部分失败: ${errors}`, "error");
          }
        } else {
          await startRsync(machine.id);
          showToast("rsync 拉取完成，已自动创建上传任务", "success");
        }
        load();
      } catch (err) {
        showToast(`传输失败: ${err}`, "error");
      } finally {
        setTransferringMachineId(null);
      }
    },
    [load]
  );

  const performDelete = useCallback(
    async (id: string) => {
      await deleteSSHMachine(id);
      showToast("已删除", "success");
      setDeleteMachineId(null);
      load();
    },
    [load]
  );

  const validateForm = useCallback((): SSHFormErrors => {
    const errors: SSHFormErrors = {};
    if (!formData.name.trim()) errors.name = "请填写机器名称";
    if (!formData.host.trim()) errors.host = "请填写主机地址";
    if (!formData.username.trim()) errors.username = "请填写用户名";
    if (!formData.remoteDir.trim()) errors.remoteDir = "请填写远程目录";
    if (!formData.localDir.trim()) errors.localDir = "请填写本地目录";
    if (formData.authType === "key" && !formData.privateKeyPath?.trim()) {
      errors.privateKeyPath = "请填写私钥路径";
    }
    if (formData.authType === "password" && !formData.password?.trim()) {
      errors.password = "请填写密码";
    }
    return errors;
  }, [formData]);

  const handleSubmit = useCallback(async () => {
    const errors = validateForm();
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) {
      showToast("请填写必要字段", "warning");
      return;
    }
    setSubmitting(true);
    try {
      await addSSHMachine(formData);
      showToast("机器已添加", "success");
      setShowForm(false);
      setFormData({ ...EMPTY_FORM, profileId: profiles[0]?.id ?? null });
      setFormErrors({});
      load();
    } catch (err) {
      showToast(`添加失败: ${err}`, "error");
    } finally {
      setSubmitting(false);
    }
  }, [formData, load, profiles, validateForm]);

  const deleteMachine = machines.find((machine) => machine.id === deleteMachineId);

  const updateForm = useCallback(
    (patch: Partial<SSHMachineInput>) => {
      setFormData((prev) => ({ ...prev, ...patch }));
      setFormErrors((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(patch)) {
          delete next[key as keyof SSHFormErrors];
        }
        return next;
      });
    },
    [],
  );

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="远程机器"
        description="通过 SSH、rsync 或 SFTP 从内网采集机同步数据。"
        actions={
          <Button
            size="sm"
            onClick={() => {
              setShowForm(!showForm);
              if (!showForm) {
                setFormData({ ...EMPTY_FORM, profileId: profiles[0]?.id ?? null });
                setFormErrors({});
              }
            }}
          >
            {showForm ? (
              <>
                <X className="h-4 w-4 mr-1" />
                取消
              </>
            ) : (
              <>
                <Plus className="h-4 w-4 mr-1" />
                添加机器
              </>
            )}
          </Button>
        }
      />

      {loadError && (
        <PageError
          message={loadError}
          actions={
            <Button variant="outline" size="sm" onClick={load}>
              重新加载
            </Button>
          }
        />
      )}

      {/* 添加表单 */}
      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">添加远程机器</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>名称</Label>
                <Input
                  value={formData.name}
                  onChange={(e) => updateForm({ name: e.target.value })}
                  className="mt-1"
                  placeholder="如: 内网采集机1"
                />
                <InlineFieldError message={formErrors.name} />
              </div>
              <div>
                <Label>主机地址</Label>
                <Input
                  value={formData.host}
                  onChange={(e) => updateForm({ host: e.target.value })}
                  className="mt-1"
                  placeholder="192.168.1.100"
                />
                <InlineFieldError message={formErrors.host} />
              </div>
              <div>
                <Label>端口</Label>
                <Input
                  type="number"
                  value={formData.port}
                  onChange={(e) =>
                    updateForm({
                      port: Number(e.target.value),
                    })
                  }
                  className="mt-1"
                />
              </div>
              <div>
                <Label>用户名</Label>
                <Input
                  value={formData.username}
                  onChange={(e) => updateForm({ username: e.target.value })}
                  className="mt-1"
                />
                <InlineFieldError message={formErrors.username} />
              </div>
              <div>
                <Label>认证方式</Label>
                <select
                  value={formData.authType}
                  onChange={(e) =>
                    updateForm({
                      authType: e.target.value as "key" | "password",
                    })
                  }
                  className="mt-1 w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="key">密钥认证</option>
                  <option value="password">密码认证</option>
                </select>
              </div>
              {formData.authType === "key" ? (
                <div>
                  <Label>私钥路径</Label>
                  <Input
                    value={formData.privateKeyPath || ""}
                    onChange={(e) =>
                      updateForm({
                        privateKeyPath: e.target.value,
                      })
                    }
                    className="mt-1"
                    placeholder="~/.ssh/id_rsa"
                  />
                  <InlineFieldError message={formErrors.privateKeyPath} />
                </div>
              ) : (
                <div>
                  <Label>密码</Label>
                  <Input
                    type="password"
                    value={formData.password || ""}
                    onChange={(e) =>
                      updateForm({
                        password: e.target.value,
                      })
                    }
                    className="mt-1"
                  />
                  <InlineFieldError message={formErrors.password} />
                </div>
              )}
            <div>
              <Label>远程目录</Label>
                <Input
                  value={formData.remoteDir}
                  onChange={(e) => updateForm({ remoteDir: e.target.value })}
                  className="mt-1"
                  placeholder="/data/collection"
                />
                <InlineFieldError message={formErrors.remoteDir} />
              </div>
              <div>
                <Label>项目 Profile</Label>
                <select
                  value={formData.profileId || ""}
                  onChange={(e) =>
                    updateForm({ profileId: e.target.value || null })
                  }
                  className="mt-1 w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>本地目录</Label>
                <Input
                  value={formData.localDir}
                  onChange={(e) => updateForm({ localDir: e.target.value })}
                  className="mt-1"
                  placeholder="/tmp/sync"
                />
                <InlineFieldError message={formErrors.localDir} />
              </div>
              <div>
                <Label>带宽限制 (KB/s)</Label>
                <Input
                  type="number"
                  value={formData.bwLimit}
                  onChange={(e) =>
                    updateForm({
                      bwLimit: Number(e.target.value),
                    })
                  }
                  className="mt-1"
                />
              </div>
              <div>
                <Label>CPU Nice (0-19)</Label>
                <Input
                  type="number"
                  min={0}
                  max={19}
                  value={formData.cpuNice}
                  onChange={(e) =>
                    updateForm({
                      cpuNice: Number(e.target.value),
                    })
                  }
                  className="mt-1"
                />
              </div>
              <div>
                <Label>传输模式</Label>
                <select
                  value={formData.transferMode}
                  onChange={(e) =>
                    updateForm({
                      transferMode: e.target.value as TransferMode,
                    })
                  }
                  className="mt-1 w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="rsync">rsync (落盘 + 自动上传)</option>
                  <option value="sftp">SFTP (直传当前云端)</option>
                </select>
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 h-9">
                  <input
                    type="checkbox"
                    checked={formData.enabled}
                    onChange={(e) =>
                      updateForm({
                        enabled: e.target.checked,
                      })
                    }
                    className="rounded"
                  />
                  <span className="text-sm">启用</span>
                </label>
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSubmit} disabled={submitting}>
                <Save className="h-4 w-4 mr-1" />
                {submitting ? "保存中..." : "保存"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {loading && machines.length === 0 ? (
        <LoadingBlock text="正在加载远程机器..." />
      ) : machines.length === 0 && !showForm ? (
        <EmptyState
          icon={<Server className="h-5 w-5" />}
          title="暂无远程机器配置"
          description="添加机器后，可通过 SSH + rsync/SFTP 从内网机器拉取数据。"
          action={
            <Button
              size="sm"
              onClick={() => {
                setShowForm(true);
                setFormData({ ...EMPTY_FORM, profileId: profiles[0]?.id ?? null });
              }}
            >
              <Plus className="h-4 w-4 mr-1" />
              添加机器
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4">
          {machines.map((machine) => (
            <Card key={machine.id}>
              <CardContent className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 space-y-2">
                    <div>
                      <div className="font-medium">{machine.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {machine.username}@{machine.host}:{machine.port}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                    <Badge variant={machine.enabled ? "default" : "outline"}>
                      {machine.enabled ? "启用" : "禁用"}
                    </Badge>
                    <Badge variant="secondary">
                      {machine.authType === "key" ? "密钥认证" : "密码认证"}
                    </Badge>
                    <Badge variant="secondary">
                      {machine.transferMode === "sftp" ? "SFTP 直传" : "rsync"}
                    </Badge>
                    <Badge variant="outline">
                      {profiles.find((profile) => profile.id === machine.profileId)?.name || "默认归档"}
                    </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      远程: {machine.remoteDir}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      本地: {machine.localDir} · 带宽限制: {machine.bwLimit} KB/s
                      {machine.lastSyncAt && (
                        <>
                          {" "}
                          · 上次同步:{" "}
                          {new Date(machine.lastSyncAt).toLocaleString()}
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {testResults[machine.id] && (
                      <span
                        className={`text-xs ${
                          testResults[machine.id].ok
                            ? "text-green-600"
                            : "text-destructive"
                        }`}
                      >
                        {testResults[machine.id].ok ? "连接成功" : "连接失败"}
                      </span>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleTest(machine.id)}
                      disabled={testingMachineId === machine.id}
                    >
                      <Wifi className="h-3 w-3 mr-1" />
                      {testingMachineId === machine.id ? "测试中..." : "测试"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleTransfer(machine)}
                      disabled={transferringMachineId === machine.id}
                    >
                      <Play className="h-3 w-3 mr-1" />
                      {transferringMachineId === machine.id
                        ? "传输中..."
                        : machine.transferMode === "sftp"
                          ? "直传"
                          : "拉取"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => setDeleteMachineId(machine.id)}
                      title="删除机器"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {deleteMachine && (
        <ConfirmDialog
          open={Boolean(deleteMachine)}
          title="删除远程机器"
          description={`确认删除「${deleteMachine.name}」吗？这不会删除已经创建的上传任务。`}
          confirmText="删除"
          cancelText="取消"
          variant="destructive"
          onConfirm={() => performDelete(deleteMachine.id)}
          onOpenChange={(open) => {
            if (!open) setDeleteMachineId(null);
          }}
        />
      )}
    </div>
  );
}
