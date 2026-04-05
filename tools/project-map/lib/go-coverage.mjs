/**
 * Go test coverage collector.
 * Runs `go test ./... -cover -short -json` and parses per-package coverage.
 * Caches results to .cache/go-coverage.json.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CACHE_FILE = 'go-coverage.json';

// Extract short package name from full Go module path
// e.g. "github.com/owncord/server/admin" -> "admin"
// e.g. "github.com/owncord/server" -> "root"
function extractPkgName(fullPath) {
  const parts = fullPath.split('/');
  const last = parts[parts.length - 1];
  // If the package ends with "server" it's the root package
  if (last === 'server') return 'server-root';
  return last;
}

function parseGoCoverage(jsonLines) {
  const coverage = {};

  for (const line of jsonLines.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      // Look for coverage output lines
      if (entry.Action === 'output' && entry.Output) {
        // Match: "coverage: 67.3% of statements"
        const coverMatch = entry.Output.match(/coverage:\s+([\d.]+)%\s+of\s+statements/);
        if (coverMatch && entry.Package) {
          const pkg = extractPkgName(entry.Package);
          coverage[pkg] = {
            percentage: parseFloat(coverMatch[1]),
            package: pkg,
          };
        }
        // Match: "[no test files]"
        if (entry.Output.includes('[no test files]') && entry.Package) {
          const pkg = extractPkgName(entry.Package);
          coverage[pkg] = {
            percentage: null,
            package: pkg,
            noTests: true,
          };
        }
      }
      // Also check for pass/fail
      if (entry.Action === 'pass' && entry.Package) {
        const pkg = extractPkgName(entry.Package);
        if (!coverage[pkg]) {
          coverage[pkg] = { percentage: 0, package: pkg };
        }
        coverage[pkg].passed = true;
      }
      if (entry.Action === 'fail' && entry.Package) {
        const pkg = extractPkgName(entry.Package);
        if (!coverage[pkg]) {
          coverage[pkg] = { percentage: 0, package: pkg };
        }
        coverage[pkg].failed = true;
      }
    } catch { /* skip non-JSON lines */ }
  }

  return coverage;
}

export async function collectGoCoverage(root, cacheDir, quick) {
  const cacheFile = resolve(cacheDir, CACHE_FILE);

  if (quick && existsSync(cacheFile)) {
    console.log('  [Go] Using cached coverage data');
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (cached.hasFailures) {
        console.warn('  [Go Coverage] Cached data has test failures — re-running tests');
        // Fall through to full collection instead of returning cached
      } else {
        return cached;
      }
    } catch {
      console.warn('  [Go] Corrupt cache — re-running tests');
    }
  }

  const serverDir = resolve(root, 'Server');
  if (!existsSync(serverDir)) {
    console.log('  [Go] Server directory not found, skipping');
    return {};
  }

  console.log('  [Go] Running tests with coverage (this may take a minute)...');
  try {
    const output = execFileSync('go', ['test', './...', '-cover', '-short', '-json', '-count=1'], {
      cwd: serverDir,
      encoding: 'utf8',
      timeout: 300_000, // 5 min
      maxBuffer: 10 * 1024 * 1024,
    });

    const coverage = parseGoCoverage(output);

    // Cache results
    const result = {
      timestamp: new Date().toISOString(),
      packages: coverage,
    };
    writeFileSync(cacheFile, JSON.stringify(result, null, 2));
    console.log(`  [Go] Coverage collected for ${Object.keys(coverage).length} packages`);
    return result;
  } catch (err) {
    // go test returns non-zero on test failure but still produces output
    if (err.stdout) {
      const coverage = parseGoCoverage(err.stdout);
      const result = {
        timestamp: new Date().toISOString(),
        packages: coverage,
        hasFailures: true,
      };
      writeFileSync(cacheFile, JSON.stringify(result, null, 2));
      console.log(`  [Go] Coverage collected (some tests failed)`);
      return result;
    }
    console.error(`  [Go] Failed to collect coverage: ${err.message}`);
    return { timestamp: new Date().toISOString(), packages: {}, error: err.message };
  }
}
