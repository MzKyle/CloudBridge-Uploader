# 云存储适配

`CloudUploadService` 根据 CloudConnection 类型创建 uploader。

| 类型 | 实现 |
| --- | --- |
| `aliyun-oss` | `OSSUploadService` |
| `s3` | `TencentS3UploadService`，用于 S3-compatible endpoint |

`TaskDestinationRepo` 和 `task_file_destinations` 使用 `connectionId` 做唯一目标身份。数据库
仍保留 `provider` 字段用于迁移兼容，但运行时不以它作为 destination identity。

## 上传结果

每个 file destination 单独保存：

- status
- objectKey
- uploadId
- errorMessage

逻辑文件状态由所有目标聚合得到。
