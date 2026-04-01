# Testing Tools Guide

This guide covers the mutation testing, load testing, and chaos testing tools
installed in the OwnCord project.

## Quick Reference

| Tool | Purpose | Config | Command |
|------|---------|--------|---------|
| **Stryker** | Client mutation testing | `stryker.config.mjs` | `npm run test:mutate` |
| **go-gremlins** | Server mutation testing | `.gremlins.yaml` | `go-gremlins mutate ./...` |
| **k6** | WebSocket load testing | `scripts/k6/ws-load.js` | `k6 run scripts/k6/ws-load.js` |
| **toxiproxy** | Chaos/network testing | `scripts/toxiproxy/chaos-test.sh` | `bash scripts/toxiproxy/chaos-test.sh` |
| **Coraza WAF** | OWASP security middleware | `server.waf_enabled` config | Optional; enable in `config.yaml` |

## Client: Stryker Mutation Testing

**Purpose:** Verify that your unit/integration tests actually catch bugs.
Stryker introduces small mutations into your TypeScript code and checks
if tests fail. Tests that don't catch mutations are "survivors."

### Installation

Already in `package.json` as dev dependency:

```bash
cd Client/tauri-client
npm install
```

### Configuration

File: `Client/tauri-client/stryker.config.mjs`

- Runs against all tests in `tests/unit/` and `tests/integration/`
- Uses vitest as the test runner
- Generates HTML and JSON reports

### Running Mutations

```bash
cd Client/tauri-client

# Full mutation testing (will take several minutes)
npm run test:mutate

# Dry run (checks what would be tested, no actual mutations)
npm run test:mutate:dry
```

### Understanding Results

After a run, open the HTML report:

```bash
# On Windows
start reports\mutation\index.html

# On Linux/macOS
open reports/mutation/index.html
```

**Key metrics:**

- **Killed**: Mutations that tests caught (good)
- **Survived**: Mutations that tests missed (investigate)
- **Timeout**: Mutation caused infinite loop
- **Compile error**: Mutation syntax was invalid (rare)

**Kill rate interpretation:**

- **>95%**: Excellent, tests are very thorough
- **80-95%**: Good, typical for mature projects
- **<80%**: Poor, tests may have gaps

### Investigating Survivors

A surviving mutation means tests don't cover that code path. Steps:

1. Find the mutation in the HTML report (file + line number)
2. Read the mutation details (what changed?)
3. Determine if this path is reachable
4. If reachable, add a test that kills this mutation

Example:

```typescript
// Original code
if (count > 0) {
  console.log("positive");
}

// Mutation: > becomes >= 
// Surviving mutation means no test with count === 0
```

## Server: go-gremlins Mutation Testing

**Purpose:** Same as Stryker, but for Go code. Mutates Go source
and runs `go test ./...` to check if tests catch the mutations.

### Installation

```bash
go install github.com/go-gremlins/gremlins/cmd/go-gremlins@latest
```

### Configuration

File: `Server/.gremlins.yaml`

Specifies which files to mutate and mutation settings.

### Running Mutations

```bash
cd Server

# Run full mutation testing
go-gremlins mutate ./...

# View JSON report
cat gremlins-report.json
```

### Mutation Types

go-gremlins applies mutations like:

- Boundary changes: `<` → `<=`, `>` → `>=`
- Logical operators: `&&` → `||`
- Assignment mutations: `x = y` → `x = 0`
- Arithmetic: `x + y` → `x - y`

See [go-gremlins docs](https://github.com/go-gremlins/gremlins) for full list.

## Load Testing: k6

**Purpose:** Stress-test the WebSocket server and HTTP API.
Simulates many concurrent clients sending messages.

### Installation

Download from [k6.io](https://k6.io/docs/get-started/installation/):

```bash
# On Windows (via chocolatey)
choco install k6

# On macOS
brew install k6

# On Linux
sudo apt-get install k6
```

### Configuration

File: `Server/scripts/k6/ws-load.js`

- Configurable VU (virtual users), duration, ramp-up, etc.
- Measures: response time, throughput, errors, WebSocket latency

### Running Load Tests

```bash
cd Server

# Run the default WebSocket load test
k6 run scripts/k6/ws-load.js

# With custom options
k6 run --vus 100 --duration 30s scripts/k6/ws-load.js
```

### Interpreting Results

Output shows:

- **http_req_duration**: Response time (ms)
- **http_reqs**: Total requests per second
- **errors**: Failed requests
- **ws_connecting**: WebSocket connection latency

Monitor for:

- High error rates (server instability)
- Increasing latency (saturation)
- Resource exhaustion (check server logs)

## Chaos Testing: toxiproxy

**Purpose:** Inject network faults (latency, packet loss, timeouts)
to verify reconnection and error handling logic.

### Installation

Download from [shopify/toxiproxy](https://github.com/shopify/toxiproxy):

```bash
# On Windows
# Download release from GitHub

# On macOS
brew install shopify/shopify/toxiproxy

# On Linux
# Download release from GitHub
```

### Configuration

File: `Server/scripts/toxiproxy/chaos-test.sh`

- Defines toxiproxy proxies (intercept server connections)
- Applies faults: latency, bandwidth limits, packet loss, timeouts
- Runs tests before/during/after fault injection

### Running Chaos Tests

```bash
cd Server

bash scripts/toxiproxy/chaos-test.sh
```

### Fault Scenarios

Common scenarios defined in the script:

1. **Latency injection**: Add 500ms delay to all packets
2. **Packet loss**: Drop 10% of packets
3. **Bandwidth throttle**: Limit to 1 Mbps
4. **Connection timeout**: Kill connections after inactivity
5. **Periodic disconnects**: Force reconnect every 30s

Watch for:

- Client reconnects successfully
- No data loss (seq numbers correct)
- Graceful fallback (no app crashes)

## Security: Coraza WAF

**Purpose:** Protect against OWASP top 10 attacks (SQL injection, XSS, etc.)
using OWASP CRS (Core Rule Set) rules.

### Configuration

Enable in `config.yaml`:

```yaml
server:
  waf_enabled: true
  waf_paranoia_level: 2
```

Or via environment variable:

```bash
OWNCORD_SERVER_WAF_ENABLED=true
OWNCORD_SERVER_WAF_PARANOIA_LEVEL=2
```

### Paranoia Levels

| Level | Coverage | False Positives | Recommended For |
|-------|----------|-----------------|-----------------|
| 1 | Basic | Very low | Production (default baseline) |
| 2 | Standard | Low | Production (balance) |
| 3 | Strict | Medium | Staging/QA |
| 4 | Paranoid | High | Testing only |

### Behavior

With WAF enabled:

- All HTTP requests are scanned against OWASP CRS rules
- Suspicious requests are blocked with HTTP 403
- Benign requests pass through
- Logs show rule violations

### Testing the WAF

Try a simple SQL injection attempt (should be blocked):

```bash
curl -X POST http://localhost:8443/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin\" OR \"1\"=\"1", "password": "test"}'
# Response: 403 Forbidden (if WAF enabled)
```

## Integration with CI

All mutation tests can run in CI pipelines:

```bash
# Client
npm run test:mutate

# Server
go-gremlins mutate ./...

# Load testing (optional, longer duration)
k6 run --vus 50 --duration 60s scripts/k6/ws-load.js

# Chaos testing (optional, requires toxiproxy)
bash scripts/toxiproxy/chaos-test.sh
```

## Next Steps

- See [[06-Specs/TESTING-STRATEGY|TESTING-STRATEGY.md]] for detailed test patterns
- See [[06-Specs/CHATSERVER|CHATSERVER.md]] for security rules (WAF context)
- See [[08-Guides/Server-Configuration|Server-Configuration.md]] for config details
