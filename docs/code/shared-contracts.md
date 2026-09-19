# 共享契约

共享类型位于 `src/shared/types.ts`，IPC channel 位于 `src/shared/ipc-channels.ts`。

v3 主要共享概念：

- UploadRule
- CloudConnection
- UploadGroupSummary
- Task
- TaskDestination
- TaskFileDestination
- UploadRuleDryRunResult
- UploadQueueStatus

Destination identity 使用 `connectionId`。
