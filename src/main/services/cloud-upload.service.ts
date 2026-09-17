import type { AliyunOSSConnectionConfig, CloudConnection, S3ConnectionConfig } from '@shared/types'
import { getOSSUploadService } from './oss-upload.service'
import { getTencentS3UploadService } from './tencent-s3-upload.service'
import type { CloudTaskUploader } from './cloud-upload.types'

export class CloudUploadService {
  async createTaskUploader(
    connection: CloudConnection,
    multipartThreshold?: number
  ): Promise<CloudTaskUploader> {
    if (connection.type === 'aliyun-oss') {
      return getOSSUploadService().createTaskUploader(
        connection.config as AliyunOSSConnectionConfig,
        multipartThreshold
      )
    }
    return getTencentS3UploadService().createTaskUploader(
      connection.config as S3ConnectionConfig,
      multipartThreshold
    )
  }

  validateConnection(connection: CloudConnection): string | null {
    if (connection.type === 'aliyun-oss') {
      const config = connection.config as AliyunOSSConnectionConfig
      if (!config.region.trim()) return `${connection.name} Region 不能为空`
      if (!config.bucket.trim()) return `${connection.name} Bucket 不能为空`
      if (!config.accessKeyId.trim()) return `${connection.name} AccessKey ID 不能为空`
      if (!config.accessKeySecret.trim()) return `${connection.name} AccessKey Secret 不能为空`
      return null
    }
    const error = getTencentS3UploadService().validateConfig(
      connection.config as S3ConnectionConfig
    )
    return error ? `${connection.name} ${error}` : null
  }
}

let instance: CloudUploadService | null = null
export function getCloudUploadService(): CloudUploadService {
  if (!instance) instance = new CloudUploadService()
  return instance
}
