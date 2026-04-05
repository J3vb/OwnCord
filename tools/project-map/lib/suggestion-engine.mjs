/**
 * Smart suggestion engine.
 * Combines all signals (coverage, bugs, churn, staleness, coupling, debt, recent work)
 * into ranked "Focus Next" recommendations.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CACHE_FILE = 'suggestions.json';
const PREFS_FILE = 'user-prefs.json';

// Signal weights (tunable)
const WEIGHTS = {
  coverageGap: 2.0,      // per % below 80
  openBugs: 15,           // per bug
  codeReviewFixes: 10,    // per fix
  openTasks: 3,           // per task
  highChurn: 1.5,         // per commit in last 30d
  staleness: 0.5,         // per day since last commit
  coupling: 2.0,          // per coupling score point
  debtMarkers: 1.0,       // per TODO/FIXME/HACK
  largeFiles: 5,          // per large file
  longFunctions: 3,       // per long function
  recentWorkCooldown: -20, // penalty if worked on in last 2 sessions
};

function loadPrefs(cacheDir) {
  const prefsFile = resolve(cacheDir, PREFS_FILE);
  if (existsSync(prefsFile)) {
    try { return JSON.parse(readFileSync(prefsFile, 'utf8')); } catch { /* skip */ }
  }
  return { recentlyWorked: [], strategy: 'balanced' };
}

function savePrefs(cacheDir, prefs) {
  try {
    writeFileSync(resolve(cacheDir, PREFS_FILE), JSON.stringify(prefs, null, 2));
  } catch { /* non-fatal — prefs write failure should not crash the server */ }
}

export function markWorkedOn(cacheDir, moduleName) {
  const prefs = loadPrefs(cacheDir);
  prefs.recentlyWorked = [moduleName, ...prefs.recentlyWorked.filter(m => m !== moduleName)].slice(0, 5);
  savePrefs(cacheDir, prefs);
}

export function setStrategy(cacheDir, strategy) {
  const prefs = loadPrefs(cacheDir);
  prefs.strategy = strategy;
  savePrefs(cacheDir, prefs);
}

export async function generateSuggestions(cacheDir, {
  priorities = [],
  goCoverage = {},
  vitestCoverage = {},
  backlog = {},
  gitData = null,
  debtData = null,
  importGraph = null,
  sessionData = null,
} = {}) {
  const prefs = loadPrefs(cacheDir);
  const strategy = prefs.strategy || 'balanced';
  const recentlyWorked = new Set(prefs.recentlyWorked || []);

  // Strategy multipliers
  const strategyMult = {
    balanced: { coverage: 1, bugs: 1, momentum: 1, debt: 1 },
    'bugs-first': { coverage: 0.5, bugs: 2.5, momentum: 0.5, debt: 0.5 },
    'coverage-first': { coverage: 2.5, bugs: 0.5, momentum: 0.5, debt: 0.5 },
    'momentum-first': { coverage: 0.5, bugs: 0.5, momentum: 2.5, debt: 0.5 },
    'debt-first': { coverage: 0.5, bugs: 0.5, momentum: 0.5, debt: 2.5 },
  };
  const mult = strategyMult[strategy] || strategyMult.balanced;

  // Build per-module signal aggregation
  const moduleSignals = {};

  function ensureModule(name) {
    if (!moduleSignals[name]) {
      moduleSignals[name] = {
        name,
        signals: [],
        score: 0,
        coverageScore: 0,
        bugScore: 0,
        momentumScore: 0,
        debtScore: 0,
      };
    }
    return moduleSignals[name];
  }

  // 1. Coverage gaps (from priorities which already have this data)
  for (const p of priorities) {
    const m = ensureModule(p.name);
    if (p.coverage !== null && p.coverage < 80) {
      const gap = 80 - p.coverage;
      const pts = gap * WEIGHTS.coverageGap * mult.coverage;
      m.coverageScore += pts;
      m.signals.push({ signal: 'coverage-gap', value: `${p.coverage.toFixed(1)}% (${gap.toFixed(0)}% below target)`, points: pts });
    } else if (p.coverage === null && p.type !== 'feature-area') {
      const pts = 80 * WEIGHTS.coverageGap * 0.5 * mult.coverage; // unknown coverage = assume 50% gap
      m.coverageScore += pts;
      m.signals.push({ signal: 'no-coverage-data', value: 'No test coverage', points: pts });
    }
  }

  // 2. Open bugs and tasks
  for (const [phase, tasks] of Object.entries(backlog.byPhase || {})) {
    for (const task of tasks) {
      for (const mod of task.modules) {
        const m = ensureModule(mod);
        if (phase === 'bug') {
          const pts = WEIGHTS.openBugs * mult.bugs;
          m.bugScore += pts;
          m.signals.push({ signal: 'open-bug', value: `${task.id}: ${task.description.slice(0, 60)}`, points: pts });
        } else if (phase === 'code-review') {
          const pts = WEIGHTS.codeReviewFixes * mult.bugs;
          m.bugScore += pts;
          m.signals.push({ signal: 'code-review-fix', value: `${task.id}: ${task.description.slice(0, 60)}`, points: pts });
        } else {
          const pts = WEIGHTS.openTasks * mult.momentum;
          m.momentumScore += pts;
          m.signals.push({ signal: 'open-task', value: `${task.id}: ${task.description.slice(0, 60)}`, points: pts });
        }
      }
    }
  }

  // 3. Git signals (churn, staleness)
  if (gitData) {
    for (const [mod, data] of Object.entries(gitData.commitsByModule || {})) {
      const m = ensureModule(mod);
      // High churn = needs attention
      if (data.count > 10) {
        const pts = (data.count - 10) * WEIGHTS.highChurn * mult.momentum;
        m.momentumScore += pts;
        m.signals.push({ signal: 'high-churn', value: `${data.count} commits in 30d`, points: pts });
      }
    }

    for (const [mod, data] of Object.entries(gitData.staleness || {})) {
      const m = ensureModule(mod);
      if (data.daysSinceLastCommit > 14) {
        const pts = data.daysSinceLastCommit * WEIGHTS.staleness * mult.momentum;
        m.momentumScore += pts;
        m.signals.push({ signal: 'stale', value: `${data.daysSinceLastCommit} days since last commit`, points: pts });
      }
    }
  }

  // 4. Debt signals
  if (debtData) {
    for (const [mod, data] of Object.entries(debtData.summary?.byModule || {})) {
      const m = ensureModule(mod);
      if (data.markers > 0) {
        const pts = data.markers * WEIGHTS.debtMarkers * mult.debt;
        m.debtScore += pts;
        m.signals.push({ signal: 'debt-markers', value: `${data.markers} TODO/FIXME/HACK`, points: pts });
      }
      if (data.largeFiles > 0) {
        const pts = data.largeFiles * WEIGHTS.largeFiles * mult.debt;
        m.debtScore += pts;
        m.signals.push({ signal: 'large-files', value: `${data.largeFiles} oversized file(s)`, points: pts });
      }
      if (data.longFunctions > 0) {
        const pts = data.longFunctions * WEIGHTS.longFunctions * mult.debt;
        m.debtScore += pts;
        m.signals.push({ signal: 'long-functions', value: `${data.longFunctions} long function(s)`, points: pts });
      }
    }
  }

  // 5. Coupling signals
  if (importGraph) {
    for (const node of importGraph.nodes || []) {
      const m = ensureModule(node.name);
      if (node.coupling > 10) {
        const pts = node.coupling * WEIGHTS.coupling * mult.debt;
        m.debtScore += pts;
        m.signals.push({ signal: 'high-coupling', value: `Coupling score ${node.coupling} (fan-in ${node.fanIn}, fan-out ${node.fanOut})`, points: pts });
      }
    }
  }

  // 6. Recent work cooldown
  for (const [name, m] of Object.entries(moduleSignals)) {
    if (recentlyWorked.has(name)) {
      const pts = WEIGHTS.recentWorkCooldown;
      m.momentumScore += pts;
      m.signals.push({ signal: 'recently-worked', value: 'Worked on recently — cooling down', points: pts });
    }
  }

  // Compute total scores
  for (const m of Object.values(moduleSignals)) {
    m.score = m.coverageScore + m.bugScore + m.momentumScore + m.debtScore;
  }

  // Sort and take top suggestions
  const sorted = Object.values(moduleSignals)
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score);

  const suggestions = sorted.slice(0, 10).map((m, i) => {
    // Build a human-readable rationale from top 3 signals
    const topSignals = [...m.signals].sort((a, b) => b.points - a.points).slice(0, 3);
    const rationale = topSignals.map(s => s.value).join('; ');

    return {
      rank: i + 1,
      module: m.name,
      score: Math.round(m.score),
      rationale,
      breakdown: {
        coverage: Math.round(m.coverageScore),
        bugs: Math.round(m.bugScore),
        momentum: Math.round(m.momentumScore),
        debt: Math.round(m.debtScore),
      },
      signals: m.signals,
    };
  });

  const result = {
    timestamp: new Date().toISOString(),
    strategy,
    suggestions,
    recentlyWorked: [...recentlyWorked],
  };

  try {
    writeFileSync(resolve(cacheDir, CACHE_FILE), JSON.stringify(result, null, 2));
  } catch { /* non-fatal */ }
  return result;
}
