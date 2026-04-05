#!/usr/bin/env node
/**
 * OwnCord Project Map Generator
 *
 * Scans the repository, collects test coverage, parses the backlog,
 * scores priorities, and outputs a markdown report + terminal summary.
 *
 * Usage:
 *   node index.mjs            # full run (runs tests for coverage)
 *   node index.mjs --quick    # skip test runs, use cached coverage
 *   node index.mjs --research # interactive research launcher
 *   node index.mjs --serve    # launch web dashboard
 */

import { scanModules } from './lib/scanner.mjs';
import { collectGoCoverage } from './lib/go-coverage.mjs';
import { collectVitestCoverage } from './lib/vitest-coverage.mjs';
import { parseBacklog } from './lib/backlog-parser.mjs';
import { scorePriorities } from './lib/priority-engine.mjs';
import { generateReport } from './lib/report-generator.mjs';
import { printTerminalSummary } from './lib/terminal-summary.mjs';
import { launchResearchAgent } from './lib/research-agent.mjs';
import { scanGitHistory } from './lib/git-scanner.mjs';
import { parseSessionHistory } from './lib/session-parser.mjs';
import { scanTechnicalDebt } from './lib/debt-scanner.mjs';
import { buildImportGraph } from './lib/import-graph.mjs';
import { generateSuggestions } from './lib/suggestion-engine.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const CACHE_DIR = resolve(__dirname, '.cache');
const REPORT_PATH = resolve(ROOT, 'docs/brain/00-Overview/Project-Map.md');

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const research = args.includes('--research');
const serve = args.includes('--serve');

if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

async function main() {
  if (research) {
    await launchResearchAgent(ROOT);
    return;
  }

  if (serve) {
    // Dynamic import to launch the server
    await import('./server.mjs');
    return;
  }

  console.log(quick
    ? '\n  Project Map (quick mode — using cached data)\n'
    : '\n  Project Map (full mode — running tests for coverage)\n');

  // Core data
  const modules = await scanModules(ROOT);
  const goCoverage = await collectGoCoverage(ROOT, CACHE_DIR, quick);
  const vitestCoverage = await collectVitestCoverage(ROOT, CACHE_DIR, quick);
  const backlog = await parseBacklog(ROOT);
  const priorities = scorePriorities(modules, goCoverage, vitestCoverage, backlog);

  // Enhanced data (graceful failures)
  let gitData = null, sessionData = null, debtData = null, importGraph = null, suggestions = null;
  try { gitData = await scanGitHistory(ROOT, CACHE_DIR, quick); } catch (e) { console.error(`  [Git] ${e.message}`); }
  try { sessionData = await parseSessionHistory(ROOT, CACHE_DIR, quick); } catch (e) { console.error(`  [Session] ${e.message}`); }
  try { debtData = await scanTechnicalDebt(ROOT, CACHE_DIR, quick); } catch (e) { console.error(`  [Debt] ${e.message}`); }
  try { importGraph = await buildImportGraph(ROOT, CACHE_DIR, quick); } catch (e) { console.error(`  [Graph] ${e.message}`); }
  try {
    suggestions = await generateSuggestions(CACHE_DIR, {
      priorities, goCoverage, vitestCoverage, backlog, gitData, debtData, importGraph, sessionData,
    });
  } catch (e) { console.error(`  [Suggestions] ${e.message}`); }

  // Generate markdown report
  await generateReport(REPORT_PATH, modules, goCoverage, vitestCoverage, backlog, priorities);

  // Print terminal summary
  printTerminalSummary(modules, goCoverage, vitestCoverage, backlog, priorities);

  // Print top suggestions
  if (suggestions?.suggestions?.length) {
    const CYAN = '\x1b[36m', BOLD = '\x1b[1m', DIM = '\x1b[2m', RESET = '\x1b[0m';
    console.log(`\n  ${CYAN}${BOLD}SMART SUGGESTIONS (${suggestions.strategy})${RESET}`);
    console.log(`  ${DIM}${'─'.repeat(60)}${RESET}`);
    for (const s of suggestions.suggestions.slice(0, 5)) {
      console.log(`  ${CYAN}${s.rank}.${RESET} ${BOLD}${s.module}${RESET} (score: ${s.score}) — ${DIM}${s.rationale}${RESET}`);
    }
    console.log('');
  }
}

main().catch(err => {
  console.error('Project map failed:', err.message);
  process.exit(1);
});
