# 模块全景

| 模块 | 当前职责 |
| --- | --- |
| Renderer | 展示 Dashboard、Upload Rules、Cloud Connections、History 和设置页面 |
| Preload | 暴露受控 IPC API |
| IPC | 参数校验、调用主进程服务、推送事件 |
| ScannerService | 从 Source Roots 发现 UploadGroup 和 UploadTask，并执行增量 reconcile |
| TaskQueueService | 上传 gate、时间窗口、并发、shutdown 中止 |
| TaskRunnerService | 规则快照上传、路径映射、稳定性检查、连接隔离重试 |
| CloudUploadService | Aliyun OSS 与 S3-compatible uploader 入口 |
| CleanupService | sealed UploadGroup 清理、cleanup claim、路径安全检查 |
| SQLite Repos | 设置、任务、目标、文件、UploadGroup 和历史记录 |

## 主链路

```text
Source Roots
-> ScannerService
-> UploadGroupRepo / TaskRepo
-> TaskQueueService
-> TaskRunnerService
-> CloudUploadService
-> TaskDestinationRepo
-> UploadGroupService
-> CleanupService
```
