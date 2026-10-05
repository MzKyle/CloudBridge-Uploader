# 安装与打包

当前 RC 版本：`3.0.0-rc.6`

## 本地构建

```bash
npm run build
```

## Linux installer smoke

```bash
npm run build:linux
```

产物输出到 `dist/`，包括 AppImage 和 deb。

## Windows

Windows NSIS x64 使用：

```bash
npm run build:win
npm run smoke:win
```

Windows 验收需要在 Windows 上执行。`smoke:win` 默认启动 `dist/win-unpacked/云桥上传器.exe`，
验证打包后的 SQLite、凭据加密、页面、扫描、上传、重试、重启恢复和封账。
安装 NSIS 后，可以传入已安装的程序路径：

```powershell
npm run smoke:win -- "C:\path\to\云桥上传器.exe"
```

验收使用本机 S3 协议测试服务与测试密钥，不访问生产存储。结果、日志和截图保存在 `.acceptance/`。
正式使用前仍应对实际 S3/OSS Endpoint 做上传测试。

程序支持 `--user-data-dir=绝对路径` 启动独立配置目录，验收脚本用它隔离用户数据库与日志。
跨平台打包无法生成 installer 时，应在 release checklist 中明确记录为未执行。
