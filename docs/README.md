# 云桥上传器文档

云桥上传器 v3 是规则驱动的桌面上传工具。它把一个或多个本地源目录映射到一个或多个
对象存储连接，并在发现、上传、恢复、封账和清理之间保持可恢复的 SQLite 状态。

## 当前产品模型

```text
Source Roots
-> UploadRule
-> Discovery
-> UploadGroup
-> UploadTask
-> Path Mapping
-> CloudConnection(s)
-> Completion Policy
-> Cleanup Policy
```

## 快速导航

- [环境依赖与准备](guide/prerequisites.md)
- [开发运行](guide/run-app.md)
- [安装与打包](guide/package-install.md)
- [架构总览](architecture/README.md)
- [模块总览](modules/README.md)
- [目录扫描器](modules/scanner.md)
- [任务队列与上传执行](modules/task-upload.md)
- [云存储适配](modules/oss.md)
- [设置总览](configuration/settings.md)
- [云连接配置](configuration/oss-config.md)
- [本地目录上传](workflow/local-upload.md)
- [测试验收流程](workflow/testing.md)
- [数据存储结构](logging/data-storage.md)
- [IPC 通道](interfaces/ipc.md)
- [故障排查](faq/troubleshooting.md)

## 文档状态

v3 正式入口只保留当前产品模型。旧的 SSH、rsync、SFTP、数采模式和 v2 Profile 文档不再
作为当前主线发布；保留的旧页面均标注为 Legacy，仅用于历史兼容背景。
