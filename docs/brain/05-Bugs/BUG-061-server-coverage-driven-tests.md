---
date: 2026-03-30
severity: "low"
status: "open"
---

# BUG-061: Server contains low-confidence coverage-driven tests

## Description

Several server test files were written primarily to push coverage numbers up rather than to verify behavior. They use "doesn't panic" style assertions that provide low confidence.

## Affected Files

- `coverage_boost_test.go` — structurally a coverage-booster, not behavior-first
- `middleware_coverage_test.go` — similar intent
- `api_edge_cases_test.go` — similar intent

## Expected Behavior

Server tests should assert observable state changes and behavioral contracts, not just "code doesn't crash."

## Actual Behavior

Tests execute code paths without meaningful assertions. `SetClientVoiceChID` cases were improved in a prior session, but the rest of `coverage_boost_test.go` still needs cleanup.

## Environment

- **OS:** Windows
- **Server:** Go
- **Component:** `Server/ws/`, `Server/api/`

## Root Cause

Tests were written to increase coverage metrics rather than to verify behavior.

## Fix

Audit and rewrite assertions in these files to check observable outcomes (return values, state mutations, error conditions) rather than just executing lines.

## Related

- [[Open Bugs 2]] item 4
- [[BUG-067-coverage-boost-remaining-cleanup]] (partially fixed)
