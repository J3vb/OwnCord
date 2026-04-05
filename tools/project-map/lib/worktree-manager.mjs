/**
 * Worktree Manager — git worktree lifecycle for isolated agent execution.
 *
 * Each agent job gets its own worktree under .worktrees/<jobId>.
 * Changes stay isolated until explicitly merged back.
 *
 * Lifecycle:
 *   createWorktree() → agent runs → mergeWorktree() → destroyWorktree()
 *
 * State machine:
 *   queued → provisioning → running → review → merged → archived
 *                        → failed → (retry → queued)
 *                        → cancelled
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  cpSync,
  rmSync,
  readdirSync,
  lstatSync,
} from 'node:fs';
import { resolve, join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKTREES_DIR = '.worktrees';
const BRANCH_PREFIX = 'agent/';
const GIT_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(args, cwd, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: opts.timeout ?? GIT_TIMEOUT,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

/**
 * Link or copy .claude/ and CLAUDE.md into a worktree so agents
 * inherit project config, skills, and MCP server settings.
 *
 * Strategy: try symlink first (works if Developer Mode enabled on Windows).
 * If symlink fails (EPERM), fall back to a full copy.
 *
 * @returns {'symlink'|'copy'|'none'} — method used
 */
function inheritConfig(rootDir, worktreePath) {
  let method = 'none';

  const claudeDir = resolve(rootDir, '.claude');
  const claudeMd = resolve(rootDir, 'CLAUDE.md');
  const targetDir = resolve(worktreePath, '.claude');
  const targetMd = resolve(worktreePath, 'CLAUDE.md');

  if (existsSync(claudeDir) && !existsSync(targetDir)) {
    // Try symlink
    try {
      symlinkSync(claudeDir, targetDir, 'junction'); // junction works without admin on Windows
      method = 'symlink';
    } catch {
      // Fallback to copy
      try {
        cpSync(claudeDir, targetDir, { recursive: true });
        method = 'copy';
      } catch (copyErr) {
        console.error(`  [Worktree] Failed to copy .claude/: ${copyErr.message}`);
      }
    }
  }

  if (existsSync(claudeMd) && !existsSync(targetMd)) {
    try {
      symlinkSync(claudeMd, targetMd, 'file');
    } catch {
      try {
        cpSync(claudeMd, targetMd);
      } catch { /* non-critical */ }
    }
  }

  return method;
}

/**
 * Remove inherited config from a worktree before destruction.
 * Must handle both symlinks and copies.
 */
function removeInheritedConfig(worktreePath) {
  const targets = [
    resolve(worktreePath, '.claude'),
    resolve(worktreePath, 'CLAUDE.md'),
  ];

  for (const target of targets) {
    if (!existsSync(target)) continue;
    try {
      rmSync(target, { recursive: true, force: true });
    } catch (err) {
      console.error(`  [Worktree] Failed to remove ${target}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Merge mutex — only one merge at a time
// ---------------------------------------------------------------------------

let mergeInProgress = false;

export function isMergeInProgress() {
  return mergeInProgress;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an isolated git worktree for an agent job.
 *
 * @param {string} root — project root (must be a git repo)
 * @param {string} jobId — unique job identifier (used for directory + branch name)
 * @returns {{ worktreePath: string, branchName: string, configMethod: string }}
 */
export function createWorktree(root, jobId) {
  const worktreesBase = resolve(root, WORKTREES_DIR);
  if (!existsSync(worktreesBase)) {
    mkdirSync(worktreesBase, { recursive: true });
  }

  const worktreePath = resolve(worktreesBase, jobId);
  const branchName = `${BRANCH_PREFIX}${jobId}`;

  if (existsSync(worktreePath)) {
    throw new Error(`Worktree already exists for job ${jobId}`);
  }

  // Create worktree with a new branch based on current HEAD
  git(['worktree', 'add', worktreePath, '-b', branchName], root);

  // Inherit project config
  const configMethod = inheritConfig(root, worktreePath);

  return { worktreePath, branchName, configMethod };
}

/**
 * Destroy a worktree and its branch.
 * Handles the Windows-specific cleanup order: remove config → remove dir → prune → delete branch.
 *
 * @param {string} root — project root
 * @param {string} jobId — job identifier
 */
export function destroyWorktree(root, jobId) {
  const worktreePath = resolve(root, WORKTREES_DIR, jobId);
  const branchName = `${BRANCH_PREFIX}${jobId}`;

  if (existsSync(worktreePath)) {
    // Step 1: Remove inherited config (symlinks/copies) first
    removeInheritedConfig(worktreePath);

    // Step 2: Try git worktree remove
    try {
      git(['worktree', 'remove', worktreePath, '--force'], root);
    } catch {
      // Fallback: force-remove directory + prune
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch (rmErr) {
        console.error(`  [Worktree] rm failed for ${jobId}: ${rmErr.message}`);
      }
      try {
        git(['worktree', 'prune'], root);
      } catch { /* best effort */ }
    }
  } else {
    // Directory already gone — just prune
    try {
      git(['worktree', 'prune'], root);
    } catch { /* best effort */ }
  }

  // Step 3: Delete the branch
  try {
    git(['branch', '-D', branchName], root);
  } catch {
    // Branch may already be deleted or never created
  }
}

/**
 * List all active worktrees.
 *
 * @param {string} root — project root
 * @returns {Array<{ path: string, branch: string, head: string, jobId: string|null }>}
 */
export function listWorktrees(root) {
  let raw;
  try {
    raw = git(['worktree', 'list', '--porcelain'], root);
  } catch {
    return [];
  }

  const worktrees = [];
  let current = {};

  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current);
      current = { path: line.slice(9) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7);
    } else if (line === '') {
      if (current.path) worktrees.push(current);
      current = {};
    }
  }
  if (current.path) worktrees.push(current);

  // Filter to agent worktrees only and extract jobId
  return worktrees
    .filter(w => w.branch && w.branch.includes(BRANCH_PREFIX))
    .map(w => ({
      ...w,
      jobId: w.branch.replace(`refs/heads/${BRANCH_PREFIX}`, ''),
    }));
}

/**
 * Merge a worktree's branch back into the current branch.
 *
 * Guards:
 * - Only one merge at a time (mutex)
 * - Working tree must be clean
 *
 * @param {string} root — project root
 * @param {string} jobId — job identifier
 * @param {string} [message] — optional merge commit message
 * @returns {{ success: boolean, filesChanged: number, commitSha: string|null, conflicts: string[] }}
 */
export function mergeWorktree(root, jobId, message) {
  if (mergeInProgress) {
    return { success: false, filesChanged: 0, commitSha: null, conflicts: [], error: 'merge_in_progress' };
  }

  mergeInProgress = true;

  try {
    // Guard: working tree must be clean
    try {
      git(['diff', '--quiet'], root);
      git(['diff', '--quiet', '--cached'], root);
    } catch {
      return { success: false, filesChanged: 0, commitSha: null, conflicts: [], error: 'working_tree_dirty' };
    }

    const branchName = `${BRANCH_PREFIX}${jobId}`;
    const commitMsg = message || `agent: merge results from ${jobId}`;

    // Guard: branch must exist
    try {
      git(['rev-parse', '--verify', branchName], root);
    } catch {
      return { success: false, filesChanged: 0, commitSha: null, conflicts: [], error: 'branch_not_found' };
    }

    // Attempt merge
    try {
      git(['merge', branchName, '--no-ff', '-m', commitMsg], root, { timeout: 60_000 });
    } catch (mergeErr) {
      // Check if it's a conflict
      try {
        const conflictRaw = git(['diff', '--name-only', '--diff-filter=U'], root);
        const conflicts = conflictRaw.split('\n').filter(Boolean);

        if (conflicts.length > 0) {
          // Abort the merge
          try { git(['merge', '--abort'], root); } catch { /* may already be clean */ }
          return { success: false, filesChanged: 0, commitSha: null, conflicts };
        }
      } catch { /* fall through */ }

      // Not a conflict — some other error
      try { git(['merge', '--abort'], root); } catch { /* best effort */ }
      throw mergeErr;
    }

    // Success — get stats
    const commitSha = git(['rev-parse', '--short', 'HEAD'], root);
    let filesChanged = 0;
    try {
      const stat = git(['diff', '--stat', 'HEAD~1..HEAD', '--numstat'], root);
      filesChanged = stat.split('\n').filter(Boolean).length;
    } catch { /* non-critical */ }

    return { success: true, filesChanged, commitSha, conflicts: [] };
  } finally {
    mergeInProgress = false;
  }
}

/**
 * Clean up stale worktrees — those whose agent process is dead.
 * Call on server startup.
 *
 * @param {string} root — project root
 * @param {function} isJobAlive — callback (jobId) => boolean, checks if the agent process is still running
 * @returns {{ cleaned: number, errors: string[] }}
 */
export function cleanupStaleWorktrees(root, isJobAlive) {
  const worktreesBase = resolve(root, WORKTREES_DIR);
  if (!existsSync(worktreesBase)) return { cleaned: 0, errors: [] };

  let entries;
  try {
    entries = readdirSync(worktreesBase);
  } catch {
    return { cleaned: 0, errors: [] };
  }

  let cleaned = 0;
  const errors = [];

  for (const entry of entries) {
    const entryPath = resolve(worktreesBase, entry);
    try {
      const stat = lstatSync(entryPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    // Check if the agent for this worktree is still alive
    const alive = typeof isJobAlive === 'function' ? isJobAlive(entry) : false;
    if (alive) continue;

    // Dead worktree — clean up
    try {
      destroyWorktree(root, entry);
      cleaned += 1;
    } catch (err) {
      errors.push(`${entry}: ${err.message}`);
    }
  }

  return { cleaned, errors };
}

/**
 * Get disk usage estimate for a worktree directory (in bytes).
 * Best-effort — returns 0 on failure.
 */
export function getWorktreeDiskUsage(root, jobId) {
  const worktreePath = resolve(root, WORKTREES_DIR, jobId);
  if (!existsSync(worktreePath)) return 0;

  try {
    // Use git to count the worktree overhead (not the full repo — worktrees share objects)
    const countOutput = git(['count-objects', '-vH'], worktreePath);
    // Parse "size-pack: 42.00 MiB" or similar
    const match = countOutput.match(/size-pack:\s*([\d.]+)\s*(\w+)/);
    if (match) {
      const size = parseFloat(match[1]);
      const unit = match[2].toLowerCase();
      if (unit.startsWith('kib') || unit.startsWith('k')) return Math.round(size * 1024);
      if (unit.startsWith('mib') || unit.startsWith('m')) return Math.round(size * 1024 * 1024);
      if (unit.startsWith('gib') || unit.startsWith('g')) return Math.round(size * 1024 * 1024 * 1024);
      return Math.round(size);
    }
  } catch { /* best effort */ }

  return 0;
}
