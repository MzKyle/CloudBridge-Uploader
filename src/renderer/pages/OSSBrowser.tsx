import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowDownAZ, ArrowUpAZ, CornerUpLeft, Eye, File, FileImage, Folder, RefreshCw, Settings } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { showToast } from '@/components/ui/toast'
import { openOSSPreviewWindow } from '@/lib/ipc-client'
import { formatBytes } from '@/lib/utils'
import { useOSSBrowser } from '@/hooks/useOSSBrowser'

function formatTime(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString('zh-CN', { hour12: false })
}

export default function OSSBrowser() {
  const navigate = useNavigate()
  const {
    state,
    breadcrumbs,
    filteredObjects,
    selectedItem,
    setSearchText,
    setSortBy,
    toggleSortDirection,
    openPrefix,
    refresh,
    goParent,
    loadMore,
    selectObject
  } = useOSSBrowser()

  const sortLabel = useMemo(() => {
    if (state.sortBy === 'size') return '大小'
    if (state.sortBy === 'lastModified') return '修改时间'
    return '名称'
  }, [state.sortBy])

  const openPreview = async (key: string) => {
    try {
      await openOSSPreviewWindow(key)
    } catch (err) {
      showToast(`打开预览失败: ${err}`, 'error')
    }
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="OSS 浏览"
        description={`当前路径: ${state.currentPrefix || '/'}`}
        actions={<Badge variant="outline">只读</Badge>}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">资源管理器视图</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center flex-wrap gap-2 text-sm">
            <Button size="sm" variant="outline" onClick={goParent} disabled={state.loading}>
              <CornerUpLeft className="h-4 w-4 mr-1" />
              返回上级
            </Button>
            {breadcrumbs.map((item, idx) => (
              <Button
                key={item.prefix || 'root'}
                size="sm"
                variant={idx === breadcrumbs.length - 1 ? 'secondary' : 'ghost'}
                onClick={() => openPrefix(item.prefix)}
              >
                {item.label}
              </Button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={refresh} disabled={state.loading}>
                <RefreshCw className={`h-4 w-4 mr-1 ${state.loading ? 'animate-spin' : ''}`} />
                刷新
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Input
              placeholder="按文件名过滤（当前目录）"
              value={state.searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="md:col-span-2"
            />
            <div className="flex gap-2">
              <select
                className="h-10 rounded-md border bg-background px-3 text-sm w-full"
                value={state.sortBy}
                onChange={(e) => setSortBy(e.target.value as 'name' | 'size' | 'lastModified')}
              >
                <option value="name">按名称</option>
                <option value="size">按大小</option>
                <option value="lastModified">按修改时间</option>
              </select>
              <Button variant="outline" size="icon" onClick={toggleSortDirection} title={`当前按${sortLabel}排序`}>
                {state.sortAsc ? <ArrowDownAZ className="h-4 w-4" /> : <ArrowUpAZ className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {state.error && (
        <div className="text-sm border border-destructive/40 rounded-md px-3 py-3 bg-destructive/10 space-y-3">
          <div className="text-destructive break-all">{state.error}</div>
          <div className="flex flex-wrap gap-2">
            {state.error.includes('配置不完整') && (
              <Button size="sm" variant="outline" onClick={() => navigate('/connections')}>
                <Settings className="h-4 w-4 mr-1" />
                云端连接
              </Button>
            )}
          </div>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">文件与目录（双击打开）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {state.loading ? (
            <div className="text-sm text-muted-foreground py-10 text-center">加载中...</div>
          ) : (
            <>
              {state.prefixes.length === 0 && filteredObjects.length === 0 ? (
                <EmptyState
                  icon={<Folder className="h-5 w-5" />}
                  title="当前目录为空"
                  description="切换到其他路径或刷新后再查看。"
                />
              ) : (
                <div className="border rounded-md overflow-hidden">
                  <div className="grid grid-cols-12 gap-2 px-3 py-2 text-xs text-muted-foreground bg-muted/40 border-b">
                    <div className="col-span-5">名称</div>
                    <div className="col-span-2">类型</div>
                    <div className="col-span-2 text-right">大小</div>
                    <div className="col-span-2 text-right">修改时间</div>
                    <div className="col-span-1 text-right">操作</div>
                  </div>

                  <div className="divide-y">
                    {state.prefixes.map((prefix) => {
                      const rowKey = `dir:${prefix.prefix}`
                      const selected = state.selectedKey === rowKey
                      return (
                        <div
                          key={prefix.prefix}
                          role="button"
                          tabIndex={0}
                          className={`w-full grid grid-cols-12 gap-2 items-center px-3 py-2 text-left hover:bg-accent ${selected ? 'bg-accent/80' : ''}`}
                          onClick={() => selectObject({
                            key: rowKey,
                            name: `${prefix.name}/`,
                            size: 0,
                            lastModified: '',
                            isImage: false
                          })}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') openPrefix(prefix.prefix)
                          }}
                          onDoubleClick={() => openPrefix(prefix.prefix)}
                        >
                          <div className="col-span-5 flex items-center gap-2 min-w-0">
                            <Folder className="h-4 w-4 text-primary" />
                            <span className="text-sm truncate">{prefix.name}/</span>
                          </div>
                          <div className="col-span-2 text-xs text-muted-foreground">文件夹</div>
                          <div className="col-span-2 text-xs text-muted-foreground text-right">-</div>
                          <div className="col-span-2 text-xs text-muted-foreground text-right">-</div>
                          <div className="col-span-1 text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              onClick={(event) => {
                                event.stopPropagation()
                                openPrefix(prefix.prefix)
                              }}
                            >
                              打开
                            </Button>
                          </div>
                        </div>
                      )
                    })}

                    {filteredObjects.map((obj) => {
                      const selected = state.selectedKey === obj.key
                      return (
                        <div
                          key={obj.key}
                          role="button"
                          tabIndex={0}
                          className={`w-full grid grid-cols-12 gap-2 items-center px-3 py-2 text-left hover:bg-accent ${selected ? 'bg-accent/80' : ''}`}
                          onClick={() => selectObject(obj)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') openPreview(obj.key)
                          }}
                          onDoubleClick={() => openPreview(obj.key)}
                        >
                          <div className="col-span-5 flex items-center gap-2 min-w-0">
                            {obj.isImage ? <FileImage className="h-4 w-4 text-primary" /> : <File className="h-4 w-4" />}
                            <span className="text-sm truncate">{obj.name}</span>
                          </div>
                          <div className="col-span-2 text-xs text-muted-foreground">{obj.isImage ? '图片' : '文件'}</div>
                          <div className="col-span-2 text-xs text-muted-foreground text-right">{formatBytes(obj.size)}</div>
                          <div className="col-span-2 text-xs text-muted-foreground text-right truncate" title={formatTime(obj.lastModified)}>
                            {formatTime(obj.lastModified)}
                          </div>
                          <div className="col-span-1 text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              onClick={(event) => {
                                event.stopPropagation()
                                openPreview(obj.key)
                              }}
                            >
                              预览
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {state.isTruncated && (
                <div className="pt-2">
                  <Button variant="outline" size="sm" onClick={loadMore} disabled={state.loadingMore}>
                    {state.loadingMore ? '加载中...' : '加载更多'}
                  </Button>
                </div>
              )}

              {selectedItem && (
                <div className="rounded-md border bg-muted/20 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="font-medium truncate">
                        {selectedItem.kind === 'prefix'
                          ? `${selectedItem.item.name}/`
                          : selectedItem.item.name}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>{selectedItem.kind === 'prefix' ? '文件夹' : selectedItem.item.isImage ? '图片' : '文件'}</span>
                        {selectedItem.kind === 'object' && (
                          <>
                            <span>{formatBytes(selectedItem.item.size)}</span>
                            <span>{formatTime(selectedItem.item.lastModified)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    {selectedItem.kind === 'prefix' ? (
                      <Button size="sm" variant="outline" onClick={() => openPrefix(selectedItem.item.prefix)}>
                        <Folder className="h-4 w-4 mr-1" />
                        打开
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => openPreview(selectedItem.item.key)}>
                        <Eye className="h-4 w-4 mr-1" />
                        预览
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
