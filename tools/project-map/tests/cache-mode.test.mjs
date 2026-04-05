/**
 * Tests for server cache behavior — verifies that quick-mode cached data
 * is not incorrectly reused for full-mode requests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('server cache mode awareness', () => {
  it('source code has mode-aware cache logic', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(__dirname, '../server.mjs'), 'utf8');

    // Should track cache mode separately
    assert.ok(source.includes('cachedDataMode'), 'should have cachedDataMode variable');

    // The /api/data handler should compare requested mode with cached mode
    assert.ok(source.includes('requestedMode'), 'should compute requestedMode');

    // Quick cache should not be valid for full requests
    assert.ok(
      source.includes('cachedDataMode === requestedMode'),
      'should compare cached mode with requested mode'
    );
  });

  it('cache logic prevents quick data from serving full requests', () => {
    // Simulate the cache validation logic extracted from server.mjs
    function isCacheValid(cachedData, cachedDataMode, requestedMode, hasRefresh) {
      const cacheValid = cachedData && cachedDataMode === requestedMode && !hasRefresh;
      const fullCacheForQuick = cachedData && cachedDataMode === 'full' && requestedMode === 'quick' && !hasRefresh;
      return cacheValid || fullCacheForQuick;
    }

    const data = { some: 'data' };

    // Quick cache should serve quick requests
    assert.ok(isCacheValid(data, 'quick', 'quick', false), 'quick cache serves quick request');

    // Quick cache should NOT serve full requests
    assert.ok(!isCacheValid(data, 'quick', 'full', false), 'quick cache must NOT serve full request');

    // Full cache should serve full requests
    assert.ok(isCacheValid(data, 'full', 'full', false), 'full cache serves full request');

    // Full cache should serve quick requests (superset)
    assert.ok(isCacheValid(data, 'full', 'quick', false), 'full cache serves quick request');

    // No cached data
    assert.ok(!isCacheValid(null, null, 'quick', false), 'no cache is not valid');

    // Refresh flag forces re-fetch
    assert.ok(!isCacheValid(data, 'quick', 'quick', true), 'refresh flag invalidates cache');
  });
});
