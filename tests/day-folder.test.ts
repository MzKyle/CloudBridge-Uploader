import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildOssKey,
  buildUploadRelativePath,
  deriveDateScopedUploadRelativePath,
  determineDayFolderStatus,
  isDateFolderBeforeToday,
  isDateFolderName,
  parseDateFolderName,
} from '../src/shared/day-folder'

test('validates real YYYY-MM-DD directory names', () => {
  assert.equal(isDateFolderName('2026-06-18'), true)
  assert.equal(isDateFolderName('2024-02-29'), true)
  assert.equal(isDateFolderName('2026-02-29'), false)
  assert.equal(isDateFolderName('2026-13-01'), false)
  assert.equal(isDateFolderName('test_data'), false)
  assert.equal(parseDateFolderName('2026-06-18')?.getFullYear(), 2026)
})

test('uses the local calendar day as the completion boundary', () => {
  const now = new Date(2026, 5, 18, 12, 0, 0)
  assert.equal(isDateFolderBeforeToday('2026-06-17', now), true)
  assert.equal(isDateFolderBeforeToday('2026-06-18', now), false)
  assert.equal(isDateFolderBeforeToday('2026-06-19', now), false)
})

test('derives day folder status from all discovered child tasks', () => {
  const now = new Date(2026, 5, 18, 12, 0, 0)
  assert.equal(determineDayFolderStatus('2026-06-17', ['completed', 'completed'], now), 'completed')
  assert.equal(determineDayFolderStatus('2026-06-18', ['completed'], now), 'collecting')
  assert.equal(determineDayFolderStatus('2026-06-17', ['completed', null], now), 'processing')
  assert.equal(determineDayFolderStatus('2026-06-17', ['completed', 'pending'], now), 'processing')
  assert.equal(determineDayFolderStatus('2026-06-17', ['completed', 'paused'], now), 'blocked')
  assert.equal(determineDayFolderStatus('2026-06-17', ['failed'], now), 'blocked')
  assert.equal(determineDayFolderStatus('2026-06-17', ['synced', 'synced'], now), 'completed')
  assert.equal(
    determineDayFolderStatus('2026-06-17', ['synced', 'skipped'], now),
    'completed_with_skips'
  )
  assert.equal(determineDayFolderStatus('2026-06-18', ['synced'], now), 'collecting')
  assert.equal(determineDayFolderStatus('2026-06-17', ['retrying'], now), 'processing')
  assert.equal(determineDayFolderStatus('2026-06-17', [], now), 'collecting')
})

test('builds stable POSIX OSS paths with date and welding directory', () => {
  const relativePath = buildUploadRelativePath('2026-06-18', '04-39-04')
  assert.equal(relativePath, '2026-06-18/04-39-04')
  assert.equal(
    buildOssKey('upload/', relativePath, 'camera\\0001.jpg'),
    'upload/2026-06-18/04-39-04/camera/0001.jpg'
  )
})

test('keeps the date level when uploading a date directory or its child package', () => {
  assert.equal(
    deriveDateScopedUploadRelativePath('/data/2026-03-14/17-38-09_teleop'),
    '2026-03-14/17-38-09_teleop'
  )
  assert.equal(
    deriveDateScopedUploadRelativePath('/data/2026-03-14'),
    '2026-03-14'
  )
  assert.equal(
    deriveDateScopedUploadRelativePath('D:\\data\\2026-03-14\\08-05-00'),
    '2026-03-14/08-05-00'
  )
})
