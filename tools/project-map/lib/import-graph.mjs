/**
 * Import-graph builder — parses Go, TypeScript, and Rust source files to
 * construct a dependency graph with fan-in/fan-out metrics and cycle detection.
 * Zero external dependencies — Node built-ins only.
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, basename, relative } from 'node:path';

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Recursively collect files matching `extensions` under `dir`, skipping
 * common non-source directories.
 */
function collectFiles(dir, extensions, skipSuffix = []) {
  const results = [];
  if (!existsSync(dir)) return results;

  function walk(d) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ['node_modules', 'vendor', 'dist', 'target'].includes(entry.name)) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()
        && extensions.some(ext => entry.name.endsWith(ext))
        && !skipSuffix.some(suf => entry.name.endsWith(suf))) {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Go import parsing
// ---------------------------------------------------------------------------

const GO_MODULE_PREFIX = 'github.com/owncord/server/';

/**
 * Parse a single Go file and return the set of internal package short-names
 * it imports (e.g. "db", "auth", "ws").
 */
function parseGoImports(content) {
  const deps = new Set();
  // Match import blocks: import ( ... )
  const blockRe = /import\s*\(([^)]*)\)/gs;
  let blockMatch;
  while ((blockMatch = blockRe.exec(content)) !== null) {
    const block = blockMatch[1];
    const lineRe = /["']([^"']+)["']/g;
    let lineMatch;
    while ((lineMatch = lineRe.exec(block)) !== null) {
      const path = lineMatch[1];
      if (path.startsWith(GO_MODULE_PREFIX)) {
        deps.add(path.slice(GO_MODULE_PREFIX.length).split('/')[0]);
      }
    }
  }
  // Match single-line imports: import "..."
  const singleRe = /import\s+["']([^"']+)["']/g;
  let singleMatch;
  while ((singleMatch = singleRe.exec(content)) !== null) {
    const path = singleMatch[1];
    if (path.startsWith(GO_MODULE_PREFIX)) {
      deps.add(path.slice(GO_MODULE_PREFIX.length).split('/')[0]);
    }
  }
  return deps;
}

/**
 * Scan Go source files under `serverDir` and return a map of
 * package-name -> Set<dependency-package-name>.
 */
function scanGoImports(serverDir) {
  const graph = new Map();
  const files = collectFiles(serverDir, ['.go'], ['_test.go']);

  for (const file of files) {
    // Determine package from directory name relative to server root
    const rel = relative(serverDir, file);
    const pkg = rel.includes('/') || rel.includes('\\')
      ? rel.split(/[/\\]/)[0]
      : '.'; // root-level files (main.go etc.)

    if (pkg === '.' || pkg === 'scripts' || pkg === 'migrations') continue;

    if (!graph.has(pkg)) graph.set(pkg, new Set());

    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }

    const deps = parseGoImports(content);
    const existing = graph.get(pkg);
    for (const dep of deps) {
      if (dep !== pkg) existing.add(dep);
    }
  }

  return graph;
}

// ---------------------------------------------------------------------------
// TypeScript import parsing
// ---------------------------------------------------------------------------

/** Known TS path-alias prefixes that map to source directories. */
const TS_ALIAS_MAP = {
  '@lib': 'lib',
  '@stores': 'stores',
  '@components': 'components',
  '@pages': 'pages',
  '@styles': 'styles',
  '@types': 'types',
};

/**
 * Parse a TypeScript file and return the set of internal module names it
 * imports (e.g. "lib", "stores", "components").
 */
function parseTsImports(content) {
  const deps = new Set();

  // Match: import ... from '...' / import '...' (including type imports)
  const re = /import\s+(?:type\s+)?(?:[^'"]*from\s+)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const specifier = m[1];

    // Check @alias paths: @lib/foo -> "lib"
    for (const [alias, dir] of Object.entries(TS_ALIAS_MAP)) {
      if (specifier.startsWith(alias + '/') || specifier === alias) {
        deps.add(dir);
        break;
      }
    }

    // Check relative paths: ../lib/foo -> "lib", ./sibling stays in same dir
    if (specifier.startsWith('../')) {
      const segment = specifier.slice(3).split('/')[0];
      if (segment && Object.values(TS_ALIAS_MAP).includes(segment)) {
        deps.add(segment);
      }
    }
  }

  return deps;
}

/**
 * Determine which TS "module" a file belongs to based on its directory.
 * Files directly in src/ are grouped as "main".
 */
function tsModuleName(file, srcDir) {
  const rel = relative(srcDir, file).replace(/\\/g, '/');
  const parts = rel.split('/');
  if (parts.length === 1) return basename(parts[0], '.ts'); // top-level file -> its name
  return parts[0]; // first directory segment
}

/**
 * Scan TypeScript files under `srcDir` and return a dependency map.
 */
function scanTsImports(srcDir) {
  const graph = new Map();
  const files = collectFiles(srcDir, ['.ts']);

  for (const file of files) {
    const mod = tsModuleName(file, srcDir);
    if (!graph.has(mod)) graph.set(mod, new Set());

    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }

    const deps = parseTsImports(content);
    const existing = graph.get(mod);
    for (const dep of deps) {
      if (dep !== mod) existing.add(dep);
    }
  }

  return graph;
}

// ---------------------------------------------------------------------------
// Rust import parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Rust file and return module names referenced via `mod` declarations
 * and `use crate::` paths.
 */
function parseRustImports(content) {
  const deps = new Set();

  // mod declarations: mod foo;
  const modRe = /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm;
  let m;
  while ((m = modRe.exec(content)) !== null) {
    deps.add(m[1]);
  }

  // use crate::foo (possibly ::bar::baz)
  const useRe = /use\s+crate::(\w+)/g;
  while ((m = useRe.exec(content)) !== null) {
    deps.add(m[1]);
  }

  return deps;
}

/**
 * Determine Rust module name from filename.
 * lib.rs and main.rs -> "lib" / "main"; others -> stem.
 */
function rustModuleName(file) {
  const name = basename(file, '.rs');
  return name;
}

/**
 * Scan Rust files and return a dependency map.
 */
function scanRustImports(rustDir) {
  const graph = new Map();
  const files = collectFiles(rustDir, ['.rs']);

  for (const file of files) {
    const mod = rustModuleName(file);
    if (!graph.has(mod)) graph.set(mod, new Set());

    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }

    const deps = parseRustImports(content);
    const existing = graph.get(mod);
    for (const dep of deps) {
      if (dep !== mod) existing.add(dep);
    }
  }

  return graph;
}

// ---------------------------------------------------------------------------
// Graph analysis
// ---------------------------------------------------------------------------

/**
 * Merge multiple per-language graphs into a single adjacency list (object).
 * Each value is a Map<moduleName, Set<dep>>; we also track which language
 * each module belongs to.
 */
function mergeGraphs(goGraph, tsGraph, rustGraph) {
  const merged = {};    // module -> string[]
  const types = {};     // module -> 'go' | 'typescript' | 'rust'

  for (const [mod, deps] of goGraph) {
    const key = `go/${mod}`;
    merged[key] = [...deps].map(d => `go/${d}`);
    types[key] = 'go';
  }
  for (const [mod, deps] of tsGraph) {
    const key = `ts/${mod}`;
    merged[key] = [...deps].map(d => `ts/${d}`);
    types[key] = 'typescript';
  }
  for (const [mod, deps] of rustGraph) {
    const key = `rs/${mod}`;
    merged[key] = [...deps].map(d => `rs/${d}`);
    types[key] = 'rust';
  }

  return { merged, types };
}

/**
 * Compute fan-in (how many modules depend on this one) and fan-out (how many
 * modules this one depends on).
 */
function computeMetrics(graph) {
  const fanIn = {};
  const fanOut = {};

  for (const mod of Object.keys(graph)) {
    fanOut[mod] = graph[mod].length;
    if (!(mod in fanIn)) fanIn[mod] = 0;
    for (const dep of graph[mod]) {
      fanIn[dep] = (fanIn[dep] || 0) + 1;
    }
  }

  return { fanIn, fanOut };
}

/**
 * Detect all cycles in the directed graph using iterative DFS with an
 * explicit stack to avoid call-stack overflow on large graphs.
 * Returns an array of cycles, each cycle being an array of module names.
 */
function detectCycles(graph) {
  const WHITE = 0; // unvisited
  const GRAY = 1;  // in current path
  const BLACK = 2; // fully explored

  const color = {};
  for (const node of Object.keys(graph)) {
    color[node] = WHITE;
  }

  const cycles = [];

  for (const start of Object.keys(graph)) {
    if (color[start] !== WHITE) continue;

    // Stack entries: [node, neighborIndex, pathSoFar]
    const stack = [[start, 0, [start]]];
    color[start] = GRAY;

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const node = top[0];
      const neighbors = graph[node] || [];

      if (top[1] >= neighbors.length) {
        // All neighbors explored — backtrack
        color[node] = BLACK;
        stack.pop();
        continue;
      }

      const neighbor = neighbors[top[1]];
      top[1]++;

      if (color[neighbor] === GRAY) {
        // Found a cycle — extract the cycle portion from the current path
        const fullPath = [...top[2], neighbor];
        const cycleStart = fullPath.indexOf(neighbor);
        if (cycleStart !== -1 && cycleStart < fullPath.length - 1) {
          cycles.push(fullPath.slice(cycleStart));
        }
      } else if (color[neighbor] === WHITE) {
        color[neighbor] = GRAY;
        stack.push([neighbor, 0, [...top[2], neighbor]]);
      }
    }
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build the full import graph for the OwnCord project.
 *
 * @param {string} root       — project root directory
 * @param {string} cacheDir   — directory for caching results
 * @param {boolean} quick     — if true, return cached results when available
 * @returns {Promise<object>} — import graph data
 */
export async function buildImportGraph(root, cacheDir, quick) {
  const cacheFile = join(cacheDir, 'import-graph.json');

  // Quick mode: return cache if it exists
  if (quick && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
      return cached;
    } catch {
      // Cache corrupt — rebuild
    }
  }

  // Scan each language
  const serverDir = resolve(root, 'Server');
  const tsSrcDir = resolve(root, 'Client', 'tauri-client', 'src');
  const rustDir = resolve(root, 'Client', 'tauri-client', 'src-tauri', 'src');

  const goGraph = scanGoImports(serverDir);
  const tsGraph = scanTsImports(tsSrcDir);
  const rustGraph = scanRustImports(rustDir);

  // Merge into unified adjacency list
  const { merged, types } = mergeGraphs(goGraph, tsGraph, rustGraph);

  // Compute metrics
  const { fanIn, fanOut } = computeMetrics(merged);

  // Build nodes array
  const nodes = Object.keys(merged).map(mod => {
    const fi = fanIn[mod] || 0;
    const fo = fanOut[mod] || 0;
    return {
      name: mod,
      type: types[mod] || 'go',
      fanIn: fi,
      fanOut: fo,
      coupling: fi * fo,
    };
  });

  // Also include nodes that appear only as dependencies (no outgoing edges)
  for (const mod of Object.keys(fanIn)) {
    if (!(mod in merged)) {
      const fi = fanIn[mod] || 0;
      nodes.push({
        name: mod,
        type: types[mod] || inferType(mod),
        fanIn: fi,
        fanOut: 0,
        coupling: 0,
      });
    }
  }

  // Build edges array
  const edges = [];
  for (const [from, deps] of Object.entries(merged)) {
    for (const to of deps) {
      edges.push({ from, to });
    }
  }

  // Detect cycles
  const cycles = detectCycles(merged);

  // Top 5 most coupled
  const mostCoupled = [...nodes]
    .sort((a, b) => b.coupling - a.coupling)
    .slice(0, 5)
    .map(({ name, coupling, fanIn, fanOut }) => ({ name, coupling, fanIn, fanOut }));

  const result = {
    timestamp: new Date().toISOString(),
    graph: merged,
    nodes,
    edges,
    cycles,
    mostCoupled,
  };

  // Write cache
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8');
  } catch {
    // Non-fatal — proceed without caching
  }

  return result;
}

/**
 * Infer language type from a prefixed module name.
 */
function inferType(mod) {
  if (mod.startsWith('go/')) return 'go';
  if (mod.startsWith('ts/')) return 'typescript';
  if (mod.startsWith('rs/')) return 'rust';
  return 'go';
}
