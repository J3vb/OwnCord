/**
 * Terminal summary — prints a color-coded overview to stdout.
 */

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';

function covColor(pct) {
  if (pct === null || pct === undefined) return RED;
  if (pct >= 80) return GREEN;
  if (pct >= 60) return YELLOW;
  return RED;
}

function bar(pct, width = 20) {
  if (pct === null || pct === undefined) return `${RED}${'░'.repeat(width)}${RESET} ---`;
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const color = covColor(pct);
  return `${color}${'█'.repeat(filled)}${'░'.repeat(empty)}${RESET} ${pct.toFixed(1)}%`;
}

function divider(title) {
  const line = '─'.repeat(60);
  return `\n  ${CYAN}${BOLD}${title}${RESET}\n  ${DIM}${line}${RESET}`;
}

export function printTerminalSummary(modules, goCoverage, vitestCoverage, backlog, priorities) {
  console.log(divider('PROJECT OVERVIEW'));

  const total = backlog.openCount + backlog.doneCount;
  const pct = total > 0 ? ((backlog.doneCount / total) * 100).toFixed(1) : '0.0';
  console.log(`  ${WHITE}Tasks: ${GREEN}${backlog.doneCount} done${RESET} / ${YELLOW}${backlog.openCount} open${RESET} (${pct}% complete)`);
  console.log(`  ${WHITE}Files: ${modules.summary.goSourceFiles} Go + ${modules.summary.tsSourceFiles} TS + ${modules.summary.rustSourceFiles} Rust${RESET}`);
  console.log(`  ${WHITE}Tests: ${modules.summary.goTestFiles} Go + ${modules.summary.tsTestFiles} TS + ${modules.summary.rustTestFiles} Rust${RESET}`);

  // Go coverage
  console.log(divider('SERVER (GO) COVERAGE'));
  for (const pkg of modules.go) {
    const covData = goCoverage.packages?.[pkg.name];
    const cov = covData?.percentage ?? null;
    const name = `${pkg.name}/`.padEnd(16);
    const failed = covData?.failed ? ` ${RED}FAIL${RESET}` : '';
    console.log(`  ${WHITE}${name}${RESET} ${bar(cov)}${failed}`);
  }

  // TS coverage
  console.log(divider('CLIENT (TYPESCRIPT) COVERAGE'));
  const tsAreas = vitestCoverage.areas || {};
  const totalCov = tsAreas._total;
  if (totalCov) {
    console.log(`  ${WHITE}${'Overall'.padEnd(16)}${RESET} ${bar(totalCov.statements)}`);
  }
  for (const dir of modules.typescript.filter(d => d.type === 'typescript')) {
    const areaCov = tsAreas[dir.name];
    const cov = areaCov?.statements ?? null;
    const name = `${dir.name}/`.padEnd(16);
    console.log(`  ${WHITE}${name}${RESET} ${bar(cov)}`);
  }

  // Rust
  console.log(divider('CLIENT (RUST) STATUS'));
  for (const rust of modules.rust) {
    console.log(`  ${WHITE}${rust.sourceFiles} files, ${rust.sourceLines} lines${RESET} — ${RED}No test infrastructure${RESET}`);
  }

  // Where to work next
  console.log(divider('WHERE TO WORK NEXT (TOP 5)'));
  const top5 = priorities.slice(0, 5);
  top5.forEach((p, i) => {
    const num = `${i + 1}.`.padEnd(3);
    const name = p.name.padEnd(16);
    const cov = p.coverage !== null ? `${p.coverage.toFixed(0)}%`.padEnd(5) : '---  ';
    const tasks = p.openTaskCount > 0 ? `${YELLOW}${p.openTaskCount} task(s)${RESET}` : `${GREEN}0 tasks${RESET}`;
    console.log(`  ${CYAN}${num}${RESET} ${BOLD}${name}${RESET} ${covColor(p.coverage)}${cov}${RESET} ${tasks} — ${DIM}${p.recommendation}${RESET}`);
  });

  // Open bugs
  const bugs = backlog.byPhase['bug'] || [];
  if (bugs.length > 0) {
    console.log(divider('OPEN BUGS'));
    for (const bug of bugs) {
      console.log(`  ${RED}${bug.id}${RESET}: ${bug.description}`);
    }
  }

  // Code review items
  const reviews = backlog.byPhase['code-review'] || [];
  if (reviews.length > 0) {
    console.log(divider('CODE REVIEW FIXES'));
    for (const r of reviews) {
      console.log(`  ${YELLOW}${r.id}${RESET}: ${r.description}`);
    }
  }

  console.log(`\n  ${DIM}Full report: docs/brain/00-Overview/Project-Map.md${RESET}\n`);
}
