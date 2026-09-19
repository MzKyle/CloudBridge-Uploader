# 故障排查 FAQ

## 没有发现任务

- UploadRule 是否启用。
- Source Root 是否存在且可读。
- Discovery 配置是否匹配实际目录。
- Dry Run 是否能看到 group 和 task。

## 上传没有开始

- Upload gate 是否打开。
- 是否处于上传时间窗口。
- 文件 stable count 是否达到要求。
- CloudConnection 是否可解析并通过配置校验。

## 一个目标失败，另一个目标已完成

这是预期隔离行为。只重试失败 connection，不会重传已经 completed/synced 的 connection。

## cleanup 没有删除目录

cleanup 宁可保守也不会误删。常见原因：

- UploadGroup 未 sealed。
- 仍有 pending/uploading/failed/paused task。
- 仍有 pending/failed file destination。
- claim 后发现新文件或新目录。
- cleanup path safety 拒绝目标路径。

## 启动后任务回到 pending

这是 startup reconciliation。进程中断留下的 uploading 状态会恢复为 pending，已完成的
destination/file destination 会保留。
