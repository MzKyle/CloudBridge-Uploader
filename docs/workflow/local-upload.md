# 本地目录上传

## 建规则

1. 创建 CloudConnection。
2. 创建 UploadRule。
3. 添加 Source Roots。
4. 配置 Discovery，决定如何把目录识别为 UploadGroup 和 UploadTask。
5. 配置 Filter。
6. 配置 Path Mapping。
7. 选择 Destination Connections。
8. 运行 Dry Run 并确认 object keys。

## 上传流程

```text
Scanner discovers UploadGroup/UploadTask
-> files become stable
-> TaskQueue starts runnable task
-> TaskRunner uploads pending file destinations
-> per-connection state is persisted
-> UploadGroup refreshes
-> sealed group can be cleaned
```

## 文件变化

上传前和上传后都会检查 size/mtime。若源文件在上传期间变化，当前 file destination 会回到
pending，等待下一轮稳定检查后重新上传最新版本。
