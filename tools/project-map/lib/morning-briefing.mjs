/**
 * Morning Briefing — digest of overnight agent results + session suggestions.
 * Composes data from session-parser, agent-manager, suggestion-engine, and backlog-parser.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Generate a morning briefing digest.
 * Shows what happened since the last session (agent results, coverage changes, etc.)
 * and suggests what to work on next.
 */
export async function generateBriefing(root, cacheDir, {
  sessionData = null,
  suggestions = null,
  backlog = null,
  agentJobs = null,
} = {}) {
  const briefing = {
    timestamp: new Date().toISOString(),
    greeting: '',
    agentResults: [],
    deadJobs: [],
    coverageChanges: [],
    suggestedTasks: [],
    autoQueueSuggestions: [],
    stats: { completedJobs: 0, failedJobs: 0, deadJobs: 0 },
  };

  // Determine last session date for "since last session" filtering
  const lastSessionDate = sessionData?.lastSession?.date
    ? new Date(sessionData.lastSession.date)
    : null;

  // Greeting
  if (lastSessionDate) {
    const daysSince = Math.floor((Date.now() - lastSessionDate.getTime()) / 86400000);
    if (daysSince === 0) {
      briefing.greeting = 'Welcome back! You had a session earlier today.';
    } else if (daysSince === 1) {
      briefing.greeting = 'Good morning! Last session was yesterday.';
    } else {
      briefing.greeting = `Welcome back! It's been ${daysSince} days since your last session.`;
    }
  } else {
    briefing.greeting = 'Welcome! This is your first time opening the briefing.';
  }

  // Agent results since last session
  if (agentJobs?.jobs) {
    for (const job of agentJobs.jobs) {
      if (job.status === 'completed') {
        const completedAt = job.completedAt ? new Date(job.completedAt) : null;
        if (!lastSessionDate || (completedAt && completedAt > lastSessionDate)) {
          // Read result summary (first 500 chars)
          let summary = '';
          const resultPath = resolve(cacheDir, `agent-results/${job.id}.md`);
          if (existsSync(resultPath)) {
            try {
              const content = readFileSync(resultPath, 'utf8');
              summary = content.slice(0, 500).split('\n').slice(0, 10).join('\n');
              if (content.length > 500) summary += '\n...';
            } catch { /* skip */ }
          }
          briefing.agentResults.push({
            id: job.id,
            type: job.type,
            target: job.target,
            completedAt: job.completedAt,
            summary,
          });
          briefing.stats.completedJobs++;
        }
      }

      if (job.status === 'failed') briefing.stats.failedJobs++;

      if (job.status === 'dead') {
        briefing.deadJobs.push({
          id: job.id,
          type: job.type,
          target: job.target,
          error: job.error,
          retryCount: job.retryCount,
        });
        briefing.stats.deadJobs++;
      }
    }
  }

  // Top suggested tasks from suggestion engine
  if (suggestions?.suggestions) {
    briefing.suggestedTasks = suggestions.suggestions.slice(0, 5).map(s => ({
      module: s.module,
      score: s.score,
      rationale: s.rationale,
      breakdown: s.breakdown,
    }));
  }

  // Auto-queue suggestions — only when agent jobs context is available
  briefing.autoQueueSuggestions = agentJobs
    ? generateAutoQueueSuggestions(suggestions, backlog, sessionData, agentJobs)
    : [];

  return briefing;
}

/**
 * Generate smart auto-queue suggestions.
 * Recommends agent jobs based on current project state.
 */
function generateAutoQueueSuggestions(suggestions, backlog, sessionData, agentJobs) {
  const existing = new Set(
    (agentJobs?.jobs || [])
      .filter(j => ['queued', 'running', 'completed'].includes(j.status))
      .map(j => `${j.type}:${j.target}`)
  );

  const suggestions_list = [];

  if (!suggestions?.suggestions) return suggestions_list;

  for (const s of suggestions.suggestions.slice(0, 10)) {
    // Coverage gap → suggest write-tests
    if (s.breakdown?.coverage > 20) {
      const key = `write-tests:${s.module}`;
      if (!existing.has(key)) {
        suggestions_list.push({
          type: 'write-tests',
          target: s.module,
          rationale: `Coverage gap on ${s.module} (score: ${s.breakdown.coverage})`,
          priority: 2,
        });
      }
    }

    // High debt → suggest fix-debt
    if (s.breakdown?.debt > 15) {
      const key = `fix-debt:${s.module}`;
      if (!existing.has(key)) {
        suggestions_list.push({
          type: 'fix-debt',
          target: s.module,
          rationale: `Tech debt markers in ${s.module} (score: ${s.breakdown.debt})`,
          priority: 3,
        });
      }
    }

    // Open bugs → suggest code-review
    if (s.breakdown?.bugs > 10) {
      const key = `code-review:${s.module}`;
      if (!existing.has(key)) {
        suggestions_list.push({
          type: 'code-review',
          target: s.module,
          rationale: `Open bugs/review items in ${s.module} (score: ${s.breakdown.bugs})`,
          priority: 1,
        });
      }
    }
  }

  // Stale modules → suggest research (limit to top 2)
  const staleModules = suggestions.suggestions
    .filter(s => s.signals?.some(sig => sig.signal === 'stale'))
    .slice(0, 2);

  for (const s of staleModules) {
    const key = `research:${s.module}`;
    if (!existing.has(key)) {
      suggestions_list.push({
        type: 'research',
        target: s.module,
        rationale: `Module ${s.module} has been stale — investigate status`,
        priority: 4,
      });
    }
  }

  // Deduplicate and limit to 5
  const seen = new Set();
  return suggestions_list.filter(s => {
    const key = `${s.type}:${s.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}
