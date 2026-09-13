import { safeStorage } from 'electron'

const SAFE_STORAGE_PREFIX = 'safe-storage:v1:'

type SecretConfig = Record<string, unknown> & {
  accessKeySecret?: unknown
}

export class CredentialStore {
  encryptSecret(secret: string): string {
    if (!secret || this.isEncryptedSecret(secret)) return secret
    if (!safeStorage?.isEncryptionAvailable?.()) return secret
    return `${SAFE_STORAGE_PREFIX}${safeStorage.encryptString(secret).toString('base64')}`
  }

  decryptSecret(secret: string): string {
    if (!this.isEncryptedSecret(secret)) return secret
    if (!safeStorage?.isEncryptionAvailable?.()) return secret
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
