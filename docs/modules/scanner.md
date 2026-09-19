# 目录扫描器

`ScannerService` 读取启用的 UploadRule，并按每条规则的 Source Roots 和 Discovery 配置发现
UploadGroup 与 UploadTask。

## 行为

- watcher 监听目录结构变化。
- 周期扫描作为兜底。
- 文件内容变化由稳定性检查和 reconcile 处理。
- cleanable/cleaned UploadGroup 不允许 scanner 创建新 task 或修改 group 状态。

## Reconcile

Scanner 会把当前文件清单与 SQLite 中的 task files 对比：

- 新文件插入 pending。
- size/mtime 未变时增加 stable count。
- size/mtime 变化时回到 pending。
- 缺失文件标记 missing/skipped。

`synced` 的本地任务仍会被持续 reconcile，因此晚到或修改的文件不会永久停留在 completed。
