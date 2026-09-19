# 渲染进程代码

Renderer 使用 React，通过 preload 暴露的 IPC client 调用主进程。

当前主要页面：

- `Dashboard`
- `UploadRules`
- `CloudConnections`
- `History`
- `Settings`

Renderer 不直接访问文件系统、SQLite 或对象存储 SDK。
