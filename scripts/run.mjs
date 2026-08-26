#!/usr/bin/env node
// Root command facade (RL-04 / L-04).
//
// One entry point for the checks CI runs, so a contributor does not have to
// know which directory each stack lives in. `node scripts/run.mjs --list`
// prints every task and the exact commands it runs.
//
// Two rules this file exists to keep:
//
//   1. Cross-platform. No `make`, no shell syntax, no `cd &&`. Every step is
//      spawned directly with an explicit `cwd`, so there is no shell to quote
//      for and nothing that behaves differently on Windows.
//   2. The facade orchestrates, it never becomes the only path. Each step
//      prints the command it runs, in the directory it runs it in, so a
//      Go-only contributor can read the output and type those commands
//      instead — and never needs Node to work on the server.
//
// Dependency-free by design: Node's standard library only, like
// .superpowers/render-ledger.mjs. Adding a dependency here would mean
// `npm run check` could not run until `npm install` had.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WIN = process.platform === 'win32'

// npm and npx are batch shims on Windows; everything else is a real binary.
const bin = (c) => (WIN && (c === 'npm' || c === 'npx') ? `${c}.cmd` : c)

/** A step that always runs. */
const step = (cmd, args, cwd = '.') => ({ cmd, args, cwd })

/**
 * A step that is skipped, with a printed reason, when `probe` is not on PATH.
 * Used for tools CI installs but a contributor may not have: golangci-lint has
 * no wrapper in this repo at all, and sqlc is pinned by Server/sqlc.version.
 */
const optional = (probe, cmd, args, cwd, why) => ({ cmd, args, cwd, probe, why })

// `git diff --exit-code` after regenerating is what `make protocol-verify` and
// `make sqlc-verify` reduce to. Inlined so neither needs make.
const PROTOCOL_VERIFY = [
  step('go', ['run', './scripts/genprotocol'], 'Server'),
  step('git', ['diff', '--exit-code', 'ws/message_types.go', '../Client/src/lib/protocolTypes.ts'], 'Server'),
]
const SQLC_VERIFY = [
  optional('sqlc', 'sqlc', ['generate'], 'Server', 'sqlc not on PATH — install the version in Server/sqlc.version'),
  optional('sqlc', 'git', ['diff', '--exit-code', 'db/dbgen'], 'Server', 'sqlc not on PATH'),
]

const CHECK_SERVER = [
  step('go', ['build', './...'], 'Server'),
  step('go', ['build', '-tags', 'otel', './...'], 'Server'),
  step('go', ['build', '-tags', 'wazero', './...'], 'Server'),
  step('go', ['build', '-tags', 'otel,wazero', './...'], 'Server'),
  step('go', ['vet', './...'], 'Server'),
  step('go', ['test', '-race', './...'], 'Server'),
  step('go', ['test', '-tags', 'deadlock', '-count=1', './ws/'], 'Server'),
  optional('golangci-lint', 'golangci-lint', ['run', './...'], 'Server', 'golangci-lint not on PATH — CI pins v2.11.3'),
  ...PROTOCOL_VERIFY,
  ...SQLC_VERIFY,
]

const CHECK_CLIENT = [
  step('npm', ['run', 'typecheck'], 'Client'),
  step('npm', ['run', 'lint'], 'Client'),
  step('npm', ['run', 'format:check'], 'Client'),
  step('npm', ['test'], 'Client'),
]

// Matches ci.yml's Rust Unit Tests job exactly: --lib for tests, --all-targets
// for clippy. They differ deliberately; do not "align" them.
const CHECK_RUST = [
  step('cargo', ['test', '--lib'], 'Client/src-tauri'),
  step('cargo', ['clippy', '--all-targets', '--', '-D', 'warnings'], 'Client/src-tauri'),
]

const TASKS = {
  bootstrap: [
    step('npm', ['ci'], '.'),
    step('npm', ['ci'], 'Client'),
    step('npm', ['ci'], 'tools/mcp-introspect'),
  ],
  'check:server': CHECK_SERVER,
  'check:client': CHECK_CLIENT,
  'check:rust': CHECK_RUST,
  check: [...CHECK_SERVER, ...CHECK_CLIENT, ...CHECK_RUST],
  generate: [
    step('go', ['run', './scripts/genprotocol'], 'Server'),
    optional('sqlc', 'sqlc', ['generate'], 'Server', 'sqlc not on PATH — install the version in Server/sqlc.version'),
  ],
  format: [
    step('npm', ['run', 'format'], 'Client'),
    optional('gofmt', 'gofmt', ['-w', '.'], 'Server', 'gofmt not on PATH'),
  ],
  'release:preflight': [
    ...CHECK_SERVER,
    ...CHECK_CLIENT,
    ...CHECK_RUST,
    step('npm', ['run', 'build'], 'Client'),
  ],
}

function onPath(cmd) {
  const probe = spawnSync(WIN ? 'where' : 'command', WIN ? [cmd] : ['-v', cmd], {
    stdio: 'ignore',
    shell: !WIN, // `command` is a shell builtin; `where` is a real binary
  })
  return probe.status === 0
}

function runTask(name) {
  const steps = TASKS[name]
  if (!steps) {
    console.error(`unknown task: ${name}\nknown: ${Object.keys(TASKS).join(', ')}`)
    process.exit(2)
  }
  const skipped = []
  for (const s of steps) {
    if (s.probe && !onPath(s.probe)) {
      console.log(`\n--- SKIP  ${s.cmd} ${s.args.join(' ')}  (${s.why})`)
      skipped.push(s.probe)
      continue
    }
    const where = s.cwd === '.' ? '' : `  [in ${s.cwd}]`
    console.log(`\n--- ${s.cmd} ${s.args.join(' ')}${where}`)
    const r = spawnSync(bin(s.cmd), s.args, {
      cwd: join(ROOT, s.cwd),
      stdio: 'inherit',
      shell: false,
    })
    if (r.error && r.error.code === 'ENOENT') {
      console.error(`\nFAILED: ${s.cmd} is not installed or not on PATH.`)
      process.exit(1)
    }
    if (r.status !== 0) {
      console.error(`\nFAILED: ${s.cmd} ${s.args.join(' ')}${where} exited ${r.status}`)
      process.exit(r.status ?? 1)
    }
  }
  if (skipped.length) {
    console.log(`\n${name}: passed, with ${[...new Set(skipped)].join(', ')} skipped (not installed). CI runs them.`)
  } else {
    console.log(`\n${name}: passed`)
  }
}

const arg = process.argv[2]
if (!arg || arg === '--list') {
  for (const [name, steps] of Object.entries(TASKS)) {
    console.log(`\n${name}`)
    for (const s of steps) {
      const where = s.cwd === '.' ? '' : `   (in ${s.cwd})`
      console.log(`  ${s.probe ? '[optional] ' : ''}${s.cmd} ${s.args.join(' ')}${where}`)
    }
  }
  console.log('')
  process.exit(0)
}
if (!existsSync(join(ROOT, 'Server')) || !existsSync(join(ROOT, 'Client'))) {
  console.error('run this from the repository root')
  process.exit(2)
}
runTask(arg)
