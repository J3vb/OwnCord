/**
 * Vitest coverage collector.
 * Runs vitest with coverage and parses the Istanbul coverage-final.json.
 * Caches results to .cache/vitest-coverage.json.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// Coverage data older than this is considered stale and gets a warning flag
const FRESHNESS_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const CACHE_FILE = 'vitest-coverage.json';

function computeFileCoverage(fileData) {
  const s = fileData.s || {};
  const b = fileData.b || {};
  const f = fileData.f || {};

  const stmtTotal = Object.keys(s).length;
  const stmtCovered = Object.values(s).filter(v => v > 0).length;

  let branchTotal = 0;
  let branchCovered = 0;
  for (const branches of Object.values(b)) {
    for (const count of branches) {
      branchTotal++;
      if (count > 0) branchCovered++;
    }
  }

  const fnTotal = Object.keys(f).length;
  const fnCovered = Object.values(f).filter(v => v > 0).length;

  return {
    statements: stmtTotal > 0 ? (stmtCovered / stmtTotal) * 100 : 100,
    branches: branchTotal > 0 ? (branchCovered / branchTotal) * 100 : 100,
    functions: fnTotal > 0 ? (fnCovered / fnTotal) * 100 : 100,
    stmtTotal,
    stmtCovered,
    branchTotal,
    branchCovered,
    fnTotal,
    fnCovered,
  };
}

function parseCoverageFinal(coverageJsonPath) {
  if (!existsSync(coverageJsonPath)) return {};

  const raw = JSON.parse(readFileSync(coverageJsonPath, 'utf8'));
  const byArea = {};
  let totalStmt = 0, totalStmtCov = 0;
  let totalBranch = 0, totalBranchCov = 0;
  let totalFn = 0, totalFnCov = 0;

  for (const [filePath, fileData] of Object.entries(raw)) {
    const normalized = filePath.replace(/\\/g, '/');
    const srcMatch = normalized.match(/src\/(\w+)\//);
    const area = srcMatch ? srcMatch[1] : 'other';

    const cov = computeFileCoverage(fileData);

    if (!byArea[area]) {
      byArea[area] = {
        files: 0,
        stmtTotal: 0, stmtCovered: 0,
        branchTotal: 0, branchCovered: 0,
        fnTotal: 0, fnCovered: 0,
      };
    }

    byArea[area].files++;
    byArea[area].stmtTotal += cov.stmtTotal;
    byArea[area].stmtCovered += cov.stmtCovered;
    byArea[area].branchTotal += cov.branchTotal;
    byArea[area].branchCovered += cov.branchCovered;
    byArea[area].fnTotal += cov.fnTotal;
    byArea[area].fnCovered += cov.fnCovered;

    totalStmt += cov.stmtTotal;
    totalStmtCov += cov.stmtCovered;
    totalBranch += cov.branchTotal;
    totalBranchCov += cov.branchCovered;
    totalFn += cov.fnTotal;
    totalFnCov += cov.fnCovered;
  }

  // Compute percentages
  const result = {};
  for (const [area, data] of Object.entries(byArea)) {
    result[area] = {
      files: data.files,
      statements: data.stmtTotal > 0 ? (data.stmtCovered / data.stmtTotal) * 100 : 100,
      branches: data.branchTotal > 0 ? (data.branchCovered / data.branchTotal) * 100 : 100,
      functions: data.fnTotal > 0 ? (data.fnCovered / data.fnTotal) * 100 : 100,
    };
  }

  result._total = {
    statements: totalStmt > 0 ? (totalStmtCov / totalStmt) * 100 : 0,
    branches: totalBranch > 0 ? (totalBranchCov / totalBranch) * 100 : 0,
    functions: totalFn > 0 ? (totalFnCov / totalFn) * 100 : 0,
  };

  return result;
}

export async function collectVitestCoverage(root, cacheDir, quick) {
  const cacheFile = resolve(cacheDir, CACHE_FILE);

  const clientDir = resolve(root, 'Client/tauri-client');

  if (quick && existsSync(cacheFile)) {
    console.log('  [TS] Using cached coverage data');
    let cached;
    try {
      cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    } catch {
      console.warn('  [TS] Corrupt cache — falling through to fresh collection');
      cached = null;
    }
    if (cached) {
      // Still evaluate freshness of the underlying coverage-final.json
      const coveragePath = resolve(clientDir, 'coverage/coverage-final.json');
      if (existsSync(coveragePath)) {
        try {
          const covStat = statSync(coveragePath);
          const ageMs = Date.now() - covStat.mtimeMs;
          if (ageMs > FRESHNESS_MAX_AGE_MS) {
            cached.stale = true;
            console.log(`  [TS] coverage-final.json is ${Math.round(ageMs / 3600000)}h old — flagging as stale`);
          }
        } catch { /* stat failed, leave stale flag as-is */ }
      }
      return cached;
    }
  }
  if (!existsSync(clientDir)) {
    console.log('  [TS] Client directory not found, skipping');
    return {};
  }

  // Check if coverage-final.json already exists (from a previous test run)
  const coveragePath = resolve(clientDir, 'coverage/coverage-final.json');
  let needsRun = !existsSync(coveragePath);
  let stale = false;

  // Check freshness — don't blindly trust old coverage data
  if (!needsRun) {
    try {
      const covStat = statSync(coveragePath);
      const ageMs = Date.now() - covStat.mtimeMs;
      if (ageMs > FRESHNESS_MAX_AGE_MS) {
        stale = true;
        console.log(`  [TS] coverage-final.json is ${Math.round(ageMs / 3600000)}h old — flagging as stale`);
        if (!quick) {
          needsRun = true; // Full mode re-runs stale coverage
        }
      }
    } catch { /* stat failed, treat as needing a run */ needsRun = true; }
  }

  if (needsRun && !quick) {
    console.log('  [TS] Running vitest with coverage (this may take a moment)...');
    try {
      execFileSync('npx', ['vitest', 'run', '--coverage'], {
        cwd: clientDir,
        encoding: 'utf8',
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      // vitest may exit non-zero but still produce coverage
    }
  } else if (!needsRun) {
    console.log('  [TS] Using existing coverage-final.json');
  }

  let coverageData = {};
  if (existsSync(coveragePath)) {
    coverageData = parseCoverageFinal(coveragePath);
  }

  // Get test count from a quick vitest --reporter=json run if available
  let testCount = 0;
  const reportPath = resolve(clientDir, 'coverage-report.json');
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      testCount = report.numTotalTests ?? 0;
    } catch { /* skip */ }
  }

  // Instead of running vitest again, count files from coverage data
  if (testCount === 0 && Object.keys(coverageData).length > 0) {
    try {
      const coverageJsonPath = resolve(clientDir, 'coverage', 'coverage-final.json');
      if (existsSync(coverageJsonPath)) {
        const raw = JSON.parse(readFileSync(coverageJsonPath, 'utf8'));
        testCount = Object.keys(raw).length;
      }
    } catch { /* keep testCount as 0 */ }
  }

  const result = {
    timestamp: new Date().toISOString(),
    areas: coverageData,
    testCount,
    stale,
  };

  writeFileSync(cacheFile, JSON.stringify(result, null, 2));
  console.log(`  [TS] Coverage collected for ${Object.keys(coverageData).length} areas, ${testCount} tests`);
  return result;
}
