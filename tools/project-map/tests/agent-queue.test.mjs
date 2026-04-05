/**
 * Tests for agent-manager.mjs — verifies that a spawn failure
 * does not wedge the queue (lock must be released).
 *
 * Uses setSpawnCommand() to inject a guaranteed-nonexistent binary,
 * making the test deterministic regardless of whether Claude CLI is installed.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createJob,
  processQueue,
  getJobs,
  isQueueLocked,
  resetQueueLock,
  setSpawnCommand,
} from '../lib/agent-manager.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_CACHE = resolve(__dirname, '.test-cache-agent');
const FAKE_ROOT = resolve(__dirname, '.test-root-agent');

// A binary name that will never exist on any platform
const NONEXISTENT_CMD = '__owncord_test_no_such_binary_12345__';

describe('agent queue lock recovery', () => {
  beforeEach(() => {
    mkdirSync(TEST_CACHE, { recursive: true });
    mkdirSync(FAKE_ROOT, { recursive: true });
    resetQueueLock();
    setSpawnCommand(NONEXISTENT_CMD);
  });

  afterEach(() => {
    resetQueueLock();
    setSpawnCommand('claude');
    rmSync(TEST_CACHE, { recursive: true, force: true });
    rmSync(FAKE_ROOT, { recursive: true, force: true });
  });

  it('releases lock after spawn error (command not found)', async () => {
    createJob(TEST_CACHE, {
      type: 'research',
      target: 'api',
      priority: 1,
    });

    assert.equal(isQueueLocked(), false, 'lock should be free before processing');

    // processQueue spawns the nonexistent command which will ENOENT
    const result = await processQueue(FAKE_ROOT, TEST_CACHE);

    assert.equal(result.processed, true, 'should have attempted processing');
    assert.equal(isQueueLocked(), false, 'lock MUST be released after spawn failure');
  });

  it('allows subsequent jobs after a failed spawn', async () => {
    createJob(TEST_CACHE, { type: 'research', target: 'ws', priority: 1 });

    // First job will fail due to nonexistent command
    await processQueue(FAKE_ROOT, TEST_CACHE);
    assert.equal(isQueueLocked(), false, 'lock should be free after first failure');

    // Create and process another job — should not be blocked
    createJob(TEST_CACHE, { type: 'code-review', target: 'auth', priority: 1 });
    const result2 = await processQueue(FAKE_ROOT, TEST_CACHE);

    // It should attempt processing (not be stuck on 'locked')
    assert.notEqual(result2.reason, 'locked', 'queue should not be wedged');
  });

  it('marks job as dead after max retries', async () => {
    createJob(TEST_CACHE, { type: 'research', target: 'db', priority: 1 });

    // Exhaust retries (maxRetries defaults to 2)
    await processQueue(FAKE_ROOT, TEST_CACHE);
    await processQueue(FAKE_ROOT, TEST_CACHE);

    const { jobs } = getJobs(TEST_CACHE);
    const job = jobs.find(j => j.target === 'db');
    assert.ok(job, 'job should still exist in queue');
    assert.equal(job.status, 'dead', 'job should be dead after max retries');
    assert.ok(job.error, 'job should have an error message');
  });
});
