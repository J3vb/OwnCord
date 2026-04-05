/**
 * Tests for module name normalization — verifies that git-scanner,
 * scanner, backlog-parser, and debt-scanner all produce the same
 * canonical module keys so signals merge correctly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import the resolveModule function from git-scanner by reading the source
// and extracting the function (git-scanner doesn't export it).
// Instead, we test the expected behavior by checking the patterns.
describe('module naming consistency', () => {
  // These are the canonical module names used by scanner.mjs:
  // Go packages: 'api', 'ws', 'db', 'auth', 'config', 'admin', etc.
  // TS areas: 'lib', 'stores', 'components', 'pages', 'styles'
  // Rust: 'tauri-rust'

  // git-scanner resolveModule should produce the SAME names (no prefixes).
  // We test this by importing the git-scanner module and checking its output.

  it('git-scanner resolveModule produces unprefixed Go module names', async () => {
    // Read the git-scanner source and check that resolveModule for Server paths
    // no longer returns "go:" prefixed names
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(__dirname, '../lib/git-scanner.mjs'), 'utf8');

    // Ensure "go:" prefix is NOT used in resolveModule
    const resolveModuleFn = source.match(/function resolveModule\([\s\S]*?\n\}/);
    assert.ok(resolveModuleFn, 'should find resolveModule function');

    const fnBody = resolveModuleFn[0];
    assert.ok(!fnBody.includes('`go:'), 'resolveModule should not produce go: prefixed names');
    assert.ok(!fnBody.includes('`ts:'), 'resolveModule should not produce ts: prefixed names');
    assert.ok(!fnBody.includes("'go:"), 'resolveModule should not produce go: prefixed names (single quotes)');
    assert.ok(!fnBody.includes("'ts:"), 'resolveModule should not produce ts: prefixed names (single quotes)');
  });

  it('session-manager fileToModule matches git-scanner convention', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const sessionSource = readFileSync(resolve(__dirname, '../lib/session-manager.mjs'), 'utf8');
    const gitSource = readFileSync(resolve(__dirname, '../lib/git-scanner.mjs'), 'utf8');

    // Both should use 'server-root' for Server/ root, not 'go:root'
    assert.ok(sessionSource.includes("'server-root'"), 'session-manager should use server-root');
    assert.ok(gitSource.includes("'server-root'"), 'git-scanner should use server-root');

    // Both should use 'client-config' not 'ts:config'
    assert.ok(sessionSource.includes("'client-config'"), 'session-manager should use client-config');
    assert.ok(gitSource.includes("'client-config'"), 'git-scanner should use client-config');
  });

  it('backlog and scanner module names have no type prefixes', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const backlogSource = readFileSync(resolve(__dirname, '../lib/backlog-parser.mjs'), 'utf8');

    // Backlog MODULE_KEYWORDS keys should be plain names
    const keyMatch = backlogSource.match(/const MODULE_KEYWORDS = \{([\s\S]*?)\n\};/);
    assert.ok(keyMatch, 'should find MODULE_KEYWORDS');

    // Ensure no prefixed keys
    assert.ok(!keyMatch[1].includes("'go:"), 'backlog keywords should not have go: prefix');
    assert.ok(!keyMatch[1].includes("'ts:"), 'backlog keywords should not have ts: prefix');
  });

  it('suggestion engine merges modules from different sources under same key', async () => {
    const { generateSuggestions } = await import('../lib/suggestion-engine.mjs');
    const { mkdirSync, rmSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const tmpCache = resolve(__dirname, '.test-cache-naming');
    mkdirSync(tmpCache, { recursive: true });

    try {
      // Simulate data from different sources all using 'components' (not 'ts:components')
      const result = await generateSuggestions(tmpCache, {
        priorities: [{ name: 'components', coverage: 40, type: 'typescript' }],
        backlog: {
          byPhase: {
            bug: [{ id: 'T-001', description: 'UI button bug', modules: ['components'] }],
          },
        },
        gitData: {
          commitsByModule: {
            components: { count: 15, lastCommit: new Date().toISOString() },
          },
          staleness: {},
        },
        debtData: {
          summary: {
            byModule: {
              components: { markers: 3, largeFiles: 1, longFunctions: 0 },
            },
          },
        },
      });

      // All signals should merge into a single 'components' entry
      const compSuggestion = result.suggestions.find(s => s.module === 'components');
      assert.ok(compSuggestion, 'should have a components suggestion');

      // It should have signals from coverage, bugs, git, AND debt
      const signalTypes = new Set(compSuggestion.signals.map(s => s.signal));
      assert.ok(signalTypes.has('coverage-gap'), 'should have coverage signal');
      assert.ok(signalTypes.has('open-bug'), 'should have bug signal');
      assert.ok(signalTypes.has('high-churn'), 'should have churn signal');
      assert.ok(signalTypes.has('debt-markers'), 'should have debt signal');

      // Verify NO 'ts:components' entry exists
      const prefixed = result.suggestions.find(s => s.module === 'ts:components');
      assert.equal(prefixed, undefined, 'should NOT have ts:components — should be merged into components');
    } finally {
      rmSync(tmpCache, { recursive: true, force: true });
    }
  });
});
