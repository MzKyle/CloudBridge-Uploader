# 云连接配置

CloudConnection 是 v3 的目标身份。任务、目标和文件目标都使用 `connectionId` 区分目的地。

## Aliyun OSS

必填字段：

- endpoint
- bucket
- region
- accessKeyId
- accessKeySecret

可选字段：

- prefix

## S3-Compatible

必填字段：

- endpoint
- bucket
- region
- accessKeyId
- accessKeySecret

可选字段：

- prefix
- forcePathStyle
- allowInsecureTls

S3-compatible 可以用于 MinIO、Tencent TurboS3 或其他兼容 endpoint。不同服务的行为可能
存在差异，正式使用前应运行连接测试和真实上传 smoke test。

## Destination Identity

规则只引用 connection id：

```json
{
  "destinations": [
    { "connectionId": "archive-a" },
    { "connectionId": "archive-b" }
  ]
}
```

重试某个 connection 不会重置其他已经完成的 connection。
