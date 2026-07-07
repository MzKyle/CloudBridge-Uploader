import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Cloud,
  FolderOpen,
  Globe,
  Plus,
  Settings as SettingsIcon,
  TestTube,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { AutoSaveStatusBadge } from "@/components/settings/AutoSaveStatusBadge";
import { InlineFieldError } from "@/components/settings/InlineFieldError";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { SettingsSectionCard } from "@/components/settings/SettingsSectionCard";
import { PathTree } from "@/components/PathTree";
import { useSettingsStore } from "@/stores/settings.store";
import { testOSS, testTencentS3, selectFolder, previewUploadPath } from "@/lib/ipc-client";
import { buildPathTreeFromPaths } from "@/lib/path-tree";
import { showToast } from "@/components/ui/toast";
import { CLOUD_PROVIDER_LABELS } from "@shared/constants";
import {
  DEFAULT_PROFILE_EXTENSIONS,
  DEFAULT_PROFILE_UPLOAD_PIPELINE,
  EXTENSION_IDS,
  UPLOAD_PIPELINE_IDS
} from "@shared/plugins";
import {
  DEFAULT_GENERIC_CONVERTER_CONFIG,
  normalizeGenericConverterConfig
} from "@shared/generic-converter";
import type { AppSettings, CloudProvider, UploadPathMode, UploadProfile } from "@shared/types";
import type { UploadPathPreview } from "@shared/upload-profile";

type SettingsSection = "global" | "profiles" | CloudProvider;
type ProfileSection =
  | "basic"
  | "directories"
  | "paths"
  | "capabilities"
  | "preview";

const uploadPathModeOptions: Array<{ value: UploadPathMode; label: string }> = [
  { value: "target-root", label: "上传到目标路径" },
  { value: "date-workdir", label: "日期/工作次" },
  { value: "keep-source", label: "保持本地结构" },
  { value: "last-segments", label: "保留末 N 级" },
  { value: "template", label: "对象 Key 模板" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyWebhookHeaders(value: unknown): string {
  return JSON.stringify(isRecord(value) ? value : {}, null, 2);
}

function parseWebhookHeaders(value: string): Record<string, string> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Webhook Header 必须是 JSON 对象");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, headerValue]) => [key, String(headerValue)]),
  );
}

function stringifyEnv(value: unknown): string {
  return JSON.stringify(isRecord(value) ? value : {}, null, 2);
}

function parseEnv(value: string): Record<string, string> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("环境变量必须是 JSON 对象");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, envValue]) => [key, String(envValue)]),
  );
}

function stringifyArgs(value: unknown): string {
  return Array.isArray(value)
    ? value.map((item) => String(item)).join("\n")
    : "";
}

function parseArgs(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export default function Settings() {
  const { settings, loading, loadSettings, saveSettings } = useSettingsStore();
  const [local, setLocal] = useState<AppSettings>(settings);
  const [ossTestResult, setOssTestResult] = useState<{
    ok: boolean;
    error?: string;
  } | null>(null);
  const [tencentTestResult, setTencentTestResult] = useState<{
    ok: boolean;
    error?: string;
  } | null>(null);
  const [autoSaveState, setAutoSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [suffixInput, setSuffixInput] = useState("");
  const [activeSection, setActiveSection] =
    useState<SettingsSection>("global");
  const [activeProfileSection, setActiveProfileSection] =
    useState<ProfileSection>("basic");
  const [editingProfileId, setEditingProfileId] = useState(settings.activeProfileId);
  const [deleteProfileId, setDeleteProfileId] = useState<string | null>(null);
  const [profilePreviewSource, setProfilePreviewSource] = useState("");
  const [profilePreview, setProfilePreview] = useState<UploadPathPreview | null>(null);
  const [profilePreviewLoading, setProfilePreviewLoading] = useState(false);
  const [webhookHeaderDrafts, setWebhookHeaderDrafts] = useState<Record<string, string>>({});
  const [webhookHeaderErrors, setWebhookHeaderErrors] = useState<Record<string, string>>({});
  const [converterEnvDrafts, setConverterEnvDrafts] = useState<Record<string, string>>({});
  const [converterEnvErrors, setConverterEnvErrors] = useState<Record<string, string>>({});
  const [converterArgsDrafts, setConverterArgsDrafts] = useState<Record<string, string>>({});
  const scanDirectoryTrees = useMemo(
    () => ({
      aliyun: buildPathTreeFromPaths(
        local.scan.providerDirectories?.aliyun ?? [],
      ),
      tencent: buildPathTreeFromPaths(
        local.scan.providerDirectories?.tencent ?? [],
      ),
    }),
    [local.scan.providerDirectories],
  );
  const editingProfile = useMemo(
    () =>
      local.profiles.find((profile) => profile.id === editingProfileId) ||
      local.profiles[0],
    [editingProfileId, local.profiles],
  );
  const profileDirectoryTrees = useMemo(
    () => ({
      aliyun: buildPathTreeFromPaths(
        editingProfile?.scan.providerDirectories.aliyun ?? [],
      ),
      tencent: buildPathTreeFromPaths(
        editingProfile?.scan.providerDirectories.tencent ?? [],
      ),
    }),
    [editingProfile],
  );

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    setLocal(settings);
    setEditingProfileId(settings.activeProfileId);
    setConverterEnvDrafts({});
    setConverterEnvErrors({});
    setConverterArgsDrafts({});
  }, [settings]);

  useEffect(() => {
    if (loading) return;

    const localSnapshot = JSON.stringify(local);
    const settingsSnapshot = JSON.stringify(settings);

    if (localSnapshot === settingsSnapshot) {
      return;
    }

    setAutoSaveState("saving");
    const timer = setTimeout(async () => {
      try {
        await saveSettings(local);
        setAutoSaveState("saved");
        setLastSavedAt(
          new Date().toLocaleTimeString("zh-CN", { hour12: false })
        );
      } catch (err) {
        setAutoSaveState("error");
        showToast(`自动保存失败: ${err}`, "error");
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [local, settings, loading, saveSettings]);

  const handleTestOSS = useCallback(async () => {
    setOssTestResult(null);
    const result = await testOSS(local.oss);
    setOssTestResult(result);
  }, [local.oss]);

  const handleTestTencent = useCallback(async () => {
    setTencentTestResult(null);
    const result = await testTencentS3(local.tencentS3);
    setTencentTestResult(result);
  }, [local.tencentS3]);

  const updateProviderDirectories = useCallback(
    (
      provider: CloudProvider,
      updater: (directories: string[]) => string[],
    ) => {
      setLocal((prev) => {
        const current = prev.scan.providerDirectories ?? {
          aliyun: [],
          tencent: [],
        };
        const providerDirectories = {
          aliyun: current.aliyun ?? [],
          tencent: current.tencent ?? [],
          [provider]: updater(current[provider] ?? []),
        };
        const directories = Array.from(
          new Set([
            ...providerDirectories.aliyun,
            ...providerDirectories.tencent,
          ]),
        );

        return {
          ...prev,
          scan: {
            ...prev.scan,
            directories,
            providerDirectories,
          },
        };
      });
    },
    [],
  );

  const handleAddScanDir = useCallback(async (provider: CloudProvider) => {
    const dir = await selectFolder();
    if (dir) {
      updateProviderDirectories(provider, (directories) =>
        directories.includes(dir) ? directories : [...directories, dir],
      );
    }
  }, [updateProviderDirectories]);

  const handleRemoveScanDir = useCallback(
    (provider: CloudProvider, dir: string) => {
      updateProviderDirectories(provider, (directories) =>
        directories.filter((d) => d !== dir),
      );
    },
    [updateProviderDirectories],
  );

  const handleAddSuffix = useCallback(() => {
    const s = suffixInput.trim();
    if (!s) return;
    const suffix = s.startsWith(".") ? s : `.${s}`;
    if (!local.filter.suffixes.includes(suffix)) {
      setLocal((prev) => ({
        ...prev,
        filter: { ...prev.filter, suffixes: [...prev.filter.suffixes, suffix] },
      }));
    }
    setSuffixInput("");
  }, [suffixInput, local.filter.suffixes]);

  const handleRemoveSuffix = useCallback((suffix: string) => {
    setLocal((prev) => ({
      ...prev,
      filter: {
        ...prev.filter,
        suffixes: prev.filter.suffixes.filter((s) => s !== suffix),
      },
    }));
  }, []);

  const handleSelectLogDir = useCallback(async () => {
    const dir = await selectFolder();
    if (dir) {
      setLocal((p) => ({ ...p, log: { ...p.log, directory: dir } }));
    }
  }, []);

  const updateProfile = useCallback((
    profileId: string,
    updater: (profile: UploadProfile) => UploadProfile,
  ) => {
    setLocal((prev) => ({
      ...prev,
      profiles: prev.profiles.map((profile) =>
        profile.id === profileId ? updater(profile) : profile,
      ),
    }));
  }, []);

  const handleAddProfile = useCallback(() => {
    const base = editingProfile || local.profiles[0];
    const baseUploadPipeline = base.uploadPipeline || DEFAULT_PROFILE_UPLOAD_PIPELINE;
    const baseExtensions = base.extensions || DEFAULT_PROFILE_EXTENSIONS;
    const id = `profile-${Date.now()}`;
    const profile: UploadProfile = {
      ...base,
      id,
      name: `${base.name} 副本`,
      enabled: true,
      scan: {
        ...base.scan,
        providerDirectories: {
          aliyun: [...base.scan.providerDirectories.aliyun],
          tencent: [...base.scan.providerDirectories.tencent],
        },
      },
      filter: {
        whitelist: [...base.filter.whitelist],
        blacklist: [...base.filter.blacklist],
        regex: [...base.filter.regex],
        suffixes: [...base.filter.suffixes],
      },
      providers: {
        aliyun: { ...base.providers.aliyun },
        tencent: { ...base.providers.tencent },
      },
      uploadPipeline: {
        id: baseUploadPipeline.id,
        config: JSON.parse(JSON.stringify(baseUploadPipeline.config)),
      },
      extensions: {
        enabledIds: [...baseExtensions.enabledIds],
        configs: JSON.parse(JSON.stringify(baseExtensions.configs)),
      },
    };
    delete profile.plugins;
    setLocal((prev) => ({
      ...prev,
      profiles: [...prev.profiles, profile],
      activeProfileId: prev.activeProfileId || id,
    }));
    setEditingProfileId(id);
  }, [editingProfile, local.profiles]);

  const performDeleteProfile = useCallback((profileId: string) => {
    setLocal((prev) => {
      if (prev.profiles.length <= 1) return prev;
      const profiles = prev.profiles.filter((profile) => profile.id !== profileId);
      const activeProfileId =
        prev.activeProfileId === profileId ? profiles[0].id : prev.activeProfileId;
      setEditingProfileId(activeProfileId);
      return { ...prev, profiles, activeProfileId };
    });
    setDeleteProfileId(null);
  }, []);

  const updateProfileProvider = useCallback((
    profileId: string,
    provider: CloudProvider,
    patch: Partial<UploadProfile["providers"][CloudProvider]>,
  ) => {
    updateProfile(profileId, (profile) => ({
      ...profile,
      providers: {
        ...profile.providers,
        [provider]: {
          ...profile.providers[provider],
          ...patch,
        },
      },
    }));
  }, [updateProfile]);

  const updateProfilePipeline = useCallback((
    profileId: string,
    pipelineId: NonNullable<UploadProfile["uploadPipeline"]>["id"],
  ) => {
    updateProfile(profileId, (profile) => ({
      ...profile,
      uploadPipeline: {
        id: pipelineId,
        config: profile.uploadPipeline?.config || {},
      },
      plugins: undefined,
    }));
  }, [updateProfile]);

  const updateProfilePipelineConfig = useCallback((
    profileId: string,
    patch: Record<string, unknown>,
  ) => {
    updateProfile(profileId, (profile) => ({
      ...profile,
      uploadPipeline: {
        id: profile.uploadPipeline?.id || DEFAULT_PROFILE_UPLOAD_PIPELINE.id,
        config: {
          ...(profile.uploadPipeline?.config || {}),
          ...patch,
        },
      },
      plugins: undefined,
    }));
  }, [updateProfile]);

  const updateProfileExtensionEnabled = useCallback((
    profileId: string,
    extensionId: string,
    enabled: boolean,
  ) => {
    updateProfile(profileId, (profile) => {
      const extensions = profile.extensions || DEFAULT_PROFILE_EXTENSIONS;
      const enabledIds = new Set(extensions.enabledIds || []);
      if (enabled) enabledIds.add(extensionId);
      else enabledIds.delete(extensionId);
      const currentConfig =
        typeof extensions.configs?.[extensionId] === "object" && extensions.configs?.[extensionId] !== null
          ? extensions.configs[extensionId] as Record<string, unknown>
          : {};

      return {
        ...profile,
        extensions: {
          enabledIds: Array.from(enabledIds),
          configs: {
            ...DEFAULT_PROFILE_EXTENSIONS.configs,
            ...(extensions.configs || {}),
            [extensionId]: {
              ...currentConfig,
              enabled,
            },
          },
        },
        plugins: undefined,
      };
    });
  }, [updateProfile]);

  const updateProfileExtensionConfig = useCallback((
    profileId: string,
    extensionId: string,
    patch: Record<string, unknown>,
  ) => {
    updateProfile(profileId, (profile) => {
      const extensions = profile.extensions || DEFAULT_PROFILE_EXTENSIONS;
      const currentConfig =
        typeof extensions.configs?.[extensionId] === "object" && extensions.configs?.[extensionId] !== null
          ? extensions.configs[extensionId] as Record<string, unknown>
          : {};
      return {
        ...profile,
        extensions: {
          enabledIds: [...(extensions.enabledIds || [])],
          configs: {
            ...DEFAULT_PROFILE_EXTENSIONS.configs,
            ...(extensions.configs || {}),
            [extensionId]: {
              ...currentConfig,
              ...patch,
            },
          },
        },
        plugins: undefined,
      };
    });
  }, [updateProfile]);

  const updateProfileDirectories = useCallback((
    profileId: string,
    provider: CloudProvider,
    updater: (directories: string[]) => string[],
  ) => {
    updateProfile(profileId, (profile) => ({
      ...profile,
      scan: {
        ...profile.scan,
        providerDirectories: {
          ...profile.scan.providerDirectories,
          [provider]: updater(profile.scan.providerDirectories[provider] ?? []),
        },
      },
    }));
  }, [updateProfile]);

  const handleAddProfileScanDir = useCallback(async (
    profileId: string,
    provider: CloudProvider,
  ) => {
    const dir = await selectFolder();
    if (!dir) return;
    updateProfileDirectories(profileId, provider, (directories) =>
      directories.includes(dir) ? directories : [...directories, dir],
    );
  }, [updateProfileDirectories]);

  const handlePreviewProfile = useCallback(async () => {
    if (!editingProfile || !profilePreviewSource.trim()) return;
    setProfilePreviewLoading(true);
    try {
      const preview = await previewUploadPath({
        profileId: editingProfile.id,
        sourcePath: profilePreviewSource.trim(),
      });
      setProfilePreview(preview);
    } catch (err) {
      showToast(`预览失败: ${err}`, "error");
      setProfilePreview(null);
    } finally {
      setProfilePreviewLoading(false);
    }
  }, [editingProfile, profilePreviewSource]);

  const updateProviderCloudConfig = useCallback(
    (
      provider: CloudProvider,
      patch: Partial<
        Pick<AppSettings["oss"], "prefix" | "pathMode" | "pathSegmentCount">
      >,
    ) => {
      setLocal((prev) =>
        provider === "aliyun"
          ? { ...prev, oss: { ...prev.oss, ...patch } }
          : { ...prev, tencentS3: { ...prev.tencentS3, ...patch } },
      );
    },
    [],
  );

  const renderUploadPathControls = (provider: CloudProvider) => {
    const config = provider === "aliyun" ? local.oss : local.tencentS3;

    return (
      <div className="grid grid-cols-2 gap-4 border-t pt-4">
        <div>
          <Label>上传路径模式</Label>
          <select
            value={config.pathMode}
            onChange={(e) =>
              updateProviderCloudConfig(provider, {
                pathMode: e.target.value as UploadPathMode,
              })
            }
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {uploadPathModeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>保留末 N 级</Label>
          <Input
            type="number"
            min={0}
            max={20}
            value={config.pathSegmentCount}
            disabled={config.pathMode !== "last-segments"}
            onChange={(e) =>
              updateProviderCloudConfig(provider, {
                pathSegmentCount: Number(e.target.value),
              })
            }
            className="mt-1"
          />
        </div>
      </div>
    );
  };

  const renderProviderDirectories = (provider: CloudProvider) => {
    const directories = local.scan.providerDirectories?.[provider] ?? [];

    return (
      <SettingsSectionCard
        title={`${CLOUD_PROVIDER_LABELS[provider]}监控目录 (${directories.length})`}
      >
          <p className="text-xs text-muted-foreground">
            根目录下仅自动扫描当天 YYYY-MM-DD 日期目录；旧日期需要手动添加具体工作次目录
          </p>
          <div className="mt-2 space-y-2">
            <PathTree
              nodes={scanDirectoryTrees[provider]}
              className="rounded-md border bg-muted/20 p-1"
              rowClassName="text-xs"
              renderActions={({ node }) => {
                const originalPath = node.items[0]?.originalPath;
                if (!originalPath) return null;

                return (
                  <button
                    type="button"
                    title={`删除 ${originalPath}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleRemoveScanDir(provider, originalPath);
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-destructive"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                );
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAddScanDir(provider)}
            >
              <Plus className="h-3 w-3 mr-1" />
              添加目录
            </Button>
          </div>
      </SettingsSectionCard>
    );
  };

  const renderProfileDirectories = (
    profile: UploadProfile,
    provider: CloudProvider,
  ) => {
    const directories = profile.scan.providerDirectories[provider] ?? [];

    return (
      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium">
              {CLOUD_PROVIDER_LABELS[provider]}监控目录 ({directories.length})
            </div>
            <div className="text-xs text-muted-foreground">
              自动扫描仍只识别当天日期目录下的工作次
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleAddProfileScanDir(profile.id, provider)}
          >
            <FolderOpen className="h-3.5 w-3.5 mr-1" />
            添加
          </Button>
        </div>
        {directories.length > 0 && (
          <PathTree
            nodes={profileDirectoryTrees[provider]}
            className="mt-2 rounded-md border bg-muted/20 p-1"
            rowClassName="text-xs"
            renderActions={({ node }) => {
              const originalPath = node.items[0]?.originalPath;
              if (!originalPath) return null;
              return (
                <button
                  type="button"
                  title={`删除 ${originalPath}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    updateProfileDirectories(profile.id, provider, (items) =>
                      items.filter((item) => item !== originalPath),
                    );
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              );
            }}
          />
        )}
      </div>
    );
  };

  const renderProfileProviderControls = (
    profile: UploadProfile,
    provider: CloudProvider,
  ) => {
    const config = profile.providers[provider];

    return (
      <div className="rounded-md border p-3 space-y-3">
        <div className="text-sm font-medium">
          {CLOUD_PROVIDER_LABELS[provider]}路径规则
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>固定前缀</Label>
            <Input
              value={config.prefix}
              onChange={(event) =>
                updateProfileProvider(profile.id, provider, {
                  prefix: event.target.value,
                })
              }
              className="mt-1"
              placeholder="可为空，例如 upload/project-a/"
            />
          </div>
          <div>
            <Label>上传路径模式</Label>
            <select
              value={config.pathMode}
              onChange={(event) =>
                updateProfileProvider(profile.id, provider, {
                  pathMode: event.target.value as UploadPathMode,
                })
              }
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {uploadPathModeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>保留末 N 级</Label>
            <Input
              type="number"
              min={0}
              max={20}
              value={config.pathSegmentCount}
              disabled={config.pathMode !== "last-segments"}
              onChange={(event) =>
                updateProfileProvider(profile.id, provider, {
                  pathSegmentCount: Number(event.target.value),
                })
              }
              className="mt-1"
            />
          </div>
          <div className="col-span-2">
            <Label>对象 Key 模板</Label>
            <Input
              value={config.objectKeyTemplate}
              disabled={config.pathMode !== "template"}
              onChange={(event) =>
                updateProfileProvider(profile.id, provider, {
                  objectKeyTemplate: event.target.value,
                })
              }
              className="mt-1 font-mono"
              placeholder="{date}/{workDir}/{relativePath}"
            />
          </div>
        </div>
      </div>
    );
  };

  const renderProfileCapabilityControls = (profile: UploadProfile) => {
    const uploadPipeline = profile.uploadPipeline || DEFAULT_PROFILE_UPLOAD_PIPELINE;
    const extensions = profile.extensions || DEFAULT_PROFILE_EXTENSIONS;
    const enabledIds = new Set(extensions.enabledIds || []);
    const module1Enabled = uploadPipeline.id === UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD;
    const webhookEnabled = enabledIds.has(EXTENSION_IDS.WEBHOOK_NOTIFIER);
    const ossBrowserEnabled = enabledIds.has(EXTENSION_IDS.OSS_BROWSER);
    const genericConverterEnabled = enabledIds.has(EXTENSION_IDS.GENERIC_CONVERTER);
    const module1Config =
      typeof uploadPipeline.config === "object" &&
      uploadPipeline.config !== null
        ? uploadPipeline.config as Record<string, unknown>
        : {};
    const webhookConfig =
      typeof extensions.configs?.[EXTENSION_IDS.WEBHOOK_NOTIFIER] === "object" &&
      extensions.configs?.[EXTENSION_IDS.WEBHOOK_NOTIFIER] !== null
        ? extensions.configs[EXTENSION_IDS.WEBHOOK_NOTIFIER] as Record<string, unknown>
        : {};
    const genericConverterConfig = normalizeGenericConverterConfig({
      ...DEFAULT_GENERIC_CONVERTER_CONFIG,
      ...(isRecord(extensions.configs?.[EXTENSION_IDS.GENERIC_CONVERTER])
        ? extensions.configs[EXTENSION_IDS.GENERIC_CONVERTER] as Record<string, unknown>
        : {}),
    });
    const webhookHeadersText =
      webhookHeaderDrafts[profile.id] ?? stringifyWebhookHeaders(webhookConfig.headers);
    const converterEnvText =
      converterEnvDrafts[profile.id] ?? stringifyEnv(genericConverterConfig.env);
    const converterArgsText =
      converterArgsDrafts[profile.id] ?? stringifyArgs(genericConverterConfig.extraArgs);

    return (
      <div className="rounded-md border p-3 space-y-4">
        <div>
          <div className="text-sm font-medium">项目能力</div>
          <div className="text-xs text-muted-foreground mt-1">
            上传流程互斥选择；扩展插件可叠加启用。任务创建后会冻结当前 Profile 快照
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>上传流程</Label>
            <select
              value={uploadPipeline.id}
              onChange={(event) =>
                updateProfilePipeline(
                  profile.id,
                  event.target.value as NonNullable<UploadProfile["uploadPipeline"]>["id"],
                )
              }
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value={UPLOAD_PIPELINE_IDS.STANDARD_UPLOAD}>通用上传</option>
              <option value={UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD}>SANY Module1 数据采集上传</option>
            </select>
          </div>
          <div>
            <Label>Module1 Station 前缀</Label>
            <Input
              value={String(module1Config.stationPrefix || "station2")}
              disabled={!module1Enabled}
              onChange={(event) =>
                updateProfilePipelineConfig(
                  profile.id,
                  { stationPrefix: event.target.value },
                )
              }
              className="mt-1"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={webhookEnabled}
              onChange={(event) =>
                updateProfileExtensionEnabled(
                  profile.id,
                  EXTENSION_IDS.WEBHOOK_NOTIFIER,
                  event.target.checked,
                )
              }
              className="rounded"
            />
            启用 Webhook 通知插件
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={ossBrowserEnabled}
              onChange={(event) =>
                updateProfileExtensionEnabled(
                  profile.id,
                  EXTENSION_IDS.OSS_BROWSER,
                  event.target.checked,
                )
              }
              className="rounded"
            />
            启用 OSS 浏览工具插件
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={genericConverterEnabled}
              onChange={(event) =>
                updateProfileExtensionEnabled(
                  profile.id,
                  EXTENSION_IDS.GENERIC_CONVERTER,
                  event.target.checked,
                )
              }
              className="rounded"
            />
            启用通用转换工具插件
          </label>
        </div>

        <div className="rounded-md border p-3 space-y-3">
          <div className="text-sm font-medium">通用转换工具</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label>Python 命令</Label>
              <Input
                value={genericConverterConfig.pythonPath}
                disabled={!genericConverterEnabled}
                onChange={(event) =>
                  updateProfileExtensionConfig(
                    profile.id,
                    EXTENSION_IDS.GENERIC_CONVERTER,
                    {
                      ...genericConverterConfig,
                      enabled: genericConverterEnabled,
                      pythonPath: event.target.value,
                    },
                  )
                }
                className="mt-1"
                placeholder="python3"
              />
            </div>
            <div>
              <Label>设备/项目标识</Label>
              <Input
                value={genericConverterConfig.deviceCode}
                disabled={!genericConverterEnabled}
                onChange={(event) =>
                  updateProfileExtensionConfig(
                    profile.id,
                    EXTENSION_IDS.GENERIC_CONVERTER,
                    {
                      ...genericConverterConfig,
                      enabled: genericConverterEnabled,
                      deviceCode: event.target.value,
                    },
                  )
                }
                className="mt-1"
              />
            </div>
            <div className="md:col-span-2">
              <Label>监控脚本路径</Label>
              <Input
                value={genericConverterConfig.monitorScriptPath}
                disabled={!genericConverterEnabled}
                onChange={(event) =>
                  updateProfileExtensionConfig(
                    profile.id,
                    EXTENSION_IDS.GENERIC_CONVERTER,
                    {
                      ...genericConverterConfig,
                      enabled: genericConverterEnabled,
                      monitorScriptPath: event.target.value,
                    },
                  )
                }
                className="mt-1 font-mono"
                placeholder="/home/kyle/sany/盖面数采上传/monitor_cover_dataset.py"
              />
            </div>
            <div className="md:col-span-2">
              <Label>转换脚本路径</Label>
              <Input
                value={genericConverterConfig.converterScriptPath}
                disabled={!genericConverterEnabled}
                onChange={(event) =>
                  updateProfileExtensionConfig(
                    profile.id,
                    EXTENSION_IDS.GENERIC_CONVERTER,
                    {
                      ...genericConverterConfig,
                      enabled: genericConverterEnabled,
                      converterScriptPath: event.target.value,
                    },
                  )
                }
                className="mt-1 font-mono"
                placeholder="/home/kyle/sany/盖面数采上传/convert_cover_dataset_to_mcap.py"
              />
            </div>
            <div>
              <Label>输入根目录</Label>
              <Input
                value={genericConverterConfig.dataRoot}
                disabled={!genericConverterEnabled}
                onChange={(event) =>
                  updateProfileExtensionConfig(
                    profile.id,
                    EXTENSION_IDS.GENERIC_CONVERTER,
                    {
                      ...genericConverterConfig,
                      enabled: genericConverterEnabled,
                      dataRoot: event.target.value,
                    },
                  )
                }
                className="mt-1 font-mono"
                placeholder="/mnt/data/data"
              />
            </div>
            <div>
              <Label>输出根目录</Label>
              <Input
                value={genericConverterConfig.outputRoot}
                disabled={!genericConverterEnabled}
                onChange={(event) =>
                  updateProfileExtensionConfig(
                    profile.id,
                    EXTENSION_IDS.GENERIC_CONVERTER,
                    {
                      ...genericConverterConfig,
                      enabled: genericConverterEnabled,
                      outputRoot: event.target.value,
                    },
                  )
                }
                className="mt-1 font-mono"
                placeholder="/mnt/data/mcap_data"
              />
            </div>
            <div>
              <Label>稳定等待秒数</Label>
              <Input
                type="number"
                min={0}
                value={genericConverterConfig.stableSeconds}
                disabled={!genericConverterEnabled}
                onChange={(event) =>
                  updateProfileExtensionConfig(
                    profile.id,
                    EXTENSION_IDS.GENERIC_CONVERTER,
                    {
                      ...genericConverterConfig,
                      enabled: genericConverterEnabled,
                      stableSeconds: Number(event.target.value),
                    },
                  )
                }
                className="mt-1"
              />
            </div>
            <div>
              <Label>轮询间隔秒数</Label>
              <Input
                type="number"
                min={1}
                value={genericConverterConfig.pollIntervalSeconds}
                disabled={!genericConverterEnabled}
                onChange={(event) =>
                  updateProfileExtensionConfig(
                    profile.id,
                    EXTENSION_IDS.GENERIC_CONVERTER,
                    {
                      ...genericConverterConfig,
                      enabled: genericConverterEnabled,
                      pollIntervalSeconds: Number(event.target.value),
                    },
                  )
                }
                className="mt-1"
              />
            </div>
            <div className="md:col-span-2">
              <Label>输出目录模板</Label>
              <Input
                value={genericConverterConfig.outputDirectoryTemplate}
                disabled={!genericConverterEnabled}
                onChange={(event) =>
                  updateProfileExtensionConfig(
                    profile.id,
                    EXTENSION_IDS.GENERIC_CONVERTER,
                    {
                      ...genericConverterConfig,
                      enabled: genericConverterEnabled,
                      outputDirectoryTemplate: event.target.value,
                    },
                  )
                }
                className="mt-1 font-mono"
                placeholder="{outputRoot}/{date}"
              />
            </div>
            <div>
              <Label>输出批次名模板</Label>
              <Input
                value={genericConverterConfig.outputBatchNameTemplate}
                disabled={!genericConverterEnabled}
                onChange={(event) =>
                  updateProfileExtensionConfig(
                    profile.id,
                    EXTENSION_IDS.GENERIC_CONVERTER,
                    {
                      ...genericConverterConfig,
                      enabled: genericConverterEnabled,
                      outputBatchNameTemplate: event.target.value,
                    },
                  )
                }
                className="mt-1 font-mono"
                placeholder="{deviceCode}_{startTs}_{endTs}"
              />
            </div>
            <div>
              <Label>输出文件名模板</Label>
              <Input
                value={genericConverterConfig.outputFileNameTemplate}
                disabled={!genericConverterEnabled}
                onChange={(event) =>
                  updateProfileExtensionConfig(
                    profile.id,
                    EXTENSION_IDS.GENERIC_CONVERTER,
                    {
                      ...genericConverterConfig,
                      enabled: genericConverterEnabled,
                      outputFileNameTemplate: event.target.value,
                    },
                  )
                }
                className="mt-1 font-mono"
                placeholder="{batchName}.mcap"
              />
            </div>
            <div className="md:col-span-2">
              <Label>输出批次目录正则</Label>
              <Input
                value={genericConverterConfig.outputBatchNamePattern}
                disabled={!genericConverterEnabled}
                onChange={(event) =>
                  updateProfileExtensionConfig(
                    profile.id,
                    EXTENSION_IDS.GENERIC_CONVERTER,
                    {
                      ...genericConverterConfig,
                      enabled: genericConverterEnabled,
                      outputBatchNamePattern: event.target.value,
                    },
                  )
                }
                className="mt-1 font-mono"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={genericConverterConfig.retryFailed}
              disabled={!genericConverterEnabled}
              onChange={(event) =>
                updateProfileExtensionConfig(
                  profile.id,
                  EXTENSION_IDS.GENERIC_CONVERTER,
                  {
                    ...genericConverterConfig,
                    enabled: genericConverterEnabled,
                    retryFailed: event.target.checked,
                  },
                )
              }
              className="rounded"
            />
            重试失败批次
          </label>
          <div>
            <Label>环境变量 (JSON)</Label>
            <textarea
              value={converterEnvText}
              disabled={!genericConverterEnabled}
              onChange={(event) => {
                setConverterEnvDrafts((prev) => ({
                  ...prev,
                  [profile.id]: event.target.value,
                }));
                setConverterEnvErrors((prev) => {
                  if (!prev[profile.id]) return prev;
                  const next = { ...prev };
                  delete next[profile.id];
                  return next;
                });
              }}
              onBlur={() => {
                try {
                  const env = parseEnv(converterEnvText);
                  updateProfileExtensionConfig(
                    profile.id,
                    EXTENSION_IDS.GENERIC_CONVERTER,
                    {
                      ...genericConverterConfig,
                      enabled: genericConverterEnabled,
                      env,
                    },
                  );
                  setConverterEnvDrafts((prev) => {
                    const next = { ...prev };
                    delete next[profile.id];
                    return next;
                  });
                  setConverterEnvErrors((prev) => {
                    const next = { ...prev };
                    delete next[profile.id];
                    return next;
                  });
                } catch (error) {
                  setConverterEnvErrors((prev) => ({
                    ...prev,
                    [profile.id]: error instanceof Error ? error.message : String(error),
                  }));
                }
              }}
              className="mt-1 min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono disabled:cursor-not-allowed disabled:opacity-50"
              placeholder={'{\n  "COVER_MCAP_WORKSPACE_SETUP": "/path/to/install/setup.bash"\n}'}
            />
            {converterEnvErrors[profile.id] && (
              <InlineFieldError message={converterEnvErrors[profile.id]} />
            )}
          </div>
          <div>
            <Label>额外参数</Label>
            <textarea
              value={converterArgsText}
              disabled={!genericConverterEnabled}
              onChange={(event) =>
                setConverterArgsDrafts((prev) => ({
                  ...prev,
                  [profile.id]: event.target.value,
                }))
              }
              onBlur={() => {
                updateProfileExtensionConfig(
                  profile.id,
                  EXTENSION_IDS.GENERIC_CONVERTER,
                  {
                    ...genericConverterConfig,
                    enabled: genericConverterEnabled,
                    extraArgs: parseArgs(converterArgsText),
                  },
                );
                setConverterArgsDrafts((prev) => {
                  const next = { ...prev };
                  delete next[profile.id];
                  return next;
                });
              }}
              className="mt-1 min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="--write-meta-json"
            />
          </div>
        </div>

        <div>
          <Label>Webhook URL</Label>
          <Input
            value={String(webhookConfig.url || "")}
            disabled={!webhookEnabled}
            onChange={(event) =>
              updateProfileExtensionConfig(
                profile.id,
                EXTENSION_IDS.WEBHOOK_NOTIFIER,
                {
                  enabled: webhookEnabled,
                  url: event.target.value,
                },
              )
            }
            className="mt-1"
            placeholder="https://example.com/webhook"
          />
        </div>
        <div>
          <Label>Webhook Headers (JSON)</Label>
          <textarea
            value={webhookHeadersText}
            disabled={!webhookEnabled}
            onChange={(event) => {
              setWebhookHeaderDrafts((prev) => ({
                ...prev,
                [profile.id]: event.target.value,
              }));
              setWebhookHeaderErrors((prev) => {
                if (!prev[profile.id]) return prev;
                const next = { ...prev };
                delete next[profile.id];
                return next;
              });
            }}
            onBlur={() => {
              try {
                const headers = parseWebhookHeaders(webhookHeadersText);
                updateProfileExtensionConfig(
                  profile.id,
                  EXTENSION_IDS.WEBHOOK_NOTIFIER,
                  {
                    enabled: webhookEnabled,
                    headers,
                  },
                );
                setWebhookHeaderDrafts((prev) => {
                  const next = { ...prev };
                  delete next[profile.id];
                  return next;
                });
                setWebhookHeaderErrors((prev) => {
                  const next = { ...prev };
                  delete next[profile.id];
                  return next;
                });
              } catch (error) {
                setWebhookHeaderErrors((prev) => ({
                  ...prev,
                  [profile.id]:
                    error instanceof Error ? error.message : String(error),
                }));
              }
            }}
            className="mt-1 min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono disabled:cursor-not-allowed disabled:opacity-50"
            placeholder='{"Authorization":"Bearer ..."}'
          />
          <InlineFieldError message={webhookHeaderErrors[profile.id]} />
        </div>
      </div>
    );
  };

  const renderProfilesSection = () => {
    if (!editingProfile) return null;

    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">项目 Profile</CardTitle>
            <Button size="sm" onClick={handleAddProfile}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              新建/复制
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[220px,1fr]">
          <div className="space-y-2">
            {local.profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                onClick={() => setEditingProfileId(profile.id)}
                className={`w-full rounded-md border px-3 py-2 text-left text-sm ${
                  editingProfile.id === profile.id
                    ? "border-primary bg-primary/10"
                    : "hover:bg-muted/50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{profile.name}</span>
                  {local.activeProfileId === profile.id && (
                    <Badge>默认</Badge>
                  )}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {profile.enabled ? "启用" : "停用"} · {profile.targetMode}
                </div>
              </button>
            ))}
          </div>

          <div className="space-y-4">
            <div className="flex flex-wrap gap-1 rounded-md border bg-muted/30 p-1">
              {[
                { id: "basic" as const, label: "基础信息" },
                { id: "directories" as const, label: "扫描目录" },
                { id: "paths" as const, label: "上传路径" },
                { id: "capabilities" as const, label: "项目能力" },
                { id: "preview" as const, label: "模板预览" },
              ].map((item) => (
                <Button
                  key={item.id}
                  variant={activeProfileSection === item.id ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setActiveProfileSection(item.id)}
                >
                  {item.label}
                </Button>
              ))}
            </div>

            {activeProfileSection === "basic" && (
              <>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Profile 名称</Label>
                <Input
                  value={editingProfile.name}
                  onChange={(event) =>
                    updateProfile(editingProfile.id, (profile) => ({
                      ...profile,
                      name: event.target.value,
                    }))
                  }
                  className="mt-1"
                />
              </div>
              <div>
                <Label>上传目标</Label>
                <select
                  value={editingProfile.targetMode}
                  onChange={(event) =>
                    updateProfile(editingProfile.id, (profile) => ({
                      ...profile,
                      targetMode: event.target.value as AppSettings["cloud"]["targetMode"],
                    }))
                  }
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="aliyun">仅阿里云</option>
                  <option value="tencent">仅腾讯云</option>
                  <option value="both">阿里云 + 腾讯云</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editingProfile.enabled}
                  onChange={(event) =>
                    updateProfile(editingProfile.id, (profile) => ({
                      ...profile,
                      enabled: event.target.checked,
                    }))
                  }
                  className="rounded"
                />
                启用 Profile
              </label>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setLocal((prev) => ({
                    ...prev,
                    activeProfileId: editingProfile.id,
                  }))
                }
              >
                <SettingsIcon className="h-3.5 w-3.5 mr-1" />
                设为默认
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteProfileId(editingProfile.id)}
                disabled={local.profiles.length <= 1}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                删除
              </Button>
            </div>

            <div>
              <Label>文件后缀过滤</Label>
              <Input
                value={editingProfile.filter.suffixes.join(", ")}
                onChange={(event) =>
                  updateProfile(editingProfile.id, (profile) => ({
                    ...profile,
                    filter: {
                      ...profile.filter,
                      suffixes: event.target.value
                        .split(",")
                        .map((item) => item.trim())
                        .filter(Boolean),
                    },
                  }))
                }
                className="mt-1"
                placeholder=".jpg, .csv, .json"
              />
            </div>
              </>
            )}

            {activeProfileSection === "directories" && (
            <div className="grid gap-3">
              {renderProfileDirectories(editingProfile, "aliyun")}
              {renderProfileDirectories(editingProfile, "tencent")}
            </div>
            )}

            {activeProfileSection === "paths" && (
            <div className="grid gap-3">
              {renderProfileProviderControls(editingProfile, "aliyun")}
              {renderProfileProviderControls(editingProfile, "tencent")}
            </div>
            )}

            {activeProfileSection === "capabilities" &&
              renderProfileCapabilityControls(editingProfile)}

            {activeProfileSection === "preview" && (
            <div className="rounded-md border p-3 space-y-3">
              <div>
                <div className="text-sm font-medium">模板预览</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  可用变量：{"{profile} {provider} {date} {yy} {yyyy} {MM} {dd} {workDir} {HH} {mm} {ss} {folderName} {sourceRelativePath} {sourceLast1} {sourceLast2} {sourceLast3} {relativePath} {filename} {stem} {ext}"}
                </div>
              </div>
              <div className="flex gap-2">
                <Input
                  value={profilePreviewSource}
                  onChange={(event) => setProfilePreviewSource(event.target.value)}
                  placeholder="/data/2026-06-27/20-46-05"
                />
                <Button
                  variant="outline"
                  onClick={handlePreviewProfile}
                  disabled={!profilePreviewSource.trim() || profilePreviewLoading}
                >
                  预览
                </Button>
              </div>
              {profilePreview && (
                <div className="space-y-2">
                  {profilePreview.providers.map((item) => (
                    <div key={item.provider} className="rounded-md bg-muted/30 p-2">
                      <div className="text-xs font-medium">
                        {CLOUD_PROVIDER_LABELS[item.provider]}
                      </div>
                      {item.keys.map((key) => (
                        <div key={key} className="break-all font-mono text-xs">
                          {key}
                        </div>
                      ))}
                      {[...item.errors, ...item.warnings].length > 0 && (
                        <div className="mt-1 text-xs text-destructive">
                          {[...item.errors, ...item.warnings].join("；")}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  };

  const settingsNavItems = [
    {
      id: "global" as const,
      label: "全局配置",
      description: "扫描、上传、过滤和日志",
      icon: <SettingsIcon className="h-4 w-4" />,
    },
    {
      id: "profiles" as const,
      label: "项目 Profile",
      description: "项目目录、路径和能力",
      icon: <Globe className="h-4 w-4" />,
    },
    {
      id: "aliyun" as const,
      label: "阿里云",
      description: "OSS 连接和监控目录",
      icon: <Cloud className="h-4 w-4" />,
    },
    {
      id: "tencent" as const,
      label: "腾讯云",
      description: "TurboS3 连接和监控目录",
      icon: <Cloud className="h-4 w-4" />,
    },
  ];
  const deleteProfile = local.profiles.find(
    (profile) => profile.id === deleteProfileId,
  );

  if (loading)
    return <div className="p-6 text-muted-foreground">加载中...</div>;

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="设置"
        description="管理扫描、上传目标、项目 Profile 和云端连接。"
        actions={
          <AutoSaveStatusBadge
            state={autoSaveState}
            lastSavedAt={lastSavedAt}
          />
        }
      />

      <div className="grid gap-6 lg:grid-cols-[240px,1fr]">
        <SettingsNav
          items={settingsNavItems}
          activeId={activeSection}
          onChange={setActiveSection}
        />
        <div className="min-w-0 space-y-6">

      {activeSection === "profiles" && renderProfilesSection()}

      {/* 扫描配置 */}
      {activeSection === "global" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">扫描配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <Label>扫描间隔 (秒)</Label>
              <Input
                type="number"
                min={5}
                value={local.scan.intervalSeconds}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    scan: {
                      ...p.scan,
                      intervalSeconds: Number(e.target.value),
                    },
                  }))
                }
                className="mt-1"
              />
            </div>
            <div className="col-span-2">
              <Label>工作次目录正则</Label>
              <Input
                value={local.scan.workDirNamePattern || "^\\d{2}-\\d{2}-\\d{2}$"}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    scan: {
                      ...p.scan,
                      workDirNamePattern: e.target.value,
                    },
                  }))
                }
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                只自动上传匹配该规则的当天工作次目录；默认匹配 20-46-05 这类目录
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <Label>稳定性检查次数</Label>
              <Input
                type="number"
                min={1}
                max={20}
                value={local.stability.checkCount}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    stability: {
                      ...p.stability,
                      checkCount: Number(e.target.value),
                    },
                  }))
                }
                className="mt-1"
              />
            </div>
            <div>
              <Label>检查间隔 (秒)</Label>
              <Input
                type="number"
                min={1}
                max={300}
                value={Math.round(local.stability.checkIntervalMs / 1000)}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    stability: {
                      ...p.stability,
                      checkIntervalMs: Number(e.target.value) * 1000,
                    },
                  }))
                }
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                每次检查间隔，总等待 = 次数 x 间隔
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
      )}

      {/* 数采模式 */}
      {activeSection === "global" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">数采模式</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={local.dataCollect.enabled}
              onChange={(e) =>
                setLocal((p) => ({
                  ...p,
                  dataCollect: { ...p.dataCollect, enabled: e.target.checked },
                }))
              }
              className="rounded"
            />
            <Label>
              启用数采模式（自动对含焊接数据的文件夹提取元信息并展示）
            </Label>
          </div>
        </CardContent>
      </Card>
      )}

      {/* 自动清理 */}
      {activeSection === "global" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">自动清理</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={local.cleanup.enabled}
              onChange={(e) =>
                setLocal((p) => ({
                  ...p,
                  cleanup: { ...p.cleanup, enabled: e.target.checked },
                }))
              }
              className="rounded"
            />
            <Label>启用自动清理（按保留天数自动删除已上传的本地文件夹）</Label>
          </div>
          <div>
            <Label>保留天数（0 表示上传完成后尽快删除）</Label>
            <Input
              type="number"
              min={0}
              max={365}
              value={local.cleanup.retentionDays}
              onChange={(e) =>
                setLocal((p) => ({
                  ...p,
                  cleanup: {
                    ...p.cleanup,
                    retentionDays: Number(e.target.value),
                  },
                }))
              }
              className="mt-1 w-32"
              disabled={!local.cleanup.enabled}
            />
            <p className="text-xs text-muted-foreground mt-1">
              仅清理自动扫描和 rsync 同步的文件夹，手动添加的不会被清理
            </p>
          </div>
        </CardContent>
      </Card>
      )}

      {/* 上传配置 */}
      {activeSection === "global" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">上传配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>上传目标</Label>
            <select
              value={local.cloud.targetMode}
              onChange={(e) =>
                setLocal((p) => ({
                  ...p,
                  cloud: {
                    ...p.cloud,
                    targetMode: e.target.value as AppSettings["cloud"]["targetMode"],
                  },
                }))
              }
              className="mt-1 w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="aliyun">仅上传阿里云</option>
              <option value="tencent">仅上传腾讯云</option>
              <option value="both">同时上传阿里云和腾讯云</option>
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              只影响之后创建的任务；已有任务保持创建时的上传目标
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
            <div>
              <Label>最大并发任务数</Label>
              <Input
                type="number"
                min={1}
                max={20}
                value={local.upload.maxConcurrentTasks}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    upload: {
                      ...p.upload,
                      maxConcurrentTasks: Number(e.target.value),
                    },
                  }))
                }
                className="mt-1"
              />
            </div>
            <div>
              <Label>单任务并发文件数</Label>
              <Input
                type="number"
                min={1}
                max={50}
                value={local.upload.maxFilesPerTask}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    upload: {
                      ...p.upload,
                      maxFilesPerTask: Number(e.target.value),
                    },
                  }))
                }
                className="mt-1"
              />
            </div>
            <div>
              <Label>全局并发上传数</Label>
              <Input
                type="number"
                min={1}
                max={200}
                value={local.upload.maxConcurrentUploads}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    upload: {
                      ...p.upload,
                      maxConcurrentUploads: Number(e.target.value),
                    },
                  }))
                }
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                跨任务全局上限
              </p>
            </div>
            <div>
              <Label>开始上传时间</Label>
              <div className="mt-1 space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="rounded"
                    checked={local.upload.startAfterTime !== null}
                    onChange={(e) =>
                      setLocal((p) => ({
                        ...p,
                        upload: {
                          ...p.upload,
                          startAfterTime: e.target.checked
                            ? p.upload.startAfterTime ?? "20:30"
                            : null,
                        },
                      }))
                    }
                  />
                  <span>启用开始时间</span>
                </label>
                <Input
                  type="time"
                  value={local.upload.startAfterTime ?? "20:30"}
                  disabled={local.upload.startAfterTime === null}
                  onChange={(e) =>
                    setLocal((p) => ({
                      ...p,
                      upload: {
                        ...p.upload,
                        startAfterTime: e.target.value || "20:30",
                      },
                    }))
                  }
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                关闭后等价于“不设置”，开始时间不限制
              </p>
            </div>
            <div>
              <Label>结束上传时间</Label>
              <div className="mt-1 space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="rounded"
                    checked={local.upload.endBeforeTime !== null}
                    onChange={(e) =>
                      setLocal((p) => ({
                        ...p,
                        upload: {
                          ...p.upload,
                          endBeforeTime: e.target.checked
                            ? p.upload.endBeforeTime ?? "23:59"
                            : null,
                        },
                      }))
                    }
                  />
                  <span>启用结束时间</span>
                </label>
                <Input
                  type="time"
                  value={local.upload.endBeforeTime ?? "23:59"}
                  disabled={local.upload.endBeforeTime === null}
                  onChange={(e) =>
                    setLocal((p) => ({
                      ...p,
                      upload: {
                        ...p.upload,
                        endBeforeTime: e.target.value || "23:59",
                      },
                    }))
                  }
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                关闭后等价于“不设置”，仅影响新任务启动，不中断进行中任务
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
      )}

      {/* OSS 配置 */}
      {activeSection === "aliyun" && (
      <>
      {renderProviderDirectories("aliyun")}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">阿里云 OSS</CardTitle>
            <div className="flex items-center gap-2">
              {ossTestResult && (
                <span
                  className={`text-xs ${
                    ossTestResult.ok ? "text-green-600" : "text-destructive"
                  }`}
                >
                  {ossTestResult.ok
                    ? "连接成功"
                    : `失败: ${ossTestResult.error}`}
                </span>
              )}
              <Button variant="outline" size="sm" onClick={handleTestOSS}>
                <TestTube className="h-3 w-3 mr-1" />
                测试连接
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Endpoint</Label>
              <Input
                value={local.oss.endpoint}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    oss: { ...p.oss, endpoint: e.target.value },
                  }))
                }
                className="mt-1"
                placeholder="oss-cn-hangzhou.aliyuncs.com"
              />
            </div>
            <div>
              <Label>Region</Label>
              <Input
                value={local.oss.region}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    oss: { ...p.oss, region: e.target.value },
                  }))
                }
                className="mt-1"
                placeholder="oss-cn-hangzhou"
              />
            </div>
            <div>
              <Label>Bucket</Label>
              <Input
                value={local.oss.bucket}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    oss: { ...p.oss, bucket: e.target.value },
                  }))
                }
                className="mt-1"
              />
            </div>
            <div>
              <Label>固定前缀 (Prefix，可为空)</Label>
              <Input
                value={local.oss.prefix}
                onChange={(e) =>
                  updateProviderCloudConfig("aliyun", { prefix: e.target.value })
                }
                className="mt-1"
                placeholder="例如 upload/"
              />
            </div>
            <div>
              <Label>AccessKey ID</Label>
              <Input
                value={local.oss.accessKeyId}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    oss: { ...p.oss, accessKeyId: e.target.value },
                  }))
                }
                className="mt-1"
              />
            </div>
            <div>
              <Label>AccessKey Secret</Label>
              <Input
                type="password"
                value={local.oss.accessKeySecret}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    oss: { ...p.oss, accessKeySecret: e.target.value },
                  }))
                }
                className="mt-1"
              />
            </div>
          </div>
          {renderUploadPathControls("aliyun")}
        </CardContent>
      </Card>
      </>
      )}

      {/* 腾讯云 TurboS3 配置 */}
      {activeSection === "tencent" && (
      <>
      {renderProviderDirectories("tencent")}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">腾讯云 TurboS3</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                S3 兼容接口，使用 V4 签名和 path-style 请求
              </p>
            </div>
            <div className="flex items-center gap-2">
              {tencentTestResult && (
                <span
                  className={`text-xs ${
                    tencentTestResult.ok ? "text-green-600" : "text-destructive"
                  }`}
                >
                  {tencentTestResult.ok
                    ? "连接成功"
                    : `失败: ${tencentTestResult.error}`}
                </span>
              )}
              <Button variant="outline" size="sm" onClick={handleTestTencent}>
                <TestTube className="h-3 w-3 mr-1" />
                测试连接
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Endpoint</Label>
              <Input
                value={local.tencentS3.endpoint}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    tencentS3: { ...p.tencentS3, endpoint: e.target.value },
                  }))
                }
                className="mt-1"
                placeholder="https://turbos3.tencentcfs.com"
              />
            </div>
            <div>
              <Label>Region</Label>
              <Input
                value={local.tencentS3.region}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    tencentS3: { ...p.tencentS3, region: e.target.value },
                  }))
                }
                className="mt-1"
                placeholder="us-east-1"
              />
            </div>
            <div>
              <Label>Bucket</Label>
              <Input
                value={local.tencentS3.bucket}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    tencentS3: { ...p.tencentS3, bucket: e.target.value },
                  }))
                }
                className="mt-1"
              />
            </div>
            <div>
              <Label>固定前缀 (Prefix，可为空)</Label>
              <Input
                value={local.tencentS3.prefix}
                onChange={(e) =>
                  updateProviderCloudConfig("tencent", {
                    prefix: e.target.value,
                  })
                }
                className="mt-1"
                placeholder="例如 upload/<user-id>/"
              />
            </div>
            <div>
              <Label>AccessKey ID</Label>
              <Input
                value={local.tencentS3.accessKeyId}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    tencentS3: { ...p.tencentS3, accessKeyId: e.target.value },
                  }))
                }
                className="mt-1"
              />
            </div>
            <div>
              <Label>AccessKey Secret</Label>
              <Input
                type="password"
                value={local.tencentS3.accessKeySecret}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    tencentS3: {
                      ...p.tencentS3,
                      accessKeySecret: e.target.value,
                    },
                  }))
                }
                className="mt-1"
              />
            </div>
          </div>
          {renderUploadPathControls("tencent")}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={local.tencentS3.allowInsecureTls}
              onChange={(e) =>
                setLocal((p) => ({
                  ...p,
                  tencentS3: {
                    ...p.tencentS3,
                    allowInsecureTls: e.target.checked,
                  },
                }))
              }
              className="rounded mt-0.5"
            />
            <span>
              允许不安全 TLS（仅在现场 TurboS3 使用无法验证的自签名证书时开启）
            </span>
          </label>
        </CardContent>
      </Card>
      </>
      )}

      {/* 文件过滤规则 */}
      {activeSection === "global" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">文件过滤规则</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>后缀过滤 (标签)</Label>
            <div className="flex flex-wrap gap-2 mt-2">
              {local.filter.suffixes.map((s) => (
                <Badge key={s} variant="secondary" className="gap-1 pr-1">
                  {s}
                  <button
                    onClick={() => handleRemoveSuffix(s)}
                    className="ml-1 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <div className="flex gap-2 mt-2">
              <Input
                value={suffixInput}
                onChange={(e) => setSuffixInput(e.target.value)}
                placeholder="输入后缀如 .jpg"
                className="w-40"
                onKeyDown={(e) => e.key === "Enter" && handleAddSuffix()}
              />
              <Button variant="outline" size="sm" onClick={handleAddSuffix}>
                添加
              </Button>
            </div>
          </div>
          <div>
            <Label>白名单 (每行一个文件名或模式，优先级最高)</Label>
            <textarea
              className="mt-1 w-full h-20 rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={local.filter.whitelist.join("\n")}
              onChange={(e) =>
                setLocal((p) => ({
                  ...p,
                  filter: {
                    ...p.filter,
                    whitelist: e.target.value.split("\n").filter(Boolean),
                  },
                }))
              }
            />
          </div>
          <div>
            <Label>黑名单 (每行一个文件名或模式)</Label>
            <textarea
              className="mt-1 w-full h-20 rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={local.filter.blacklist.join("\n")}
              onChange={(e) =>
                setLocal((p) => ({
                  ...p,
                  filter: {
                    ...p.filter,
                    blacklist: e.target.value.split("\n").filter(Boolean),
                  },
                }))
              }
            />
          </div>
          <div>
            <Label>正则表达式 (每行一个)</Label>
            <textarea
              className="mt-1 w-full h-20 rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={local.filter.regex.join("\n")}
              onChange={(e) =>
                setLocal((p) => ({
                  ...p,
                  filter: {
                    ...p.filter,
                    regex: e.target.value.split("\n").filter(Boolean),
                  },
                }))
              }
            />
          </div>
        </CardContent>
      </Card>
      )}

      {/* Webhook */}
      {activeSection === "global" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Webhook 通知</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={local.webhook.enabled}
              onChange={(e) =>
                setLocal((p) => ({
                  ...p,
                  webhook: { ...p.webhook, enabled: e.target.checked },
                }))
              }
              className="rounded"
            />
            <Label>启用 Webhook</Label>
          </div>
          <div>
            <Label>URL</Label>
            <Input
              value={local.webhook.url}
              onChange={(e) =>
                setLocal((p) => ({
                  ...p,
                  webhook: { ...p.webhook, url: e.target.value },
                }))
              }
              className="mt-1"
              placeholder="https://example.com/webhook"
            />
          </div>
        </CardContent>
      </Card>
      )}

      {/* 日志配置 */}
      {activeSection === "global" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">日志配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>日志目录 (留空使用默认目录)</Label>
            <div className="flex gap-2 mt-1">
              <Input
                value={local.log.directory}
                onChange={(e) =>
                  setLocal((p) => ({
                    ...p,
                    log: { ...p.log, directory: e.target.value },
                  }))
                }
                placeholder="默认: 应用数据目录/logs"
                className="flex-1"
              />
              <Button variant="outline" size="sm" onClick={handleSelectLogDir}>
                <FolderOpen className="h-3 w-3 mr-1" />
                选择
              </Button>
            </div>
          </div>
          <div>
            <Label>日志保留天数</Label>
            <Input
              type="number"
              min={1}
              max={365}
              value={local.log.maxDays}
              onChange={(e) =>
                setLocal((p) => ({
                  ...p,
                  log: { ...p.log, maxDays: Number(e.target.value) },
                }))
              }
              className="mt-1 w-32"
            />
          </div>
        </CardContent>
      </Card>
      )}

      {/* 快捷键 */}
      {activeSection === "global" && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">快捷键</CardTitle>
        </CardHeader>
        <CardContent>
          <div>
            <Label>切换窗口快捷键</Label>
            <Input
              value={local.hotkey}
              onChange={(e) =>
                setLocal((p) => ({ ...p, hotkey: e.target.value }))
              }
              className="mt-1 w-64"
              placeholder="CommandOrControl+Shift+U"
            />
          </div>
        </CardContent>
      </Card>
      )}
        </div>
      </div>

      {deleteProfile && (
        <ConfirmDialog
          open={Boolean(deleteProfile)}
          title="删除项目 Profile"
          description={
            local.activeProfileId === deleteProfile.id
              ? `确认删除「${deleteProfile.name}」吗？当前默认 Profile 会自动切换到列表中的第一个 Profile。`
              : `确认删除「${deleteProfile.name}」吗？已有任务仍保留创建时的 Profile 快照。`
          }
          confirmText="删除"
          cancelText="取消"
          variant="destructive"
          onConfirm={() => performDeleteProfile(deleteProfile.id)}
          onOpenChange={(open) => {
            if (!open) setDeleteProfileId(null);
          }}
        />
      )}
    </div>
  );
}
