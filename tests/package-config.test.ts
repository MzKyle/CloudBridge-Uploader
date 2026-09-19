import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

test('packaging excludes only project source and keeps dependency src entrypoints', () => {
  const config = readText('electron-builder.yml')

  assert.ok(
    config.includes("- '!src/**'"),
    'project source should be excluded with a root-scoped pattern'
  )
  assert.ok(
    !config.includes("- '!**/src/**'"),
    'dependency src directories must remain packagable for modules such as electron-log'
  )
})

test('packaging keeps native modules unpacked for Electron runtime', () => {
  const config = readText('electron-builder.yml')

  assert.ok(
    config.includes('asarUnpack:\n  - node_modules/better-sqlite3/**/*'),
    'better-sqlite3 must remain unpacked from app.asar'
  )
})

test('packaging uses CloudBridge release asset names', () => {
  const config = readText('electron-builder.yml')

  assert.ok(
    config.includes('artifactName: CloudBridge-Uploader-${version}-windows-${arch}.${ext}'),
    'Windows artifact name should include product, version, platform, arch, and extension'
  )
  assert.ok(
    config.includes('artifactName: CloudBridge-Uploader-${version}-linux-${arch}.${ext}'),
    'Linux artifact name should include product, version, platform, arch, and extension'
  )
})

test('Windows icon path points to a real ICO file', () => {
  const config = readText('electron-builder.yml')

  assert.ok(config.includes('icon: resources/icon.ico'), 'Windows packaging should use the generated ICO icon')
  assert.ok(existsSync('resources/icon.ico'), 'Windows icon file should exist')
})
