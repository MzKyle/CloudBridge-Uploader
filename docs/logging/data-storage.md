# 数据存储结构

数据库位于 Electron `userData/uploader.db`，启用 WAL、busy timeout 和外键。

## 核心表

| 表 | 内容 |
| --- | --- |
| `settings` | 配置 section JSON |
| `day_folders` | UploadGroup 兼容表名，保存 group 状态和统计 |
| `tasks` | UploadTask、规则快照、源路径、状态 |
| `task_files` | 逻辑文件、size/mtime、stable count、retry 信息 |
| `task_destinations` | 每个 task 的 connection 状态 |
| `task_file_destinations` | 每个 file 的 connection 状态 |

`day_folders` 是历史表名；v3 文档和 UI 使用 UploadGroup 术语。

## 兼容字段

`provider`、`oss_prefix`、`profile_snapshot_json` 等字段保留用于迁移兼容或历史数据读取。新运行时
以 UploadRule、CloudConnection、UploadGroup 和 `connectionId` 为主模型。

## 启动恢复

启动时会：

- 恢复中断的 uploading task/file destination。
- 保留 completed/synced/skipped 状态。
- 对源目录已删除的未完成任务标记 skipped。
- 保持 connectionId 唯一约束。

## 日志

日志默认位于 `userData/logs`。排查时优先搜索：

- `任务失败`
- `上传队列`
- `持续同步校准`
- `自动清理`
- `迁移`
