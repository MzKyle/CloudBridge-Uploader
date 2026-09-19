# 设置总览

设置通过 `SettingsRepo` 存在 SQLite `settings` 表中。v3 当前配置围绕 UploadRule 和
CloudConnection 展开。

## 关键 section

| Section | 内容 |
| --- | --- |
| `rules` | UploadRule 列表 |
| `activeRuleId` | 默认选中的规则 |
| `connections` | CloudConnection 列表 |
| `scan` | 扫描间隔 |
| `upload` | 任务并发、文件并发、上传时间窗口 |
| `stability` | size/mtime 稳定检查次数和间隔 |
| `cleanup` | 全局兼容清理开关；实际规则优先使用 UploadRule cleanup |
| `log` | 日志目录和保留天数 |

## UploadRule

每条 UploadRule 包含：

- `source.roots`
- `discovery`
- `filter`
- `pathMapping`
- `destinations`
- `completion`
- `cleanup`

任务创建时保存 UploadRule snapshot。后续编辑规则不会改写旧任务的 filter、path mapping、
destination 或 cleanup/completion policy。

## Upload

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `maxConcurrentTasks` | `4` | 同时运行的 UploadTask 数 |
| `maxFilesPerTask` | `12` | 单个任务内的文件 worker 数 |
| `maxConcurrentUploads` | `12` | 全局上传 slot 数 |
| `multipartThreshold` | `100 MB` | 大文件加权占用 slot 的阈值 |
| `startAfterTime` | `20:30` | 可启动新任务的最早时间 |
| `endBeforeTime` | `23:59` | 可启动新任务的最晚时间 |

时间窗口只控制新任务启动。正常退出时，运行中任务会被 abort 并落到可恢复状态。

## Completion 与 Cleanup

Completion Policy 只决定 UploadGroup 何时进入 sealed。Cleanup Policy 还必须通过 DB 状态、
路径安全和文件系统二次验证，才会删除本地目录。
