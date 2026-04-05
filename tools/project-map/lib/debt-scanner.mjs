import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, sep, posix } from 'node:path';

const MARKER_RE = /\b(TODO|FIXME|HACK|XXX)\b[:\s]*(.*)/i;

const SCAN_DIRS = [
  { dir: 'Server', ext: '.go', skipFile: '_test.go', skipDirs: ['vendor'] },
  { dir: 'Client/tauri-client/src', ext: '.ts', skipFile: null, skipDirs: ['node_modules', 'dist'] },
  { dir: 'Client/tauri-client/src-tauri/src', ext: '.rs', skipFile: null, skipDirs: ['target'] },
];

const LARGE_FILE_WARNING = 400;
const LARGE_FILE_CRITICAL = 800;
const LONG_FUNCTION_LINES = 50;
const DEEP_NESTING_THRESHOLD = 4;

/**
 * Recursively collect files matching an extension, skipping specified directories.
 */
async function collectFiles(base, ext, skipFile, skipDirs) {
  const results = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(ext)) {
        if (skipFile && entry.name.endsWith(skipFile)) continue;
        results.push(join(dir, entry.name));
      }
    }
  }

  await walk(base);
  return results;
}

/**
 * Derive the module name from a file path relative to root.
 */
function getModule(relPath) {
  const parts = relPath.split(/[/\\]/);

  // Server/{package}/file.go -> package name
  if (parts[0] === 'Server' && parts.length >= 2) {
    return parts.length >= 3 ? parts[1] : 'server-root';
  }

  // Client/tauri-client/src-tauri/src/file.rs -> "tauri-rust"
  if (
    parts[0] === 'Client' &&
    parts[1] === 'tauri-client' &&
    parts[2] === 'src-tauri'
  ) {
    return 'tauri-rust';
  }

  // Client/tauri-client/src/{area}/file.ts -> area name
  if (
    parts[0] === 'Client' &&
    parts[1] === 'tauri-client' &&
    parts[2] === 'src'
  ) {
    return parts.length >= 5 ? parts[3] : 'client-root';
  }

  return 'unknown';
}

/**
 * Normalize path to forward slashes for consistent output.
 */
function normalizePath(p) {
  return p.split(sep).join(posix.sep);
}

/**
 * Detect long functions via brace-depth tracking.
 * Returns array of { line, name, lines }.
 */
function detectLongFunctions(content, ext) {
  const lines = content.split('\n');
  const functions = [];

  // Stack: { name, startLine, depth }
  let current = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Detect function start
    let funcName = null;

    if (ext === '.go') {
      const match = trimmed.match(/^func\s+(?:\([^)]*\)\s*)?(\w+)/);
      if (match) funcName = match[1];
    } else if (ext === '.ts') {
      // Named function declaration
      const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (fnMatch) {
        funcName = fnMatch[1];
      } else {
        // Arrow function: const name = (...) => {
        const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])*=>\s*\{/);
        if (arrowMatch) {
          funcName = arrowMatch[1];
        }
      }
    } else if (ext === '.rs') {
      const match = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
      if (match) funcName = match[1];
    }

    if (funcName && current === null) {
      current = { name: funcName, startLine: i + 1, depth: braceDepth };
    }

    // Track braces
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }
    if (braceDepth < 0) braceDepth = 0;

    // Check if current function has ended
    if (current !== null && braceDepth <= current.depth) {
      const funcLines = (i + 1) - current.startLine + 1;
      if (funcLines > LONG_FUNCTION_LINES) {
        functions.push({
          line: current.startLine,
          name: current.name,
          lines: funcLines,
        });
      }
      current = null;
    }
  }

  return functions;
}

/**
 * Scan a single file for all debt indicators.
 */
function scanFile(content, relPath, ext) {
  const lines = content.split('\n');
  const mod = getModule(relPath);
  const file = normalizePath(relPath);

  const markers = [];
  const deepNesting = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Marker detection
    const markerMatch = line.match(MARKER_RE);
    if (markerMatch) {
      markers.push({
        type: markerMatch[1].toUpperCase(),
        file,
        line: i + 1,
        text: markerMatch[2].trim(),
        module: mod,
      });
    }

    // Deep nesting detection
    const leadingSpaces = line.match(/^(\s*)/)[1];
    const tabCount = (leadingSpaces.match(/\t/g) || []).length;
    const spaceCount = leadingSpaces.replace(/\t/g, '').length;
    const depth = tabCount + Math.floor(spaceCount / 4);

    if (depth >= DEEP_NESTING_THRESHOLD && line.trim().length > 0) {
      deepNesting.push({
        file,
        line: i + 1,
        depth,
        module: mod,
      });
    }
  }

  // Large file detection
  let largeFile = null;
  if (lines.length > LARGE_FILE_WARNING) {
    largeFile = {
      file,
      lines: lines.length,
      module: mod,
      severity: lines.length > LARGE_FILE_CRITICAL ? 'critical' : 'warning',
    };
  }

  // Long function detection
  const longFunctions = detectLongFunctions(content, ext).map((f) => ({
    file,
    line: f.line,
    name: f.name,
    lines: f.lines,
    module: mod,
  }));

  return { markers, largeFile, longFunctions, deepNesting };
}

/**
 * Scan the codebase for technical debt indicators.
 *
 * @param {string} root - Absolute path to the repository root
 * @param {string} cacheDir - Directory to store cached results
 * @param {boolean} quick - If true and cache exists, return cached data
 * @returns {Promise<object>} Technical debt report
 */
export async function scanTechnicalDebt(root, cacheDir, quick) {
  const cachePath = join(cacheDir, 'debt-data.json');

  if (quick) {
    try {
      const cached = await readFile(cachePath, 'utf-8');
      return JSON.parse(cached);
    } catch {
      // Cache miss, proceed with full scan
    }
  }

  const allMarkers = [];
  const allLargeFiles = [];
  const allLongFunctions = [];
  let allDeepNesting = [];

  for (const { dir, ext, skipFile, skipDirs } of SCAN_DIRS) {
    const baseDir = join(root, ...dir.split('/'));
    const files = await collectFiles(baseDir, ext, skipFile, skipDirs);

    for (const filePath of files) {
      let content;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        continue;
      }

      const relPath = relative(root, filePath);
      const result = scanFile(content, relPath, ext);

      allMarkers.push(...result.markers);
      if (result.largeFile) allLargeFiles.push(result.largeFile);
      allLongFunctions.push(...result.longFunctions);
      allDeepNesting.push(...result.deepNesting);
    }
  }

  // Keep only top 20 deepest nesting instances
  allDeepNesting.sort((a, b) => b.depth - a.depth);
  allDeepNesting = allDeepNesting.slice(0, 20);

  // Build per-module summary
  const byModule = {};
  const ensureModule = (mod) => {
    if (!byModule[mod]) {
      byModule[mod] = { markers: 0, largeFiles: 0, longFunctions: 0 };
    }
  };

  for (const m of allMarkers) {
    ensureModule(m.module);
    byModule[m.module].markers++;
  }
  for (const f of allLargeFiles) {
    ensureModule(f.module);
    byModule[f.module].largeFiles++;
  }
  for (const f of allLongFunctions) {
    ensureModule(f.module);
    byModule[f.module].longFunctions++;
  }

  const report = {
    timestamp: new Date().toISOString(),
    markers: allMarkers,
    largeFiles: allLargeFiles,
    longFunctions: allLongFunctions,
    deepNesting: allDeepNesting,
    summary: {
      totalMarkers: allMarkers.length,
      totalLargeFiles: allLargeFiles.length,
      totalLongFunctions: allLongFunctions.length,
      byModule,
    },
  };

  // Write cache
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachePath, JSON.stringify(report, null, 2), 'utf-8');
  } catch {
    // Non-fatal: cache write failure is acceptable
  }

  return report;
}
