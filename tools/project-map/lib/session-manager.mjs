/**
 * Session manager — consolidates session planning, tracking, and vault writing.
 *
 * Manages the full session lifecycle: plan → start → poll → end, with
 * automatic vault integration (session logs, task file updates).
 *
 * Zero external dependencies — Node built-ins only.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { generateSuggestions } from './suggestion-engine.mjs';
import { parseSessionHistory } from './session-parser.mjs';
import { parseBacklog } from './backlog-parser.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_STATE_FILE = 'session-state.json';
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const TASK_ID_REGEX = /\b(?:fix|close|resolve|implement|complete)\s+T-(\d+)/gi;
const SHA_RE = /^[0-9a-f]{40}$/i;

function validateSha(sha) {
  if (!SHA_RE.test(sha)) throw new Error(`Invalid git SHA: "${sha}"`);
  return sha;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(args, root) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function getHeadSha(root) {
  return git(['rev-parse', 'HEAD'], root);
}

// ---------------------------------------------------------------------------
// File path to module mapping (mirrors git-scanner.mjs logic)
// ---------------------------------------------------------------------------

function fileToModule(filePath) {
  const normalized = filePath.replace(/\\/g, '/');

  if (normalized.startsWith('Server/')) {
    const parts = normalized.split('/');
    // parts[1] is a subdirectory only when there are 3+ segments
    // e.g. Server/ws/handler.go → 'ws', Server/main.go → 'server-root'
    return parts.length >= 3 ? parts[1] : 'server-root';
  }

  if (normalized.startsWith('Client/tauri-client/src-tauri/src/')) {
    return 'tauri-rust';
  }

  if (normalized.startsWith('Client/tauri-client/src/')) {
    const area = normalized.replace('Client/tauri-client/src/', '').split('/')[0];
    return area || 'client-root';
  }

  if (normalized.startsWith('Client/tauri-client/')) {
    return 'client-config';
  }

  return 'root';
}

// ---------------------------------------------------------------------------
// Session state I/O
// ---------------------------------------------------------------------------

function stateFilePath(cacheDir) {
  return resolve(cacheDir, SESSION_STATE_FILE);
}

function readSessionState(cacheDir) {
  const fp = stateFilePath(cacheDir);
  if (!existsSync(fp)) return null;

  try {
    return JSON.parse(readFileSync(fp, 'utf8'));
  } catch {
    console.warn('  [Session] Corrupt session-state.json — renaming and treating as inactive');
    try {
      const corruptPath = `${fp}.corrupt.${Date.now()}`;
      renameSync(fp, corruptPath);
    } catch { /* best effort */ }
    return null;
  }
}

function writeSessionState(cacheDir, state) {
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
  writeFileSync(stateFilePath(cacheDir), JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Safe vault write — temp file → validate → atomic rename → rollback copy
// ---------------------------------------------------------------------------

function safeWriteFile(targetPath, content) {
  const dir = resolve(targetPath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = targetPath + '.tmp';
  const backupPath = targetPath + '.bak';

  // Write to temp file
  writeFileSync(tmpPath, content, 'utf8');

  // Validate: temp file content must match what was written
  const written = readFileSync(tmpPath, 'utf8');
  if (written !== content) {
    unlinkSync(tmpPath);
    throw new Error(`Safe write validation failed: content mismatch at ${tmpPath}`);
  }

  // Keep one rollback copy of existing file
  if (existsSync(targetPath)) {
    try {
      if (existsSync(backupPath)) unlinkSync(backupPath);
      renameSync(targetPath, backupPath);
    } catch {
      // Non-fatal — proceed without backup
    }
  }

  // Atomic rename
  renameSync(tmpPath, targetPath);
}

// ---------------------------------------------------------------------------
// Vault helpers
// ---------------------------------------------------------------------------

function readVaultFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    console.warn(`  [Session] Failed to read vault file ${filePath}: ${err.message}`);
    return null;
  }
}

function formatDuration(startIso) {
  const ms = Date.now() - new Date(startIso).getTime();
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function generateSessionLogPath(root, summary) {
  const sessionsDir = resolve(root, 'docs/brain/03-Sessions');
  const today = new Date().toISOString().slice(0, 10);
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  let baseName = `${today}-${slug || 'session'}`;
  let filePath = join(sessionsDir, `${baseName}.md`);
  let counter = 1;

  while (existsSync(filePath)) {
    filePath = join(sessionsDir, `${baseName}-${counter}.md`);
    counter++;
  }

  return filePath;
}

function buildSessionLogContent(state, autoMarker = '') {
  const today = new Date().toISOString().slice(0, 10);
  const tasksCompleted = state.commits
    .flatMap(c => extractTaskIds(c))
    .filter((id, i, arr) => arr.indexOf(id) === i);

  const modulesStr = state.modulesTouched.length > 0
    ? state.modulesTouched.join(', ')
    : 'none';

  const commitsList = state.commits.length > 0
    ? state.commits.map(c => `- ${c}`).join('\n')
    : '- (no commits)';

  const filesList = state.filesChanged.length > 0
    ? state.filesChanged.slice(0, 20).map(f => `- ${f}`).join('\n')
    : '- (no files changed)';

  const tasksTable = tasksCompleted.length > 0
    ? tasksCompleted.map(id => `| ${id} | completed | Done |`).join('\n')
    : '| — | — | — |';

  const marker = autoMarker ? ` ${autoMarker}` : '';

  return `---
date: ${today}
summary: "Session${marker} — ${state.modulesTouched.slice(0, 3).join(', ') || 'general'}"
tasks-completed: ${tasksCompleted.length}
---

# Session — ${today}${marker}

## Goal

*Auto-generated session log from session manager*

## What Was Done

### Commits
${commitsList}

### Files Changed (${state.filesChanged.length} total)
${filesList}${state.filesChanged.length > 20 ? `\n- ...and ${state.filesChanged.length - 20} more` : ''}

### Modules Touched
${modulesStr}

## Decisions Made

- *See commit messages for details*

## Blockers / Issues

-

## Next Steps

-

## Tasks Touched

| Task | Action | Status |
| ---- | ------ | ------ |
${tasksTable}
`;
}

// ---------------------------------------------------------------------------
// Task ID extraction from commit messages
// ---------------------------------------------------------------------------

function extractTaskIds(commitMessage) {
  const ids = [];
  let match;
  const regex = new RegExp(TASK_ID_REGEX.source, TASK_ID_REGEX.flags);
  while ((match = regex.exec(commitMessage)) !== null) {
    ids.push(`T-${match[1]}`);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Vault task file updates
// ---------------------------------------------------------------------------

function updateVaultTasks(root, completedTaskIds, preloadedInProgressContent) {
  const inProgressPath = resolve(root, 'docs/brain/02-Tasks/In Progress.md');
  const donePath = resolve(root, 'docs/brain/02-Tasks/Done.md');
  const today = new Date().toISOString().slice(0, 10);
  const updated = [];

  const inProgressContent = preloadedInProgressContent ?? readVaultFile(inProgressPath);
  const doneContent = readVaultFile(donePath);

  if (!inProgressContent || !doneContent) {
    console.warn('  [Session] Cannot update vault tasks — file read failed');
    return updated;
  }

  const idSet = new Set(completedTaskIds);
  const movedTasks = [];
  const remainingLines = [];

  // Parse In Progress.md, extract completed tasks
  for (const line of inProgressContent.split('\n')) {
    const taskMatch = line.match(/^- \[ \] \*\*T-(\d+):\*\*\s*(.+)/);
    if (taskMatch && idSet.has(`T-${taskMatch[1]}`)) {
      movedTasks.push({
        id: `T-${taskMatch[1]}`,
        description: taskMatch[2].trim(),
      });
    } else {
      remainingLines.push(line);
    }
  }

  if (movedTasks.length === 0) return updated;

  // Write updated In Progress.md
  safeWriteFile(inProgressPath, remainingLines.join('\n'));

  // Append to Done.md
  const doneEntries = movedTasks
    .map(t => `- [x] **${t.id}:** ${t.description} — completed ${today}`)
    .join('\n');

  const sectionHeader = `\n## Session (${today})\n\n`;
  const insertionPoint = doneContent.indexOf('\n## ');
  let newDoneContent;

  if (insertionPoint !== -1) {
    // Insert after the main heading, before the first section
    newDoneContent = doneContent.slice(0, insertionPoint) +
      sectionHeader + doneEntries + '\n' +
      doneContent.slice(insertionPoint);
  } else {
    newDoneContent = doneContent + sectionHeader + doneEntries + '\n';
  }

  safeWriteFile(donePath, newDoneContent);

  for (const t of movedTasks) {
    updated.push(t.id);
  }

  return updated;
}

// Exported for testing
export { fileToModule };

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Generate a session plan combining suggestions, last session, and backlog.
 */
export async function generatePlan(root, cacheDir) {
  // Gather data from existing engines
  const [sessionData, backlog] = await Promise.all([
    parseSessionHistory(root, cacheDir, true),
    parseBacklog(root),
  ]);

  const suggestions = await generateSuggestions(cacheDir, {
    backlog,
    sessionData,
  });

  // Build greeting
  const last = sessionData.lastSession;
  const greeting = last.date
    ? `Welcome back! Last session: ${last.date} — ${last.summary || 'no summary'}`
    : 'Welcome! This appears to be the first session.';

  // Map suggestions to plan tasks
  const tasks = suggestions.suggestions.map((s, i) => {
    const topSignals = s.signals || [];
    const relatedFiles = topSignals
      .filter(sig => sig.signal === 'open-bug' || sig.signal === 'open-task')
      .map(sig => sig.value)
      .slice(0, 5);

    const score = s.score || 0;
    let estimatedFocus = 'small';
    if (score > 100) estimatedFocus = 'large';
    else if (score > 40) estimatedFocus = 'medium';

    return {
      priority: Math.min(i + 1, 5),
      title: `Focus on ${s.module}`,
      rationale: s.rationale,
      estimatedFocus,
      relatedFiles,
      module: s.module,
    };
  });

  // In-progress tasks
  const inProgress = sessionData.inProgress.map(t => ({
    id: t.id,
    description: t.description,
  }));

  return {
    greeting,
    tasks,
    lastSession: {
      date: last.date,
      summary: last.summary,
      tasksCompleted: last.tasksCompleted,
    },
    inProgress,
  };
}

/**
 * Start a new session. Records HEAD SHA and creates session state.
 * Rejects if a session is already active.
 */
export function startSession(root, cacheDir) {
  const existing = readSessionState(cacheDir);
  if (existing && existing.active) {
    throw new Error(
      'Session already active (started at ' + existing.startedAt + '). ' +
      'End or recover it before starting a new one.'
    );
  }

  const baselineSha = getHeadSha(root);
  const state = {
    active: true,
    startedAt: new Date().toISOString(),
    baselineSha,
    filesChanged: [],
    commits: [],
    modulesTouched: [],
  };

  writeSessionState(cacheDir, state);
  return { ...state };
}

/**
 * Get the current session status with live diff stats.
 */
export function getSessionStatus(cacheDir) {
  const state = readSessionState(cacheDir);
  if (!state || !state.active) {
    return { active: false };
  }

  return { ...state };
}

/**
 * Poll for changes since session baseline. Updates session state with
 * current file changes, commits, and modules touched.
 */
export function pollChanges(root, cacheDir) {
  const state = readSessionState(cacheDir);
  if (!state || !state.active) {
    return { active: false };
  }

  let filesChanged = [];
  let newCommits = [];

  try {
    const diffOutput = git(['diff', '--name-only', validateSha(state.baselineSha)], root);
    filesChanged = diffOutput ? diffOutput.split('\n').filter(Boolean) : [];
  } catch (err) {
    throw new Error(`Failed to get git diff: ${err.message}`);
  }

  try {
    const logOutput = git(['log', '--oneline', `${validateSha(state.baselineSha)}..HEAD`], root);
    newCommits = logOutput ? logOutput.split('\n').filter(Boolean) : [];
  } catch (err) {
    throw new Error(`Failed to get git log: ${err.message}`);
  }

  // Derive modules from changed files
  const moduleSet = new Set();
  for (const file of filesChanged) {
    moduleSet.add(fileToModule(file));
  }

  const updatedState = {
    ...state,
    filesChanged,
    commits: newCommits,
    modulesTouched: [...moduleSet],
    lastHeartbeat: new Date().toISOString(),
  };

  writeSessionState(cacheDir, updatedState);
  return { ...updatedState };
}

/**
 * End the current session. Generates a vault session log, updates task
 * files, and clears session state.
 */
export function endSession(root, cacheDir) {
  const state = readSessionState(cacheDir);
  if (!state || !state.active) {
    throw new Error('No active session to end.');
  }

  // Final poll to capture latest changes
  const finalState = pollChanges(root, cacheDir);

  // Generate session log
  const logContent = buildSessionLogContent(finalState);
  const logPath = generateSessionLogPath(
    root,
    finalState.modulesTouched.slice(0, 3).join('-') || 'session'
  );

  safeWriteFile(logPath, logContent);

  // Extract task IDs from commit messages and update vault
  const allTaskIds = finalState.commits
    .flatMap(c => extractTaskIds(c))
    .filter((id, i, arr) => arr.indexOf(id) === i);

  let tasksUpdated = [];
  if (allTaskIds.length > 0) {
    // Verify task IDs exist in vault before updating
    const inProgressContent = readVaultFile(
      resolve(root, 'docs/brain/02-Tasks/In Progress.md')
    );
    if (inProgressContent) {
      const knownIds = allTaskIds.filter(id => inProgressContent.includes(id));
      const unknownIds = allTaskIds.filter(id => !inProgressContent.includes(id));

      for (const uid of unknownIds) {
        console.warn(`  [Session] Task ${uid} not found in In Progress — skipping`);
      }

      if (knownIds.length > 0) {
        tasksUpdated = updateVaultTasks(root, knownIds, inProgressContent);
      }
    }
  }

  // Clear session state
  const closedState = {
    active: false,
    closedAt: new Date().toISOString(),
    startedAt: finalState.startedAt,
    baselineSha: finalState.baselineSha,
  };
  writeSessionState(cacheDir, closedState);

  return {
    sessionLog: logPath,
    tasksUpdated,
    filesChanged: finalState.filesChanged.length,
    duration: formatDuration(finalState.startedAt),
  };
}

/**
 * Recover a stale session on dashboard startup.
 * If session-state.json shows active=true but last git activity was
 * >30 minutes ago, auto-close it with a partial log.
 */
export function recoverStaleSession(root, cacheDir) {
  const state = readSessionState(cacheDir);
  if (!state || !state.active) {
    return { recovered: false };
  }

  // Use session-specific timestamps: lastHeartbeat > startedAt
  // Do NOT use repo-wide git log — that reflects any commit, not this session's activity
  const lastActivityTime = new Date(state.lastHeartbeat || state.startedAt).getTime();

  const elapsed = Date.now() - lastActivityTime;
  if (elapsed < STALE_THRESHOLD_MS) {
    return { recovered: false };
  }

  // Auto-close the stale session
  let finalState;
  try {
    finalState = pollChanges(root, cacheDir);
  } catch {
    // If poll fails, use whatever state we have
    finalState = { ...state };
  }

  const logContent = buildSessionLogContent(finalState, '[auto-closed]');
  const logPath = generateSessionLogPath(root, 'auto-closed');

  try {
    safeWriteFile(logPath, logContent);
  } catch (err) {
    console.warn(`  [Session] Failed to write auto-close log: ${err.message}`);
  }

  // Clear session state
  const closedState = {
    active: false,
    closedAt: new Date().toISOString(),
    startedAt: state.startedAt,
    baselineSha: state.baselineSha,
    autoRecovered: true,
  };
  writeSessionState(cacheDir, closedState);

  return {
    recovered: true,
    log: logPath,
  };
}
