# 主进程代码

`src/main/index.ts` 初始化日志、数据库、IPC、窗口、Scanner、TaskQueue 和 CleanupService。

## 服务

- `ScannerService`：发现和 reconcile。
- `TaskQueueService`：上传 gate、时间窗口、shutdown。
- `TaskRunnerService`：执行上传。
- `CleanupService`：清理 sealed UploadGroup。
- `CloudUploadService`：按 connection type 选择 uploader。

## Repositories

- `TaskRepo`
- `TaskDestinationRepo`
- `UploadGroupRepo`
- `SettingsRepo`
- `HistoryRepo`

启动数据库时会运行 migrations 并执行 startup reconciliation。
