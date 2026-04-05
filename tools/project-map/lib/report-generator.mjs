/**
 * Markdown report generator.
 * Writes the full project map to docs/brain/00-Overview/Project-Map.md.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function badge(coverage) {
  if (coverage === null || coverage === undefined) return '---';
  return `${coverage.toFixed(1)}%`;
}

function statusIcon(coverage) {
  if (coverage === null || coverage === undefined) return 'No tests';
  if (coverage >= 80) return 'Above target';
  if (coverage >= 70) return 'Near target';
  if (coverage >= 50) return 'Below target';
  return 'Critical';
}

export async function generateReport(reportPath, modules, goCoverage, vitestCoverage, backlog, priorities) {
  mkdirSync(dirname(reportPath), { recursive: true });

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines = [];

  lines.push('# OwnCord Project Map');
  lines.push('');
  lines.push(`> Auto-generated on ${now} by \`tools/project-map\``);
  lines.push(`> Run \`node tools/project-map/index.mjs\` to regenerate`);
  lines.push('');

  // --- Summary ---
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Go packages | ${modules.summary.goPackages} |`);
  lines.push(`| Go source files | ${modules.summary.goSourceFiles} |`);
  lines.push(`| Go test files | ${modules.summary.goTestFiles} |`);
  lines.push(`| TypeScript source files | ${modules.summary.tsSourceFiles} |`);
  lines.push(`| TypeScript test files | ${modules.summary.tsTestFiles} |`);
  lines.push(`| Rust source files | ${modules.summary.rustSourceFiles} |`);
  lines.push(`| Rust test files | ${modules.summary.rustTestFiles} |`);
  lines.push(`| Open backlog tasks | ${backlog.openCount} |`);
  lines.push(`| Completed tasks | ${backlog.doneCount} |`);
  lines.push(`| Completion rate | ${backlog.doneCount > 0 ? ((backlog.doneCount / (backlog.openCount + backlog.doneCount)) * 100).toFixed(1) : 0}% |`);
  lines.push('');

  // --- Server Coverage ---
  lines.push('## Server (Go) — Test Coverage');
  lines.push('');
  lines.push('| Package | Source Files | Test Files | Coverage | Status |');
  lines.push('|---------|-------------|------------|----------|--------|');

  for (const pkg of modules.go) {
    const covData = goCoverage.packages?.[pkg.name];
    const cov = covData?.percentage ?? null;
    const status = covData?.noTests ? 'No tests' : statusIcon(cov);
    const failed = covData?.failed ? ' (FAILING)' : '';
    lines.push(`| \`${pkg.name}/\` | ${pkg.sourceFiles} | ${pkg.testFiles} | ${badge(cov)} | ${status}${failed} |`);
  }
  lines.push('');

  // --- Client Coverage ---
  lines.push('## Client (TypeScript) — Test Coverage');
  lines.push('');
  const tsAreas = vitestCoverage.areas || {};
  const totalCov = tsAreas._total;
  if (totalCov) {
    lines.push(`**Overall:** ${totalCov.statements.toFixed(1)}% statements, ${totalCov.branches.toFixed(1)}% branches, ${totalCov.functions.toFixed(1)}% functions`);
    lines.push('');
  }
  if (vitestCoverage.testCount) {
    lines.push(`**Total tests:** ${vitestCoverage.testCount}`);
    lines.push('');
  }

  lines.push('| Area | Source Files | Coverage (stmts) | Status |');
  lines.push('|------|-------------|------------------|--------|');
  for (const dir of modules.typescript.filter(d => d.type === 'typescript')) {
    const areaCov = tsAreas[dir.name];
    const cov = areaCov?.statements ?? null;
    lines.push(`| \`${dir.name}/\` | ${dir.sourceFiles} | ${badge(cov)} | ${statusIcon(cov)} |`);
  }
  lines.push('');

  // Test file counts
  lines.push('| Test Suite | Files |');
  lines.push('|-----------|-------|');
  for (const dir of modules.typescript.filter(d => d.type !== 'typescript')) {
    lines.push(`| \`${dir.name}\` | ${dir.testFiles} |`);
  }
  lines.push('');

  // --- Rust ---
  lines.push('## Client (Rust/Tauri) — Status');
  lines.push('');
  for (const rust of modules.rust) {
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Source files | ${rust.sourceFiles} |`);
    lines.push(`| Lines of code | ${rust.sourceLines} |`);
    lines.push(`| Test files | ${rust.testFiles} |`);
    lines.push(`| Coverage | No test infrastructure |`);
  }
  lines.push('');

  // --- Backlog by Phase ---
  lines.push('## Open Work — By Phase');
  lines.push('');
  const phaseOrder = ['bug', 'high', 'code-review', 'medium', 'deferred', 'roadmap-r1', 'roadmap-r2', 'roadmap-r3', 'roadmap-r4', 'roadmap-r5', 'roadmap-r6', 'other'];
  const phaseLabels = {
    'bug': 'Bugs', 'high': 'High Priority', 'code-review': 'Code Review',
    'medium': 'Medium Priority', 'deferred': 'Deferred Features',
    'roadmap-r1': 'R1: Community Essentials', 'roadmap-r2': 'R2: Gaming DNA',
    'roadmap-r3': 'R3: Voice Power', 'roadmap-r4': 'R4: LAN Party Toolkit',
    'roadmap-r5': 'R5: Platform & Extensibility', 'roadmap-r6': 'R6: Future Vision',
    'other': 'Other',
  };

  for (const phase of phaseOrder) {
    const tasks = backlog.byPhase[phase];
    if (!tasks || tasks.length === 0) continue;
    lines.push(`### ${phaseLabels[phase] || phase} (${tasks.length})`);
    lines.push('');
    for (const task of tasks) {
      lines.push(`- **${task.id}:** ${task.description}`);
    }
    lines.push('');
  }

  // --- Where to Work Next ---
  lines.push('## Where to Work Next');
  lines.push('');
  lines.push('Ranked by priority score (coverage gap + module size + open tasks):');
  lines.push('');
  lines.push('| # | Module | Type | Score | Coverage | Open Tasks | Recommendation |');
  lines.push('|---|--------|------|-------|----------|------------|----------------|');

  const top = priorities.slice(0, 15);
  top.forEach((p, i) => {
    const cov = p.coverage !== null ? `${p.coverage.toFixed(1)}%` : '---';
    lines.push(`| ${i + 1} | \`${p.name}\` | ${p.type} | ${p.totalScore.toFixed(0)} | ${cov} | ${p.openTaskCount} | ${p.recommendation} |`);
  });
  lines.push('');

  // --- Research ---
  lines.push('## Research');
  lines.push('');
  lines.push('Use `node tools/project-map/index.mjs --research` to launch a Claude Code agent');
  lines.push('that investigates a specific area and saves findings to `docs/brain/00-Overview/Research/`.');
  lines.push('');

  // --- Staleness ---
  lines.push('---');
  lines.push(`*Last generated: ${now}*`);
  lines.push('');

  writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`\n  Report written to: ${reportPath}`);
}
