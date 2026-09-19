# 代码导读索引

## 阅读顺序

```text
src/main/index.ts
-> src/main/ipc/index.ts
-> scanner / queue / task-runner / cleanup
-> cloud-upload adapters
-> task / destination / upload-group repositories
-> preload
-> renderer pages
-> shared types and IPC channels
```

## 核心文件

| 文件 | 重点 |
| --- | --- |
| `src/main/services/scanner.service.ts` | UploadRule discovery、UploadGroup/UploadTask 注册和 reconcile |
| `src/main/services/task-queue.service.ts` | upload gate、并发、shutdown |
| `src/main/services/task-runner.service.ts` | 规则快照上传、路径映射、重试隔离 |
| `src/main/services/cleanup.service.ts` | sealed group cleanup、claim、二次验证 |
| `src/main/services/cloud-upload.service.ts` | CloudConnection uploader 入口 |
| `src/main/db/task.repo.ts` | UploadTask 与 task files |
| `src/main/db/task-destination.repo.ts` | connectionId 维度的 task/file destination |
| `src/main/db/upload-group.repo.ts` | UploadGroup 状态、封账、cleanup safety |
| `src/renderer/pages/UploadRules.tsx` | UploadRule 编辑与 Dry Run |
| `src/renderer/pages/CloudConnections.tsx` | CloudConnection 管理 |

`day_folders`、`profile_snapshot_json` 和 `provider` 是兼容性字段名。v3 代码导读使用
UploadGroup、UploadRule 和 CloudConnection 术语。
