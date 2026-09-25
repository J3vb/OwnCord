# OwnCord design system

Condensed from the sources listed at the end, at commit `7732f969` (2026-09-25). On conflict, the source documents win.

## Brand direction

The visual direction is **Refined Neon** (owner decision Q13), applied across four themes: `dark` (default), `neon-glow` (the OwnCord brand identity), `midnight`, and `light`. Themes are switched by a body class (`body.theme-*`) that overrides `Client/src/styles/tokens.css`'s dark defaults; a user's custom accent colour overrides accent-derived tokens on top of whichever theme is active. High Contrast is a separate toggle layered over any theme.

Accessibility is load-bearing, not decorative: the app targets a WCAG 2.2 AA-oriented bar (owner decision Q1), checked automatically on every UI PR, not a certification claim.

## Color tokens

Tokens live in `Client/src/styles/tokens.css` (`:root`, shared by `dark` and inherited by `midnight`/`neon-glow` where they don't override), `body.theme-light` in the same file, `Client/src/styles/theme-neon-glow.css` (`body.theme-neon-glow`), and `Client/src/components/settings/helpers.ts`'s `THEMES` map (the small per-theme overrides for `dark`, `neon-glow`, `midnight`, `light`). `Client/src/styles/app/accessibility.css` holds the High Contrast overrides.

### Backgrounds, per theme

| Token            | dark (`:root`)    | neon-glow     | midnight      | light         |
| ---------------- | ----------------- | ------------- | ------------- | ------------- |
| `--bg-tertiary`  | `#1e1f22`         | `#0b0c0e`     | `#0f1a38`     | `#e3e5e8`     |
| `--bg-secondary` | `#2b2d31`         | `#111214`     | `#16213e`     | `#f2f3f5`     |
| `--bg-primary`   | `#313338`         | `#17181b`     | `#1a1a2e`     | `#ffffff`     |
| `--bg-input`     | `#383a40`         | `#222328`     | `#232845`     | `#ebedef`     |
| `--bg-hover`     | `#35373c`         | `#1d1e22`     | _(inherited)_ | `#e8e9ed`     |
| `--bg-active`    | `#404249`         | `#27282d`     | _(inherited)_ | `#dcdfe4`     |
| `--bg-overlay`   | `rgba(0,0,0,0.7)` | _(inherited)_ | _(inherited)_ | _(inherited)_ |

### Accent, per theme

| Token                                 | dark      | neon-glow | midnight              | light                 |
| ------------------------------------- | --------- | --------- | --------------------- | --------------------- |
| `--accent` (fill)                     | `#5865f2` | `#00c8ff` | _(inherited dark)_    | `#4f5bd5`             |
| `--accent-hover`                      | `#4752c4` | `#26d0ff` |                       | `#4150c4`             |
| `--accent-active`                     | `#3c45a5` | `#4dd9ff` |                       | `#3740a8`             |
| `--on-accent` (text/icons on a fill)  | `#ffffff` | `#000000` |                       | `#ffffff` (inherited) |
| `--accent-text` (accent used as text) | `#a3aaf8` | `#2fd0ff` | `#a3aaf8` (inherited) | `#4150c4`             |
| `--focus-ring`                        | `#a3aaf8` | `#2fd0ff` | `#a3aaf8` (inherited) | `#4752c4`             |

The default _fill_ accents (`#00c8ff`, `#5865f2`, light's `#4f5bd5`) read below the Q1 4.5:1 bar as **text** on at least one surface, which is why `--accent-text`/`--focus-ring` are separate, tested tokens — never substitute `--accent` for either. A custom accent (`applyAccent()` in `Client/src/lib/themes.ts`) always wins for fills; it only wins for `--accent-text`/`--focus-ring` when it independently clears 4.5:1 / 3:1 on every surface, otherwise those two fall back to the theme's tested value (fail closed). High Contrast always restores the theme's tested `--accent-text`/`--focus-ring`, even over a readable custom accent.

### Text and status

| Token                | dark      | neon-glow            | midnight  | light                                 |
| -------------------- | --------- | -------------------- | --------- | ------------------------------------- |
| `--text-normal`      | `#dbdee1` | `#dfe2e6`            | `#e2e4ef` | `#2a2c31`                             |
| `--text-muted`       | `#a9aeb6` | `#a3a9b2`            | `#a9b0c8` | _(dark default; not re-tabled above)_ |
| `--text-faint`       | `#80848e` | —                    | —         | —                                     |
| `--text-micro`       | `#6d6f78` | —                    | —         | —                                     |
| `--text-link`        | `#4cc0ff` | `var(--accent-text)` | `#5cc8ff` | —                                     |
| `--text-positive`    | `#62c28c` | `#5cc389`            | —         | —                                     |
| `--text-warning`     | `#f2b84b` | `#f2b84b`            | —         | —                                     |
| `--text-danger`      | `#ff9a9c` | `#ff8f92`            | —         | —                                     |
| `--header-primary`   | `#f2f3f5` | `#f4f5f7`            | `#f4f5fa` | —                                     |
| `--header-secondary` | `#b5bac1` | —                    | —         | —                                     |

`--text-faint` and `--text-micro` are for incidental text only (decoration, separators, disabled) — they are **not contrast-qualified**, unlike every other text token above, which is ≥4.5:1 on every `--bg-*` surface in every theme including High Contrast.

### Borders, status fills, and other fixed tokens

| Token                                                      | Value (dark)                                                     | Note                                                                                                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--border`                                                 | `#3f4147`                                                        | decorative separator only                                                                                                                               |
| `--border-strong`                                          | `#4e5058`                                                        | decorative separator only                                                                                                                               |
| `--border-control`                                         | `#7a7f89` (neon-glow: `#5f6773`, midnight: `#6a7194`)            | the 1px edge of an input/control, ≥3:1 on `--bg-primary`/`--bg-secondary`                                                                               |
| `--green` / `--yellow` / `--red`                           | `#23a55a` / `#f0b232` / `#f23f43`                                | fill colours only — use `--text-positive`/`--text-warning`/`--text-danger` for text                                                                     |
| `--danger-fill` / `--danger-fill-hover`                    | `#d0302f` / `#b3272a`                                            | destructive button fills; ≥4.5:1 with white text (`--red` itself misses that)                                                                           |
| `--on-fill`                                                | `#ffffff`                                                        | text/icons on a theme-independent fill or media scrim                                                                                                   |
| `--on-warning`                                             | `#1e1f22`                                                        | text on the `--yellow` warning fill                                                                                                                     |
| `--role-owner`/`--role-admin`/`--role-mod`/`--role-member` | `#e74c3c` / `#f39c12` / `#2ecc71` / `#949ba4`                    | server role colours; a role colour is only used as text through `readableRoleColor()` in `lib/themes.ts`, which clamps to `--text-normal` if unreadable |
| `--scrim` / `--scrim-strong` / `--scrim-hover`             | `rgba(0,0,0,0.6)` / `rgba(0,0,0,0.85)` / `rgba(255,255,255,0.2)` | overlays on media                                                                                                                                       |

### High Contrast overrides (`app/accessibility.css`)

| Token                            | dark/neon-glow/midnight          | light                 |
| -------------------------------- | -------------------------------- | --------------------- |
| `--text-normal`                  | `#ffffff`                        | `#000000`             |
| `--text-muted`                   | `#cccccc`                        | `#2e3035`             |
| `--bg-active`                    | `rgba(255,255,255,0.15)`         | `rgba(0,0,0,0.15)`    |
| `--accent-text` / `--focus-ring` | `#a3aaf8` (neon-glow: `#2fd0ff`) | `#4150c4` / `#4752c4` |

### Rules

- Text on an accent fill is `var(--on-accent)` — never `white` or a literal hex.
- The accent used as text is `var(--accent-text)` — never `var(--accent)`.
- A focus indicator is `var(--focus-ring)` — never `var(--accent)`.
- A badge/banner with white text fills with `--danger-fill`, not `--red`.
- An input's edge is `1px solid var(--border-control)`; a fill difference alone is not a boundary. Placeholders are `--text-muted`.
- Contrast is checked against every surface a token can sit on: `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--bg-input`.
- Kept literal (deliberately not tokenized): true-black video letterbox, each theme tile's own preview swatch, and px glyph sizes in fixed boxes (avatar initials, icon buttons, emoji).

## Typography

| Token            | Value                                                                              |
| ---------------- | ---------------------------------------------------------------------------------- |
| `--font-display` | `"Segoe UI Variable Display", "Segoe UI", "Inter Variable", system-ui, sans-serif` |
| `--font-body`    | `"Segoe UI Variable Text", "Segoe UI", "Inter Variable", system-ui, sans-serif`    |
| `--font-mono`    | `"Cascadia Code", "Consolas", monospace`                                           |

Segoe UI Variable is used on Windows; everywhere else (Linux builds) the bundled Inter Variable (`Client/src/assets/fonts/`, SIL OFL 1.1) is the fallback, declared via `@font-face` in `base.css` with `font-src` restricted to `'self'` — no font is ever fetched from a CDN.

### Scale

Every step is `calc(var(--font-size, 16px) * factor)`, so it follows the Appearance "Large Font" size (12–20px, default 16px, `--font-size` written inline on `<html>` by `appearance.ts`). Comments below are the px value at the 16px default.

| Token                 | Factor  | Default px |
| --------------------- | ------- | ---------- |
| `--font-size-xxs`     | ×0.625  | 10px       |
| `--font-size-xs`      | ×0.75   | 12px       |
| `--font-size-sm`      | ×0.8125 | 13px       |
| `--font-size-md`      | ×0.875  | 14px       |
| `--font-size-lg`      | ×1      | 16px       |
| `--font-size-xl`      | ×1.25   | 20px       |
| `--font-size-xxl`     | ×1.5    | 24px       |
| `--font-size-display` | ×1.75   | 28px       |

Glyphs sized to a fixed box (avatar initials, icon buttons, emoji) are kept as literal px, not the scale.

## Spacing

4px-step scale (`tokens.css`):

| Token                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| `--space-1` … `--space-8` | `4px`, `8px`, `12px`, `16px`, `20px`, `24px`, `28px`, `32px` |

Layout constants also defined in `tokens.css`: `--sidebar-width: 240px`, `--header-height: 48px`, and message-layout tokens `--message-group-spacing: 17px`, `--message-inline-spacing: 0`, `--avatar-size: 40px`, `--avatar-offset-left: 16px`, `--message-content-left: 72px`, `--message-content-right: 48px`.

## Radius & shadows

| Token             | Value   |
| ----------------- | ------- |
| `--radius-sm`     | `4px`   |
| `--radius-md`     | `8px`   |
| `--radius-lg`     | `12px`  |
| `--radius-pill`   | `999px` |
| `--radius-circle` | `50%`   |

| Token              | Value                                                 | Use                     |
| ------------------ | ----------------------------------------------------- | ----------------------- |
| `--elevation-low`  | `0 1px 0 rgba(4,4,5,0.2), 0 1.5px 0 rgba(4,4,5,0.05)` | flat surface separation |
| `--elevation-high` | `0 8px 16px rgba(0,0,0,0.24)`                         | raised surface          |
| `--shadow-sm`      | `0 2px 8px rgba(0,0,0,0.3)`                           | buttons, chips          |
| `--shadow-md`      | `0 8px 24px rgba(0,0,0,0.5)`                          | menus, toasts           |
| `--shadow-lg`      | `0 8px 32px rgba(0,0,0,0.6)`                          | pickers, dialogs        |

Transition timing tokens: `--transition-fast: 100ms ease`, `--transition-normal: 170ms ease`, `--transition-slow: 200ms ease`.

## Components

**Reuse an existing component or CSS class before adding a new one.** Shared UI components live under `Client/src/components/` (e.g. `SettingsOverlay.ts`, `EditChannelModal.ts`, `Toast.ts`); shared factories/helpers live in `Client/src/lib/` (`modalFactory.ts`, `a11y.ts`, `dom.ts`) and `Client/src/components/settings/helpers.ts` (`createToggle`, `THEMES`). Style rules live in `Client/src/styles/app/*.css`, imported in cascade order from `Client/src/styles/app.css` — add rules to the owning fragment, never reorder imports or move rules between fragments.

| Pattern                 | Classes / factory                                                                                            | Notes                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Modal dialog            | `.modal-overlay.visible > .modal[role=dialog][aria-modal]` (`.modal-header`, `.modal-body`, `.modal-footer`) | Build with `createModal()` (`Client/src/lib/modalFactory.ts`): applies dialog semantics, Tab focus trap, Escape-to-close, and restores focus to the opener. Pass `ariaLabel`/`ariaLabelledBy` and, if the dialog can remove its own opener, `fallbackFocus`. |
| Primary/save button     | `.btn-primary`, `.btn-modal-save`                                                                            | Accent fill, `--on-accent` text; `.btn-primary` has a `.loading` state with `.btn-spinner`.                                                                                                                                                                  |
| Secondary/cancel button | `.btn-modal-cancel`, `.btn-ghost`                                                                            | Transparent/muted background.                                                                                                                                                                                                                                |
| Destructive button      | `.btn-danger`                                                                                                | `--danger-fill` background, `--on-fill` text.                                                                                                                                                                                                                |
| Text input              | `.form-input` (+ `.form-group`, `.form-label`, `.form-error`, `.form-status`, `.form-warning`, `.form-hint`) | 1px `--border-control` edge; error state adds `.error`/`[aria-invalid="true"]`; no separate focus border/glow — the base `--focus-ring` outline is the one ring.                                                                                             |
| Checkbox                | `.form-checkbox` / `.checkbox-box`                                                                           | Accent fill when checked.                                                                                                                                                                                                                                    |
| Toggle switch           | `.toggle[role=switch]` via `createToggle()` (`components/settings/helpers.ts`)                               | Requires a `label` option — it becomes the accessible name.                                                                                                                                                                                                  |
| Settings row            | `.setting-row`, `.setting-label`, `.setting-desc`                                                            | Used inside `SettingsOverlay`.                                                                                                                                                                                                                               |
| Toast                   | `.toast-container > .toast.show` with `.toast-info`/`.toast-error`/`.toast-success`/`.toast-warning`         | Left-border colour by kind; built by `Toast.ts`.                                                                                                                                                                                                             |
| Status/banner bar       | `.status-bar`, `.reconnecting-banner`                                                                        | Non-modal transient state.                                                                                                                                                                                                                                   |

## States (hover, focus, active, disabled, loading, empty, error)

| State                  | Pattern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hover                  | Transition to `--bg-hover`/`--accent-hover`/lighter border (e.g. `.form-input:hover` → `--border-strong`; `.settings-nav-item:hover` → `--bg-hover`).                                                                                                                                                                                                                                                                                                                                                     |
| Focus                  | A single 2px `var(--focus-ring)` outline, 2px offset, drawn by `base.css` on `:focus-visible` for buttons, inputs, selects, textareas, links and focusable `[tabindex]` elements. Never suppressed without a ≥2px/3:1 replacement; never `var(--accent)`. Composite controls (the composer, login fields) draw exactly one ring on the outer box, not a second one on the inner control.                                                                                                                  |
| Active                 | Darker/`--accent-active` step (e.g. `.btn-primary:active`).                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Disabled               | `.btn-primary:disabled` → `--border-strong` background, `--text-faint` text, `cursor: not-allowed`. Disabled controls are exempt from the contrast bar. A _pending_ control uses `aria-busy="true"`/`aria-disabled="true"` instead of the `disabled` attribute, because disabling a focused element drops focus to `<body>` — exceptions are the Settings account/recovery forms and the connect page's login/2FA/recovery forms, which do set `disabled` and restore focus afterward with `focusIsOurs`. |
| Loading                | `.btn-primary.loading` hides `.btn-text` and shows `.btn-spinner` (a `.spinner` div, `animation: spin`).                                                                                                                                                                                                                                                                                                                                                                                                  |
| Empty                  | No dedicated empty-state token/class was found in the styles read for this doc — treat as project-specific per component until one exists.                                                                                                                                                                                                                                                                                                                                                                |
| Error                  | `.form-error` (role="alert" when focus does not move to the field) linked via `aria-describedby`, plus `aria-invalid="true"` and a `.error`/`[aria-invalid="true"]` border tint on the input. Colour is never the only signal — the error text says it in words. Focus stays on, or returns to, the field at fault.                                                                                                                                                                                       |
| Success/pending status | `.form-status` (role="status", `--text-positive`), announced politely, not assertively.                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Responsive rules

Beta is **desktop-only**. The Tauri window has a hard minimum size of **940×500px** (`Client/src-tauri/tauri.conf.json`), and the accessibility bar requires nothing to clip or become unreachable at that minimum with 20px text and OS 200% zoom (WCAG 1.4.10 as applied to desktop) — there is no mobile or tablet tier.

The only `@media` width breakpoints found in `Client/src/styles/`:

| Breakpoint          | File                 | Effect                                                              |
| ------------------- | -------------------- | ------------------------------------------------------------------- |
| `max-width: 1200px` | `app/responsive.css` | collapses `.member-list` to width 0                                 |
| `max-width: 800px`  | `app/responsive.css` | collapses `.channel-sidebar`/`.unified-sidebar` to width 0          |
| `max-width: 700px`  | `login.css`          | narrows `.server-panel` and `.form-container` on the connect screen |

`prefers-reduced-motion: reduce` queries exist in `login.css`, `app/chat-area.css`, and `app/profile-popup.css` to zero out specific animations; the app-wide mechanism is the `.reduced-motion` class (see Accessibility below), not per-file media queries.

## Accessibility

The full contract is [`docs/architecture/b9-ui-contract.md`](docs/architecture/b9-ui-contract.md); this is the design-facing summary. It is a **WCAG 2.2 AA-oriented checklist, not a certification claim** — automated checks plus an owner OS-zoom review are the acceptance evidence.

### Thresholds (owner decision Q1)

| What                                                             | Minimum                        | Criterion                         |
| ---------------------------------------------------------------- | ------------------------------ | --------------------------------- |
| Text, placeholders, status messages                              | 4.5:1                          | WCAG 1.4.3                        |
| Large text, UI component boundaries, focus rings                 | 3:1                            | WCAG 1.4.3 / 1.4.11               |
| Pointer targets                                                  | 24×24px                        | WCAG 2.5.8                        |
| App text scale 12–20px, OS zoom 200%, the 940×500 minimum window | nothing clipped or unreachable | WCAG 1.4.10 as applied to desktop |

Disabled controls are exempt from contrast. Colour is never the only signal — an error states it is an error in words.

### Focus, keyboard, motion

- One visible focus indicator per control, ≥2px, ≥3:1, via `var(--focus-ring)` — see States above.
- Every action is reachable with Tab/Shift+Tab and activates with Enter (Space for buttons); nothing is hover-only. Dialogs trap Tab and restore focus on close. Radio groups/option grids/nav lists use roving tabindex (`setRovingTabindex`/`enableRovingNavigation` in `lib/a11y.ts`).
- Motion reduces when either the in-app **Reduce Motion** toggle or (when **Sync with OS**, on by default) the OS asks for it; neither source can force motion back on over the other. `lib/os-motion.ts` is the single writer of the `.reduced-motion` class on `<html>`; `app/accessibility.css` zeroes animation/transition durations under it. Feedback never depends on an animation playing.

### Announcements

| Situation                                                  | Pattern                                                                                                                            | Politeness          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Field error after submit                                   | `.form-error` + `aria-describedby` + `aria-invalid`, focus moved to the field (add `role="alert"` only when focus does _not_ move) | assertive when live |
| Pending/success/count/background result                    | `.form-status` or `role="status"`                                                                                                  | polite              |
| Blocking failure (login error banner, incompatible server) | `role="alert"`                                                                                                                     | assertive           |
| Toasts, typing indicator                                   | existing `aria-live="polite"` regions                                                                                              | polite              |

Live regions exist in the DOM before their text changes (a region inserted already filled is skipped by screen readers). An announcement never carries hidden, private, or secret content.

### Shared checks (`Client/tests/e2e/support/b9-accessibility.ts`)

Every B9 feature PR runs these against its own journey:

| Helper                           | Checks                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `setAppearance(page, prefs)`     | stores theme/accent/High Contrast/font size/Large Font/motion prefs, then reloads so real startup applies them            |
| `findUnnamedControls(root)`      | every visible focusable control has an accessible name                                                                    |
| `focusIndicator(page)`           | the focused element's ring is visible, ≥2px, ≥3:1 against its background                                                  |
| `textContrast(locator, pseudo?)` | text (or `::placeholder`) against its composited background                                                               |
| `tokenContrasts(page, pairs)`    | token pairs as the page actually resolves them                                                                            |
| `mountSharedControls(page)`      | the shared-controls fixture (modal, form, button, toggle, status classes) in every state, including pending/error/success |

`Client/tests/e2e/b9-primitives.spec.ts` demonstrates each helper, including negative controls proving each check fails when the underlying behaviour is removed.

## Sources

- [docs/architecture/b9-ui-contract.md](docs/architecture/b9-ui-contract.md)
- [Client/src/styles/tokens.css](Client/src/styles/tokens.css)
- [Client/src/styles/theme-neon-glow.css](Client/src/styles/theme-neon-glow.css)
- [Client/src/styles/base.css](Client/src/styles/base.css)
- [Client/src/styles/login.css](Client/src/styles/login.css)
- [Client/src/styles/app/accessibility.css](Client/src/styles/app/accessibility.css)
- [Client/src/styles/app/settings.css](Client/src/styles/app/settings.css)
- [Client/src/styles/app/responsive.css](Client/src/styles/app/responsive.css)
- [Client/src/styles/app/overlays.css](Client/src/styles/app/overlays.css)
- [Client/src/styles/app/messages.css](Client/src/styles/app/messages.css)
- [Client/src/components/settings/helpers.ts](Client/src/components/settings/helpers.ts)
- [Client/src/lib/modalFactory.ts](Client/src/lib/modalFactory.ts)
- [Client/tests/e2e/support/b9-accessibility.ts](Client/tests/e2e/support/b9-accessibility.ts)
- [Client/src-tauri/tauri.conf.json](Client/src-tauri/tauri.conf.json)
- [Client/CLAUDE.md](Client/CLAUDE.md)
