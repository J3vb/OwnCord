/**
 * Fleet Agent Manager — concurrent job queue with worktree isolation.
 *
 * Reworked from single-job queue to support parallel agent execution.
 * Each agent runs in its own git worktree via worktree-manager.
 *
 * Key changes from v1:
 * - activeAgents Map replaces queueLocked boolean
 * - QueueStore provides atomic read-modify-write for queue file
 * - Ring buffer caps live output at 500KB per agent
 * - Provisioning state for worktree creation phase
 * - MAX_CONCURRENT configurable parallel limit
 * - Timeout escalation: 80% warning → SIGTERM → 5s → SIGKILL
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { resolve, join } from 'node:path';

import {
  createWorktree,
  destroyWorktree,
  cleanupStaleWorktrees,
} from './worktree-manager.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUEUE_FILE = 'agent-queue.json';
const RESULTS_DIR = 'agent-results';
const PROMPTS_DIR = 'agent-prompts';

const ALLOWED_TYPES = new Set([
  'research',
  'write-tests',
  'code-review',
  'security-audit',
  'fix-debt',
  'custom',
]);

const TIMEOUTS = {
  research: 600_000,
  'write-tests': 1_200_000,
  'code-review': 900_000,
  'security-audit': 1_200_000,
  'fix-debt': 900_000,
  custom: 1_800_000,
};

/** Default max concurrent agents */
let MAX_CONCURRENT = 4;

/** Ring buffer cap per agent (bytes) */
const RING_BUFFER_MAX = 512_000; // 500KB

// ---------------------------------------------------------------------------
// QueueStore — centralized queue I/O with atomic updates
// ---------------------------------------------------------------------------

class QueueStore {
  #cacheDir;
  #updateLock = false;

  constructor(cacheDir) {
    this.#cacheDir = cacheDir;
  }

  /** Read current queue state */
  get() {
    const file = resolve(this.#cacheDir, QUEUE_FILE);
    if (!existsSync(file)) return [];
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** Get a single job by ID */
  getJob(jobId) {
    return this.get().find(j => j.id === jobId) ?? null;
  }

  /**
   * Atomic read-modify-write. The updater function receives the current
   * jobs array and must return the new jobs array.
   * Prevents concurrent reads from overwriting each other's changes.
   */
  update(updaterFn) {
    if (this.#updateLock) {
      throw new Error('QueueStore: concurrent update detected');
    }
    this.#updateLock = true;
    try {
      const jobs = this.get();
      const updated = updaterFn(jobs);
      writeFileSync(
        resolve(this.#cacheDir, QUEUE_FILE),
        JSON.stringify(updated, null, 2),
      );
      return updated;
    } finally {
      this.#updateLock = false;
    }
  }
}

/** Module-level store instance — set via init() or createJob() */
let store = null;

function ensureStore(cacheDir) {
  if (!store || store._dir !== cacheDir) {
    store = new QueueStore(cacheDir);
    store._dir = cacheDir;
  }
  return store;
}

// ---------------------------------------------------------------------------
// Helpers — directory setup
// ---------------------------------------------------------------------------

function ensureDirs(cacheDir) {
  mkdirSync(resolve(cacheDir, RESULTS_DIR), { recursive: true });
  mkdirSync(resolve(cacheDir, PROMPTS_DIR), { recursive: true });
}

// ---------------------------------------------------------------------------
// Helpers — scope path resolution
// ---------------------------------------------------------------------------

const GO_PACKAGES = new Set([
  'api', 'ws', 'db', 'auth', 'config', 'admin', 'migrations', 'scripts',
]);

const TS_AREAS = new Set([
  'lib', 'stores', 'components', 'pages',
]);

function resolveScopePath(target) {
  if (GO_PACKAGES.has(target)) return `Server/${target}/`;
  if (TS_AREAS.has(target)) return `Client/tauri-client/src/${target}/`;
  if (target === 'tauri-rust') return 'Client/tauri-client/src-tauri/src/';
  return target;
}

// ---------------------------------------------------------------------------
// Helpers — process checking
// ---------------------------------------------------------------------------

function isProcessAlive(pid) {
  const safePid = parseInt(pid, 10);
  if (!Number.isInteger(safePid) || safePid <= 0) return false;
  try {
    process.kill(safePid, 0);
    return true;
  } catch {
    return false;
  }
}

function isClaudeProcess(pid) {
  const safePid = parseInt(pid, 10);
  if (!Number.isInteger(safePid) || safePid <= 0) return false;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'tasklist',
        ['/FI', `PID eq ${safePid}`, '/FO', 'CSV', '/NH'],
        { stdio: 'pipe', timeout: 5_000 },
      ).toString();
      const lower = out.toLowerCase();
      return lower.includes('claude') || lower.includes('node');
    }
    const out = execFileSync('ps', ['-p', String(safePid), '-o', 'comm='], {
      stdio: 'pipe',
      timeout: 5_000,
    }).toString().trim().toLowerCase();
    return out.includes('claude') || out.includes('node');
  } catch {
    return false;
  }
}

function killProcess(pid) {
  const safePid = parseInt(pid, 10);
  if (!Number.isInteger(safePid) || safePid <= 0) return;
  try {
    process.kill(safePid, 'SIGTERM');
    setTimeout(() => {
      try {
        process.kill(safePid, 0);
        process.kill(safePid, 'SIGKILL');
      } catch { /* already dead */ }
    }, 5_000);
  } catch { /* already dead */ }
}

// ---------------------------------------------------------------------------
// Active agents — tracks running processes
// ---------------------------------------------------------------------------

/** Map<jobId, { pid, worktreePath, branchName, child, timer, warningTimer }> */
const activeAgents = new Map();

/** Processing flag — guards the auto-process interval from double-spawn */
let isProcessing = false;

// ---------------------------------------------------------------------------
// Ring buffer for live output
// ---------------------------------------------------------------------------

const liveOutputBuffers = new Map();

function appendToRingBuffer(jobId, text) {
  const current = liveOutputBuffers.get(jobId) || '';
  let updated = current + text;

  if (updated.length > RING_BUFFER_MAX) {
    const truncateMarker = '\n[... output truncated — showing last 500KB ...]\n';
    updated = truncateMarker + updated.slice(updated.length - RING_BUFFER_MAX + truncateMarker.length);
  }

  liveOutputBuffers.set(jobId, updated);
}

export function getLiveOutput(jobId) {
  return liveOutputBuffers.get(jobId) || '';
}

export function clearLiveOutput(jobId) {
  liveOutputBuffers.delete(jobId);
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

function buildPrompt(job, _root) {
  const { type, target, customPrompt } = job;
  const scopePath = resolveScopePath(target);

  switch (type) {
    case 'research':
      return [
        `You are a research agent for OwnCord. Investigate the ${target} module.`,
        'Focus on: coverage gaps, potential bugs, edge cases, security concerns, missing functionality.',
        `Scope: ${scopePath}`,
        'Read relevant source and test files. Prioritize findings as CRITICAL/HIGH/MEDIUM/LOW.',
        'Output a structured markdown report.',
      ].join('\n');

    case 'write-tests':
      return [
        'You are a test-writing agent for OwnCord.',
        `Module: ${target}`,
        `Read the source files in ${scopePath}.`,
        'Read docs/brain/06-Specs/TESTING-STRATEGY.md for test patterns.',
        'Write tests targeting untested functions and branches. Aim for 80%+ coverage.',
        'Save tests to the appropriate test directory.',
      ].join('\n');

    case 'code-review':
      return [
        'You are a code review agent for OwnCord.',
        `Review recent changes in the ${target} module for bugs, security issues, code quality.`,
        `Scope: ${scopePath}`,
        'Output findings with file:line references and severity ratings.',
      ].join('\n');

    case 'security-audit':
      return [
        'You are a security audit agent for OwnCord.',
        `Perform an OWASP Top 10 review of the ${target} module.`,
        `Scope: ${scopePath}`,
        'Check for: injection, auth bypass, XSS, CSRF, path traversal, hardcoded secrets.',
        'Output findings with severity, file:line, and remediation steps.',
      ].join('\n');

    case 'fix-debt':
      return [
        'You are a technical debt agent for OwnCord.',
        `Address TODO/FIXME/HACK items in the ${target} module.`,
        `Scope: ${scopePath}`,
        'For each debt marker, either fix it or explain why it should remain.',
      ].join('\n');

    case 'custom':
      return customPrompt;

    default:
      return `Investigate ${target} in OwnCord.`;
  }
}

// ---------------------------------------------------------------------------
// Activity hint parsing — extract file paths from agent stdout
// ---------------------------------------------------------------------------

const FILE_PATH_PATTERNS = [
  /Server\/[\w/.-]+\.go/g,
  /Client\/[\w/.-]+\.tsx?/g,
  /(?<!\/)src\/[\w/.-]+\.tsx?/g,
  /src-tauri\/[\w/.-]+\.rs/g,
  /docs\/[\w/.-]+\.md/g,
];

export function parseActivityHints(chunk) {
  if (!chunk || typeof chunk !== 'string') return [];

  const seen = new Set();
  const results = [];

  for (const pattern of FILE_PATH_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(chunk)) !== null) {
      const file = match[0];
      if (!seen.has(file)) {
        seen.add(file);
        results.push({ hint: `Accessing ${file}`, file });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Git diff for running jobs
// ---------------------------------------------------------------------------

function gitArgs(args, root) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Get the current git diff for a job.
 * For fleet jobs, reads diff from the worktree directory.
 */
export function getJobDiff(root, baselineSha, preExistingDirtyFiles, worktreePath) {
  const diffRoot = worktreePath || root;
  const excludeSet = new Set(preExistingDirtyFiles || []);
  const freshness = new Date().toISOString();

  let numstatRaw = '';
  try {
    const args = baselineSha
      ? ['diff', baselineSha, '--numstat']
      : ['diff', '--numstat'];
    numstatRaw = gitArgs(args, diffRoot);
  } catch { /* empty diff */ }

  let untrackedRaw = '';
  try {
    untrackedRaw = gitArgs(['ls-files', '--others', '--exclude-standard'], diffRoot);
  } catch { /* ignore */ }

  const files = [];
  const trackedPaths = new Set();

  for (const line of numstatRaw.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const additions = parseInt(parts[0], 10) || 0;
    const deletions = parseInt(parts[1], 10) || 0;
    const path = parts[2];
    if (excludeSet.has(path)) continue;
    trackedPaths.add(path);
    files.push({ path, status: 'M', additions, deletions });
  }

  for (const path of untrackedRaw.split('\n').filter(Boolean)) {
    if (excludeSet.has(path)) continue;
    if (trackedPaths.has(path)) continue;
    files.push({ path, status: 'A', additions: 0, deletions: 0 });
  }

  const diffs = {};
  for (const f of files) {
    try {
      if (f.status === 'A') {
        const fullPath = resolve(diffRoot, f.path);
        const content = readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');
        f.additions = lines.length;
        diffs[f.path] = lines.map(l => '+' + l).join('\n');
      } else {
        const args = baselineSha
          ? ['diff', baselineSha, '--', f.path]
          : ['diff', '--', f.path];
        const content = gitArgs(args, diffRoot);
        diffs[f.path] = content;
      }
    } catch {
      diffs[f.path] = '';
    }
  }

  return { files, diffs, freshness };
}

// ---------------------------------------------------------------------------
// Public API — configuration
// ---------------------------------------------------------------------------

export function setMaxConcurrent(n) {
  const val = parseInt(n, 10);
  if (Number.isInteger(val) && val >= 1 && val <= 8) {
    MAX_CONCURRENT = val;
  }
}

export function getMaxConcurrent() {
  return MAX_CONCURRENT;
}

export function getActiveCount() {
  return activeAgents.size;
}

export function getActiveAgentIds() {
  return [...activeAgents.keys()];
}

// ---------------------------------------------------------------------------
// Public API — health check
// ---------------------------------------------------------------------------

export function healthCheck() {
  try {
    const version = execFileSync('claude', ['--version'], { stdio: 'pipe' })
      .toString()
      .trim();
    return { available: true, version };
  } catch (err) {
    return { available: false, error: err.message || 'Claude CLI not found' };
  }
}

// ---------------------------------------------------------------------------
// Public API — job CRUD
// ---------------------------------------------------------------------------

export function getJobs(cacheDir) {
  const s = ensureStore(cacheDir);
  const jobs = s.get();
  const sorted = [...jobs].sort((a, b) => {
    const priDiff = (b.priority ?? 1) - (a.priority ?? 1);
    if (priDiff !== 0) return priDiff;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
  return { jobs: sorted };
}

export function createJob(cacheDir, { type, target, priority, customPrompt }) {
  if (!ALLOWED_TYPES.has(type)) {
    throw new Error(`Invalid job type "${type}". Allowed: ${[...ALLOWED_TYPES].join(', ')}`);
  }
  if (!target || typeof target !== 'string' || target.trim().length === 0) {
    throw new Error('Job target must be a non-empty string');
  }
  if (type === 'custom' && (!customPrompt || typeof customPrompt !== 'string' || customPrompt.trim().length === 0)) {
    throw new Error('Custom jobs require a non-empty customPrompt');
  }

  ensureDirs(cacheDir);
  const s = ensureStore(cacheDir);

  const job = {
    id: `job-${Date.now()}-${randomBytes(4).toString('hex')}`,
    type,
    target: target.trim(),
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    resultPath: null,
    error: null,
    priority: typeof priority === 'number' ? priority : 1,
    retryCount: 0,
    maxRetries: 2,
    pid: null,
    customPrompt: customPrompt ?? null,
    // Fleet fields
    worktreePath: null,
    branchName: null,
    configMethod: null,
  };

  s.update(jobs => [...jobs, job]);
  return job;
}

export function cancelJob(cacheDir, jobId) {
  const s = ensureStore(cacheDir);
  const job = s.getJob(jobId);
  if (!job) throw new Error(`Job "${jobId}" not found`);

  if (job.status === 'queued') {
    s.update(jobs => jobs.filter(j => j.id !== jobId));
    return { ok: true };
  }

  if (job.status === 'provisioning' || job.status === 'running') {
    // Kill process if running
    const agent = activeAgents.get(jobId);
    if (agent?.pid) killProcess(agent.pid);
    if (agent?.timer) clearTimeout(agent.timer);
    if (agent?.warningTimer) clearTimeout(agent.warningTimer);
    activeAgents.delete(jobId);

    // Destroy worktree
    if (job.worktreePath) {
      try {
        const root = resolve(job.worktreePath, '..', '..');
        destroyWorktree(root, jobId);
      } catch (err) {
        console.error(`  [Agent] Worktree cleanup failed for ${jobId}: ${err.message}`);
      }
    }

    s.update(jobs => jobs.map(j =>
      j.id === jobId
        ? { ...j, status: 'cancelled', completedAt: new Date().toISOString(), pid: null }
        : j,
    ));
    setTimeout(() => clearLiveOutput(jobId), 5000);
    return { ok: true };
  }

  // Terminal statuses (review, done, failed, cancelled) — just remove from list
  if (['review', 'dead', 'cancelled'].includes(job.status)) {
    if (job.worktreePath) {
      try {
        const root = resolve(job.worktreePath, '..', '..');
        destroyWorktree(root, jobId);
      } catch (err) {
        console.error(`  [Agent] Worktree cleanup failed for ${jobId}: ${err.message}`);
      }
    }
    s.update(jobs => jobs.filter(j => j.id !== jobId));
    return { ok: true };
  }

  throw new Error(`Cannot cancel job "${jobId}" with status "${job.status}"`);
}

export function getJobResult(cacheDir, jobId) {
  const resultFile = resolve(cacheDir, RESULTS_DIR, `${jobId}.md`);
  if (!existsSync(resultFile)) return { content: null };
  return { content: readFileSync(resultFile, 'utf8') };
}

// ---------------------------------------------------------------------------
// Public API — fleet queue processing
// ---------------------------------------------------------------------------

/** Override CLI command for testing */
let _spawnCommand = 'claude';
export function setSpawnCommand(cmd) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setSpawnCommand is only available in test environments');
  }
  if (typeof cmd !== 'string' || cmd.length === 0 || cmd.includes('/') || cmd.includes('\\')) {
    throw new Error('setSpawnCommand: cmd must be a simple command name');
  }
  _spawnCommand = cmd;
}

/** Check processing state (for diagnostics) */
export function getIsProcessing() { return isProcessing; }

/**
 * Process the queue — spawn agents up to MAX_CONCURRENT.
 * Returns after spawning; agents run asynchronously.
 *
 * @param {string} root — project root
 * @param {string} cacheDir — cache directory
 * @param {function} [onOutput] — callback (jobId, chunk) for streaming
 * @param {function} [onWarning] — callback (jobId, message) for timeout warnings
 * @returns {Promise<{ launched: number, skipped: string[] }>}
 */
export async function processQueue(root, cacheDir, onOutput, onWarning) {
  if (isProcessing) return { launched: 0, skipped: ['locked'] };
  isProcessing = true;

  try {
    ensureDirs(cacheDir);
    const s = ensureStore(cacheDir);
    const jobs = s.get();

    // How many slots available?
    const slotsAvailable = MAX_CONCURRENT - activeAgents.size;
    if (slotsAvailable <= 0) {
      return { launched: 0, skipped: ['at_capacity'] };
    }

    // Pick highest-priority queued jobs
    const queued = jobs
      .filter(j => j.status === 'queued')
      .sort((a, b) => {
        const priDiff = (b.priority ?? 1) - (a.priority ?? 1);
        if (priDiff !== 0) return priDiff;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      })
      .slice(0, slotsAvailable);

    if (queued.length === 0) {
      return { launched: 0, skipped: [] };
    }

    let launched = 0;
    const skipped = [];

    for (const job of queued) {
      try {
        // Mark provisioning
        s.update(jobs => jobs.map(j =>
          j.id === job.id ? { ...j, status: 'provisioning' } : j,
        ));

        // Create worktree
        let worktreeInfo;
        try {
          worktreeInfo = createWorktree(root, job.id);
        } catch (wtErr) {
          console.error(`  [Agent] Worktree creation failed for ${job.id}: ${wtErr.message}`);
          // Re-queue or mark dead
          const newRetry = (job.retryCount ?? 0) + 1;
          const nextStatus = newRetry < (job.maxRetries ?? 2) ? 'queued' : 'dead';
          s.update(jobs => jobs.map(j =>
            j.id === job.id
              ? { ...j, status: nextStatus, error: `Worktree failed: ${wtErr.message}`, retryCount: newRetry, pid: null }
              : j,
          ));
          skipped.push(job.id);
          continue;
        }

        // Build prompt and spawn agent
        const prompt = buildPrompt(job, root);
        const timeout = TIMEOUTS[job.type] ?? TIMEOUTS.custom;
        const resultPath = resolve(cacheDir, RESULTS_DIR, `${job.id}.md`);

        // Save prompt for debugging
        const promptFile = resolve(cacheDir, PROMPTS_DIR, `${job.id}.txt`);
        try { writeFileSync(promptFile, prompt, 'utf8'); } catch { /* non-critical */ }

        // Spawn claude in the worktree
        const child = spawn(_spawnCommand, [
          '-p', prompt,
          '--dangerously-skip-permissions',
          '--output-format', 'text',
        ], {
          cwd: worktreeInfo.worktreePath,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const pid = child.pid ?? null;
        if (pid === null) {
          console.error(`  [Agent] Failed to get PID for ${job.id}`);
          destroyWorktree(root, job.id);
          const newRetry = (job.retryCount ?? 0) + 1;
          const nextStatus = newRetry < (job.maxRetries ?? 2) ? 'queued' : 'dead';
          s.update(jobs => jobs.map(j =>
            j.id === job.id
              ? { ...j, status: nextStatus, error: 'Failed to start process', retryCount: newRetry, pid: null, worktreePath: null }
              : j,
          ));
          skipped.push(job.id);
          continue;
        }

        // Capture baseline SHA for diff tracking
        let baselineSha = null;
        try {
          baselineSha = gitArgs(['rev-parse', 'HEAD'], worktreeInfo.worktreePath);
        } catch { /* non-critical */ }

        // Mark running
        s.update(jobs => jobs.map(j =>
          j.id === job.id
            ? {
              ...j,
              status: 'running',
              startedAt: new Date().toISOString(),
              pid,
              worktreePath: worktreeInfo.worktreePath,
              branchName: worktreeInfo.branchName,
              configMethod: worktreeInfo.configMethod,
              baselineSha,
              preExistingDirtyFiles: [],
            }
            : j,
        ));

        // Initialize live output
        liveOutputBuffers.set(job.id, '');
        let stdout = '';

        child.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          stdout += text;
          appendToRingBuffer(job.id, text);
          if (typeof onOutput === 'function') {
            try { onOutput(job.id, text); } catch { /* non-critical */ }
          }
        });

        child.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          appendToRingBuffer(job.id, `[stderr] ${text}`);
        });

        // Timeout warning at 80%
        const warningTimer = setTimeout(() => {
          if (typeof onWarning === 'function') {
            try { onWarning(job.id, `Agent approaching timeout (80% of ${timeout / 1000}s)`); } catch { /* */ }
          }
        }, timeout * 0.8);

        // Hard timeout — SIGTERM then SIGKILL
        const timer = setTimeout(() => {
          killProcess(pid);
        }, timeout);

        // Track active agent
        activeAgents.set(job.id, {
          pid,
          worktreePath: worktreeInfo.worktreePath,
          branchName: worktreeInfo.branchName,
          child,
          timer,
          warningTimer,
        });

        // Handle completion
        child.on('close', (code) => {
          clearTimeout(timer);
          clearTimeout(warningTimer);
          activeAgents.delete(job.id);

          const currentJob = ensureStore(cacheDir).getJob(job.id);
          if (!currentJob) return;

          // If cancelled while running, don't overwrite
          if (currentJob.status === 'cancelled') {
            setTimeout(() => clearLiveOutput(job.id), 5000);
            return;
          }

          const timedOut = !isProcessAlive(pid) && code !== 0;

          if (code === 0) {
            // Success — save result, mark as review (worktree kept for merge)
            writeFileSync(resultPath, stdout, 'utf8');
            s.update(jobs => jobs.map(j =>
              j.id === job.id
                ? { ...j, status: 'review', completedAt: new Date().toISOString(), resultPath, pid: null }
                : j,
            ));
          } else {
            // Failure
            const newRetry = (currentJob.retryCount ?? 0) + 1;
            const maxRetries = currentJob.maxRetries ?? 2;
            const errorMsg = code === null
              ? `Timed out after ${timeout / 1000}s`
              : `Exited with code ${code}`;
            const nextStatus = newRetry < maxRetries ? 'queued' : 'dead';

            // Save partial output
            if (stdout.length > 0) {
              writeFileSync(resultPath, stdout, 'utf8');
            }

            // Destroy worktree on failure
            try { destroyWorktree(root, job.id); } catch { /* best effort */ }

            s.update(jobs => jobs.map(j =>
              j.id === job.id
                ? {
                  ...j,
                  status: nextStatus,
                  completedAt: nextStatus === 'dead' ? new Date().toISOString() : null,
                  startedAt: nextStatus === 'queued' ? null : currentJob.startedAt,
                  error: errorMsg,
                  retryCount: newRetry,
                  pid: null,
                  resultPath: stdout.length > 0 ? resultPath : null,
                  worktreePath: null,
                  branchName: nextStatus === 'queued' ? null : currentJob.branchName,
                }
                : j,
            ));
          }

          setTimeout(() => clearLiveOutput(job.id), 5000);
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          clearTimeout(warningTimer);
          activeAgents.delete(job.id);

          try { destroyWorktree(root, job.id); } catch { /* best effort */ }

          const newRetry = (job.retryCount ?? 0) + 1;
          const maxRetries = job.maxRetries ?? 2;
          const nextStatus = newRetry < maxRetries ? 'queued' : 'dead';

          s.update(jobs => jobs.map(j =>
            j.id === job.id
              ? {
                ...j,
                status: nextStatus,
                completedAt: nextStatus === 'dead' ? new Date().toISOString() : null,
                error: err.message,
                retryCount: newRetry,
                pid: null,
                worktreePath: null,
              }
              : j,
          ));

          setTimeout(() => clearLiveOutput(job.id), 5000);
        });

        launched += 1;
      } catch (err) {
        console.error(`  [Agent] Unexpected error launching ${job.id}: ${err.message}`);
        skipped.push(job.id);
      }
    }

    return { launched, skipped };
  } finally {
    isProcessing = false;
  }
}

// ---------------------------------------------------------------------------
// Public API — orphan recovery
// ---------------------------------------------------------------------------

export function recoverOrphans(cacheDir, root) {
  const s = ensureStore(cacheDir);
  const jobs = s.get();
  let recovered = 0;

  const updated = jobs.map((job) => {
    if (job.status !== 'running' && job.status !== 'provisioning') return job;

    const pid = job.pid;
    const alive = pid && isProcessAlive(pid);
    const isClaude = alive && isClaudeProcess(pid);

    if (alive && isClaude) return job;

    // Orphan detected
    recovered += 1;

    // Destroy worktree if it exists
    if (job.worktreePath && root) {
      try { destroyWorktree(root, job.id); } catch { /* best effort */ }
    }

    const newRetry = (job.retryCount ?? 0) + 1;
    const maxRetries = job.maxRetries ?? 2;

    if (newRetry < maxRetries) {
      return {
        ...job,
        status: 'queued',
        startedAt: null,
        error: 'Orphaned process — re-queued',
        retryCount: newRetry,
        pid: null,
        worktreePath: null,
        branchName: null,
      };
    }

    return {
      ...job,
      status: 'dead',
      completedAt: new Date().toISOString(),
      error: 'Orphaned process — max retries exceeded',
      retryCount: newRetry,
      pid: null,
      worktreePath: null,
      branchName: null,
    };
  });

  if (recovered > 0) {
    s.update(() => updated);
  }

  // Also clean stale worktree directories
  if (root) {
    try {
      cleanupStaleWorktrees(root, (jobId) => {
        const job = jobs.find(j => j.id === jobId);
        return job?.status === 'running' && job?.pid && isProcessAlive(job.pid);
      });
    } catch { /* best effort */ }
  }

  return { recovered };
}

// ---------------------------------------------------------------------------
// Public API — result pruning
// ---------------------------------------------------------------------------

export function pruneResults(cacheDir) {
  const dir = resolve(cacheDir, RESULTS_DIR);
  if (!existsSync(dir)) return { pruned: 0 };

  let entries;
  try {
    entries = readdirSync(dir)
      .map((name) => {
        const full = join(dir, name);
        try {
          const stat = statSync(full);
          return { name, path: full, mtime: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return { pruned: 0 };
  }

  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - thirtyDaysMs;
  let pruned = 0;

  const remaining = [];
  for (const entry of entries) {
    if (entry.mtime < cutoff) {
      try { unlinkSync(entry.path); pruned += 1; } catch { /* skip */ }
    } else {
      remaining.push(entry);
    }
  }

  if (remaining.length > 50) {
    remaining.sort((a, b) => a.mtime - b.mtime);
    const excess = remaining.slice(0, remaining.length - 50);
    for (const entry of excess) {
      try { unlinkSync(entry.path); pruned += 1; } catch { /* skip */ }
    }
  }

  return { pruned };
}

// ---------------------------------------------------------------------------
// Legacy exports for backward compatibility (used by existing tests)
// ---------------------------------------------------------------------------

/** @deprecated Use getIsProcessing() instead */
export function isQueueLocked() { return isProcessing; }

/** @deprecated Use internal reset instead */
export function resetQueueLock() { isProcessing = false; }
