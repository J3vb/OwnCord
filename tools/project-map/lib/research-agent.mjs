/**
 * Research agent launcher.
 * Spawns a Claude Code subprocess to investigate a specific area
 * and saves findings to docs/brain/00-Overview/Research/.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const RESEARCH_DIR = 'docs/brain/00-Overview/Research';

const RESEARCH_AREAS = {
  'server-api': {
    label: 'Server API package',
    description: 'Analyze Server/api/ for coverage gaps, missing error handling, untested endpoints',
    scope: 'Server/api/',
  },
  'server-ws': {
    label: 'Server WebSocket package',
    description: 'Analyze Server/ws/ for coverage gaps, race conditions, edge cases in voice/chat handlers',
    scope: 'Server/ws/',
  },
  'server-auth': {
    label: 'Server auth package',
    description: 'Analyze Server/auth/ for security gaps, missing test cases, TOTP edge cases',
    scope: 'Server/auth/',
  },
  'server-db': {
    label: 'Server database package',
    description: 'Analyze Server/db/ for missing indexes, query performance, untested queries',
    scope: 'Server/db/',
  },
  'server-admin': {
    label: 'Server admin package',
    description: 'Analyze Server/admin/ for test coverage issues, build-tag gating, missing functionality',
    scope: 'Server/admin/',
  },
  'client-livekit': {
    label: 'Client LiveKit session',
    description: 'Analyze livekitSession.ts and related audio/video code for coverage gaps and edge cases',
    scope: 'Client/tauri-client/src/lib/livekitSession.ts',
  },
  'client-stores': {
    label: 'Client stores',
    description: 'Analyze reactive stores for state management edge cases, race conditions, memory leaks',
    scope: 'Client/tauri-client/src/stores/',
  },
  'rust-backend': {
    label: 'Tauri Rust backend',
    description: 'Analyze Rust backend for missing tests, security gaps in proxy/credential code',
    scope: 'Client/tauri-client/src-tauri/src/',
  },
  'e2e-coverage': {
    label: 'E2E test coverage',
    description: 'Analyze E2E test suite for missing critical user flows, flaky tests, gaps',
    scope: 'Client/tauri-client/tests/e2e/',
  },
  'security': {
    label: 'Security audit',
    description: 'Review codebase for OWASP Top 10 vulnerabilities, auth bypass, injection, XSS',
    scope: 'Server/ Client/tauri-client/src/',
  },
  'protocol': {
    label: 'Protocol compliance',
    description: 'Check server and client code against docs/brain/06-Specs/PROTOCOL.md for drift',
    scope: 'Server/ws/ Client/tauri-client/src/lib/dispatcher.ts',
  },
};

function buildPrompt(areaKey, area, root) {
  const date = new Date().toISOString().slice(0, 10);
  const outputFile = `${RESEARCH_DIR}/${areaKey}-${date}.md`;

  return `You are a research agent investigating the OwnCord project.

## Task
${area.description}

## Scope
Focus on: ${area.scope}

## Instructions
1. Read the relevant source files and test files
2. Identify:
   - Coverage gaps (functions/branches not tested)
   - Potential bugs or edge cases
   - Security concerns
   - Code quality issues
   - Missing functionality vs specs
3. For each finding, note the file path and line number
4. Prioritize findings as CRITICAL, HIGH, MEDIUM, or LOW

## Output
Write your findings to: ${outputFile}

Use this format:
---
# Research: ${area.label}
Date: ${date}
Scope: ${area.scope}

## Summary
[2-3 sentence overview]

## Findings

### CRITICAL
- [finding with file:line reference]

### HIGH
- [finding with file:line reference]

### MEDIUM
- [finding with file:line reference]

### LOW
- [finding with file:line reference]

## Recommendations
[Prioritized list of what to fix/improve next]
---

After writing the file, print a brief summary of what you found.`;
}

async function promptUser(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function launchResearchAgent(root) {
  console.log('\n  Research Agent Launcher\n');
  console.log('  Available research areas:\n');

  const keys = Object.keys(RESEARCH_AREAS);
  keys.forEach((key, i) => {
    const area = RESEARCH_AREAS[key];
    console.log(`  ${i + 1}. ${area.label} — ${area.description.slice(0, 70)}...`);
  });

  console.log(`\n  ${keys.length + 1}. Custom (enter your own research prompt)`);

  const choice = await promptUser('\n  Enter number (or "q" to quit): ');

  if (choice === 'q' || choice === '') {
    console.log('  Cancelled.');
    return;
  }

  const num = parseInt(choice, 10);
  if (isNaN(num) || num < 1 || num > keys.length + 1) {
    console.log('  Invalid choice.');
    return;
  }

  // Ensure research directory exists
  const researchDir = resolve(root, RESEARCH_DIR);
  mkdirSync(researchDir, { recursive: true });

  let prompt;
  let areaKey;

  if (num <= keys.length) {
    areaKey = keys[num - 1];
    const area = RESEARCH_AREAS[areaKey];
    prompt = buildPrompt(areaKey, area, root);
    console.log(`\n  Launching research on: ${area.label}`);
  } else {
    const customPrompt = await promptUser('  Enter your research prompt: ');
    if (!customPrompt) {
      console.log('  Cancelled.');
      return;
    }
    areaKey = 'custom';
    prompt = customPrompt;
    console.log(`\n  Launching custom research...`);
  }

  // Save the prompt for reference
  const date = new Date().toISOString().slice(0, 10);
  const promptFile = resolve(researchDir, `${areaKey}-${date}-prompt.txt`);
  // Boundary check: ensure promptFile stays within researchDir
  if (!promptFile.startsWith(resolve(researchDir))) {
    console.error('  Error: prompt file path escapes research directory');
    return;
  }
  writeFileSync(promptFile, prompt, 'utf8');

  console.log(`  Prompt saved to: ${promptFile}`);
  console.log(`\n  To run the research agent, execute:\n`);
  console.log(`    claude --print "${promptFile.replace(/\\/g, '/')}"`);
  console.log(`\n  Or copy the prompt and paste it into a Claude Code session.`);
  console.log(`  The agent will save findings to: ${RESEARCH_DIR}/${areaKey}-${date}.md\n`);

  // Try to launch claude directly if available
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe' });
    const launch = await promptUser('  Claude CLI detected. Launch now? (y/n): ');
    if (launch.toLowerCase() === 'y') {
      console.log('\n  Spawning Claude Code agent...\n');
      // Use prompt file instead of inline prompt to avoid shell injection
      const child = spawn('claude', ['--print', promptFile], {
        cwd: root,
        stdio: 'inherit',
        shell: false,
      });
      child.on('close', (code) => {
        console.log(`\n  Research agent exited with code ${code}`);
        console.log(`  Check ${RESEARCH_DIR}/${areaKey}-${date}.md for findings.\n`);
      });
      // Wait for completion
      await new Promise(resolve => child.on('close', resolve));
    }
  } catch {
    // Claude CLI not available — just show instructions
  }
}
