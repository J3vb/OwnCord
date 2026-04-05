/**
 * Backlog parser — reads Backlog.md and extracts open tasks,
 * mapping them to project modules by keyword matching.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Keywords that map tasks to modules
const MODULE_KEYWORDS = {
  // Server Go packages
  'admin': ['admin', 'admin panel', 'admin api'],
  'api': ['api', 'REST', 'endpoint', 'handler', 'middleware'],
  'auth': ['auth', '2FA', 'TOTP', 'login', 'register', 'password', 'session', 'token'],
  'db': ['database', 'SQLite', 'migration', 'schema', 'query', 'db'],
  'ws': ['websocket', 'WS', 'hub', 'voice', 'broadcast', 'ringbuffer', 'reconnect'],
  'permissions': ['permission', 'role', 'RBAC'],
  'storage': ['upload', 'file storage', 'attachment'],
  'config': ['config', 'settings'],
  // Client areas
  'lib': ['livekitSession', 'audioPipeline', 'dispatcher', 'tenor', 'ptt', 'notification', 'theme'],
  'stores': ['store', 'state management'],
  'components': ['component', 'UI', 'sidebar', 'overlay', 'widget', 'picker', 'modal'],
  'pages': ['page', 'ConnectPage', 'MainPage', 'ChatArea', 'SidebarArea'],
  // Rust
  'tauri-rust': ['Rust', 'Tauri', 'tray', 'hotkey', 'credential', 'proxy', 'updater', 'ptt.rs'],
  // Cross-cutting
  'protocol': ['protocol', 'message type', 'payload'],
  'e2e': ['E2E', 'Playwright', 'end-to-end'],
  'livekit': ['LiveKit', 'voice', 'video', 'spatial audio', 'whisper', 'screen sharing', 'streaming'],
  // Feature areas
  'gaming': ['game detection', 'game time', 'LAN', 'tournament', 'leaderboard', 'seat map', 'Xfire'],
  'community': ['poll', 'gallery', 'scheduler', 'activity feed', 'pinned notes'],
  'platform': ['theme engine', 'webhook', 'bot', 'plugin', 'backup', 'monitoring'],
  'ai': ['AI', 'noise cancellation', 'translation', 'summarization', 'overlay'],
};

function matchModule(description) {
  const lower = description.toLowerCase();
  const matches = [];

  for (const [mod, keywords] of Object.entries(MODULE_KEYWORDS)) {
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      const re = new RegExp(`\\b${kwLower}\\b`);
      if (re.test(lower)) {
        matches.push(mod);
        break;
      }
    }
  }

  return matches.length > 0 ? matches : ['unclassified'];
}

function extractPhase(sectionHeader) {
  if (sectionHeader.includes('Bug')) return 'bug';
  if (sectionHeader.includes('Code Review')) return 'code-review';
  if (sectionHeader.includes('Medium Priority') || sectionHeader.includes('P2')) return 'medium';
  if (sectionHeader.includes('High Priority') || sectionHeader.includes('P0') || sectionHeader.includes('P1')) return 'high';
  if (sectionHeader.includes('Deferred')) return 'deferred';
  if (/\bR1\b/.test(sectionHeader)) return 'roadmap-r1';
  if (/\bR2\b/.test(sectionHeader)) return 'roadmap-r2';
  if (/\bR3\b/.test(sectionHeader)) return 'roadmap-r3';
  if (/\bR4\b/.test(sectionHeader)) return 'roadmap-r4';
  if (/\bR5\b/.test(sectionHeader)) return 'roadmap-r5';
  if (/\bR6\b/.test(sectionHeader)) return 'roadmap-r6';
  return 'other';
}

export async function parseBacklog(root) {
  const backlogPath = resolve(root, 'docs/brain/02-Tasks/Backlog.md');
  if (!existsSync(backlogPath)) {
    console.log('  [Backlog] File not found');
    return { tasks: [], openCount: 0, doneCount: 0, byModule: {}, byPhase: {} };
  }

  const content = readFileSync(backlogPath, 'utf8');
  const lines = content.split('\n');

  const tasks = [];
  let currentSection = '';

  for (const line of lines) {
    // Track section headers
    if (line.startsWith('## ') || line.startsWith('### ')) {
      currentSection = line.replace(/^#+\s*/, '');
    }

    // Match task lines in two formats:
    //   - [ ] **T-XXX:** description   (colon inside bold)
    //   - [ ] **T-XXX**: description   (colon after bold)
    const taskMatch = line.match(/^- \[([ x])\] \*\*T-(\d+)(?::\*\*|\*\*:)\s*(.+)/);
    if (taskMatch) {
      const done = taskMatch[1] === 'x';
      const id = `T-${taskMatch[2]}`;
      const description = taskMatch[3].replace(/\s*—\s*\d{4}-\d{2}-\d{2}$/, '').trim();
      const modules = matchModule(description);
      const phase = extractPhase(currentSection);

      tasks.push({ id, description, done, modules, phase, section: currentSection });
    }
  }

  // Aggregate
  const openTasks = tasks.filter(t => !t.done);
  const doneTasks = tasks.filter(t => t.done);

  const byModule = {};
  for (const task of openTasks) {
    for (const mod of task.modules) {
      if (!byModule[mod]) byModule[mod] = [];
      byModule[mod].push(task);
    }
  }

  const byPhase = {};
  for (const task of openTasks) {
    if (!byPhase[task.phase]) byPhase[task.phase] = [];
    byPhase[task.phase].push(task);
  }

  console.log(`  [Backlog] ${openTasks.length} open tasks, ${doneTasks.length} done`);
  return { tasks, openCount: openTasks.length, doneCount: doneTasks.length, byModule, byPhase };
}
