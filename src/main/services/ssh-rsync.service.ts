import { spawn, type ChildProcess } from 'child_process'
import { Client as SSHClient, type SFTPWrapper } from 'ssh2'
import { readFileSync } from 'fs'
import { posix } from 'path'
import log from 'electron-log'
import type {
  CloudOperationResult,
  MultiCloudOperationResult,
  SSHMachine,
  RsyncProgress,
  SftpProgress,
  AppSettings,
  CloudProvider
} from '@shared/types'
import { providersForProfile } from '@shared/cloud-upload'
import {
  getProfileById,
  renderObjectKey,
  resolveProfileUploadSnapshot
} from '@shared/upload-profile'
import { getCloudUploadService } from './cloud-upload.service'
import type { CloudTaskUploader } from './cloud-upload.types'

/**
 * SSH + rsync / SFTP 远程传输服务
 * - rsync: 拉取到本地后自动触发云端上传
 * - sftp: 流式直传到当前选择的云端，不落盘
 */
export class SSHRsyncService {
  private runningProcesses: Map<string, ChildProcess | SSHClient> = new Map()

  /**
   * 测试 SSH 连接
   */
  async testConnection(machine: SSHMachine, password?: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const client = new SSHClient()
      const timeout = setTimeout(() => {
        client.end()
        resolve({ ok: false, error: '连接超时 (10s)' })
      }, 10000)

      client.on('ready', () => {
        clearTimeout(timeout)
        client.end()
        resolve({ ok: true })
      })

      client.on('error', (err) => {
        clearTimeout(timeout)
        resolve({ ok: false, error: err.message })
      })

      const connectOpts: Record<string, unknown> = {
        host: machine.host,
        port: machine.port,
        username: machine.username
      }

      if (machine.authType === 'key' && machine.privateKeyPath) {
        try {
          connectOpts.privateKey = readFileSync(machine.privateKeyPath)
        } catch (err) {
          resolve({ ok: false, error: `无法读取密钥文件: ${err}` })
          return
        }
      } else if (password) {
        connectOpts.password = password
      }

      client.connect(connectOpts as Parameters<typeof client.connect>[0])
    })
  }

  /**
   * 执行 rsync 拉取
   */
  async startRsync(
    machine: SSHMachine,
    password?: string,
    onProgress?: (progress: RsyncProgress) => void
  ): Promise<void> {
    if (this.runningProcesses.has(machine.id)) {
      throw new Error('该机器已有传输进程在运行')
    }

    return new Promise((resolve, reject) => {
      const args = this.buildRsyncArgs(machine)
      const env = { ...process.env }

      let cmd: string
      let cmdArgs: string[]

      if (machine.authType === 'password' && password) {
        cmd = 'sshpass'
        cmdArgs = ['-p', password, 'rsync', ...args]
      } else {
        cmd = 'rsync'
        cmdArgs = args
      }

      log.info(`rsync 启动: ${cmd} ${cmdArgs.join(' ')}`)

      const proc = spawn(cmd, cmdArgs, { env })
      this.runningProcesses.set(machine.id, proc)

      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        const line = data.toString()
        const progress = this.parseRsyncProgress(machine.id, line)
        if (progress && onProgress) {
          onProgress(progress)
        }
      })

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        this.runningProcesses.delete(machine.id)
        if (code === 0) {
          log.info(`rsync 完成: ${machine.name}`)
          resolve()
        } else {
          const err = `rsync 退出码 ${code}: ${stderr}`
          log.error(err)
          reject(new Error(err))
        }
      })

      proc.on('error', (err) => {
        this.runningProcesses.delete(machine.id)
        reject(err)
      })
    })
  }

  /**
   * SFTP 流式直传到当前选择的云端（不落盘）
   */
  async sftpStreamToCloud(
    machine: SSHMachine,
    password: string | undefined,
    settings: AppSettings,
    onProgress?: (progress: SftpProgress) => void
  ): Promise<MultiCloudOperationResult> {
    if (this.runningProcesses.has(machine.id)) {
      throw new Error('该机器已有传输进程在运行')
    }

    const profile = getProfileById(settings, machine.profileId)
    const providers = providersForProfile(profile)
    const uploaders = new Map<CloudProvider, CloudTaskUploader>()
    try {
      for (const provider of providers) {
        const validationError = getCloudUploadService().validateProvider(provider, settings)
        if (validationError) throw new Error(validationError)
        uploaders.set(
          provider,
          await getCloudUploadService().createTaskUploader(
            provider,
            settings,
            settings.upload.multipartThreshold
          )
        )
      }
    } catch (err) {
      for (const uploader of uploaders.values()) uploader.dispose()
      throw err
    }

    const client = new SSHClient()
    this.runningProcesses.set(machine.id, client)

    return new Promise((resolve, reject) => {
      const connectOpts: Record<string, unknown> = {
        host: machine.host,
        port: machine.port,
        username: machine.username
      }

      if (machine.authType === 'key' && machine.privateKeyPath) {
        try {
          connectOpts.privateKey = readFileSync(machine.privateKeyPath)
        } catch (err) {
          this.runningProcesses.delete(machine.id)
          reject(new Error(`无法读取密钥文件: ${err}`))
          return
        }
      } else if (password) {
        connectOpts.password = password
      }

      client.on('error', (err) => {
        this.runningProcesses.delete(machine.id)
        reject(err)
      })

      client.on('ready', () => {
        client.sftp(async (err, sftp) => {
          if (err) {
            client.end()
            this.runningProcesses.delete(machine.id)
            reject(err)
            return
          }

          try {
            const result = await this.sftpUploadDir(
              sftp,
              machine,
              settings,
              uploaders,
              onProgress
            )
            client.end()
            this.runningProcesses.delete(machine.id)
            for (const uploader of uploaders.values()) uploader.dispose()
            resolve(result)
          } catch (uploadErr) {
            client.end()
            this.runningProcesses.delete(machine.id)
            for (const uploader of uploaders.values()) uploader.dispose()
            reject(uploadErr)
          }
        })
      })

      client.connect(connectOpts as Parameters<typeof client.connect>[0])
    })
  }

  private async sftpUploadDir(
    sftp: SFTPWrapper,
    machine: SSHMachine,
    settings: AppSettings,
    uploaders: Map<CloudProvider, CloudTaskUploader>,
    onProgress?: (progress: SftpProgress) => void
  ): Promise<MultiCloudOperationResult> {
    // 递归列出所有远程文件
    const files = await this.sftpListFiles(sftp, machine.remoteDir, machine.remoteDir)
    log.info(`SFTP 发现 ${files.length} 个文件`)

    const providers = Array.from(uploaders.keys())
    const snapshot = resolveProfileUploadSnapshot(
      getProfileById(settings, machine.profileId),
      { sourcePath: machine.remoteDir },
      providers
    )
    let uploadedCount = 0
    const providerResults = new Map<string, CloudOperationResult>()
    for (const provider of uploaders.keys()) {
      providerResults.set(provider, { provider: provider as CloudOperationResult['provider'], ok: true, keys: [] })
    }

    for (const remoteFile of files) {
      const relativePath = remoteFile.slice(machine.remoteDir.length).replace(/^\//, '')
      onProgress?.({
        machineId: machine.id,
        totalFiles: files.length,
        uploadedFiles: uploadedCount,
        currentFile: relativePath,
        speed: ''
      })

      // 通过 SFTP 流式读取后上传到当前启用的云端
      await new Promise<void>((res, rej) => {
        const readStream = sftp.createReadStream(remoteFile)
        const chunks: Buffer[] = []

        readStream.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })

        readStream.on('end', async () => {
          try {
            const buffer = Buffer.concat(chunks)
            const active = Array.from(uploaders.entries()).filter(([provider]) => {
              return providerResults.get(provider)?.ok
            })
            await Promise.all(
              active.map(async ([provider, uploader]) => {
                const objectKey = renderObjectKey(
                  {
                    provider,
                    prefix: snapshot.prefixes[provider],
                    uploadRelativePath: snapshot.uploadRelativePaths[provider] ?? '',
                    pathMode: snapshot.pathModes[provider],
                    objectKeyTemplate: snapshot.objectKeyTemplates[provider] ?? null
                  },
                  {
                    sourcePath: machine.remoteDir,
                    folderName: posix.basename(machine.remoteDir),
                    relativePath,
                    profileId: snapshot.profileId,
                    profileName: snapshot.profileName
                  }
                )
                try {
                  await uploader.uploadBuffer(buffer, objectKey)
                  providerResults.get(provider)?.keys?.push(objectKey)
                } catch (err) {
                  providerResults.set(provider, {
                    provider: provider as CloudOperationResult['provider'],
                    ok: false,
                    error: err instanceof Error ? err.message : String(err)
                  })
                }
              })
            )
            if (Array.from(providerResults.values()).every((result) => result.ok)) {
              uploadedCount++
            }
            res()
          } catch (e) {
            rej(e)
          }
        })

        readStream.on('error', rej)
      })
    }

    onProgress?.({
      machineId: machine.id,
      totalFiles: files.length,
      uploadedFiles: uploadedCount,
      currentFile: '',
      speed: ''
    })

    log.info(`SFTP 直传完成: ${uploadedCount}/${files.length} 个文件`)
    const results = Array.from(providerResults.values())
    return {
      ok: results.every((result) => result.ok),
      results
    }
  }

  private sftpListFiles(sftp: SFTPWrapper, basePath: string, currentPath: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      sftp.readdir(currentPath, async (err, list) => {
        if (err) {
          reject(err)
          return
        }

        const files: string[] = []
        for (const item of list) {
          if (item.filename.startsWith('.')) continue
          const fullPath = posix.join(currentPath, item.filename)

          if (item.attrs.isDirectory()) {
            const subFiles = await this.sftpListFiles(sftp, basePath, fullPath)
            files.push(...subFiles)
          } else if (item.attrs.isFile()) {
            files.push(fullPath)
          }
        }
        resolve(files)
      })
    })
  }

  stopRsync(machineId: string): void {
    const running = this.runningProcesses.get(machineId)
    if (running) {
      if (running instanceof SSHClient) {
        running.end()
      } else {
        (running as ChildProcess).kill('SIGTERM')
      }
      this.runningProcesses.delete(machineId)
      log.info('传输已停止:', machineId)
    }
  }

  private buildRsyncArgs(machine: SSHMachine): string[] {
    const args: string[] = [
      '-avz',
      '--partial',
      '--progress',
      `--bwlimit=${machine.bwLimit}`
    ]

    const sshCmd = machine.authType === 'key' && machine.privateKeyPath
      ? `ssh -i ${machine.privateKeyPath} -p ${machine.port} -o StrictHostKeyChecking=no`
      : `ssh -p ${machine.port} -o StrictHostKeyChecking=no`

    const remoteRsync = `nice -n ${machine.cpuNice} ionice -c 3 rsync`
    args.push(`--rsync-path=${remoteRsync}`)
    args.push('-e', sshCmd)

    const remotePath = machine.remoteDir.endsWith('/') ? machine.remoteDir : machine.remoteDir + '/'
    const source = `${machine.username}@${machine.host}:${remotePath}`
    const dest = machine.localDir.endsWith('/') ? machine.localDir : machine.localDir + '/'

    args.push(source, dest)

    return args
  }

  private parseRsyncProgress(machineId: string, line: string): RsyncProgress | null {
    const match = line.match(/(\d+)%\s+([\d.]+\w+\/s)/)
    if (match) {
      return {
        machineId,
        percent: parseInt(match[1]),
        speed: match[2],
        file: line.trim().split('\n')[0] || ''
      }
    }
    return null
  }
}

let instance: SSHRsyncService | null = null
export function getSSHRsyncService(): SSHRsyncService {
  if (!instance) instance = new SSHRsyncService()
  return instance
}
