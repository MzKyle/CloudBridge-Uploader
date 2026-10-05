import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright'

// Use the installed application path to verify an NSIS installation. By default,
// verify the packaged application produced by build:win, including ASAR/native deps.
assert.equal(process.platform, 'win32', 'Run Windows acceptance on Windows')
const executablePath = resolve(process.argv[2] || 'dist/win-unpacked/云桥上传器.exe')
assert.ok(existsSync(executablePath), `Missing application: ${executablePath}`)
mkdirSync('.acceptance', { recursive: true })
const runDirectory = mkdtempSync(resolve('.acceptance/windows-'))
const profile = join(runDirectory, 'profile')
const rootA = join(runDirectory, '中文目录 空格')
const rootB = join(runDirectory, 'second source')
mkdirSync(join(rootA, 'camera'), { recursive: true })
mkdirSync(rootB, { recursive: true })
const samples = new Map([
  ['first.txt', Buffer.from('Windows acceptance sample\r\n')],
  ['camera/中文文件.csv', Buffer.from('名称,值\r\n样本,1\r\n')],
  ['large.bin', Buffer.alloc(6 * 1024 * 1024, 37)]
])
for (const [name, bytes] of samples) {
  writeFileSync(join(name === 'large.bin' ? rootB : rootA, name), bytes)
}

const objects = new Map()
const uploads = new Map()
const writes = new Map()
let failSecondary = true
let uploadSequence = 0
let holdManualUpload = true
let manualUploadStarted = false
let fixtureError
const md5 = (bytes) => `"${createHash('md5').update(bytes).digest('hex')}"`
const xml = (response, body, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/xml' })
  response.end(body)
}
function decodeBody(body, encoding) {
  if (!encoding?.includes('aws-chunked')) return body
  const chunks = []
  let offset = 0
  while (offset < body.length) {
    const end = body.indexOf('\r\n', offset)
    assert.ok(end >= offset, 'Invalid AWS chunk header')
    const size = Number.parseInt(body.subarray(offset, end).toString().split(';')[0], 16)
    assert.ok(Number.isFinite(size), 'Invalid AWS chunk length')
    if (size === 0) break
    chunks.push(body.subarray(end + 2, end + 2 + size))
    offset = end + 2 + size + 2
  }
  return Buffer.concat(chunks)
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost')
    const object = decodeURIComponent(url.pathname.slice(1))
    if (object.startsWith('secondary/') && failSecondary) {
      request.resume()
      return xml(response, '<Error><Code>AccessDenied</Code><Message>Intentional acceptance failure</Message></Error>', 403)
    }
    if (request.method === 'GET') {
      return xml(response, '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>acceptance</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>')
    }
    if (object.endsWith('/manual.txt') && holdManualUpload) {
      manualUploadStarted = true
      request.resume()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const bytes = decodeBody(Buffer.concat(chunks), request.headers['content-encoding'])
    if (request.method === 'POST' && url.searchParams.has('uploads')) {
      const id = `acceptance-${++uploadSequence}`
      uploads.set(id, new Map())
      return xml(response, `<InitiateMultipartUploadResult><Bucket>${object.split('/')[0]}</Bucket><Key>${object.slice(object.indexOf('/') + 1)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`)
    }
    if (request.method === 'PUT' && url.searchParams.has('partNumber')) {
      uploads.get(url.searchParams.get('uploadId')).set(Number(url.searchParams.get('partNumber')), bytes)
      response.writeHead(200, { ETag: md5(bytes) })
      return response.end()
    }
    if (request.method === 'POST' && url.searchParams.has('uploadId')) {
      const parts = uploads.get(url.searchParams.get('uploadId'))
      const content = Buffer.concat([...parts].sort(([a], [b]) => a - b).map(([, part]) => part))
      objects.set(object, content)
      writes.set(object, (writes.get(object) || 0) + 1)
      uploads.delete(url.searchParams.get('uploadId'))
      return xml(response, `<CompleteMultipartUploadResult><Location>http://localhost/${object}</Location><Bucket>${object.split('/')[0]}</Bucket><Key>${object.slice(object.indexOf('/') + 1)}</Key><ETag>${md5(content)}</ETag></CompleteMultipartUploadResult>`)
    }
    if (request.method === 'PUT') {
      objects.set(object, bytes)
      writes.set(object, (writes.get(object) || 0) + 1)
      response.writeHead(200, { ETag: md5(bytes) })
      return response.end()
    }
    if (request.method === 'DELETE') {
      uploads.delete(url.searchParams.get('uploadId'))
      response.writeHead(204)
      return response.end()
    }
    throw new Error(`Unexpected fixture request: ${request.method} ${request.url}`)
  } catch (error) {
    fixtureError = error
    xml(response, '<Error><Code>InternalError</Code></Error>', 500)
  }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const endpoint = `http://127.0.0.1:${server.address().port}`
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const rendererErrors = []
const checks = []
let application
let page
let processOutput = ''
async function until(description, action, predicate, timeout = 45000) {
  const deadline = Date.now() + timeout
  let value
  while (Date.now() < deadline) {
    if (fixtureError) throw fixtureError
    value = await action()
    if (predicate(value)) return value
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`Timed out: ${description}; last result: ${JSON.stringify(value)}`)
}
const invoke = (channel, args) => page.evaluate(
  ([name, input]) => window.api.invoke(name, input), [channel, args]
)
function pass(name) {
  checks.push(name)
  console.log(`PASS ${name}`)
}
async function launch() {
  application = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env, timeout: 30000 })
  application.process().stdout.on('data', (data) => { processOutput += data })
  application.process().stderr.on('data', (data) => { processOutput += data })
  page = await until('main window', async () => application.windows().find((window) => window.url().startsWith('file:')), Boolean)
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  await page.getByRole('heading', { name: '云桥上传器', exact: true }).waitFor()
  const paths = await application.evaluate(({ app, safeStorage, nativeImage }) => ({
    profile: app.getPath('userData'),
    version: app.getVersion(),
    packaged: app.isPackaged,
    encryption: safeStorage.isEncryptionAvailable(),
    iconEmpty: nativeImage.createFromPath(process.getBuiltinModule('path').join(process.resourcesPath, 'resources', 'icon.png')).isEmpty()
  }))
  assert.equal(paths.profile, profile)
  assert.equal(paths.packaged, true)
  assert.equal(paths.encryption, true)
  assert.equal(paths.iconEmpty, false)
  return paths
}
async function field(label, value) {
  const input = page.locator('label').filter({ hasText: new RegExp(`^${label}$`) }).locator('..').locator('input')
  await input.fill(value)
}
async function addS3(name, bucket) {
  await page.getByRole('button', { name: 'S3', exact: true }).click()
  for (const [label, value] of Object.entries({
    '名称': name, Endpoint: endpoint, Region: 'us-east-1', Bucket: bucket,
    Prefix: 'acceptance', 'Access Key ID': 'acceptance-key', 'Access Key Secret': 'acceptance-test-only'
  })) await field(label, value)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  return until('connection saved', () => invoke('settings:get-all'),
    (settings) => settings.connections.some((connection) => connection.name === name))
}
let version
try {
  const paths = await launch()
  version = paths.version
  pass('installed packaged application, SQLite migration, DPAPI and tray resource')
  for (const [navigation, title] of [
    ['上传规则', '上传规则'], ['云端连接', '云端连接'],
    ['历史记录', '历史记录'], ['设置', '设置'], ['任务', '任务面板']
  ]) {
    await page.getByRole('link', { name: navigation, exact: true }).click()
    await page.getByRole('heading', { name: title, exact: true }).waitFor()
  }
  pass('all main navigation pages render')
  await page.getByRole('link', { name: '云端连接', exact: true }).click()
  await addS3('Windows primary', 'primary')
  let settings = await addS3('Windows secondary', 'secondary')
  await page.getByRole('button', { name: 'Aliyun', exact: true }).click()
  await field('名称', 'Windows OSS example')
  await field('Region', 'oss-cn-hangzhou')
  await field('Bucket', 'acceptance-example')
  await field('Access Key ID', 'acceptance-key')
  await field('Access Key Secret', 'acceptance-test-only')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  settings = await until('OSS connection saved', () => invoke('settings:get-all'),
    (value) => value.connections.some((connection) => connection.name === 'Windows OSS example'))
  const primary = settings.connections.find((connection) => connection.name === 'Windows primary')
  const secondary = settings.connections.find((connection) => connection.name === 'Windows secondary')
  const stored = await application.evaluate(({ app }) => {
    const Database = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`)('better-sqlite3')
    const database = new Database(process.getBuiltinModule('path').join(app.getPath('userData'), 'uploader.db'), { readonly: true })
    try { return database.prepare("SELECT value FROM settings WHERE key = 'connections'").get().value }
    finally { database.close() }
  })
  assert.ok(stored.includes('safe-storage:v1:'))
  assert.ok(!stored.includes('acceptance-test-only'))
  assert.equal(primary.config.accessKeySecret, 'acceptance-test-only')
  assert.deepEqual(await invoke('connection:test', { connectionId: primary.id, type: 's3', config: primary.config }), { ok: true })
  assert.equal((await invoke('connection:test', { connectionId: secondary.id, type: 's3', config: secondary.config })).ok, false)
  pass('S3 and OSS connection creation, encrypted persistence and S3 connection success/failure')
  const rule = {
    ...settings.rules[0], id: 'windows-acceptance', name: 'Windows acceptance', enabled: true,
    source: { roots: [`${rootA}\\`, `${rootB.replace(/\\/g, '/')}/`] },
    discovery: { groupPattern: '', taskPattern: '', groupRegex: '', taskRegex: '', recursive: false },
    destinations: [{ connectionId: primary.id }, { connectionId: secondary.id }],
    completion: { mode: 'manual' }, cleanup: { enabled: false, retentionDays: 0, onlyAfterSealed: true },
    pathMapping: { mode: 'keep-relative' }, filter: { whitelist: [], blacklist: [], regex: [], suffixes: [] }
  }
  await invoke('settings:save', {
    rules: [rule], activeRuleId: rule.id, scan: { intervalSeconds: 1 },
    stability: { checkIntervalMs: 100, checkCount: 2 },
    upload: { ...settings.upload, startAfterTime: null, endBeforeTime: null, multipartThreshold: 1024 * 1024 }
  })
  const dryRun = await invoke('upload-rule:dry-run', { ruleId: rule.id, sampleLimit: 10 })
  assert.equal(dryRun.ok, true, JSON.stringify(dryRun.errors))
  assert.equal(dryRun.totals.roots, 2)
  assert.equal(dryRun.totals.filesScanned, 3)
  assert.deepEqual(dryRun.roots.flatMap((root) => root.groups.flatMap((group) => group.tasks.flatMap((task) => task.sampleFiles.map((file) => file.relativePath)))).sort(), [...samples.keys()].sort())
  pass('multi-root dry run with trailing, mixed separators, Unicode and spaces')
  await invoke('scanner:trigger')
  const tasks = await until('stable discovered tasks', () => invoke('task:list'),
    (value) => value.length === 2 && value.every((task) => task.totalFiles > 0 && task.status === 'pending'))
  assert.equal((await invoke('disk:usage')).length, 2)
  await invoke('upload-queue:start', { scope: 'selected', taskIds: tasks.map((task) => task.id), overrideWindow: true })
  await until('isolated failed destination', () => invoke('task:list'),
    (value) => value.length === 2 && value.every((task) => task.status === 'failed' && task.destinations.some((destination) => destination.connectionId === primary.id && destination.status === 'synced')))
  for (const [name, bytes] of samples) assert.deepEqual(objects.get(`primary/acceptance/${name}`), bytes, name)
  assert.ok(uploadSequence > 0, 'Large sample should exercise multipart upload')
  pass('real S3 SDK single-part and multipart uploads, byte verification and destination failure isolation')
  const primaryWrites = [...writes].filter(([key]) => key.startsWith('primary/'))
  await invoke('settings:save', { rules: [{ ...rule, pathMapping: { mode: 'flatten' } }] })
  await application.close()
  application = null
  await launch()
  settings = await invoke('settings:get-all')
  assert.equal(settings.connections.find((connection) => connection.id === primary.id).config.accessKeySecret, 'acceptance-test-only')
  await until('unfinished task recovery', () => invoke('task:list'),
    (value) => value.length === 2 && value.every((task) => task.status === 'pending' && task.ruleSnapshot.pathMapping.mode === 'keep-relative'))
  assert.equal((await invoke('upload-queue:status')).gateOpen, false)
  pass('restart restores unfinished tasks, credentials and task rule snapshots with upload gate closed')
  failSecondary = false
  for (const task of tasks) await invoke('task:retry', { taskId: task.id, connectionId: secondary.id })
  await invoke('upload-queue:start', { scope: 'selected', taskIds: tasks.map((task) => task.id), overrideWindow: true })
  await until('retry completes', () => invoke('task:list'), (value) => value.length === 2 && value.every((task) => task.status === 'synced'))
  for (const [key, count] of primaryWrites) assert.equal(writes.get(key), count, `Completed destination uploaded twice: ${key}`)
  for (const [name, bytes] of samples) assert.deepEqual(objects.get(`secondary/acceptance/${name}`), bytes, name)
  assert.ok(!objects.has('secondary/acceptance/中文文件.csv'), 'Later flatten edit must not affect existing tasks')
  pass('retry only failed connection without reuploading completed destination or applying later rule edits')
  const groups = await invoke('upload-group:list')
  assert.equal(groups.length, 2)
  for (const group of groups) {
    const sealed = await invoke('upload-group:close', { id: group.id })
    assert.equal(sealed.uploadGroupStatus, 'sealed')
  }
  const archivedGroups = await invoke('upload-group:list', { includeCompleted: true })
  assert.equal(archivedGroups.filter((group) => group.status === 'completed').length, 2)
  const manualRoot = join(runDirectory, 'manual folder')
  mkdirSync(manualRoot)
  writeFileSync(join(manualRoot, 'manual.txt'), 'manual folder sample')
  const manualTask = await invoke('task:add-folder', { folderPath: manualRoot, ruleId: rule.id })
  await until('manual folder reconciled', () => invoke('task:get', { taskId: manualTask.id }),
    (task) => task.status === 'pending' && task.totalFiles === 1)
  await invoke('task:pause', { taskId: manualTask.id })
  assert.equal((await invoke('task:get', { taskId: manualTask.id })).status, 'paused')
  await invoke('task:resume', { taskId: manualTask.id })
  await invoke('upload-queue:start', { scope: 'selected', taskIds: [manualTask.id], overrideWindow: true })
  await until('manual upload in flight', () => invoke('task:get', { taskId: manualTask.id }),
    (task) => task.status === 'uploading' && manualUploadStarted)
  // Exit during an outstanding network request, bypassing graceful will-quit recovery.
  await application.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await application.close()
  application = null
  holdManualUpload = false
  await launch()
  await until('interrupted upload recovered', () => invoke('task:get', { taskId: manualTask.id }),
    (task) => task.status === 'pending')
  assert.equal((await invoke('upload-queue:status')).gateOpen, false)
  await invoke('upload-queue:start', { scope: 'selected', taskIds: [manualTask.id], overrideWindow: true })
  await until('manual task completed', () => invoke('task:get', { taskId: manualTask.id }),
    (task) => task.status === 'completed')
  for (const bucket of ['primary', 'secondary']) assert.deepEqual(objects.get(`${bucket}/acceptance/manual.txt`), Buffer.from('manual folder sample'))
  pass('abrupt exit during upload restores persistent tasks and successfully uploads after restart')
  const history = await invoke('history:list', { page: 1, pageSize: 50 })
  assert.equal(history.items.filter((item) => item.id === manualTask.id && item.status === 'completed').length, 2)
  assert.ok(existsSync(rootA) && existsSync(rootB), 'Source roots must remain present')
  pass('manual folder add/pause/resume, group seal, completed history and source preservation with cleanup disabled')
  await page.getByRole('link', { name: '历史记录', exact: true }).click()
  await page.getByRole('heading', { name: '历史记录', exact: true }).waitFor()
  await page.getByText('中文目录 空格', { exact: true }).first().waitFor()
  await page.screenshot({ path: join(runDirectory, 'history.png') })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith('file:')).close())
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith('file:')).isVisible()), false)
  await new Promise((done, reject) => {
    const secondInstance = spawn(executablePath, [`--user-data-dir=${profile}`], { env, stdio: 'ignore' })
    secondInstance.once('error', reject)
    secondInstance.once('exit', (code) => code === 0 ? done() : reject(new Error(`Second instance exit: ${code}`)))
  })
  await until('second-instance window restoration',
    () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL().startsWith('file:')).map((window) => window.isVisible())),
    (visibility) => visibility.length === 1 && visibility[0])
  pass('close hides to tray and a second instance restores the existing main window')
  assert.deepEqual(rendererErrors, [])
  await application.close()
  application = null
  assert.ok(!/应用启动失败|主进程未捕获异常|主进程未处理 Promise 异常|渲染进程异常退出/.test(processOutput), 'Unexpected application error in logs')
  pass('clean renderer and graceful shutdown')
  writeFileSync(join(runDirectory, 'result.json'), JSON.stringify({ passed: true, version, executablePath, checks, rendererErrors, realCloudTested: false }, null, 2))
  console.log(`Acceptance evidence: ${runDirectory}`)
} catch (error) {
  writeFileSync(join(runDirectory, 'result.json'), JSON.stringify({ passed: false, version, executablePath, checks, error: String(error), rendererErrors }, null, 2))
  throw error
} finally {
  if (application) await application.close().catch(() => {})
  writeFileSync(join(runDirectory, 'process.log'), processOutput)
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
}
