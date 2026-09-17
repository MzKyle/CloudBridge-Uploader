import assert from 'node:assert/strict'
import test from 'node:test'
import {
  renderPathMapping,
  validatePathMappingTemplate
} from '../src/shared/path-mapping'
import { joinOssPath } from '../src/shared/day-folder'

test('keep-relative maps nested file paths below the connection prefix', () => {
  const mappedPath = renderPathMapping(
    { mode: 'keep-relative' },
    {
      sourcePath: '/data/2026-06-27/04-39-04',
      relativePath: 'camera/1.jpg'
    }
  )

  assert.equal(mappedPath, 'camera/1.jpg')
  assert.equal(joinOssPath('upload/', mappedPath), 'upload/camera/1.jpg')
})

test('flatten maps files by filename only and normalizes Windows separators', () => {
  assert.equal(
    renderPathMapping(
      { mode: 'flatten' },
      {
        sourcePath: 'D:\\data\\2026-06-27\\04-39-04',
        relativePath: 'camera\\frame001.png'
      }
    ),
    'frame001.png'
  )
})

test('template path mapping renders built-in and discovery variables', () => {
  const mappedPath = renderPathMapping(
    {
      mode: 'template',
      template: 'archive/{machine}/{date}/{session}/{stem}{ext}'
    },
    {
      sourcePath: '/data/machine-a/20260914/run-1',
      relativePath: 'camera/result.csv',
      variables: {
        machine: 'machine-a',
        date: '20260914',
        session: 'run-1'
      }
    }
  )

  assert.equal(mappedPath, 'archive/machine-a/20260914/run-1/result.csv')
})

test('rejects unsafe or unknown template expressions', () => {
  assert.deepEqual(validatePathMappingTemplate(''), ['路径映射模板不能为空'])
  assert.deepEqual(
    validatePathMappingTemplate('{relativePath}/{unknown}'),
    ['未知路径变量: unknown']
  )
  assert.deepEqual(
    validatePathMappingTemplate('/absolute/{relativePath}'),
    ['路径映射模板不能使用绝对路径']
  )
  assert.deepEqual(
    validatePathMappingTemplate('../{relativePath}'),
    ['路径映射模板不能包含 .. 路径段']
  )
})
