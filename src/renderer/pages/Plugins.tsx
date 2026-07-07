import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ExternalLink, Plug, Power, PowerOff, RefreshCw, Settings } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { LoadingBlock } from '@/components/ui/loading-block'
import { PageError } from '@/components/ui/page-error'
import { PageHeader } from '@/components/ui/page-header'
import { showToast } from '@/components/ui/toast'
import {
  fetchGenericConverterStatus,
  fetchProjectCapabilityStatus,
  fetchSettings,
  saveSettings,
  scanGenericConverterNow,
  startGenericConverter,
  stopGenericConverter
} from '@/lib/ipc-client'
import { providersForMode } from '@shared/cloud-upload'
import { IPC } from '@shared/ipc-channels'
import { DEFAULT_PROFILE_EXTENSIONS, EXTENSION_IDS } from '@shared/plugins'
import type { AppSettings, GenericConverterStatus, ProjectCapabilityStatus } from '@shared/types'

function formatTime(value: string | null): string {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString('zh-CN', { hour12: false })
}

function categoryLabel(category: string): string {
  if (category === 'pipeline') return '上传流程'
  if (category === 'notification') return '通知'
  if (category === 'tool') return '工具'
  return category
}

function statusVariant(status?: string): 'success' | 'warning' | 'destructive' | 'secondary' {
  if (status === 'completed') return 'success'
  if (status === 'running' || status === 'pending') return 'warning'
  if (status === 'failed') return 'destructive'
  return 'secondary'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ossConfigComplete(settings: AppSettings | null): boolean {
  return Boolean(
    settings?.oss.region &&
    settings.oss.bucket &&
    settings.oss.accessKeyId &&
    settings.oss.accessKeySecret
  )
}

export default function Plugins() {
  const navigate = useNavigate()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [profileId, setProfileId] = useState('')
  const [status, setStatus] = useState<ProjectCapabilityStatus | null>(null)
  const [genericConverterStatus, setGenericConverterStatus] =
    useState<GenericConverterStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [savingExtensionId, setSavingExtensionId] = useState<string | null>(null)
  const [converterActionProfileId, setConverterActionProfileId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirmOssOpen, setConfirmOssOpen] = useState(false)

  const profiles = useMemo(() => settings?.profiles || [], [settings])
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === profileId) || profiles[0],
    [profileId, profiles]
  )
  const selectedProfileHasAliyun = useMemo(
    () => selectedProfile ? providersForMode(selectedProfile.targetMode).includes('aliyun') : false,
    [selectedProfile]
  )

  const load = async (nextProfileId?: string) => {
    setLoading(true)
    setLoadError(null)
    try {
      const loadedSettings = await fetchSettings()
      setSettings(loadedSettings)
      const id = nextProfileId || profileId || loadedSettings.activeProfileId
      setProfileId(id)
      setStatus(await fetchProjectCapabilityStatus(id))
      setGenericConverterStatus(await fetchGenericConverterStatus())
    } catch (error) {
      setLoadError(String(error))
    } finally {
      setLoading(false)
    }
  }

  const runConverterAction = async (
    action: 'start' | 'stop' | 'scan'
  ) => {
    const targetProfileId = profileId || settings?.activeProfileId
    if (!targetProfileId) return
    setConverterActionProfileId(targetProfileId)
    try {
      if (action === 'start') await startGenericConverter(targetProfileId)
      else if (action === 'stop') await stopGenericConverter(targetProfileId)
      else await scanGenericConverterNow(targetProfileId)
      setGenericConverterStatus(await fetchGenericConverterStatus())
      showToast(
        action === 'start'
          ? '转换工具已启动'
          : action === 'stop'
            ? '转换工具已停止'
            : '已触发转换工具扫描',
        'success'
      )
    } catch (error) {
      showToast(`转换工具操作失败: ${error}`, 'error')
    } finally {
      setConverterActionProfileId(null)
    }
  }

  const updateExtension = async (
    extensionId: string,
    enabled: boolean,
    options?: { activateProfile?: boolean; silent?: boolean }
  ) => {
    const targetProfileId = profileId || settings?.activeProfileId
    if (!targetProfileId) return

    setSavingExtensionId(extensionId)
    try {
      const latest = await fetchSettings()
      const nextProfiles = latest.profiles.map((profile) => {
        if (profile.id !== targetProfileId) return profile
        const currentExtensions = profile.extensions || DEFAULT_PROFILE_EXTENSIONS
        const enabledIds = new Set(currentExtensions.enabledIds || [])
        if (enabled) enabledIds.add(extensionId)
        else enabledIds.delete(extensionId)
        const currentConfig = isRecord(currentExtensions.configs?.[extensionId])
          ? currentExtensions.configs[extensionId] as Record<string, unknown>
          : {}
        const nextProfile = {
          ...profile,
          extensions: {
            enabledIds: Array.from(enabledIds),
            configs: {
              ...DEFAULT_PROFILE_EXTENSIONS.configs,
              ...(currentExtensions.configs || {}),
              [extensionId]: {
                ...currentConfig,
                enabled
              }
            }
          },
          plugins: undefined
        }
        return nextProfile
      })

      await saveSettings({
        profiles: nextProfiles,
        activeProfileId: options?.activateProfile ? targetProfileId : latest.activeProfileId
      })
      await load(targetProfileId)
      if (!options?.silent) {
        showToast(enabled ? '扩展插件已启用' : '扩展插件已停用', 'success')
      }
    } catch (error) {
      showToast(`扩展插件更新失败: ${error}`, 'error')
      throw error
    } finally {
      setSavingExtensionId(null)
    }
  }

  const openOssBrowser = async (confirmed: boolean = false) => {
    if (!selectedProfileHasAliyun) {
      showToast('OSS 浏览需要当前 Profile 包含阿里云目标', 'warning')
      return
    }
    if (!ossConfigComplete(settings)) {
      showToast('请先完善阿里云 OSS 连接配置', 'warning')
      navigate('/settings')
      return
    }

    const ossStatus = status?.extensions.find((item) => item.manifest.id === EXTENSION_IDS.OSS_BROWSER)
    if ((!ossStatus?.enabled || settings?.activeProfileId !== profileId) && !confirmed) {
      setConfirmOssOpen(true)
      return
    }
    if (!ossStatus?.enabled || settings?.activeProfileId !== profileId) {
      await updateExtension(EXTENSION_IDS.OSS_BROWSER, true, {
        activateProfile: true,
        silent: true
      })
    }
    navigate('/oss-browser')
  }

  useEffect(() => {
    load().catch(() => {})
  }, [])

  useEffect(() => {
    const off = window.api.on(
      IPC.GENERIC_CONVERTER_EVENT,
      (_event: unknown, data: unknown) => {
        setGenericConverterStatus(data as GenericConverterStatus)
      }
    )
    return () => off()
  }, [])

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="项目能力"
        description={`当前 Profile: ${status?.profileName || '-'}`}
        actions={
          <>
          <select
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={profileId}
            onChange={(event) => {
              const nextId = event.target.value
              setProfileId(nextId)
              load(nextId).catch(() => {})
            }}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
          <Button size="sm" onClick={() => navigate('/settings')}>
            <Settings className="h-4 w-4 mr-1" />
            配置
          </Button>
          </>
        }
      />

      {loadError && (
        <PageError
          message={loadError}
          actions={
            <Button variant="outline" size="sm" onClick={() => load()}>
              <RefreshCw className="h-4 w-4 mr-1" />
              重新加载
            </Button>
          }
        />
      )}

      {!loadError && selectedProfileHasAliyun && settings && !ossConfigComplete(settings) && (
        <PageError
          message="当前 Profile 包含阿里云目标，但阿里云 OSS 连接配置不完整。OSS 浏览工具需要先完善 Region、Bucket 和 AccessKey。"
          actions={
            <Button variant="outline" size="sm" onClick={() => navigate('/settings')}>
              <Settings className="h-4 w-4 mr-1" />
              去设置
            </Button>
          }
        />
      )}

      {loading && !status && <LoadingBlock text="正在加载项目能力..." />}

      {!loading && !loadError && !status && (
        <EmptyState
          icon={<Plug className="h-5 w-5" />}
          title="暂无项目能力信息"
          description="请选择 Profile 或刷新后查看当前项目能力。"
        />
      )}

      {status?.uploadPipeline && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <CardTitle className="text-base leading-6">
                {status.uploadPipeline.manifest.name}
              </CardTitle>
              <Badge variant="success">当前流程</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{categoryLabel(status.uploadPipeline.manifest.category)}</Badge>
              <span className="text-xs text-muted-foreground">v{status.uploadPipeline.manifest.version}</span>
            </div>
            <p className="text-muted-foreground">{status.uploadPipeline.manifest.description}</p>
            <div className="text-xs border rounded-md px-3 py-2 bg-muted/30">
              配置摘要: {status.uploadPipeline.configSummary || '-'}
            </div>
            <div className="text-xs text-muted-foreground space-y-1">
              <div>
                最近运行:{' '}
                {status.uploadPipeline.lastRun ? (
                  <Badge variant={statusVariant(status.uploadPipeline.lastRun.status)}>
                    {status.uploadPipeline.lastRun.status}
                  </Badge>
                ) : (
                  '-'
                )}
              </div>
              <div>开始时间: {formatTime(status.uploadPipeline.lastRun?.startedAt || null)}</div>
              <div>结束时间: {formatTime(status.uploadPipeline.lastRun?.completedAt || null)}</div>
              {status.uploadPipeline.lastRun?.errorMessage && (
                <div className="text-destructive break-all">
                  {status.uploadPipeline.lastRun.errorMessage}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(status?.extensions || []).map((item) => (
          <Card key={item.manifest.id}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <CardTitle className="text-base leading-6">{item.manifest.name}</CardTitle>
                <Badge variant={item.enabled ? 'success' : 'secondary'}>
                  {item.enabled ? '已启用' : '未启用'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{categoryLabel(item.manifest.category)}</Badge>
                <span className="text-xs text-muted-foreground">v{item.manifest.version}</span>
              </div>
              <p className="text-muted-foreground min-h-[44px]">{item.manifest.description}</p>
              <div className="text-xs border rounded-md px-3 py-2 bg-muted/30">
                配置摘要: {item.configSummary || '-'}
              </div>
              {item.manifest.id === EXTENSION_IDS.GENERIC_CONVERTER && (() => {
                const runtime = genericConverterStatus?.profiles.find(
                  (profile) => profile.profileId === profileId
                )
                const runtimeRunning =
                  runtime?.state === 'running' || runtime?.state === 'starting'
                return (
                  <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>运行状态:</span>
                      <Badge variant={runtimeRunning ? 'success' : runtime?.lastError ? 'destructive' : 'secondary'}>
                        {runtime?.state || '-'}
                      </Badge>
                      {runtime?.pid && <span>PID: {runtime.pid}</span>}
                    </div>
                    <div className="break-all">输入: {runtime?.dataRoot || '-'}</div>
                    <div className="break-all">输出: {runtime?.outputRoot || '-'}</div>
                    {runtime?.lastError && (
                      <div className="text-destructive break-all">{runtime.lastError}</div>
                    )}
                    {runtime?.recentLogs && runtime.recentLogs.length > 0 && (
                      <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-background p-2 font-mono text-[11px]">
                        {runtime.recentLogs.slice(-8).join('\n')}
                      </pre>
                    )}
                  </div>
                )
              })()}
              <div className="text-xs text-muted-foreground space-y-1">
                <div>
                  最近运行:{' '}
                  {item.lastRun ? (
                    <Badge variant={statusVariant(item.lastRun.status)}>{item.lastRun.status}</Badge>
                  ) : (
                    '-'
                  )}
                </div>
                <div>开始时间: {formatTime(item.lastRun?.startedAt || null)}</div>
                <div>结束时间: {formatTime(item.lastRun?.completedAt || null)}</div>
                {item.lastRun?.errorMessage && (
                  <div className="text-destructive break-all">{item.lastRun.errorMessage}</div>
                )}
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  size="sm"
                  variant={item.enabled ? 'outline' : 'default'}
                  disabled={savingExtensionId === item.manifest.id}
                  onClick={() => updateExtension(item.manifest.id, !item.enabled).catch(() => {})}
                >
                  {item.enabled ? (
                    <PowerOff className="h-4 w-4 mr-1" />
                  ) : (
                    <Power className="h-4 w-4 mr-1" />
                  )}
                  {item.enabled ? '停用' : '启用'}
                </Button>
                {item.manifest.id === EXTENSION_IDS.OSS_BROWSER && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={savingExtensionId === item.manifest.id || !selectedProfileHasAliyun}
                    onClick={() => openOssBrowser().catch(() => {})}
                  >
                    <ExternalLink className="h-4 w-4 mr-1" />
                    {item.enabled ? '打开 OSS 浏览' : '启用并打开'}
                  </Button>
                )}
                {item.manifest.id === EXTENSION_IDS.GENERIC_CONVERTER && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        converterActionProfileId === profileId ||
                        !item.enabled ||
                        ['running', 'starting'].includes(
                          genericConverterStatus?.profiles.find((profile) => profile.profileId === profileId)?.state || ''
                        )
                      }
                      onClick={() => runConverterAction('start')}
                    >
                      <Power className="h-4 w-4 mr-1" />
                      启动
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        converterActionProfileId === profileId ||
                        !['running', 'starting'].includes(
                          genericConverterStatus?.profiles.find((profile) => profile.profileId === profileId)?.state || ''
                        )
                      }
                      onClick={() => runConverterAction('stop')}
                    >
                      <PowerOff className="h-4 w-4 mr-1" />
                      停止
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={converterActionProfileId === profileId || !item.enabled}
                      onClick={() => runConverterAction('scan')}
                    >
                      <RefreshCw className="h-4 w-4 mr-1" />
                      立即扫描
                    </Button>
                  </>
                )}
                {item.manifest.id === EXTENSION_IDS.WEBHOOK_NOTIFIER && (
                  <Button size="sm" variant="outline" onClick={() => navigate('/settings')}>
                    <Settings className="h-4 w-4 mr-1" />
                    配置通知
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <ConfirmDialog
        open={confirmOssOpen}
        title="启用并打开 OSS 浏览"
        description="将自动启用当前 Profile 的 OSS 浏览工具，并把当前 Profile 设为默认 Profile，然后打开 OSS 浏览页面。"
        confirmText="启用并打开"
        cancelText="取消"
        variant="warning"
        loading={savingExtensionId === EXTENSION_IDS.OSS_BROWSER}
        onConfirm={async () => {
          await openOssBrowser(true)
          setConfirmOssOpen(false)
        }}
        onOpenChange={setConfirmOssOpen}
      />
    </div>
  )
}
