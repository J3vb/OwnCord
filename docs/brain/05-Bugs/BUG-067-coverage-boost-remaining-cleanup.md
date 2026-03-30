---
date: 2026-03-30
severity: "low"
status: "investigating"
---

# BUG-067: coverage_boost_test.go needs broader behavioral cleanup

## Description

`SetClientVoiceChID` tests in `coverage_boost_test.go:112` were fixed in a prior session to assert observable state instead of merely executing lines. The rest of the file still needs a broader cleanup pass.

## Status

**Partially remediated.** `SetClientVoiceChID` cases now have proper assertions. Remaining tests in `coverage_boost_test.go` still follow the "doesn't panic" pattern.

## Environment

- **OS:** Windows
- **Server:** Go
- **Component:** `Server/ws/coverage_boost_test.go`

## Fix

Audit remaining test cases in `coverage_boost_test.go` and convert to behavioral assertions (check return values, state changes, error conditions).

## Related

- [[Open Bugs 2]] item 10
- [[BUG-061-server-coverage-driven-tests]] (broader server pattern)
