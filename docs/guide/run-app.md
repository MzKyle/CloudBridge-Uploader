# 开发运行

```bash
npm install
npm run dev
```

## 基本流程

1. 打开 Cloud Connections。
2. 创建 Aliyun OSS 或 S3-compatible connection。
3. 测试 connection。
4. 打开 Upload Rules。
5. 创建 UploadRule，配置 Source Roots、Discovery、Path Mapping、Destinations。
6. 运行 Dry Run。
7. 保存规则。
8. 在 Dashboard 触发扫描或等待自动扫描。
9. 启动上传。
10. 在 History 查看结果。

## 本地校验

```bash
npm run typecheck
npm run lint
npm test
npm run build
```
