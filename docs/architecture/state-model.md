# 状态模型

## UploadTask

```text
pending -> uploading -> completed
pending -> scanning -> pending
uploading -> retrying -> pending
uploading -> failed
uploading -> paused
any unfinished -> skipped
```

本地自动发现的任务在全部连接同步后可表现为 `synced`。启动恢复会把未完成的
`uploading/scanning/retrying/failed/paused` 任务恢复为可执行状态，不会改写已经
`completed/synced/skipped` 的任务。

## File Destination

```text
pending -> uploading -> completed
pending -> uploading -> failed
uploading -> pending
pending -> skipped
```

`uploading -> pending` 用于进程中断、正常 shutdown 中止和源文件变化后的恢复。逻辑文件状态
由同一个 task file 下所有 connection 的 file destination 聚合得到。

## UploadGroup

```text
open -> closing -> sealed -> cleanable -> cleaned
open/closing -> error
error -> open/closing
cleanable -> sealed
```

`cleanable` 是 cleanup claim。claim 期间 scanner 不再修改该 UploadGroup。若 claim 后重新
验证发现新任务、未完成目标、源文件变化或未登记内容，cleanup 会释放 claim 回到 `sealed`。

## Completion

当前支持的 Completion Policy：

- `rollover`
- `manual`
- `marker-file`
- `inactivity`
- `none`

策略只控制 group 何时封账；是否删除本地数据仍由 Cleanup Policy 和 cleanup safety gate 决定。
