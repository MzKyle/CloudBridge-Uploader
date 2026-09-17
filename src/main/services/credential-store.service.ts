import { safeStorage } from 'electron'

const SAFE_STORAGE_PREFIX = 'safe-storage:v1:'

type SecretConfig = {
  accessKeySecret?: unknown
}

export class CredentialStore {
  encryptSecret(secret: string): string {
    if (!secret || this.isEncryptedSecret(secret)) return secret
    if (!safeStorage?.isEncryptionAvailable?.()) {
      throw new Error('系统安全存储不可用，无法保存云端访问密钥')
    }
    return `${SAFE_STORAGE_PREFIX}${safeStorage.encryptString(secret).toString('base64')}`
  }

  decryptSecret(secret: string): string {
    if (!this.isEncryptedSecret(secret)) return secret
    if (!safeStorage?.isEncryptionAvailable?.()) {
      throw new Error('系统安全存储不可用，无法读取云端访问密钥')
    }
    try {
      const payload = secret.slice(SAFE_STORAGE_PREFIX.length)
      return safeStorage.decryptString(Buffer.from(payload, 'base64'))
    } catch {
      return secret
    }
  }

  encryptConfig<T extends SecretConfig>(config: T): T {
    if (typeof config.accessKeySecret !== 'string') return config
    return {
      ...config,
      accessKeySecret: this.encryptSecret(config.accessKeySecret)
    }
  }

  decryptConfig<T extends SecretConfig>(config: T): T {
    if (typeof config.accessKeySecret !== 'string') return config
    return {
      ...config,
      accessKeySecret: this.decryptSecret(config.accessKeySecret)
    }
  }

  private isEncryptedSecret(secret: string): boolean {
    return secret.startsWith(SAFE_STORAGE_PREFIX)
  }
}

let instance: CredentialStore | null = null
export function getCredentialStore(): CredentialStore {
  if (!instance) instance = new CredentialStore()
  return instance
}
