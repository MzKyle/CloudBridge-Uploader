import { createReadStream } from 'fs'
import type { AliyunOSSConnectionConfig } from '@shared/types'
import type { CloudTaskUploader } from './cloud-upload.types'

// ali-oss 类型
interface OSSClient {
  put: (key: string, stream: NodeJS.ReadableStream | Buffer) => Promise<{ res: { status: number } }>
  multipartUpload: (
    key: string,
    filePath: string,
    options?: {
      checkpoint?: unknown
      partSize?: number
      progress?: (percentage: number, checkpoint: unknown) => void
    }
  ) => Promise<{ res: { status: number } }>
  cancel: () => void
}

export class OSSUploadService {
  private client: OSSClient | null = null
  private config: AliyunOSSConnectionConfig | null = null
  private multipartThreshold: number = 100 * 1024 * 1024 // 100MB
  private readonly minPartSize: number = 1024 * 1024 // 1MB
  private readonly maxMultipartParts: number = 10000

  configure(config: AliyunOSSConnectionConfig, multipartThreshold?: number): void {
    this.config = config
    if (multipartThreshold) this.multipartThreshold = multipartThreshold
    this.client = null // 重新配置时重建客户端
  }

  private async getClient(): Promise<OSSClient> {
    if (this.client) return this.client
    if (!this.config) throw new Error('OSS 未配置')

    const OSS = (await import('ali-oss')).default
    this.client = new OSS({
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
      bucket: this.config.bucket,
      endpoint: this.config.endpoint || undefined
    }) as unknown as OSSClient

    return this.client
  }

  /**
   * 创建任务级独立 OSS 客户端
   * 每个任务使用自己的客户端，cancel() 不会影响其他任务
   */
  async createTaskClient(): Promise<OSSClient> {
    if (!this.config) throw new Error('OSS 未配置')

    const OSS = (await import('ali-oss')).default
    return new OSS({
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
      bucket: this.config.bucket,
      endpoint: this.config.endpoint || undefined
    }) as unknown as OSSClient
  }

  async createTaskUploader(
    config: AliyunOSSConnectionConfig,
    multipartThreshold?: number
  ): Promise<CloudTaskUploader> {
    this.configure(config, multipartThreshold)
    const client = await this.createTaskClient()
    const threshold = multipartThreshold || this.multipartThreshold
    return {
      provider: 'aliyun',
      uploadFile: (
        filePath,
        objectKey,
        fileSize,
        onProgress,
        signal
      ) => this.uploadFileWithClient(
        client,
        filePath,
        objectKey,
        fileSize,
        threshold,
        onProgress,
        signal
      ).then((key) => ({ objectKey: key })),
      uploadBuffer: async (buffer, objectKey, signal) => {
        if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError')
        await client.put(objectKey, buffer)
        return objectKey
      },
      abort: () => client.cancel(),
      dispose: () => {}
    }
  }

  /**
   * 上传单个文件到 OSS
   * @param filePath 本地文件绝对路径
   * @param ossKey OSS 对象 key
   * @param fileSize 文件大小
   * @param onProgress 进度回调 (0-1)
   * @param signal 取消信号
   * @param taskClient 任务级 OSS 客户端（可选，默认使用共享客户端）
   * @returns OSS key
   */
  async uploadFile(
    filePath: string,
    ossKey: string,
    fileSize: number,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
    taskClient?: OSSClient
  ): Promise<string> {
    if (signal?.aborted) {
      throw new DOMException('Upload aborted', 'AbortError')
    }

    const client = taskClient || (await this.getClient())
    return this.uploadFileWithClient(
      client,
      filePath,
      ossKey,
      fileSize,
      this.multipartThreshold,
      onProgress,
      signal
    )
  }

  private async uploadFileWithClient(
    client: OSSClient,
    filePath: string,
    ossKey: string,
    fileSize: number,
    multipartThreshold: number,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal
  ): Promise<string> {
    if (signal?.aborted) {
      throw new DOMException('Upload aborted', 'AbortError')
    }

    if (fileSize > multipartThreshold) {
      // 分片上传
      try {
        const partSize = this.getPartSizeForMultipart(fileSize)
        await client.multipartUpload(ossKey, filePath, {
          partSize,
          progress: (percentage: number) => {
            onProgress?.(percentage)
          }
        })
      } catch (err: unknown) {
        // ali-oss cancel() 触发的错误
        if (signal?.aborted || (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'cancel')) {
          throw new DOMException('Upload aborted', 'AbortError')
        }
        throw err
      }
    } else {
      // 普通流式上传
      const stream = createReadStream(filePath)

      const onAbort = (): void => {
        stream.destroy()
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      try {
        await client.put(ossKey, stream)
        onProgress?.(1)
      } catch (err) {
        if (signal?.aborted) {
          throw new DOMException('Upload aborted', 'AbortError')
        }
        throw err
      } finally {
        signal?.removeEventListener('abort', onAbort)
        stream.destroy()
      }
    }

    return ossKey
  }

  private getPartSizeForMultipart(fileSize: number): number {
    const minPartSizeByCount = Math.ceil(fileSize / (this.maxMultipartParts - 1))
    const partSize = Math.max(this.minPartSize, minPartSizeByCount)
    const step = 1024 * 1024
    return Math.ceil(partSize / step) * step
  }

  /**
   * 上传 Buffer 到 OSS（用于 SFTP 直传场景）
   */
  async uploadBuffer(buffer: Buffer, ossKey: string): Promise<string> {
    const client = await this.getClient()
    await client.put(ossKey, buffer)
    return ossKey
  }

  async testConnection(config: AliyunOSSConnectionConfig): Promise<{ ok: boolean; error?: string }> {
    const endpoint = config.endpoint.trim()
    const region = config.region.trim()
    const bucket = config.bucket.trim()
    const accessKeyId = config.accessKeyId.trim()
    const accessKeySecret = config.accessKeySecret.trim()

    if (!region) return { ok: false, error: 'Region 不能为空' }
    if (!bucket) return { ok: false, error: 'Bucket 不能为空' }
    if (!accessKeyId) return { ok: false, error: 'AccessKey ID 不能为空' }
    if (!accessKeySecret) return { ok: false, error: 'AccessKey Secret 不能为空' }

    try {
      const OSS = (await import('ali-oss')).default
      const client = new OSS({
        region,
        accessKeyId,
        accessKeySecret,
        bucket,
        endpoint: endpoint || undefined,
        timeout: '10s',
        secure: true
      })

      // 必须访问当前配置的 bucket，才能真正验证“桶可连接且有权限”
      const result = await (client as unknown as {
        list: (query?: Record<string, string | number>) => Promise<{ res?: { status?: number } }>
      }).list({ 'max-keys': 1 })

      const statusCode = result?.res?.status
      if (typeof statusCode === 'number' && statusCode >= 200 && statusCode < 300) {
        return { ok: true }
      }

      return { ok: false, error: `桶连接校验失败，HTTP 状态码: ${statusCode ?? 'unknown'}` }
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string; status?: number; name?: string }
      const parts = [
        e.code || e.name,
        typeof e.status === 'number' ? `status=${e.status}` : undefined,
        e.message
      ].filter(Boolean)
      return { ok: false, error: parts.join(', ') || String(err) }
    }
  }
}

let instance: OSSUploadService | null = null
export function getOSSUploadService(): OSSUploadService {
  if (!instance) instance = new OSSUploadService()
  return instance
}
