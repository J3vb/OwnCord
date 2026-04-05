/**
 * Module scanner — discovers Go packages, TypeScript directories, and Rust files.
 * Returns a structured inventory of the project.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

function scanDir(dir, extensions, recursive = true) {
  let fileCount = 0;
  let lineCount = 0;

  function walk(d) {
    if (!existsSync(d)) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'vendor' || entry.name === 'dist' || entry.name === 'target') continue;
      const full = join(d, entry.name);
      if (entry.isDirectory() && recursive) {
        walk(full);
      } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
        fileCount++;
        try {
          lineCount += readFileSync(full, 'utf8').split('\n').length;
        } catch { /* skip */ }
      }
    }
  }
  walk(dir);
  return { fileCount, lineCount };
}

function scanGoDir(dir, name, pathPrefix) {
  const source = scanDir(dir, ['.go'], false);
  const testSource = { fileCount: 0, lineCount: 0 };

  try {
    for (const f of readdirSync(dir)) {
      if (f.endsWith('_test.go')) {
        testSource.fileCount++;
        try {
          testSource.lineCount += readFileSync(join(dir, f), 'utf8').split('\n').length;
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  const srcFiles = source.fileCount - testSource.fileCount;
  const srcLines = source.lineCount - testSource.lineCount;

  if (srcFiles > 0 || testSource.fileCount > 0) {
    return {
      name,
      type: 'go',
      path: pathPrefix,
      sourceFiles: srcFiles,
      sourceLines: srcLines,
      testFiles: testSource.fileCount,
      testLines: testSource.lineCount,
    };
  }
  return null;
}

function scanGoPackages(serverDir) {
  const packages = [];
  if (!existsSync(serverDir)) return packages;

  // Scan root-level Go files (main.go, etc.)
  const rootPkg = scanGoDir(serverDir, 'server-root', 'Server');
  if (rootPkg) packages.push(rootPkg);

  // Scan subdirectory packages
  for (const entry of readdirSync(serverDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'vendor') continue;
    const pkg = scanGoDir(join(serverDir, entry.name), entry.name, `Server/${entry.name}`);
    if (pkg) packages.push(pkg);
  }
  return packages;
}

function scanTSDirectories(clientSrcDir) {
  const dirs = [];
  if (!existsSync(clientSrcDir)) return dirs;

  const scanAreas = ['lib', 'stores', 'components', 'pages', 'styles'];
  for (const area of scanAreas) {
    const areaDir = join(clientSrcDir, area);
    if (!existsSync(areaDir)) continue;
    const source = scanDir(areaDir, ['.ts', '.tsx', '.js', '.jsx'], true);
    dirs.push({
      name: area,
      type: 'typescript',
      path: `Client/tauri-client/src/${area}`,
      sourceFiles: source.fileCount,
      sourceLines: source.lineCount,
      testFiles: 0, // tests are in a separate dir
      testLines: 0,
    });
  }

  // Count test files
  const testDir = resolve(clientSrcDir, '../tests');
  if (existsSync(testDir)) {
    for (const subdir of ['unit', 'integration']) {
      const td = join(testDir, subdir);
      if (!existsSync(td)) continue;
      const tests = scanDir(td, ['.ts', '.tsx', '.test.ts', '.test.tsx', '.spec.ts'], true);
      dirs.push({
        name: `tests/${subdir}`,
        type: 'typescript-tests',
        path: `Client/tauri-client/tests/${subdir}`,
        sourceFiles: 0,
        sourceLines: 0,
        testFiles: tests.fileCount,
        testLines: tests.lineCount,
      });
    }

    // E2E tests
    const e2eDir = join(testDir, 'e2e');
    if (existsSync(e2eDir)) {
      const e2e = scanDir(e2eDir, ['.ts', '.spec.ts'], true);
      dirs.push({
        name: 'tests/e2e',
        type: 'e2e-tests',
        path: `Client/tauri-client/tests/e2e`,
        sourceFiles: 0,
        sourceLines: 0,
        testFiles: e2e.fileCount,
        testLines: e2e.lineCount,
      });
    }
  }

  return dirs;
}

function scanRustFiles(rustDir) {
  if (!existsSync(rustDir)) return [];
  const source = scanDir(rustDir, ['.rs'], true);
  const testCount = (() => {
    let count = 0;
    function walk(d) {
      try {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('_test.rs') || entry.name === 'tests.rs') count++;
          else if (entry.name.endsWith('.rs')) {
            // Check for #[cfg(test)] inside the file
            try {
              const content = readFileSync(full, 'utf8');
              if (content.includes('#[cfg(test)]')) count++;
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    }
    walk(rustDir);
    return count;
  })();

  return [{
    name: 'tauri-rust',
    type: 'rust',
    path: 'Client/tauri-client/src-tauri/src',
    sourceFiles: source.fileCount,
    sourceLines: source.lineCount,
    testFiles: testCount,
    testLines: 0,
  }];
}

export async function scanModules(root) {
  const serverDir = resolve(root, 'Server');
  const clientSrcDir = resolve(root, 'Client/tauri-client/src');
  const rustDir = resolve(root, 'Client/tauri-client/src-tauri/src');

  const goPackages = scanGoPackages(serverDir);
  const tsDirectories = scanTSDirectories(clientSrcDir);
  const rustFiles = scanRustFiles(rustDir);

  return {
    go: goPackages,
    typescript: tsDirectories,
    rust: rustFiles,
    summary: {
      goPackages: goPackages.length,
      goSourceFiles: goPackages.reduce((s, p) => s + p.sourceFiles, 0),
      goTestFiles: goPackages.reduce((s, p) => s + p.testFiles, 0),
      tsSourceFiles: tsDirectories.filter(d => d.type === 'typescript').reduce((s, d) => s + d.sourceFiles, 0),
      tsTestFiles: tsDirectories.filter(d => d.type !== 'typescript').reduce((s, d) => s + d.testFiles, 0),
      rustSourceFiles: rustFiles.reduce((s, r) => s + r.sourceFiles, 0),
      rustTestFiles: rustFiles.reduce((s, r) => s + r.testFiles, 0),
    },
  };
}
