/**
 * Tests for backlog-parser.mjs — verifies both task syntaxes are parsed
 * and open/done counts match.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

// Direct regex test (same regex the parser uses)
const TASK_RE = /^- \[([ x])\] \*\*T-(\d+)(?::\*\*|\*\*:)\s*(.+)/;

describe('backlog parser regex', () => {
  it('matches colon-inside-bold format: **T-165:**', () => {
    const line = '- [x] **T-165:** Fix BUG-046 — wrap voice switchActiveDevice — 2026-03-28';
    const m = line.match(TASK_RE);
    assert.ok(m, 'should match');
    assert.equal(m[1], 'x');
    assert.equal(m[2], '165');
    assert.ok(m[3].startsWith('Fix BUG-046'));
  });

  it('matches colon-after-bold format: **T-033**:', () => {
    const line = '- [x] **T-033**: Fix voice state broadcast silent DB failures — 2026-03-21';
    const m = line.match(TASK_RE);
    assert.ok(m, 'should match');
    assert.equal(m[1], 'x');
    assert.equal(m[2], '033');
    assert.ok(m[3].startsWith('Fix voice state'));
  });

  it('matches open tasks (unchecked)', () => {
    const line = '- [ ] **T-195:** User profile/password/session management endpoints';
    const m = line.match(TASK_RE);
    assert.ok(m, 'should match');
    assert.equal(m[1], ' ');
    assert.equal(m[2], '195');
  });

  it('does not match non-task lines', () => {
    assert.equal('## Some Section'.match(TASK_RE), null);
    assert.equal('- Regular bullet point'.match(TASK_RE), null);
    assert.equal('- [ ] No bold task id here'.match(TASK_RE), null);
  });
});

describe('backlog parser integration', () => {
  it('parses actual Backlog.md and counts match', async () => {
    const { parseBacklog } = await import('../lib/backlog-parser.mjs');
    const result = await parseBacklog(ROOT);

    // Read the file directly and count with both regexes
    const backlogPath = resolve(ROOT, 'docs/brain/02-Tasks/Backlog.md');
    if (!existsSync(backlogPath)) {
      // Skip if file doesn't exist in CI
      return;
    }
    const content = readFileSync(backlogPath, 'utf8');
    const lines = content.split('\n');

    let expectedOpen = 0;
    let expectedDone = 0;
    for (const line of lines) {
      const m = line.match(TASK_RE);
      if (m) {
        if (m[1] === 'x') expectedDone++;
        else expectedOpen++;
      }
    }

    assert.equal(result.openCount, expectedOpen, `open count mismatch: got ${result.openCount}, expected ${expectedOpen}`);
    assert.equal(result.doneCount, expectedDone, `done count mismatch: got ${result.doneCount}, expected ${expectedDone}`);
    assert.ok(result.tasks.length > 0, 'should find tasks');
    assert.equal(result.tasks.length, expectedOpen + expectedDone, 'total tasks should match');
  });
});
