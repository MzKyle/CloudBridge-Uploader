import { extname } from 'path'
import type { AppSettings, OSSImageResult, OSSListResult, OSSObjectHead, OSSObjectItem } from '@shared/types'
import { providersForProfile } from '@shared/cloud-upload'
import { getSettingsRepo } from '../db/settings.repo'

interface OSSBrowseClient {
  listV2: (options: Record<string, unknown>) => Promise<{
    prefixes?: string[]
    objects?: Array<Record<string, unknown>>
    isTruncated?: boolean
    nextContinuationToken?: string
  }>
  head: (key: string) => Promise<{ res: { headers: Record<string, string | string[] | undefined> } }>
  get: (key: string) => Promise<{ content: unknown; res: { headers: Record<string, string | string[] | undefined> } }>
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tiff', '.tif'])
const DEFAULT_MAX_KEYS = 200
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024

function normalizePrefix(prefix: string): string {
  const normalized = prefix.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized) return ''
  return normalized.endsWith('/') ? normalized : `${normalized}/`
}

function itemNameFromPath(pathValue: string): string {
  const trimmed = pathValue.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

function isImageByName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(name).toLowerCase())
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return value
}

function asBuffer(content: unknown): Buffer {
  if (Buffer.isBuffer(content)) return content
  if (content instanceof Uint8Array) return Buffer.from(content)
  if (typeof content === 'string') return Buffer.from(content)
  throw new Error('图片数据格式不受支持')
}

function mapOSSObject(raw: Record<string, unknown>): OSSObjectItem {
  const key = String(raw.name || '')
  const size = Number(raw.size || 0)
  const lastModifiedRaw = raw.lastModified ? String(raw.lastModified) : ''
  const lastModified = lastModifiedRaw || new Date(0).toISOString()

  return {
    key,
    name: itemNameFromPath(key),
    size: Number.isFinite(size) ? size : 0,
    lastModified,
    contentType: raw.type ? String(raw.type) : undefined,
    isImage: isImageByName(key)
  }
}

export class OSSBrowserService {
  private client: OSSBrowseClient | null = null
  private configKey: string | null = null

  private async getClientAndBasePrefix(): Promise<{ client: OSSBrowseClient; basePrefix: string }> {
    const settings = getSettingsRepo().getAll()
    const profile =
      settings.profiles.find((item) => item.id === settings.activeProfileId) ||
      settings.profiles[0]
    if (!providersForProfile(profile).includes('aliyun')) {
      throw new Error('OSS 浏览器当前使用阿里云 OSS 连接，请选择包含 aliyun 连接的上传规则')
    }
    const config = {
      ...settings.oss,
      ...profile.providers.aliyun,
      accessKeyId: settings.oss.accessKeyId,
      accessKeySecret: settings.oss.accessKeySecret,
      endpoint: settings.oss.endpoint,
      bucket: settings.oss.bucket,
      region: settings.oss.region
    } as AppSettings['oss']

    if (!config.region || !config.bucket || !config.accessKeyId || !config.accessKeySecret) {
      throw new Error('阿里云 OSS 配置不完整，请先到云端连接页完成配置')
    }

    const newConfigKey = this.getConfigKey(config)
    if (!this.client || this.configKey !== newConfigKey) {
      const OSS = (await import('ali-oss')).default
      this.client = new OSS({
        region: config.region,
        accessKeyId: config.accessKeyId,
        accessKeySecret: config.accessKeySecret,
        bucket: config.bucket,
        endpoint: config.endpoint || undefined
      }) as unknown as OSSBrowseClient
      this.configKey = newConfigKey
    }

    return {
      client: this.client,
      basePrefix: normalizePrefix(config.prefix || '')
    }
  }

  private getConfigKey(config: AppSettings['oss']): string {
    return [config.endpoint, config.region, config.bucket, config.accessKeyId, config.accessKeySecret].join('|')
  }

  async list(prefix?: string, continuationToken?: string, maxKeys: number = DEFAULT_MAX_KEYS): Promise<OSSListResult> {
    const { client, basePrefix } = await this.getClientAndBasePrefix()
    const effectivePrefix = prefix ? normalizePrefix(prefix) : basePrefix

    const options: Record<string, unknown> = {
      prefix: effectivePrefix,
      delimiter: '/',
      'max-keys': Math.min(Math.max(20, maxKeys), 1000)
    }
    if (continuationToken) {
      options['continuation-token'] = continuationToken
    }

    const result = await client.listV2(options)

    return {
      effectivePrefix,
      prefixes: (result.prefixes || []).map((p) => ({
        prefix: p,
        name: itemNameFromPath(p)
      })),
      objects: (result.objects || [])
        .map(mapOSSObject)
        .filter((item) => item.key && item.key !== effectivePrefix),
      nextContinuationToken: result.nextContinuationToken,
      isTruncated: Boolean(result.isTruncated)
    }
  }

  async head(key: string): Promise<OSSObjectHead> {
    const { client } = await this.getClientAndBasePrefix()
    const result = await client.head(key)
    const headers = result.res.headers

    const size = Number(headerValue(headers, 'content-length') || 0)
    const lastModified = headerValue(headers, 'last-modified')
    const contentType = headerValue(headers, 'content-type')

    return {
      key,
      size: Number.isFinite(size) ? size : 0,
      lastModified: lastModified ? new Date(lastModified).toISOString() : new Date(0).toISOString(),
      contentType,
      etag: headerValue(headers, 'etag')
    }
  }

  async getImagePreview(key: string, maxBytes: number = DEFAULT_MAX_IMAGE_BYTES): Promise<OSSImageResult> {
    const { client } = await this.getClientAndBasePrefix()
    const meta = await this.head(key)

    if (meta.size > maxBytes) {
      throw new Error(`图片过大，超过预览限制（${Math.round(maxBytes / 1024 / 1024)}MB）`)
    }

    const response = await client.get(key)
    const buffer = asBuffer(response.content)
    const contentType = meta.contentType || 'image/jpeg'

    return {
      dataUrl: `data:${contentType};base64,${buffer.toString('base64')}`,
      contentType,
      size: buffer.length
    }
  }
}

let instance: OSSBrowserService | null = null

export function getOSSBrowserService(): OSSBrowserService {
  if (!instance) {
    instance = new OSSBrowserService()
  }
  return instance
}
