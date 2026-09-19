# 云桥上传器

[English](README.md) | [简体中文](README.zh-CN.md)

![云桥上传器](docs/assets/cover.svg)

云桥上传器是一款规则驱动的桌面数据上传工具。

它通过 UploadRule 将本地数据目录配置为：

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

[阅读完整文档](docs/README.md)

## 产品模型

- **UploadRule** 定义源目录、发现规则、文件过滤、路径映射、目标连接、完成策略和清理策略。
- **UploadGroup** 是被发现并可封账的上传分组，清理必须发生在封账之后。
- **UploadTask** 负责上传一个任务目录，并保存创建时的规则快照。
- **CloudConnection** 是目标身份。任务和文件状态以 `connectionId` 区分，因此只重试失败连接时，不会重传其他连接已经完成的文件。
- **Path Mapping** 根据规则快照和发现变量渲染对象 Key。

日期目录、工作次目录、机器批次等都可以通过 Discovery 规则表达，但它们不是 v3 的硬编码核心模型。

## 支持的目标存储

当前代码支持：

- 阿里云 OSS
- S3 兼容对象存储

S3 兼容目标可以是 MinIO、腾讯云 TurboS3，或其他兼容 S3 endpoint。实际兼容性取决于
endpoint 行为和凭据权限；连接测试只验证基础访问，正式使用前仍应做上传 smoke test。

## 快速开始

1. 创建 Cloud Connection。
2. 测试 Connection。
3. 创建 Upload Rule。
4. 添加 Source Root。
5. 配置 Discovery。
6. 配置 Path Mapping。
7. 选择 Destination Connection。
8. 执行 Dry Run。
9. 保存 Rule。
10. Scanner 发现数据。
11. 启动 Upload。
12. 在 History 中查看结果，并按策略清理。

## 可靠性模型

云桥上传器使用 SQLite 持久化任务、文件、目标连接、设置和 UploadGroup。运行时按
`connectionId` 保存每个目标的状态，重试互相隔离；启动时会恢复未完成任务；文件上传
依赖 size/mtime 稳定检查；任务使用创建时的规则快照；本地清理必须满足 sealed
UploadGroup 不变式。

清理路径采用 fail-safe 设计：先 claim 同一个 UploadGroup，阻止 scanner 在 destructive
窗口继续写入，再重新 refresh 和 validate，确认任务、目标、文件和目录内容仍安全后才删除。
这不是 exactly-once 分布式系统；中断后的工作通过持久化状态恢复并安全重试。

## 常用命令

```bash
npm install
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
npm run build:linux
npm run build:win
```

构建产物输出到 `dist/`。当前候选版本为 `3.0.0-rc.4`。

## 打包目标

`electron-builder.yml` 保持 v3 打包目标：

- Windows：NSIS x64
- Linux：AppImage x64 与 deb x64

`better-sqlite3` 会从 ASAR 中解包，保证原生模块可加载。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
