/**
 * Session parser — reads session log files from docs/brain/03-Sessions/,
 * builds a timeline, tracks progress over time, calculates streaks,
 * and extracts last-session and task-status info.
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ---------------------------------------------------------------------------
// Module keyword map — maps session content to touched modules
// ---------------------------------------------------------------------------

const MODULE_KEYWORDS = {
  'admin':      ['admin panel', 'admin api', 'admin'],
  'api':        ['REST', 'endpoint', 'handler', 'middleware', 'api'],
  'auth':       ['auth', '2FA', 'TOTP', 'login', 'register', 'password', 'session', 'token'],
  'db':         ['database', 'SQLite', 'migration', 'schema', 'query', 'db'],
  'ws':         ['websocket', 'hub', 'broadcast', 'ringbuffer', 'reconnect'],
  'voice':      ['voice', 'audio', 'LiveKit', 'livekit', 'WebRTC', 'SFU', 'RTP', 'VAD'],
  'permissions': ['permission', 'role', 'RBAC'],
  'storage':    ['upload', 'file storage', 'attachment'],
  'config':     ['config', 'settings'],
  'lib':        ['livekitSession', 'audioPipeline', 'dispatcher', 'tenor', 'ptt', 'notification', 'theme'],
  'stores':     ['store', 'state management'],
  'components': ['component', 'sidebar', 'overlay', 'widget', 'picker', 'modal'],
  'pages':      ['ConnectPage', 'MainPage', 'ChatArea', 'SidebarArea'],
  'tauri-rust': ['Rust', 'Tauri', 'tray', 'hotkey', 'credential', 'proxy', 'updater'],
  'protocol':   ['protocol', 'message type', 'payload'],
  'e2e':        ['E2E', 'Playwright', 'end-to-end'],
  'tests':      ['test', 'coverage', 'vitest', 'unit test', 'integration test'],
  'docs':       ['documentation', 'README', 'CLAUDE.md', 'spec', 'docs'],
  'security':   ['security', 'XSS', 'CSRF', 'injection', 'audit', 'vulnerability'],
  'ci':         ['CI', 'GitHub Actions', 'lint', 'golangci'],
};

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Parse YAML-like frontmatter delimited by --- lines.
 * Returns { meta: { key: value }, body: string }.
 */
function parseFrontmatter(content) {
  const lines = content.split('\n').map(l => l.replace(/\r$/, ''));
  if (lines[0].trim() !== '---') {
    return { meta: {}, body: content };
  }

  const meta = {};
  let endIdx = -1;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
    const colonIdx = lines[i].indexOf(':');
    if (colonIdx > 0) {
      const key = lines[i].slice(0, colonIdx).trim();
      let val = lines[i].slice(colonIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      meta[key] = val;
    }
  }

  if (endIdx === -1) {
    return { meta: {}, body: content };
  }

  const body = lines.slice(endIdx + 1).join('\n');
  return { meta, body };
}

// ---------------------------------------------------------------------------
// Module detection from session body text
// ---------------------------------------------------------------------------

function detectModules(body) {
  const lower = body.toLowerCase();
  const found = [];

  for (const [mod, keywords] of Object.entries(MODULE_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) {
        found.push(mod);
        break;
      }
    }
  }

  return found.length > 0 ? found : ['general'];
}

// ---------------------------------------------------------------------------
// Task file parsers (Done.md, In Progress.md)
// ---------------------------------------------------------------------------

function parseDoneFile(filePath) {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n').map(l => l.replace(/\r$/, ''));
  const tasks = [];
  let currentSection = '';

  for (const line of lines) {
    if (line.startsWith('## ')) {
      currentSection = line.replace(/^##\s*/, '');
    }

    // Match both formats:
    //   - [x] **T-XXX:** description — completed YYYY-MM-DD
    //   - [x] **T-XXX**: description — YYYY-MM-DD
    const match = line.match(
      /^- \[x\] \*\*T-(\d+)[:\*]*\*?\*?\s*(.+?)(?:\s*—\s*(?:completed\s+)?(\d{4}-\d{2}-\d{2}))?$/
    );
    if (match) {
      const id = `T-${match[1]}`;
      const description = match[2]
        .replace(/\s*—\s*(?:completed\s+)?\d{4}-\d{2}-\d{2}$/, '')
        .trim();
      // Date from the line itself, or try to extract from section header
      const date = match[3] || extractDateFromSection(currentSection) || '';
      tasks.push({ id, description, date });
    }
  }

  return tasks;
}

function extractDateFromSection(section) {
  const match = section.match(/\((\d{4}-\d{2}-\d{2})\)/);
  return match ? match[1] : null;
}

function parseInProgressFile(filePath) {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n').map(l => l.replace(/\r$/, ''));
  const tasks = [];

  for (const line of lines) {
    // Match: - [ ] **T-XXX:** description
    const match = line.match(/^- \[ \] \*\*T-(\d+):\*\*\s*(.+)/);
    if (match) {
      const id = `T-${match[1]}`;
      const description = match[2].trim();
      tasks.push({ id, description });
    }

    // Also match lines without checkbox but with task ID
    const altMatch = line.match(/^\*\*T-(\d+):\*\*\s*(.+)/);
    if (!match && altMatch) {
      const id = `T-${altMatch[1]}`;
      const description = altMatch[2].trim();
      tasks.push({ id, description });
    }
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Streak calculation
// ---------------------------------------------------------------------------

function calculateStreaks(sortedDates) {
  if (sortedDates.length === 0) {
    return { current: 0, longest: 0, totalSessions: 0 };
  }

  // Deduplicate dates (multiple sessions on same day count as 1)
  const uniqueDates = [...new Set(sortedDates)].sort();
  const totalSessions = sortedDates.length;

  let longest = 1;
  let currentStreak = 1;
  let streakAtEnd = 1;

  for (let i = 1; i < uniqueDates.length; i++) {
    const prev = new Date(uniqueDates[i - 1] + 'T00:00:00Z');
    const curr = new Date(uniqueDates[i] + 'T00:00:00Z');
    const diffMs = curr.getTime() - prev.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 1) {
      currentStreak++;
    } else {
      currentStreak = 1;
    }

    if (currentStreak > longest) {
      longest = currentStreak;
    }

    streakAtEnd = currentStreak;
  }

  // Check if the most recent session date is today or yesterday
  // to determine if the current streak is still "active"
  const lastDate = new Date(uniqueDates[uniqueDates.length - 1] + 'T00:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const daysSinceLast = Math.round((today.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));

  const current = daysSinceLast <= 1 ? streakAtEnd : 0;

  return { current, longest, totalSessions };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Parse all session logs and task files, returning a structured timeline.
 *
 * @param {string} root       - Repository root directory
 * @param {string} cacheDir   - Directory to store cached results
 * @param {boolean} quick     - If true and cache exists, return cached data
 * @returns {Promise<Object>} - Parsed session history
 */
export async function parseSessionHistory(root, cacheDir, quick) {
  const cachePath = join(cacheDir, 'session-data.json');

  // Quick mode: return cached data if available
  if (quick && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      console.log('  [Sessions] Returning cached session data');
      return cached;
    } catch {
      // Cache corrupt — fall through to fresh parse
    }
  }

  const sessionsDir = resolve(root, 'docs/brain/03-Sessions');
  const donePath = resolve(root, 'docs/brain/02-Tasks/Done.md');
  const inProgressPath = resolve(root, 'docs/brain/02-Tasks/In Progress.md');

  // -----------------------------------------------------------------------
  // 1. Parse all session files
  // -----------------------------------------------------------------------

  const sessions = [];

  if (existsSync(sessionsDir)) {
    const files = readdirSync(sessionsDir)
      .filter(f => f.endsWith('.md') && f !== 'index.md')
      .sort();

    for (const fileName of files) {
      const filePath = join(sessionsDir, fileName);
      const content = readFileSync(filePath, 'utf8');
      const { meta, body } = parseFrontmatter(content);

      const date = meta.date || fileName.slice(0, 10);
      const summary = meta.summary || '';
      const tasksCompleted = parseInt(meta['tasks-completed'] || '0', 10);
      const modulesTouched = detectModules(body);

      sessions.push({
        date,
        summary,
        tasksCompleted,
        modulesTouched,
        fileName,
      });
    }
  }

  // Sort by date ascending
  sessions.sort((a, b) => a.date.localeCompare(b.date));

  console.log(`  [Sessions] Parsed ${sessions.length} session files`);

  // -----------------------------------------------------------------------
  // 2. Build progress over time (cumulative tasks completed)
  // -----------------------------------------------------------------------

  const progressOverTime = [];
  let cumulative = 0;

  for (const session of sessions) {
    cumulative += session.tasksCompleted;
    progressOverTime.push({
      date: session.date,
      cumulativeDone: cumulative,
      sessionDone: session.tasksCompleted,
    });
  }

  // -----------------------------------------------------------------------
  // 3. Calculate streaks
  // -----------------------------------------------------------------------

  const sessionDates = sessions.map(s => s.date);
  const streaks = calculateStreaks(sessionDates);

  // -----------------------------------------------------------------------
  // 4. Extract last session info
  // -----------------------------------------------------------------------

  const lastSessionRaw = sessions.length > 0 ? sessions[sessions.length - 1] : null;
  const lastSession = lastSessionRaw
    ? {
        date: lastSessionRaw.date,
        summary: lastSessionRaw.summary,
        tasksCompleted: lastSessionRaw.tasksCompleted,
        modulesTouched: lastSessionRaw.modulesTouched,
      }
    : { date: '', summary: '', tasksCompleted: 0, modulesTouched: [] };

  // -----------------------------------------------------------------------
  // 5. Parse task files
  // -----------------------------------------------------------------------

  const allDone = parseDoneFile(donePath);
  // Last 10 completed tasks (file is ordered newest-first by section)
  const recentlyDone = allDone.slice(0, 10);

  const inProgress = parseInProgressFile(inProgressPath);

  console.log(`  [Sessions] ${allDone.length} done tasks, ${inProgress.length} in-progress`);

  // -----------------------------------------------------------------------
  // 6. Assemble result and cache
  // -----------------------------------------------------------------------

  const result = {
    timestamp: new Date().toISOString(),
    sessions,
    progressOverTime,
    streaks,
    lastSession,
    inProgress,
    recentlyDone,
  };

  // Write cache
  try {
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    writeFileSync(cachePath, JSON.stringify(result, null, 2));
  } catch (err) {
    console.warn(`  [Sessions] Failed to write cache: ${err.message}`);
  }

  return result;
}
