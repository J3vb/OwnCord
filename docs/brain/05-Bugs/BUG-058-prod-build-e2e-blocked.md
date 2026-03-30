---
date: 2026-03-30
severity: "high"
status: "open"
---

# BUG-058: Prod-build E2E blocked by TypeScript errors in test files

## Description

Production-build E2E (`npm run test:e2e:prod`) is blocked before Playwright even starts. The build step fails on TypeScript errors inside test files because `tsconfig.json` includes the `tests` directory.

## Steps to Reproduce

1. Run `npm run test:e2e:prod` in `Client/tauri-client`
2. Build step fails before Playwright launches

## Expected Behavior

Prod-build E2E should compile cleanly and run Playwright tests against the production build.

## Actual Behavior

TypeScript compilation fails on test files:
- Missing required `role` fields in `sidebar-member-section.test.ts:55`
- Broken nullable callback handling in `voice-audio-tab.test.ts:80`
- `tsconfig.json:24` includes `tests`, so test TS errors block the prod build

## Environment

- **OS:** Windows
- **Client:** Tauri v2
- **Component:** Client build / E2E

## Root Cause

`tsconfig.json` includes the `tests` directory in its compilation scope. Test files with type errors prevent the production build from completing, even though mocked E2E passes fine.

## Fix

Options:
1. Exclude `tests/` from the production build tsconfig (use a separate `tsconfig.test.json`)
2. Fix the type errors in the test files directly

## Related

- [[Open Bugs 2]] item 1
- Mocked E2E passes — only prod-build path is affected
