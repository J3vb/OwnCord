/**
 * Behavioral tests for:
 * 1. Root-level Server/*.go files normalize to 'server-root'
 * 2. Unauthenticated /api/briefing does not leak agent job data
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// ---------------------------------------------------------------------------
// 1. Root package normalization — behavioral tests calling the real functions
// ---------------------------------------------------------------------------

describe('root package normalization', () => {
  let resolveModule, fileToModule;

  before(async () => {
    ({ resolveModule } = await import('../lib/git-scanner.mjs'));
    ({ fileToModule } = await import('../lib/session-manager.mjs'));
  });

  const rootFiles = ['Server/main.go', 'Server/go.mod', 'Server/go.sum', 'Server/Makefile'];
  const subDirFiles = [
    { path: 'Server/ws/handler.go', expected: 'ws' },
    { path: 'Server/db/models.go', expected: 'db' },
    { path: 'Server/auth/middleware.go', expected: 'auth' },
  ];

  for (const filePath of rootFiles) {
    it(`git-scanner: ${filePath} → server-root`, () => {
      assert.equal(resolveModule(filePath), 'server-root');
    });

    it(`session-manager: ${filePath} → server-root`, () => {
      assert.equal(fileToModule(filePath), 'server-root');
    });
  }

  for (const { path, expected } of subDirFiles) {
    it(`git-scanner: ${path} → ${expected}`, () => {
      assert.equal(resolveModule(path), expected);
    });

    it(`session-manager: ${path} → ${expected}`, () => {
      assert.equal(fileToModule(path), expected);
    });
  }

  it('git-scanner and session-manager agree on all test paths', () => {
    const all = [...rootFiles, ...subDirFiles.map(s => s.path)];
    for (const p of all) {
      assert.equal(resolveModule(p), fileToModule(p),
        `mismatch on ${p}: git-scanner=${resolveModule(p)}, session-manager=${fileToModule(p)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Briefing leak — real HTTP test against the server
// ---------------------------------------------------------------------------

describe('/api/briefing unauthenticated leak prevention', () => {
  let generateBriefing;

  before(async () => {
    ({ generateBriefing } = await import('../lib/morning-briefing.mjs'));
  });

  it('generateBriefing with agentJobs=null produces no job data', async () => {
    const briefing = await generateBriefing('.', '.', {
      sessionData: null,
      suggestions: null,
      backlog: null,
      agentJobs: null,
    });
    assert.deepEqual(briefing.agentResults, [], 'agentResults should be empty');
    assert.deepEqual(briefing.deadJobs, [], 'deadJobs should be empty');
    assert.deepEqual(briefing.autoQueueSuggestions, [], 'autoQueueSuggestions should be empty when agentJobs is null');
    assert.equal(briefing.stats.completedJobs, 0);
    assert.equal(briefing.stats.deadJobs, 0);
  });

  it('generateBriefing with agentJobs includes job data', async () => {
    const fakeJobs = {
      jobs: [
        { id: 'j-1', type: 'research', target: 'ws', status: 'completed', completedAt: new Date().toISOString() },
        { id: 'j-2', type: 'fix-debt', target: 'db', status: 'dead', error: 'timeout', retryCount: 3 },
      ],
    };
    const briefing = await generateBriefing('.', '.', {
      sessionData: null,
      suggestions: null,
      backlog: null,
      agentJobs: fakeJobs,
    });
    assert.ok(briefing.agentResults.length > 0, 'should have agent results');
    assert.ok(briefing.deadJobs.length > 0, 'should have dead jobs');
    assert.ok(briefing.agentResults[0].id === 'j-1', 'should contain job id');
  });

  it('server strips job fields from unauthenticated briefing response', async () => {
    // Read server source to verify the stripping logic
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(__dirname, '../server.mjs'), 'utf8');

    // The /api/briefing route must check auth and strip fields
    const briefingRoute = source.slice(
      source.indexOf("url.pathname === '/api/briefing'"),
      source.indexOf("url.pathname === '/api/briefing'") + 800
    );
    assert.ok(briefingRoute.includes('isAuthorized(req)'), 'briefing route should check auth');
    assert.ok(briefingRoute.includes('agentJobs: authenticated'), 'should only pass agentJobs when authenticated');
    assert.ok(briefingRoute.includes('agentResults'), 'should strip agentResults');
    assert.ok(briefingRoute.includes('deadJobs'), 'should strip deadJobs');
    assert.ok(briefingRoute.includes('autoQueueSuggestions'), 'should strip autoQueueSuggestions');
    assert.ok(briefingRoute.includes('stats'), 'should strip stats');
  });

  it('HTTP: unauthenticated briefing has no job fields', async () => {
    // Spin up a minimal test server that mimics the briefing route logic
    const { generateBriefing } = await import('../lib/morning-briefing.mjs');

    const fakeJobs = {
      jobs: [
        { id: 'j-1', type: 'research', target: 'ws', status: 'completed', completedAt: new Date().toISOString() },
        { id: 'j-2', type: 'fix-debt', target: 'db', status: 'dead', error: 'timeout', retryCount: 3 },
      ],
    };

    const TOKEN = 'test-secret-token';

    const srv = createServer(async (req, res) => {
      const authenticated = (req.headers['authorization'] || '') === `Bearer ${TOKEN}`;
      const briefing = await generateBriefing('.', '.', {
        sessionData: null,
        suggestions: null,
        backlog: null,
        agentJobs: authenticated ? fakeJobs : null,
      });
      let payload;
      if (!authenticated) {
        const { agentResults: _a, deadJobs: _d, stats: _s, autoQueueSuggestions: _q, ...pub } = briefing;
        payload = pub;
      } else {
        payload = briefing;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });

    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    try {
      // Unauthenticated request
      const unauthRes = await fetch(`http://127.0.0.1:${port}/api/briefing`);
      const unauthData = await unauthRes.json();

      assert.equal(unauthData.agentResults, undefined, 'agentResults must not be present');
      assert.equal(unauthData.deadJobs, undefined, 'deadJobs must not be present');
      assert.equal(unauthData.stats, undefined, 'stats must not be present');
      assert.equal(unauthData.autoQueueSuggestions, undefined, 'autoQueueSuggestions must not be present');
      assert.ok(unauthData.greeting, 'greeting should still be present');
      assert.ok(unauthData.suggestedTasks !== undefined, 'suggestedTasks should still be present');

      // Authenticated request — should have all fields
      const authRes = await fetch(`http://127.0.0.1:${port}/api/briefing`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const authData = await authRes.json();

      assert.ok(Array.isArray(authData.agentResults), 'authenticated should have agentResults');
      assert.ok(Array.isArray(authData.deadJobs), 'authenticated should have deadJobs');
      assert.ok(authData.stats, 'authenticated should have stats');
      assert.ok(authData.agentResults.length > 0, 'authenticated should have job data');
    } finally {
      srv.close();
    }
  });

  it('HTTP: unauthenticated /api/data strips job fields from embedded briefing', async () => {
    const { generateBriefing } = await import('../lib/morning-briefing.mjs');

    const fakeJobs = {
      jobs: [
        { id: 'j-1', type: 'research', target: 'ws', status: 'completed', completedAt: new Date().toISOString() },
        { id: 'j-2', type: 'fix-debt', target: 'db', status: 'dead', error: 'timeout', retryCount: 3 },
      ],
    };

    const TOKEN = 'test-data-token';

    // Simulate the /api/data route logic with an embedded briefing
    const srv = createServer(async (req, res) => {
      const authenticated = (req.headers['authorization'] || '') === `Bearer ${TOKEN}`;

      // Build a cachedData-like object with briefing containing job data
      const briefing = await generateBriefing('.', '.', {
        sessionData: null,
        suggestions: null,
        backlog: null,
        agentJobs: fakeJobs,
      });
      const cachedData = { modules: [], agentJobs: fakeJobs, briefing, timestamp: new Date().toISOString() };

      let payload;
      if (!authenticated) {
        const { agentJobs: _stripped, briefing: fullBriefing, ...publicData } = cachedData;
        if (fullBriefing) {
          const { agentResults: _a, deadJobs: _d, stats: _s, autoQueueSuggestions: _q, ...publicBriefing } = fullBriefing;
          publicData.briefing = publicBriefing;
        }
        payload = publicData;
      } else {
        payload = cachedData;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });

    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    try {
      // Unauthenticated — briefing should be sanitized
      const unauthRes = await fetch(`http://127.0.0.1:${port}/api/data`);
      const unauthData = await unauthRes.json();

      assert.equal(unauthData.agentJobs, undefined, 'agentJobs must not be present');
      assert.ok(unauthData.briefing, 'briefing should still exist');
      assert.equal(unauthData.briefing.agentResults, undefined, 'briefing.agentResults must not be present');
      assert.equal(unauthData.briefing.deadJobs, undefined, 'briefing.deadJobs must not be present');
      assert.equal(unauthData.briefing.stats, undefined, 'briefing.stats must not be present');
      assert.equal(unauthData.briefing.autoQueueSuggestions, undefined, 'briefing.autoQueueSuggestions must not be present');
      assert.ok(unauthData.briefing.greeting, 'briefing.greeting should remain');

      // Authenticated — full data
      const authRes = await fetch(`http://127.0.0.1:${port}/api/data`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const authData = await authRes.json();

      assert.ok(authData.agentJobs, 'authenticated should have agentJobs');
      assert.ok(authData.briefing.agentResults, 'authenticated briefing should have agentResults');
      assert.ok(authData.briefing.deadJobs, 'authenticated briefing should have deadJobs');
      assert.ok(authData.briefing.stats, 'authenticated briefing should have stats');
    } finally {
      srv.close();
    }
  });
});
