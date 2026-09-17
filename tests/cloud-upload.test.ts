import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveLogicalFileStatus,
  deriveTaskStatus,
  legacyProviderForConnectionType
} from '../src/shared/cloud-upload'

test('maps connection types to legacy provider compatibility fields', () => {
  assert.equal(legacyProviderForConnectionType('aliyun-oss'), 'aliyun')
  assert.equal(legacyProviderForConnectionType('s3'), 'tencent')
})

test('requires every selected cloud to complete a logical file', () => {
  assert.equal(
    deriveLogicalFileStatus(['completed', 'completed']),
    'completed'
  )
  assert.equal(
    deriveLogicalFileStatus(['completed', 'failed']),
    'failed'
  )
  assert.equal(
    deriveLogicalFileStatus(['completed', 'pending']),
    'pending'
  )
})

test('keeps the logical task failed until all selected clouds complete', () => {
  assert.equal(deriveTaskStatus(['completed']), 'completed')
  assert.equal(deriveTaskStatus(['completed', 'completed']), 'completed')
  assert.equal(deriveTaskStatus(['completed', 'failed']), 'failed')
  assert.equal(deriveTaskStatus(['completed', 'uploading']), 'uploading')
  assert.equal(deriveTaskStatus(['synced', 'completed']), 'synced')
  assert.equal(deriveTaskStatus(['retrying', 'completed']), 'retrying')
  assert.equal(deriveTaskStatus(['skipped']), 'skipped')
})
