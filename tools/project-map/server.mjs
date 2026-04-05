#!/usr/bin/env node
/**
 * Project Map Web Dashboard
 * Run: node tools/project-map/server.mjs
 * Open: http://localhost:3333
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync as _writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanModules } from './lib/scanner.mjs';
import { collectGoCoverage } from './lib/go-coverage.mjs';
import { collectVitestCoverage } from './lib/vitest-coverage.mjs';
import { parseBacklog } from './lib/backlog-parser.mjs';
import { scorePriorities } from './lib/priority-engine.mjs';
import { scanGitHistory } from './lib/git-scanner.mjs';
import { parseSessionHistory } from './lib/session-parser.mjs';
import { scanTechnicalDebt } from './lib/debt-scanner.mjs';
import { buildImportGraph } from './lib/import-graph.mjs';
import { generateSuggestions, markWorkedOn, setStrategy } from './lib/suggestion-engine.mjs';
import { createFileWatcher, createSSEManager } from './lib/file-watcher.mjs';
import { generatePlan, startSession, getSessionStatus, pollChanges, endSession, recoverStaleSession } from './lib/session-manager.mjs';
import { healthCheck, getJobs, createJob, cancelJob, getJobResult, processQueue, recoverOrphans, pruneResults, getLiveOutput, getJobDiff, parseActivityHints, getActiveCount, getMaxConcurrent, setMaxConcurrent, getActiveAgentIds } from './lib/agent-manager.mjs';
import { mergeWorktree, destroyWorktree, listWorktrees, isMergeInProgress, getWorktreeDiskUsage } from './lib/worktree-manager.mjs';
import { generateBriefing } from './lib/morning-briefing.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const CACHE_DIR = resolve(__dirname, '.cache');
let PORT = parseInt(process.env.PORT || '3333', 10);
if (isNaN(PORT) || PORT < 1 || PORT > 65535) { console.error(`Invalid PORT "${process.env.PORT}", using 3333`); PORT = 3333; }

if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

// Auth token — generated per process, required for privileged endpoints
const AUTH_TOKEN = process.env.PROJECT_MAP_TOKEN || randomBytes(24).toString('hex');

// In-memory cache (mode-aware)
let cachedData = null;
let cachedDataMode = null; // 'quick' or 'full'
let collectInflight = null;

// Valid job types
const VALID_JOB_TYPES = new Set(['research', 'write-tests', 'code-review', 'security-audit', 'fix-debt', 'custom']);
const JOB_ID_RE = /^job-\d+(-[a-f0-9]+)?$/;

async function collectData(quick = true) {
  console.log(`  Collecting data (${quick ? 'quick' : 'full'} mode)...`);

  const modules = await scanModules(ROOT);
  const goCoverage = await collectGoCoverage(ROOT, CACHE_DIR, quick);
  const vitestCoverage = await collectVitestCoverage(ROOT, CACHE_DIR, quick);
  const backlog = await parseBacklog(ROOT);
  const priorities = scorePriorities(modules, goCoverage, vitestCoverage, backlog);

  let gitData = null, sessionData = null, debtData = null, importGraph = null;
  try { gitData = await scanGitHistory(ROOT, CACHE_DIR, quick); } catch (e) { console.error('  [Git] Error:', e.message); }
  try { sessionData = await parseSessionHistory(ROOT, CACHE_DIR, quick); } catch (e) { console.error('  [Session] Error:', e.message); }
  try { debtData = await scanTechnicalDebt(ROOT, CACHE_DIR, quick); } catch (e) { console.error('  [Debt] Error:', e.message); }
  try { importGraph = await buildImportGraph(ROOT, CACHE_DIR, quick); } catch (e) { console.error('  [Graph] Error:', e.message); }

  let suggestions = null;
  try {
    suggestions = await generateSuggestions(CACHE_DIR, {
      priorities, goCoverage, vitestCoverage, backlog, gitData, debtData, importGraph, sessionData,
    });
  } catch (e) { console.error('  [Suggestions] Error:', e.message); }

  // Agent jobs
  let agentJobs = null;
  try { agentJobs = getJobs(CACHE_DIR); } catch (e) { console.error('  [Jobs] Error:', e.message); }

  // Morning briefing
  let briefing = null;
  try { briefing = await generateBriefing(ROOT, CACHE_DIR, { sessionData, suggestions, backlog, agentJobs }); } catch (e) { console.error('  [Briefing] Error:', e.message); }

  return {
    modules, goCoverage, vitestCoverage, backlog, priorities,
    gitData, sessionData, debtData, importGraph, suggestions,
    agentJobs, briefing,
    agentHealth: null, // populated on demand
    timestamp: new Date().toISOString(),
  };
}

// SSE manager for live updates
const sse = createSSEManager();

// File watcher for auto-refresh
const watcher = createFileWatcher(ROOT, (change) => {
  console.log(`  [Watch] Change detected: ${change.filename}`);
  cachedData = null;
  sse.broadcast({ type: 'file-change', ...change });
});

// Valid strategy values
const VALID_STRATEGIES = new Set(['balanced', 'bugs-first', 'coverage-first', 'momentum-first', 'debt-first']);

// Parse JSON body from POST requests (with size limit and error handling)
async function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let destroyed = false;
    req.on('data', chunk => {
      if (destroyed) return;
      body += chunk;
      if (body.length > 4096) { destroyed = true; req.destroy(); resolve(null); }
    });
    req.on('end', () => {
      if (destroyed) return;
      try { resolve(JSON.parse(body)); } catch { resolve(null); }
    });
    req.on('error', () => { if (!destroyed) resolve(null); });
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Auto-process agent queue on an interval
let processInterval = null;

// Diff poller — polls git diff every 2s while a job is running
let diffPollerInterval = null;

function startDiffPoller() {
  if (diffPollerInterval) return;
  console.log('  [Diff] Starting diff poller (2s interval)');
  diffPollerInterval = setInterval(() => {
    try {
      const { jobs } = getJobs(CACHE_DIR);
      const running = jobs.filter(j => j.status === 'running' && j.baselineSha);
      if (running.length === 0) {
        stopDiffPoller();
        return;
      }
      for (const job of running) {
        try {
          const diffData = getJobDiff(ROOT, job.baselineSha, job.preExistingDirtyFiles || []);
          sse.broadcast({
            type: 'job-diff',
            jobId: job.id,
            files: diffData.files,
            diffs: diffData.diffs,
            freshness: diffData.freshness,
          });
        } catch (err) {
          console.error(`  [Diff] Error polling job ${job.id}:`, err.message);
        }
      }
    } catch { /* silent */ }
  }, 2000);
}

function stopDiffPoller() {
  if (!diffPollerInterval) return;
  console.log('  [Diff] Stopping diff poller');
  clearInterval(diffPollerInterval);
  diffPollerInterval = null;
}

// Check bearer token for privileged endpoints
function isAuthorized(req) {
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${AUTH_TOKEN}`;
}

function requireAuth(req, res) {
  if (isAuthorized(req)) return true;
  json(res, 401, { error: 'Unauthorized — pass Authorization: Bearer <token>' });
  return false;
}

const BIND_HOST = process.env.PROJECT_MAP_HOST || '127.0.0.1';

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // === EXISTING ROUTES ===

    if (url.pathname === '/api/data') {
      const quick = url.searchParams.get('full') !== '1';
      const requestedMode = quick ? 'quick' : 'full';
      // Don't reuse quick cache for full requests; always refresh if mode changed or forced
      const cacheValid = cachedData && cachedDataMode === requestedMode && !url.searchParams.has('refresh');
      // Also allow full cache to serve quick requests (full is a superset)
      const fullCacheForQuick = cachedData && cachedDataMode === 'full' && requestedMode === 'quick' && !url.searchParams.has('refresh');
      if (!cacheValid && !fullCacheForQuick) {
        if (!collectInflight) {
          collectInflight = collectData(quick).then(data => {
            cachedData = data;
            cachedDataMode = requestedMode;
            collectInflight = null;
            return data;
          }).catch(err => {
            collectInflight = null;
            throw err;
          });
        }
        await collectInflight;
      }
      // Strip agentJobs and job-derived briefing fields from unauthenticated responses
      if (!isAuthorized(req)) {
        const { agentJobs: _stripped, briefing: fullBriefing, ...publicData } = cachedData;
        if (fullBriefing) {
          const { agentResults: _a, deadJobs: _d, stats: _s, autoQueueSuggestions: _q, ...publicBriefing } = fullBriefing;
          publicData.briefing = publicBriefing;
        }
        json(res, 200, publicData);
      } else {
        json(res, 200, cachedData);
      }
      return;
    }

    if (url.pathname === '/api/events') {
      sse.handleConnection(req, res);
      return;
    }

    if (url.pathname === '/api/worked-on' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      const body = await parseBody(req);
      if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }
      if (typeof body.module !== 'string' || !body.module || body.module.length > 100 || !/^[\w:/-]+$/.test(body.module)) {
        json(res, 400, { error: 'Invalid module name' }); return;
      }
      markWorkedOn(CACHE_DIR, body.module);
      cachedData = null; cachedDataMode = null;
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/strategy' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      const body = await parseBody(req);
      if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }
      if (!VALID_STRATEGIES.has(body.strategy)) {
        json(res, 400, { error: `Invalid strategy. Valid: ${[...VALID_STRATEGIES].join(', ')}` }); return;
      }
      setStrategy(CACHE_DIR, body.strategy);
      cachedData = null; cachedDataMode = null;
      json(res, 200, { ok: true });
      return;
    }

    // === SESSION ROUTES ===

    if (url.pathname === '/api/session/plan' && req.method === 'GET') {
      // Unauthenticated — returns non-sensitive planning suggestions
      const plan = await generatePlan(ROOT, CACHE_DIR);
      json(res, 200, plan);
      return;
    }

    if (url.pathname === '/api/session/start' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      const state = startSession(ROOT, CACHE_DIR);
      sse.broadcast({ type: 'session-started' });
      json(res, 200, state);
      return;
    }

    if (url.pathname === '/api/session/status' && req.method === 'GET') {
      const status = getSessionStatus(CACHE_DIR);
      // If active, poll for latest changes
      if (status.active) {
        try { pollChanges(ROOT, CACHE_DIR); } catch { /* best effort */ }
        const updated = getSessionStatus(CACHE_DIR);
        json(res, 200, updated);
      } else {
        json(res, 200, status);
      }
      return;
    }

    if (url.pathname === '/api/session/end' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      const result = endSession(ROOT, CACHE_DIR);
      cachedData = null; // Vault changed
      sse.broadcast({ type: 'session-ended', ...result });
      json(res, 200, result);
      return;
    }

    // === AGENT JOB ROUTES ===

    if (url.pathname === '/api/agent/health' && req.method === 'GET') {
      const health = healthCheck();
      json(res, 200, health);
      return;
    }

    if (url.pathname === '/api/jobs' && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      const jobs = getJobs(CACHE_DIR);
      json(res, 200, jobs);
      return;
    }

    if (url.pathname === '/api/jobs' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      const body = await parseBody(req);
      if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }
      if (!VALID_JOB_TYPES.has(body.type)) {
        json(res, 400, { error: `Invalid job type. Valid: ${[...VALID_JOB_TYPES].join(', ')}` }); return;
      }
      if (!body.target || typeof body.target !== 'string' || !/^[\w:/-]+$/.test(body.target) || body.target.length > 100) {
        json(res, 400, { error: 'Invalid target: must be alphanumeric with :/-_ only, max 100 chars' }); return;
      }
      if (body.type === 'custom') {
        if (typeof body.customPrompt !== 'string' || body.customPrompt.trim().length === 0) {
          json(res, 400, { error: 'customPrompt required for custom jobs' }); return;
        }
        if (body.customPrompt.length > 8000) {
          json(res, 400, { error: 'customPrompt exceeds 8000 char limit' }); return;
        }
      }
      // Health check before allowing job creation
      const health = healthCheck();
      if (!health.available) {
        json(res, 503, { error: 'Claude CLI not available', details: health.error }); return;
      }
      const job = createJob(CACHE_DIR, {
        type: body.type,
        target: body.target,
        priority: body.priority,
        customPrompt: body.customPrompt,
      });
      json(res, 201, job);
      return;
    }

    // DELETE /api/jobs/:id
    const deleteMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      if (!requireAuth(req, res)) return;
      const jobId = deleteMatch[1];
      if (!JOB_ID_RE.test(jobId)) { json(res, 400, { error: 'Invalid job ID format' }); return; }
      try {
        cancelJob(CACHE_DIR, jobId);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 404, { error: err.message });
      }
      return;
    }

    // GET /api/jobs/:id/result
    const resultMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/result$/);
    if (resultMatch && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      const jobId = resultMatch[1];
      if (!JOB_ID_RE.test(jobId)) { json(res, 400, { error: 'Invalid job ID format' }); return; }
      const result = getJobResult(CACHE_DIR, jobId);
      json(res, 200, result);
      return;
    }

    // GET /api/jobs/:id/output — live output for running jobs
    const outputMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/output$/);
    if (outputMatch && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      const jobId = outputMatch[1];
      if (!JOB_ID_RE.test(jobId)) { json(res, 400, { error: 'Invalid job ID format' }); return; }
      const output = getLiveOutput(jobId);
      json(res, 200, { output });
      return;
    }

    // GET /api/jobs/:id/diff — current git diff for a job
    const diffMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/diff$/);
    if (diffMatch && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      const jobId = diffMatch[1];
      if (!JOB_ID_RE.test(jobId)) { json(res, 400, { error: 'Invalid job ID format' }); return; }
      const { jobs } = getJobs(CACHE_DIR);
      const job = jobs.find(j => j.id === jobId);
      if (!job) { json(res, 404, { error: 'Job not found' }); return; }
      if (!job.baselineSha) { json(res, 200, { files: [], diffs: {}, freshness: new Date().toISOString() }); return; }
      try {
        const diffData = getJobDiff(ROOT, job.baselineSha, job.preExistingDirtyFiles || []);
        json(res, 200, diffData);
      } catch (err) {
        json(res, 500, { error: 'Failed to compute diff: ' + err.message });
      }
      return;
    }

    if (url.pathname === '/api/jobs/process' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      startDiffPoller();
      const result = await processQueue(ROOT, CACHE_DIR,
        (jobId, chunk) => {
          sse.broadcast({ type: 'job-output', jobId, chunk });
          const hints = parseActivityHints(chunk);
          for (const hint of hints) {
            sse.broadcast({ type: 'job-activity', jobId, hint: hint.hint, file: hint.file });
          }
        },
        (jobId, message) => {
          sse.broadcast({ type: 'job-warning', jobId, message });
        },
      );
      if (result.launched > 0) {
        sse.broadcast({ type: 'fleet-update', active: getActiveCount(), max: getMaxConcurrent() });
        const { jobs } = getJobs(CACHE_DIR);
        if (!jobs.some(j => j.status === 'running')) stopDiffPoller();
      }
      json(res, 200, result);
      return;
    }

    // POST /api/jobs/:id/merge — merge worktree back to current branch
    const mergeMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/merge$/);
    if (mergeMatch && req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      const jobId = mergeMatch[1];
      if (!JOB_ID_RE.test(jobId)) { json(res, 400, { error: 'Invalid job ID format' }); return; }
      const { jobs } = getJobs(CACHE_DIR);
      const job = jobs.find(j => j.id === jobId);
      if (!job) { json(res, 404, { error: 'Job not found' }); return; }
      if (job.status !== 'review') { json(res, 400, { error: `Cannot merge job with status "${job.status}" — must be in review` }); return; }

      // Broadcast merge lock
      sse.broadcast({ type: 'merge-lock', locked: true, jobId });
      const body = await parseBody(req);
      const message = body?.message || undefined;

      const result = mergeWorktree(ROOT, jobId, message);

      if (result.error === 'merge_in_progress') {
        sse.broadcast({ type: 'merge-lock', locked: false, jobId });
        json(res, 423, { error: 'Another merge is in progress' });
        return;
      }
      if (result.error === 'working_tree_dirty') {
        sse.broadcast({ type: 'merge-lock', locked: false, jobId });
        json(res, 400, { error: 'Working tree has uncommitted changes — commit or stash first' });
        return;
      }
      if (result.error === 'branch_not_found') {
        sse.broadcast({ type: 'merge-lock', locked: false, jobId });
        json(res, 410, { error: 'Branch no longer exists — worktree was already cleaned up. Use Dismiss to clear this job.' });
        return;
      }
      if (!result.success && result.conflicts.length > 0) {
        sse.broadcast({ type: 'merge-lock', locked: false, jobId });
        json(res, 409, { error: 'merge_conflict', conflicts: result.conflicts });
        return;
      }

      // Success — destroy worktree and update job status
      try { destroyWorktree(ROOT, jobId); } catch { /* best effort */ }
      // Update job status to merged
      const s = getJobs(CACHE_DIR); // refresh
      // Direct queue file update for status change
      const allJobs = s.jobs.map(j =>
        j.id === jobId ? { ...j, status: 'merged', worktreePath: null, branchName: null } : j,
      );
      const { writeFileSync: wfs } = await import('node:fs');
      wfs(resolve(CACHE_DIR, 'agent-queue.json'), JSON.stringify(allJobs, null, 2));

      cachedData = null;
      sse.broadcast({ type: 'merge-lock', locked: false, jobId });
      sse.broadcast({ type: 'job-update', jobId, status: 'merged' });
      json(res, 200, { success: true, filesChanged: result.filesChanged, commitSha: result.commitSha });
      return;
    }

    // === FLEET ROUTES ===

    if (url.pathname === '/api/fleet/status' && req.method === 'GET') {
      const { jobs } = getJobs(CACHE_DIR);
      const active = jobs.filter(j => j.status === 'running' || j.status === 'provisioning').length;
      const queued = jobs.filter(j => j.status === 'queued').length;
      const review = jobs.filter(j => j.status === 'review').length;
      const worktrees = listWorktrees(ROOT).map(w => ({
        jobId: w.jobId,
        path: w.path,
        branch: w.branch,
        diskMB: Math.round(getWorktreeDiskUsage(ROOT, w.jobId) / (1024 * 1024)),
      }));
      json(res, 200, { active, queued, review, maxConcurrent: getMaxConcurrent(), worktrees });
      return;
    }

    if (url.pathname === '/api/fleet/config' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      const body = await parseBody(req);
      if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }
      if (typeof body.maxConcurrent === 'number') {
        if (body.maxConcurrent < 1 || body.maxConcurrent > 8) {
          json(res, 400, { error: 'maxConcurrent must be between 1 and 8' }); return;
        }
        setMaxConcurrent(body.maxConcurrent);
      }
      // Save to user prefs for persistence
      const prefsPath = resolve(CACHE_DIR, 'user-prefs.json');
      let prefs = {};
      try { prefs = JSON.parse(readFileSync(prefsPath, 'utf8')); } catch { /* new file */ }
      if (body.maxConcurrent) prefs.maxConcurrent = body.maxConcurrent;
      if (body.autopilot) prefs.autopilot = { ...prefs.autopilot, ...body.autopilot };
      _writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/worktrees' && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      const worktrees = listWorktrees(ROOT);
      json(res, 200, { worktrees });
      return;
    }

    // === BRIEFING ROUTE ===

    if (url.pathname === '/api/briefing' && req.method === 'GET') {
      // Use cached data if available, otherwise collect fresh
      if (!cachedData) cachedData = await collectData(true);
      const authenticated = isAuthorized(req);
      const briefing = await generateBriefing(ROOT, CACHE_DIR, {
        sessionData: cachedData.sessionData,
        suggestions: cachedData.suggestions,
        backlog: cachedData.backlog,
        // Only pass agent jobs for authenticated callers
        agentJobs: authenticated ? getJobs(CACHE_DIR) : null,
      });
      if (!authenticated) {
        // Strip all agent-job-derived fields from unauthenticated responses
        const { agentResults: _a, deadJobs: _d, stats: _s, autoQueueSuggestions: _q, ...publicBriefing } = briefing;
        json(res, 200, publicBriefing);
      } else {
        json(res, 200, briefing);
      }
      return;
    }

    // === DASHBOARD HTML ===

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = readFileSync(resolve(__dirname, 'dashboard.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error(`  [Server] ${req.method} ${url.pathname} error:`, err);
    json(res, 500, { error: 'Internal server error' });
  }
});

// Startup recovery
async function startup() {
  console.log('\n  Project Map Dashboard');
  console.log(`  http://${BIND_HOST}:${PORT}?token=${AUTH_TOKEN}`);
  // Also write token to a file for programmatic access
  try {
    _writeFileSync(resolve(CACHE_DIR, 'token.txt'), AUTH_TOKEN, { mode: 0o600 });
  } catch { /* non-critical */ }

  // Recover stale sessions
  try {
    const recovery = recoverStaleSession(ROOT, CACHE_DIR);
    if (recovery.recovered) console.log('  [Session] Recovered stale session');
  } catch (e) { console.error('  [Session] Recovery error:', e.message); }

  // Recover orphaned agent jobs (fleet-aware — also cleans stale worktrees)
  try {
    const orphans = recoverOrphans(CACHE_DIR, ROOT);
    if (orphans.recovered > 0) console.log(`  [Fleet] Recovered ${orphans.recovered} orphaned jobs`);
  } catch (e) { console.error('  [Fleet] Orphan recovery error:', e.message); }

  // Load saved fleet config
  try {
    const prefsPath = resolve(CACHE_DIR, 'user-prefs.json');
    if (existsSync(prefsPath)) {
      const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));
      if (prefs.maxConcurrent) setMaxConcurrent(prefs.maxConcurrent);
    }
  } catch { /* use defaults */ }

  // Prune old results
  try {
    const pruned = pruneResults(CACHE_DIR);
    if (pruned.pruned > 0) console.log(`  [Agent] Pruned ${pruned.pruned} old results`);
  } catch (e) { /* silent */ }

  // Agent health check
  try {
    const health = healthCheck();
    if (health.available) {
      console.log(`  [Agent] Claude CLI available (${health.version})`);
    } else {
      console.log('  [Agent] Claude CLI not available — agent jobs disabled');
    }
  } catch { /* silent */ }

  // Auto-process agent queue every 30 seconds (fleet-aware)
  processInterval = setInterval(async () => {
    try {
      const { jobs } = getJobs(CACHE_DIR);
      const hasQueued = jobs.some(j => j.status === 'queued');
      const activeCount = getActiveCount();
      if (hasQueued && activeCount < getMaxConcurrent()) {
        console.log(`  [Fleet] Auto-processing queue (${activeCount}/${getMaxConcurrent()} active)...`);
        startDiffPoller();
        const result = await processQueue(ROOT, CACHE_DIR,
          (jobId, chunk) => {
            sse.broadcast({ type: 'job-output', jobId, chunk });
            const hints = parseActivityHints(chunk);
            for (const hint of hints) {
              sse.broadcast({ type: 'job-activity', jobId, hint: hint.hint, file: hint.file });
            }
          },
          (jobId, message) => {
            sse.broadcast({ type: 'job-warning', jobId, message });
          },
        );
        if (result.launched > 0) {
          sse.broadcast({ type: 'fleet-update', active: getActiveCount(), max: getMaxConcurrent() });
        }
        const { jobs: currentJobs } = getJobs(CACHE_DIR);
        if (!currentJobs.some(j => j.status === 'running')) stopDiffPoller();
      }
    } catch { /* silent */ }
  }, 30000);

  console.log('  File watcher active — dashboard auto-refreshes on changes');
  console.log(`  Fleet: max ${getMaxConcurrent()} concurrent agents, auto-processes every 30s\n`);
}

server.listen(PORT, BIND_HOST, startup);

process.on('SIGINT', () => {
  if (processInterval) clearInterval(processInterval);
  stopDiffPoller();
  watcher.close();
  server.close();
  process.exit(0);
});

// Exports for testing — token only available in test environment
export function getAuthToken() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Token access restricted to test environment');
  return AUTH_TOKEN;
}
export { isAuthorized, server, BIND_HOST };
