/**
 * Tests for server.mjs — verifies that all mutating / job / session
 * endpoints require auth and that the server binds to localhost.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('server security configuration', () => {
  // Helper — read server source once per test (stateless, no port conflict)
  async function readServerSource() {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    return readFileSync(resolve(__dirname, '../server.mjs'), 'utf8');
  }

  it('binds to localhost by default', async () => {
    const source = await readServerSource();
    assert.ok(source.includes("'127.0.0.1'"), 'default bind host should be 127.0.0.1');
    assert.ok(source.includes('BIND_HOST'), 'should use BIND_HOST variable');
    assert.ok(source.includes('server.listen(PORT, BIND_HOST'), 'server.listen should include host parameter');
  });

  it('does not use wildcard CORS', async () => {
    const source = await readServerSource();
    const corsLines = source.split('\n').filter(l => l.includes('Access-Control-Allow-Origin'));
    for (const line of corsLines) {
      assert.ok(!line.includes("'*'"), `CORS should not be wildcard: ${line.trim()}`);
    }
  });

  it('generates an auth token on startup', async () => {
    const source = await readServerSource();
    assert.ok(source.includes('randomBytes'), 'should use crypto.randomBytes for token generation');
    assert.ok(source.includes('AUTH_TOKEN'), 'should define AUTH_TOKEN');
    assert.ok(source.includes('Bearer'), 'should use Bearer token scheme');
  });

  // ---- Protected route checks ----

  const protectedRoutes = [
    { label: 'POST /api/jobs', pattern: "url.pathname === '/api/jobs' && req.method === 'POST'" },
    { label: 'DELETE /api/jobs/:id', pattern: "deleteMatch && req.method === 'DELETE'" },
    { label: 'GET /api/jobs/:id/result', pattern: "resultMatch && req.method === 'GET'" },
    { label: 'POST /api/jobs/process', pattern: "url.pathname === '/api/jobs/process'" },
    { label: 'GET /api/jobs', pattern: "url.pathname === '/api/jobs' && req.method === 'GET'" },
    { label: 'POST /api/worked-on', pattern: "url.pathname === '/api/worked-on'" },
    { label: 'POST /api/strategy', pattern: "url.pathname === '/api/strategy'" },
    { label: 'POST /api/session/start', pattern: "url.pathname === '/api/session/start'" },
    { label: 'POST /api/session/end', pattern: "url.pathname === '/api/session/end'" },
  ];

  for (const { label, pattern } of protectedRoutes) {
    it(`protects ${label} with requireAuth`, async () => {
      const source = await readServerSource();
      const idx = source.indexOf(pattern);
      assert.ok(idx !== -1, `should have handler for ${label}`);
      const routeBlock = source.slice(idx, idx + 300);
      assert.ok(routeBlock.includes('requireAuth'), `${label} should call requireAuth`);
    });
  }

  it('strips agentJobs and briefing job fields from unauthenticated /api/data responses', async () => {
    const source = await readServerSource();
    // The /api/data handler should check isAuthorized and strip agentJobs
    assert.ok(source.includes('isAuthorized(req)'), '/api/data should check isAuthorized');
    assert.ok(source.includes('agentJobs: _stripped'), 'should destructure out agentJobs for public response');
    // Should also strip job-derived fields from the embedded briefing
    assert.ok(source.includes('briefing: fullBriefing'), 'should destructure out briefing for sanitization');
    assert.ok(source.includes('publicBriefing'), 'should rebuild a public briefing without job fields');
  });
});
