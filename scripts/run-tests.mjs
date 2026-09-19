import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const tsxPackage = require('tsx/package.json')
const tsxPackagePath = require.resolve('tsx/package.json')
const tsxCliPath = path.join(path.dirname(tsxPackagePath), tsxPackage.bin)
const testsDir = path.resolve('tests')

const entries = await readdir(testsDir, { withFileTypes: true })
const testFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
  .map((entry) => path.join(testsDir, entry.name))
  .sort()

if (testFiles.length === 0) {
  console.error(`No test files found in ${testsDir}`)
  process.exit(1)
}

const child = spawn(process.execPath, [tsxCliPath, '--test', ...testFiles], {
  stdio: 'inherit'
})

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Test runner exited with signal ${signal}`)
    process.exit(1)
  }

  process.exit(code ?? 1)
})
