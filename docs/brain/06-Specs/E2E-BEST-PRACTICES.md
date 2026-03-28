# E2E Testing Best Practices — OwnCord

## Assertion Strength Ladder

| Level | Assertion | Catches | Use When |
|-------|-----------|---------|----------|
| 0 | No assertion | Nothing | Never |
| 1 | `toBeAttached()` | Missing DOM | Layout smoke only |
| 2 | `toBeVisible()` | Hidden via CSS | Layout smoke only |
| 3 | `toContainText("...")` | Wrong content | Partial text match |
| 4 | `toHaveText("...")` | Wrong content | Exact text match |
| 5 | `toHaveText + toHaveAttribute` | Content + state | Critical paths |

**Rule: Every test must have at least one Level 3+ assertion.**

## Selector Priority

1. `getByRole('button', { name: 'Send' })` — accessible, survives refactors
2. `getByText('general')` — user-visible text
3. `getByTestId('msg-textarea')` — stable contract
4. `locator('.css-class')` — last resort

## Never Do

- `waitForTimeout()` — use auto-retrying assertions instead
- `expect(locator).toBeDefined()` — Locators are always defined
- `expect(count).toBeGreaterThanOrEqual(0)` — can never fail
- `if (await el.isVisible()) { /* test */ }` — silently skips assertions
- Assert CSS classes when you can assert visible state or aria attributes

## Always Do

- Test user journeys, not DOM existence
- Assert actual content (`toHaveText`), not just visibility
- Use `expect().toPass()` for state changes after WS events
- Use `test.skip()` with reason instead of `if` guards
- Extract repeated sequences into helper functions
- One login per test run (persistent fixture for native tests)
