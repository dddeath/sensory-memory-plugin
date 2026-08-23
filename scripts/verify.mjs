import { spawn } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function outputPath(argv) {
  const index = argv.findIndex((value) => value === '--out' || value.startsWith('--out='))
  if (index < 0) return join(pluginRoot, '.audit', `plugin-verification-${timestamp()}.json`)
  const value = argv[index].includes('=') ? argv[index].slice(argv[index].indexOf('=') + 1) : argv[index + 1]
  if (!value) throw new Error('--out requires a path')
  return resolve(process.cwd(), value)
}

function run(command, args, cwd) {
  const startedAt = new Date()
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolveRun({ exitCode: 1, stdout, stderr: `${stderr}${error.stack ?? error.message}` }))
    child.on('close', (exitCode) => resolveRun({ exitCode: Number(exitCode ?? 1), stdout, stderr }))
  }).then((result) => ({
    ...result,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
  }))
}

function testCounts(output) {
  const number = (label) => Number(output.match(new RegExp(`(?:ℹ\\s+)?${label}\\s+(\\d+)`))?.[1] ?? 0)
  return { tests: number('tests'), passed: number('pass'), failed: number('fail'), skipped: number('skipped') }
}

async function syntaxStep() {
  const files = []
  for (const folder of ['lib', 'scripts']) {
    for (const entry of await readdir(join(pluginRoot, folder), { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
        files.push(join(pluginRoot, folder, entry.name))
      }
    }
  }
  files.sort()
  const startedAt = new Date()
  const failures = []
  for (const file of files) {
    const result = await run(process.execPath, ['--check', file], pluginRoot)
    if (result.exitCode !== 0) failures.push({ file: relative(pluginRoot, file).replace(/\\/g, '/'), ...result })
  }
  return {
    name: 'syntax',
    command: 'node --check lib/* scripts/* (one file at a time)',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    exitCode: failures.length === 0 ? 0 : 1,
    checkedFiles: files.map((file) => relative(pluginRoot, file).replace(/\\/g, '/')),
    failures,
  }
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: npm run verify -- [--out PATH]')
    console.log('Runs syntax checks and the complete plugin test suite, then writes one readable JSON audit record.')
    return
  }
  const startedAt = new Date()
  const destination = outputPath(argv)
  const syntax = await syntaxStep()
  const tests = await run(process.execPath, ['--test', 'test/*.test.mjs'], pluginRoot)
  const steps = [
    syntax,
    {
      name: 'tests',
      command: 'node --test "test/*.test.mjs"',
      ...tests,
      counts: testCounts(`${tests.stdout}\n${tests.stderr}`),
    },
  ]
  const passed = steps.every((step) => step.exitCode === 0)
  const record = {
    schemaVersion: 1,
    kind: 'sensory-memory-plugin-verification',
    passed,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    cwd: pluginRoot.replace(/\\/g, '/'),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    steps,
  }
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  console.log(`Plugin verification: ${passed ? 'PASSED' : 'FAILED'}`)
  console.log(`Syntax: ${syntax.checkedFiles.length} files, exit ${syntax.exitCode}`)
  console.log(`Tests: ${steps[1].counts.passed}/${steps[1].counts.tests}, exit ${tests.exitCode}`)
  console.log(`Audit record: ${destination}`)
  if (!passed) process.exitCode = 1
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.stack ?? error.message)
  process.exitCode = 1
})
