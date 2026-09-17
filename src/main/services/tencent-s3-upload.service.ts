import { createReadStream } from 'fs'
import { Agent as HttpsAgent } from 'https'
import {
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import type { S3ConnectionConfig } from '@shared/types'
import type { CloudTaskUploader } from './cloud-upload.types'

export class TencentS3UploadService {
  createTaskUploader(
    config: S3ConnectionConfig,
    multipartThreshold = 100 * 1024 * 1024
  ): CloudTaskUploader {
    const client = this.createClient(config)
    const activeControllers = new Set<AbortController>()
    const activeUploads = new Set<Upload>()
    let aborted = false

    const createController = (signal?: AbortSignal): AbortController => {
      const controller = new AbortController()
      activeControllers.add(controller)
      if (aborted || signal?.aborted) controller.abort()
      signal?.addEventListener('abort', () => controller.abort(), { once: true })
      return controller
    }

    return {
      provider: 'tencent',
      uploadFile: async (filePath, objectKey, fileSize, onProgress, signal) => {
        const controller = createController(signal)
        let uploadId: string | undefined
        try {
          if (fileSize > multipartThreshold) {
            const upload = new Upload({
              client,
              params: {
                Bucket: config.bucket,
                Key: objectKey,
                Body: createReadStream(filePath),
                ContentType: 'application/octet-stream'
              },
              queueSize: 4,
              partSize: this.getPartSize(fileSize),
              leavePartsOnError: false,
              abortController: controller
            })
            activeUploads.add(upload)
            upload.on('httpUploadProgress', (progress) => {
              if (typeof progress.loaded === 'number' && fileSize > 0) {
                onProgress?.(Math.min(1, progress.loaded / fileSize))
              }
            })
            try {
              await upload.done()
              uploadId = upload.uploadId
            } finally {
              activeUploads.delete(upload)
            }
          } else {
            await client.send(
              new PutObjectCommand({
                Bucket: config.bucket,
                Key: objectKey,
                Body: createReadStream(filePath),
                ContentType: 'application/octet-stream',
                ContentLength: fileSize
              }),
              { abortSignal: controller.signal }
            )
            onProgress?.(1)
          }
          return { objectKey, uploadId }
        } catch (err) {
          if (controller.signal.aborted) {
            throw new DOMException('Upload aborted', 'AbortError')
          }
          throw err
        } finally {
          activeControllers.delete(controller)
        }
      },
      uploadBuffer: async (buffer, objectKey, signal) => {
        const controller = createController(signal)
        try {
          await client.send(
            new PutObjectCommand({
              Bucket: config.bucket,
              Key: objectKey,
              Body: buffer,
              ContentType: 'application/octet-stream',
              ContentLength: buffer.length
            }),
            { abortSignal: controller.signal }
          )
          return objectKey
        } catch (err) {
          if (controller.signal.aborted) {
            throw new DOMException('Upload aborted', 'AbortError')
          }
          throw err
        } finally {
          activeControllers.delete(controller)
        }
      },
      abort: () => {
        aborted = true
        for (const controller of activeControllers) controller.abort()
        for (const upload of activeUploads) void upload.abort()
        client.destroy()
      },
      dispose: () => client.destroy()
    }
  }

  async testConnection(
    config: S3ConnectionConfig
  ): Promise<{ ok: boolean; error?: string }> {
    const validationError = this.validateConfig(config)
    if (validationError) return { ok: false, error: validationError }

    const client = this.createClient(config, 10000)
    try {
      await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          MaxKeys: 1
        })
      )
      return { ok: true }
    } catch (err) {
      return { ok: false, error: this.formatError(err) }
    } finally {
      client.destroy()
    }
  }

  validateConfig(config: S3ConnectionConfig): string | null {
    if (!config.endpoint.trim()) return 'Endpoint 不能为空'
    if (!config.region.trim()) return 'Region 不能为空'
    if (!config.bucket.trim()) return 'Bucket 不能为空'
    if (!config.accessKeyId.trim()) return 'AccessKey ID 不能为空'
    if (!config.accessKeySecret.trim()) return 'AccessKey Secret 不能为空'
    return null
  }

  private createClient(
    config: S3ConnectionConfig,
    requestTimeout = 300000
  ): S3Client {
    const requestHandler = new NodeHttpHandler({
      connectionTimeout: 30000,
      requestTimeout,
      httpsAgent: new HttpsAgent({
        keepAlive: true,
        rejectUnauthorized: !config.allowInsecureTls
      })
    })

    return new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle ?? true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.accessKeySecret
      },
      requestHandler,
      maxAttempts: 1
    })
  }

  private getPartSize(fileSize: number): number {
    const minimum = 5 * 1024 * 1024
    const byPartCount = Math.ceil(fileSize / 9999)
    const raw = Math.max(minimum, byPartCount)
    const step = 1024 * 1024
    return Math.ceil(raw / step) * step
  }

  private formatError(err: unknown): string {
    const error = err as {
      name?: string
      message?: string
      Code?: string
      $metadata?: { httpStatusCode?: number }
    }
    return [
      error.Code || error.name,
      error.$metadata?.httpStatusCode
        ? `status=${error.$metadata.httpStatusCode}`
        : undefined,
      error.message
    ].filter(Boolean).join(', ') || String(err)
  }
}

let instance: TencentS3UploadService | null = null
export function getTencentS3UploadService(): TencentS3UploadService {
  if (!instance) instance = new TencentS3UploadService()
  return instance
}
