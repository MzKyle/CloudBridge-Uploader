import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { FileFilterService } from '../src/main/services/file-filter.service'
import type { FilterRules } from '../src/shared/types'

const ALL_FILES: FilterRules = {
  whitelist: [],
  blacklist: [],
  regex: [],
  suffixes: []
}

test('folder scans preserve complete relative paths with trailing and mixed separators', async () => {
  const root = mkdtempSync(join(tmpdir(), 'file-filter-path-'))
  try {
    mkdirSync(join(root, '中文目录 空格'))
    writeFileSync(join(root, '中文目录 空格', 'sample.csv'), 'csv')
    writeFileSync(join(root, 'first.txt'), 'first')
    const service = new FileFilterService(ALL_FILES)
    const variants = [root, `${root}${sep}`]
    if (process.platform === 'win32') variants.push(`${root.replace(/\\/g, '/')}/`)
    for (const source of variants) {
      assert.deepEqual(
        service.scanFolder(source).map((file) => file.relativePath).sort(),
        ['first.txt', '中文目录 空格/sample.csv'],
        source
      )
      assert.deepEqual(
        (await service.scanFolderAsync(source)).map((file) => file.relativePath).sort(),
        ['first.txt', '中文目录 空格/sample.csv'],
        source
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('async folder scan matches sync filtering and skips marker files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'file-filter-'))
  try {
    mkdirSync(join(root, 'camera'), { recursive: true })
    mkdirSync(join(root, '.hidden'), { recursive: true })
    writeFileSync(join(root, 'camera', '1.jpg'), 'image')
    writeFileSync(join(root, 'camera', '2.csv'), 'csv')
    writeFileSync(join(root, 'tmp_upload.json'), '{}')
    writeFileSync(join(root, '.hidden', 'secret.jpg'), 'secret')

    const service = new FileFilterService({
      ...ALL_FILES,
      suffixes: ['.jpg']
    })
    const syncFiles = service
      .scanFolder(root)
      .map((file) => file.relativePath)
      .sort()
    const asyncFiles = (await service.scanFolderAsync(root))
      .map((file) => file.relativePath)
      .sort()

    assert.deepEqual(syncFiles, ['camera/1.jpg'])
    assert.deepEqual(asyncFiles, syncFiles)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('batched folder scan matches async scan results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'file-filter-batches-'))
  try {
    mkdirSync(join(root, 'camera'), { recursive: true })
    writeFileSync(join(root, 'camera', '1.jpg'), 'image-1')
    writeFileSync(join(root, 'camera', '2.jpg'), 'image-2')
    writeFileSync(join(root, 'camera', '3.csv'), 'csv')
    writeFileSync(join(root, 'camera', 'skip.log'), 'log')

    const service = new FileFilterService({
      ...ALL_FILES,
      suffixes: ['.jpg', '.csv']
    })
    const asyncFiles = (await service.scanFolderAsync(root))
      .map((file) => file.relativePath)
      .sort()
    const batches: string[][] = []
    for await (const batch of service.scanFolderBatches(root, 2)) {
      batches.push(batch.map((file) => file.relativePath))
    }

    assert.deepEqual(asyncFiles, [
      'camera/1.jpg',
      'camera/2.jpg',
      'camera/3.csv'
    ])
    assert.deepEqual(
      batches.flat().sort(),
      asyncFiles
    )
    assert.deepEqual(
      batches.map((batch) => batch.length),
      [2, 1]
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
