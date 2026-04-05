/**
 * Git history scanner — analyzes recent commits to provide per-module
 * activity, file churn, staleness, velocity, and commit-type breakdown.
 *
 * Zero external dependencies — Node built-ins only.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WINDOW_DAYS = 30;
const TOP_CHURN = 20;
const RECENT_LIMIT = 15;

const COMMIT_TYPES = ['feat', 'fix', 'test', 'refactor', 'docs', 'chore', 'perf'];

/**
 * Map a file path to its logical module name.
 *   Server/{package}/  → package name (e.g. "ws", "db", "auth")
 *   Client/tauri-client/src/{area}/  → area name (e.g. "components", "lib")
 *   Client/tauri-client/src-tauri/src/ → "tauri-rust"
 *
 * NOTE: names are unprefixed to match scanner.mjs, backlog-parser.mjs,
 *       debt-scanner.mjs, and suggestion-engine.mjs canonical keys.
 */
function resolveModule(filePath) {
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
    const parts = normalized.replace('Client/tauri-client/src/', '').split('/');
    return parts.length >= 1 && parts[0] !== '' ? parts[0] : 'client-root';
  }

  if (normalized.startsWith('Client/tauri-client/')) {
    return 'client-config';
  }

  if (normalized.startsWith('Client/')) {
    return 'client-other';
  }

  // Root-level files (README, .gitignore, etc.)
  return 'root';
}

/**
 * Parse a conventional-commit prefix from a message.
 * Returns one of the known types or "other".
 */
function parseCommitType(message) {
  const match = message.match(/^(\w+)(?:\(.+?\))?[!]?:/);
  if (!match) return 'other';
  const prefix = match[1].toLowerCase();
  return COMMIT_TYPES.includes(prefix) ? prefix : 'other';
}

/**
 * Run a git command and return stdout as a string.
 * Uses execFileSync with argument arrays to avoid shell injection.
 */
function git(args, root) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Parse the raw git log output into structured commit objects.
 *
 * git log --format="%H|%ai|%s" --name-only produces:
 *   HASH|DATE|SUBJECT
 *   (blank line)
 *   file1
 *   file2
 *   HASH|DATE|SUBJECT
 *   (blank line)
 *   file1
 *   ...
 *
 * We detect header lines by the HASH|DATE|SUBJECT pattern and
 * accumulate file lines until the next header.
 */
function parseGitLog(raw) {
  const commits = [];
  const lines = raw.trim().split('\n');

  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    // Detect header: 40-char hex hash, then pipe, then date, then pipe, then subject
    const pipeIdx1 = trimmed.indexOf('|');
    const pipeIdx2 = pipeIdx1 !== -1 ? trimmed.indexOf('|', pipeIdx1 + 1) : -1;
    const isHeader = pipeIdx1 === 40 && pipeIdx2 !== -1;

    if (isHeader) {
      // Finalize previous commit
      if (current) {
        current.modules = [...new Set(current.files.map(resolveModule))];
        commits.push(current);
      }

      const hash = trimmed.slice(0, pipeIdx1);
      const date = trimmed.slice(pipeIdx1 + 1, pipeIdx2);
      const message = trimmed.slice(pipeIdx2 + 1);
      const type = parseCommitType(message);

      current = { hash, date, message, type, files: [], modules: [] };
    } else if (current) {
      current.files.push(trimmed);
    }
  }

  // Finalize last commit
  if (current) {
    current.modules = [...new Set(current.files.map(resolveModule))];
    commits.push(current);
  }

  return commits;
}

/**
 * Build per-module commit data from the parsed commits.
 */
function buildCommitsByModule(commits) {
  const byModule = {};

  for (const commit of commits) {
    for (const mod of commit.modules) {
      if (!byModule[mod]) {
        byModule[mod] = { count: 0, lastCommit: commit.date, commits: [] };
      }
      byModule[mod].count += 1;
      byModule[mod].commits.push({
        hash: commit.hash,
        date: commit.date,
        message: commit.message,
        type: commit.type,
      });
      // Keep the most recent date
      if (commit.date > byModule[mod].lastCommit) {
        byModule[mod].lastCommit = commit.date;
      }
    }
  }

  return byModule;
}

/**
 * Compute file churn — number of commits touching each file.
 * Returns top N most churned files.
 */
function buildFileChurn(commits) {
  const churnMap = {};

  for (const commit of commits) {
    for (const file of commit.files) {
      if (!churnMap[file]) {
        churnMap[file] = { file, commits: 0, module: resolveModule(file) };
      }
      churnMap[file].commits += 1;
    }
  }

  return Object.values(churnMap)
    .sort((a, b) => b.commits - a.commits)
    .slice(0, TOP_CHURN);
}

/**
 * Calculate staleness — days since last commit per module.
 */
function buildStaleness(commitsByModule) {
  const now = Date.now();
  const staleness = {};

  for (const [mod, data] of Object.entries(commitsByModule)) {
    const lastDate = new Date(data.lastCommit);
    const daysSince = Math.floor((now - lastDate.getTime()) / (1000 * 60 * 60 * 24));
    staleness[mod] = {
      daysSinceLastCommit: daysSince,
      lastCommitDate: data.lastCommit,
    };
  }

  return staleness;
}

/**
 * Build daily velocity and rolling 7-day average.
 */
function buildVelocity(commits) {
  // Build a map of date → commit count
  const dailyMap = {};
  const now = new Date();

  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dailyMap[key] = 0;
  }

  for (const commit of commits) {
    const key = commit.date.slice(0, 10);
    if (key in dailyMap) {
      dailyMap[key] += 1;
    }
  }

  const daily = Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  // Rolling 7-day average (use last 7 days)
  const last7 = daily.slice(-7);
  const weeklyAvg = last7.length > 0
    ? Math.round((last7.reduce((s, d) => s + d.count, 0) / last7.length) * 100) / 100
    : 0;

  // Trend: compare first half vs second half of the window
  const mid = Math.floor(daily.length / 2);
  const firstHalf = daily.slice(0, mid);
  const secondHalf = daily.slice(mid);

  const avgFirst = firstHalf.length > 0
    ? firstHalf.reduce((s, d) => s + d.count, 0) / firstHalf.length
    : 0;
  const avgSecond = secondHalf.length > 0
    ? secondHalf.reduce((s, d) => s + d.count, 0) / secondHalf.length
    : 0;

  let trend = 'stable';
  const delta = avgSecond - avgFirst;
  if (delta > 0.3) trend = 'accelerating';
  else if (delta < -0.3) trend = 'decelerating';

  return { daily, weeklyAvg, trend };
}

/**
 * Build commit type breakdown.
 */
function buildCommitTypes(commits) {
  const types = { feat: 0, fix: 0, test: 0, refactor: 0, docs: 0, chore: 0, other: 0 };

  for (const commit of commits) {
    const bucket = commit.type in types ? commit.type : 'other';
    types[bucket] += 1;
  }

  return types;
}

/**
 * Main entry point. Scans git history for the last 30 days and returns
 * structured data about module activity, churn, staleness, and velocity.
 *
 * @param {string} root      - Repository root directory
 * @param {string} cacheDir  - Directory to store cached results
 * @param {boolean} quick    - If true and cache exists, return cached data
 * @returns {Promise<object>} Structured git history data
 */
// Exported for testing
export { resolveModule };

export async function scanGitHistory(root, cacheDir, quick = false) {
  const cacheFile = join(cacheDir, 'git-data.json');

  // Quick mode: return cache if available
  if (quick && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
      return cached;
    } catch {
      // Cache corrupt — fall through to fresh scan
    }
  }

  // Fetch git log with file names
  const raw = git(
    ['log', `--since=${WINDOW_DAYS} days ago`, '--format=%H|%ai|%s', '--name-only'],
    root,
  );

  const commits = parseGitLog(raw);
  const commitsByModule = buildCommitsByModule(commits);
  const fileChurn = buildFileChurn(commits);
  const staleness = buildStaleness(commitsByModule);
  const velocity = buildVelocity(commits);
  const commitTypes = buildCommitTypes(commits);

  const recentCommits = commits.slice(0, RECENT_LIMIT).map(c => ({
    hash: c.hash,
    date: c.date,
    message: c.message,
    type: c.type,
    modules: c.modules,
  }));

  const result = {
    timestamp: new Date().toISOString(),
    commitsByModule,
    fileChurn,
    staleness,
    velocity,
    commitTypes,
    recentCommits,
    totalCommits30d: commits.length,
  };

  // Persist cache
  try {
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8');
  } catch {
    // Non-fatal — scanning still succeeds without cache write
  }

  return result;
}
