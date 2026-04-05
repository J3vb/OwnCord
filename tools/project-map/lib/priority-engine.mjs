/**
 * Priority scoring engine.
 * Ranks modules by where work is most needed based on:
 * - Coverage gap (distance from 80% target)
 * - Module size (larger modules = higher impact)
 * - Open bug/task count
 * - Roadmap position (earlier phases = higher priority)
 */

const COVERAGE_TARGET = 80;

const PHASE_WEIGHTS = {
  'bug': 10,
  'high': 8,
  'code-review': 7,
  'medium': 5,
  'deferred': 3,
  'roadmap-r1': 4,
  'roadmap-r2': 3,
  'roadmap-r3': 2,
  'roadmap-r4': 1.5,
  'roadmap-r5': 1,
  'roadmap-r6': 0.5,
  'other': 2,
};

function coverageGapScore(coveragePct) {
  if (coveragePct === null || coveragePct === undefined) return 50; // no tests = high gap
  const gap = Math.max(0, COVERAGE_TARGET - coveragePct);
  return gap * 1.5; // 1.5 points per percent below target
}

function sizeScore(sourceFiles, sourceLines) {
  // Larger modules are higher impact
  return Math.min(30, sourceFiles * 2 + (sourceLines / 200));
}

function taskScore(openTasks) {
  if (!openTasks || openTasks.length === 0) return 0;
  let score = 0;
  for (const task of openTasks) {
    score += PHASE_WEIGHTS[task.phase] || 2;
  }
  return score;
}

export function scorePriorities(modules, goCoverage, vitestCoverage, backlog) {
  const scores = [];

  // Score Go packages
  for (const pkg of modules.go) {
    const covData = goCoverage.packages?.[pkg.name];
    const coverage = covData?.percentage ?? null;
    const openTasks = backlog.byModule[pkg.name] || [];

    const cScore = coverageGapScore(coverage);
    const sScore = sizeScore(pkg.sourceFiles, pkg.sourceLines);
    const tScore = taskScore(openTasks);
    const total = cScore + sScore + tScore;

    scores.push({
      name: pkg.name,
      type: 'go',
      path: pkg.path,
      coverage,
      coverageGap: cScore,
      sizeImpact: sScore,
      taskWeight: tScore,
      totalScore: total,
      openTaskCount: openTasks.length,
      openTasks: openTasks.map(t => t.id),
      recommendation: getRecommendation(coverage, openTasks, pkg),
    });
  }

  // Score TypeScript areas
  const tsAreas = vitestCoverage.areas || {};
  for (const dir of modules.typescript.filter(d => d.type === 'typescript')) {
    const areaCov = tsAreas[dir.name];
    const coverage = areaCov?.statements ?? (tsAreas._total?.statements ?? null);
    const openTasks = backlog.byModule[dir.name] || [];

    const cScore = coverageGapScore(coverage);
    const sScore = sizeScore(dir.sourceFiles, dir.sourceLines);
    const tScore = taskScore(openTasks);
    const total = cScore + sScore + tScore;

    scores.push({
      name: dir.name,
      type: 'typescript',
      path: dir.path,
      coverage,
      coverageGap: cScore,
      sizeImpact: sScore,
      taskWeight: tScore,
      totalScore: total,
      openTaskCount: openTasks.length,
      openTasks: openTasks.map(t => t.id),
      recommendation: getRecommendation(coverage, openTasks, dir),
    });
  }

  // Score Rust
  for (const rust of modules.rust) {
    const openTasks = backlog.byModule['tauri-rust'] || [];
    const cScore = coverageGapScore(null); // no Rust tests
    const sScore = sizeScore(rust.sourceFiles, rust.sourceLines);
    const tScore = taskScore(openTasks);
    const total = cScore + sScore + tScore;

    scores.push({
      name: rust.name,
      type: 'rust',
      path: rust.path,
      coverage: null,
      coverageGap: cScore,
      sizeImpact: sScore,
      taskWeight: tScore,
      totalScore: total,
      openTaskCount: openTasks.length,
      openTasks: openTasks.map(t => t.id),
      recommendation: 'Add Rust unit tests — currently zero test coverage',
    });
  }

  // Score cross-cutting areas from backlog
  const crossCutting = ['livekit', 'gaming', 'community', 'platform', 'ai', 'protocol'];
  for (const area of crossCutting) {
    const openTasks = backlog.byModule[area] || [];
    if (openTasks.length === 0) continue;

    const tScore = taskScore(openTasks);
    scores.push({
      name: area,
      type: 'feature-area',
      path: '',
      coverage: null,
      coverageGap: 0,
      sizeImpact: 0,
      taskWeight: tScore,
      totalScore: tScore,
      openTaskCount: openTasks.length,
      openTasks: openTasks.map(t => t.id),
      recommendation: `${openTasks.length} open task(s) in backlog`,
    });
  }

  // Sort by total score descending
  scores.sort((a, b) => b.totalScore - a.totalScore);

  return scores;
}

function getRecommendation(coverage, openTasks, module) {
  const parts = [];

  if (coverage === null) {
    parts.push('No test coverage');
  } else if (coverage < 60) {
    parts.push(`Coverage critically low (${coverage.toFixed(1)}%)`);
  } else if (coverage < COVERAGE_TARGET) {
    parts.push(`Coverage below target (${coverage.toFixed(1)}% < ${COVERAGE_TARGET}%)`);
  }

  if (openTasks.length > 0) {
    const bugs = openTasks.filter(t => t.phase === 'bug');
    const reviews = openTasks.filter(t => t.phase === 'code-review');
    if (bugs.length > 0) parts.push(`${bugs.length} open bug(s)`);
    if (reviews.length > 0) parts.push(`${reviews.length} code review fix(es)`);
    if (parts.length === 0 || (bugs.length === 0 && reviews.length === 0)) {
      parts.push(`${openTasks.length} open task(s)`);
    }
  }

  if (module.sourceFiles > 15) {
    parts.push('Large module — high impact');
  }

  return parts.length > 0 ? parts.join('; ') : 'Good shape';
}
