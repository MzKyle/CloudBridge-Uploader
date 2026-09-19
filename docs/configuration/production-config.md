# 生产配置建议

## 规则

- 为每类数据建立独立 UploadRule。
- Source Root 指向稳定的本地数据根目录。
- 先用 Dry Run 检查 group、task、sample files 和 object keys。
- Path Mapping 模板不要生成绝对路径或 `..` 路径段。

## 上传

- 弱网环境降低 `maxConcurrentUploads`。
- 大文件较多时先本地压测，再提高并发。
- 使用时间窗口限制新任务启动时，确认窗口足够覆盖日常数据量。

## 清理

- 默认先关闭 cleanup。
- 确认对象存储归档可用后，再在 UploadRule 中启用 cleanup。
- Cleanup 只会删除 sealed 且二次验证通过的 UploadGroup。

## 发布前检查

使用 [release checklist](../release-checklist.md) 完成 RC 验收。
