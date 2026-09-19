# 数据流

1. 用户创建 CloudConnection，并通过连接测试验证基础访问。
2. 用户创建 UploadRule，配置 Source Roots、Discovery、Path Mapping、Destinations、Completion 和 Cleanup。
3. Dry Run 对每个 Source Root 预览 group、task、sample files 和 object keys，不写入任务状态。
4. Scanner 读取启用的 UploadRule，发现 UploadGroup 和 UploadTask。
5. TaskRepo 持久化任务及规则快照，TaskDestinationRepo 按 `connectionId` 创建目标状态。
6. Scanner 和 TaskRunner 通过 size/mtime reconcile 文件清单。
7. TaskQueue 在 upload gate 打开且时间窗口允许时启动 runnable task。
8. TaskRunner 只上传 pending 且稳定的 file destination。
9. 每个连接独立更新状态、进度、错误和 retry 信息。
10. UploadGroupService 根据子任务状态刷新 UploadGroup。
11. Completion Policy 让 group 进入 sealed 后，CleanupService 才可能清理本地目录。

## 关键不变式

- 已创建任务使用自己的 UploadRule snapshot。
- Destination identity 是 `connectionId`。
- 已完成的 destination/file destination 不因其他连接失败而重传。
- 源文件 size/mtime 变化会让文件回到 pending/stability 检查。
- Cleanup 必须在 sealed/cleanable 且二次验证通过后执行。
