import assert from 'node:assert/strict'
import test from 'node:test'
import { join, parse, resolve, sep } from 'node:path'
import { isPathWithinFolder, normalizeFolderPath } from '../src/main/utils/local-path'

test('folder normalization preserves filesystem roots and removes other trailing separators', () => {
  const root = parse(resolve('.')).root
  assert.equal(normalizeFolderPath(root), root)
  assert.equal(normalizeFolderPath(`${join(root, 'source')}${sep}`), join(root, 'source'))
  if (process.platform === 'win32') {
    assert.equal(normalizeFolderPath('C:\\'), 'C:\\')
    assert.equal(normalizeFolderPath('\\\\server\\share\\'), '\\\\server\\share\\')
  }
})

test('folder containment handles drive roots, path boundaries and Windows casing', () => {
  const root = parse(resolve('.')).root
  const folder = join(root, 'Source')
  assert.equal(isPathWithinFolder(join(folder, '中文目录', 'sample.csv'), folder), true)
  assert.equal(isPathWithinFolder(join(root, 'Source-other', 'sample.csv'), folder), false)
  assert.equal(isPathWithinFolder(join(folder, '..', 'sample.csv'), folder), false)
  assert.equal(isPathWithinFolder(join(root, 'sample.csv'), root), true)
  if (process.platform === 'win32') {
    assert.equal(isPathWithinFolder('C:\\source\\child.csv', 'c:/SOURCE/'), true)
    assert.equal(isPathWithinFolder('D:\\source\\child.csv', 'C:\\'), false)
    assert.equal(isPathWithinFolder('\\\\server\\share\\child.csv', '\\\\server\\share\\'), true)
  }
})
