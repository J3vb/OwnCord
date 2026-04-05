import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { parseActivityHints, getJobDiff } from '../lib/agent-manager.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GIT_TEST_DIR = resolve(__dirname, '.test-git-diff');

describe('parseActivityHints', () => {
  it('extracts Go file paths', () => {
    const chunk = 'Reading Server/ws/handler.go for analysis';
    const hints = parseActivityHints(chunk);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].file, 'Server/ws/handler.go');
  });

  it('extracts TypeScript file paths', () => {
    const chunk = 'Checking Client/tauri-client/src/stores/voice.ts';
    const hints = parseActivityHints(chunk);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].file, 'Client/tauri-client/src/stores/voice.ts');
  });

  it('extracts Rust file paths', () => {
    const chunk = 'Found issue in src-tauri/src/commands.rs';
    const hints = parseActivityHints(chunk);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].file, 'src-tauri/src/commands.rs');
  });

  it('extracts multiple paths from one chunk', () => {
    const chunk = 'Comparing Server/ws/handler.go with Server/ws/conn.go';
    const hints = parseActivityHints(chunk);
    assert.equal(hints.length, 2);
  });

  it('returns empty array when no paths found', () => {
    const hints = parseActivityHints('Just some regular text here');
    assert.deepEqual(hints, []);
  });

  it('handles null/undefined input', () => {
    assert.deepEqual(parseActivityHints(null), []);
    assert.deepEqual(parseActivityHints(undefined), []);
    assert.deepEqual(parseActivityHints(''), []);
  });
});

describe('getJobDiff', () => {
  beforeEach(() => {
    rmSync(GIT_TEST_DIR, { recursive: true, force: true });
    mkdirSync(GIT_TEST_DIR, { recursive: true });
    execSync('git init', { cwd: GIT_TEST_DIR, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: GIT_TEST_DIR, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: GIT_TEST_DIR, stdio: 'pipe' });
    writeFileSync(resolve(GIT_TEST_DIR, 'file.txt'), 'original\n');
    execSync('git add . && git commit -m "init"', { cwd: GIT_TEST_DIR, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(GIT_TEST_DIR, { recursive: true, force: true });
  });

  it('returns empty files when nothing changed', () => {
    const headSha = execSync('git rev-parse HEAD', { cwd: GIT_TEST_DIR, encoding: 'utf8' }).trim();
    const result = getJobDiff(GIT_TEST_DIR, headSha, []);
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.diffs, {});
  });

  it('detects modified files with +/- counts', () => {
    const headSha = execSync('git rev-parse HEAD', { cwd: GIT_TEST_DIR, encoding: 'utf8' }).trim();
    writeFileSync(resolve(GIT_TEST_DIR, 'file.txt'), 'modified\nline2\n');
    const result = getJobDiff(GIT_TEST_DIR, headSha, []);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, 'file.txt');
    assert.equal(result.files[0].status, 'M');
    assert.ok(result.files[0].additions >= 1);
    assert.ok(typeof result.diffs['file.txt'] === 'string');
    assert.ok(result.diffs['file.txt'].includes('modified'));
  });

  it('detects new files', () => {
    const headSha = execSync('git rev-parse HEAD', { cwd: GIT_TEST_DIR, encoding: 'utf8' }).trim();
    writeFileSync(resolve(GIT_TEST_DIR, 'newfile.txt'), 'brand new\n');
    const result = getJobDiff(GIT_TEST_DIR, headSha, []);
    const newFile = result.files.find(f => f.path === 'newfile.txt');
    assert.ok(newFile);
    assert.equal(newFile.status, 'A');
  });

  it('excludes pre-existing dirty files', () => {
    const headSha = execSync('git rev-parse HEAD', { cwd: GIT_TEST_DIR, encoding: 'utf8' }).trim();
    writeFileSync(resolve(GIT_TEST_DIR, 'file.txt'), 'modified\n');
    writeFileSync(resolve(GIT_TEST_DIR, 'newfile.txt'), 'new\n');
    const result = getJobDiff(GIT_TEST_DIR, headSha, ['file.txt']);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, 'newfile.txt');
    assert.ok(!result.diffs['file.txt']);
  });
});
