# 安装与打包

当前 RC 版本：`3.0.0-rc.1`

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
```

跨平台打包是否可用取决于当前 electron-builder 环境。无法在当前平台生成另一平台 installer
时，应在 release checklist 中明确记录为未执行。
