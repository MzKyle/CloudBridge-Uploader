import { appendFileSync, readFileSync } from 'node:fs'

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (!tag) {
  fail('Release tag is required. Pass it as an argument or set GITHUB_REF_NAME.')
}

const tagMatch = /^v(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(tag)
if (!tagMatch?.groups?.version) {
  fail(`Release tag "${tag}" must be vX.Y.Z or vX.Y.Z-prerelease.`)
}

const version = tagMatch.groups.version
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const packageLock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const lockPackageVersion = packageLock.packages?.['']?.version

if (packageJson.version !== version) {
  fail(`Tag/version mismatch: tag ${tag} resolves to ${version}, package.json is ${packageJson.version}.`)
}

if (packageLock.version !== packageJson.version) {
  fail(
    `package-lock.json root version ${packageLock.version} does not match package.json ${packageJson.version}.`
  )
}

if (lockPackageVersion !== packageJson.version) {
  fail(
    `package-lock.json packages[""].version ${lockPackageVersion} does not match package.json ${packageJson.version}.`
  )
}

const githubOutput = process.env.GITHUB_OUTPUT
if (githubOutput) {
  appendFileSync(githubOutput, `version=${version}\n`)
  appendFileSync(githubOutput, `prerelease=${version.includes('-') ? 'true' : 'false'}\n`)
}

console.log(`Release tag ${tag} matches package version ${version}.`)
