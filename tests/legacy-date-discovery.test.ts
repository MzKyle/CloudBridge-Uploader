import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  discoverCurrentDayDirectory,
  isWorkDirName
} from '../src/main/services/legacy-date-discovery'

test('legacy date discovery finds the current date folder and splits work dirs from ignored dirs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uploader-scan-'))

  try {
    const today = join(root, '2026-06-24')
    mkdirSync(today)
    mkdirSync(join(today, '04-39-04'))
    mkdirSync(join(today, '05-06-52'))
    mkdirSync(join(today, 'teach'))
    mkdirSync(join(today, '.working'))
    mkdirSync(join(today, '04-39-04', 'camera'))
    writeFileSync(join(today, 'root-file.txt'), 'ignored')

    const oldDay = join(root, '2026-06-23')
    mkdirSync(oldDay)
    mkdirSync(join(oldDay, '20-46-05'))
    mkdirSync(join(root, 'test_data'))
    writeFileSync(join(root, '2026-06-22'), 'not a directory')

    assert.deepEqual(await discoverCurrentDayDirectory(root, '2026-06-24'), {
      dateName: '2026-06-24',
      folderPath: today,
      childFolderNames: ['04-39-04', '05-06-52'],
      ignoredChildFolderNames: ['teach']
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('work dir name pattern is configurable and falls back when invalid', () => {
  assert.equal(isWorkDirName('20-46-05'), true)
  assert.equal(isWorkDirName('teach'), false)
  assert.equal(isWorkDirName('work-1', '^work-\\d+$'), true)
  assert.equal(isWorkDirName('work-1', '['), false)
})
