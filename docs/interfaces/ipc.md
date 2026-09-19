# IPC 通道

通道常量位于 `src/shared/ipc-channels.ts`，handler 位于 `src/main/ipc/index.ts`，渲染进程封装
位于 `src/renderer/lib/ipc-client.ts`。

## 任务与队列

- task list/detail/retry/skip/restore
- upload queue start/stop/status
- task status event
- task destination event
- task progress event

任务事件以 `taskId` 和 `connectionId` 标识目标状态。

## Upload Rules

- rule CRUD
- dry run
- path preview

Dry Run 只读取源目录和规则配置，不创建 task、destination 或 upload group。

## Connections

- cloud connection CRUD
- Aliyun OSS test
- S3-compatible test

## Scanner / Cleanup / History

- scanner status/start/stop/trigger
- upload group list/close/ignore/restore
- cleanup schedule
- history list/delete/clear

Renderer 不直接访问数据库、文件系统或云端 SDK。
