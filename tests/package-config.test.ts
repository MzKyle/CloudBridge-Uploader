import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('packaging excludes only project source and keeps dependency src entrypoints', () => {
  const config = readFileSync('electron-builder.yml', 'utf8')

  assert.ok(
    config.includes("- '!src/**'"),
    'project source should be excluded with a root-scoped pattern'
  )
  assert.ok(
    !config.includes("- '!**/src/**'"),
    'dependency src directories must remain packagable for modules such as electron-log'
  )
})
