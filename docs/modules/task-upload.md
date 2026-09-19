# 任务队列与上传执行

## Queue

`TaskQueueService` 控制上传 gate、时间窗口和任务并发。正常退出时会：

```text
close upload gate
-> abort running task controllers
-> mark incomplete task/destination recoverable
-> stop timers
```

已经完成的 destination 不会被重置。

## Runner

`TaskRunnerService` 使用任务创建时保存的 UploadRule snapshot：

- filter
- pathMapping
- destinations
- completion/cleanup policy references

Runner 只上传 pending 且稳定的 file destination。每个目标连接独立计数、报错和重试。

## Source Mutation

上传前和上传后都会检查源文件 size/mtime。若文件在上传期间变化，当前文件会被重新排队，
下一轮上传最新稳定版本。
