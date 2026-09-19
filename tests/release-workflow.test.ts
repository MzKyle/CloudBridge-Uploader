import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('release workflow is tag-triggered and gated by validation', () => {
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8')

  assert.match(workflow, /tags:\n\s+- "v\*"/)
  assert.match(workflow, /permissions:\n\s+contents: read/)
  assert.match(workflow, /validate:/)
  assert.match(workflow, /node scripts\/validate-release-tag\.mjs "\$\{GITHUB_REF_NAME\}"/)
  assert.match(workflow, /package-windows:[\s\S]*needs: validate/)
  assert.match(workflow, /package-linux:[\s\S]*needs: validate/)
  assert.match(workflow, /release:[\s\S]*contents: write/)
  assert.match(workflow, /! -name SHA256SUMS\.txt/)
  assert.match(workflow, /gh release create/)
  assert.doesNotMatch(workflow, /packages: write/)
  assert.doesNotMatch(workflow, /id-token/)
  assert.doesNotMatch(workflow, /deployments/)
  assert.doesNotMatch(workflow, /actions: write/)
})

test('release workflow builds native platform packages', () => {
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8')

  assert.match(workflow, /runs-on: windows-latest[\s\S]*npm run build:win/)
  assert.match(workflow, /runs-on: ubuntu-latest[\s\S]*npm run build:linux/)
  assert.doesNotMatch(workflow, /npm run build\n/)
})

test('release tag validation accepts the package version tag', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
  const result = spawnSync(process.execPath, ['scripts/validate-release-tag.mjs', `v${packageJson.version}`], {
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
})

test('release tag validation rejects tag and package version mismatch', () => {
  const result = spawnSync(process.execPath, ['scripts/validate-release-tag.mjs', 'v0.0.0'], {
    encoding: 'utf8'
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Tag\/version mismatch/)
})
