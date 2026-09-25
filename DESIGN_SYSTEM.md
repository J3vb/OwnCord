# Design system

Condensed from the sources listed at the end, at commit `7732f969` (2026-09-25). On conflict, the source documents win.

The visual rules for the desktop client: themes and tokens, typography, spacing, components, states, layout and accessibility. The binding contract is [docs/architecture/b9-ui-contract.md](docs/architecture/b9-ui-contract.md); token values live in `Client/src/styles/tokens.css`, `Client/src/styles/theme-neon-glow.css` and the `THEMES` map in `Client/src/components/settings/helpers.ts`.

## Brand direction

The visual direction is **Refined Neon** (owner decision Q13), applied across four themes: `neon-glow` (the default on a fresh install, and the OwnCord brand identity), `dark` (whose values are `tokens.css`'s `:root` defaults), `midnight`, and `light`.

`applyTheme()` (`components/settings/helpers.ts`) switches themes. It writes the theme's `THEMES` entry as inline custom properties on `<html>`, over `tokens.css`'s `:root` dark defaults, then `applyThemeByName()` (`lib/themes.ts`) sets `theme-<name>` on `<body>`. Only `body.theme-neon-glow` and `body.theme-light` (accent fills only) have CSS rules, so midnight is entirely its `THEMES` entry and most of light's palette is too: a new midnight or light value goes in `THEMES`. A user's custom accent (`applyAccent()`, inline on `<body>`) overrides the accent-derived tokens on top of whichever theme is active. High Contrast is a separate toggle layered over any theme.

Accessibility is load-bearing, not decorative: the app targets a WCAG 2.2 AA-oriented bar (owner decision Q1), checked automatically on every UI PR. It is not a certification claim.

## Color tokens

In the tables below, **`—` means the theme does not override the token and inherits the `dark` (`:root`) value.** `app/accessibility.css` holds the High Contrast overrides.

### Backgrounds

| Token            | dark (`:root`)    | neon-glow | midnight  | light     |
| ---------------- | ----------------- | --------- | --------- | --------- |
| `--bg-tertiary`  | `#1e1f22`         | `#0b0c0e` | `#0f1a38` | `#e3e5e8` |
| `--bg-secondary` | `#2b2d31`         | `#111214` | `#16213e` | `#f2f3f5` |
| `--bg-primary`   | `#313338`         | `#17181b` | `#1a1a2e` | `#ffffff` |
| `--bg-input`     | `#383a40`         | `#222328` | `#232845` | `#ebedef` |
| `--bg-hover`     | `#35373c`         | `#1d1e22` | —         | `#e8e9ed` |
| `--bg-active`    | `#404249`         | `#27282d` | —         | `#dcdfe4` |
| `--bg-overlay`   | `rgba(0,0,0,0.7)` | —         | —         | —         |

### Accent

| Token                                 | dark      | neon-glow | midnight | light     |
| ------------------------------------- | --------- | --------- | -------- | --------- |
| `--accent` (fill)                     | `#5865f2` | `#00c8ff` | —        | `#4f5bd5` |
| `--accent-hover`                      | `#4752c4` | `#26d0ff` | —        | `#4150c4` |
| `--accent-active`                     | `#3c45a5` | `#4dd9ff` | —        | `#3740a8` |
| `--on-accent` (text/icons on a fill)  | `#ffffff` | `#000000` | —        | —         |
| `--accent-text` (accent used as text) | `#a3aaf8` | `#2fd0ff` | —        | `#4150c4` |
| `--focus-ring`                        | `#a3aaf8` | `#2fd0ff` | —        | `#4752c4` |

Dark and midnight's fill `#5865f2` (2.47–3.72:1) and light's `#4f5bd5` (4.39:1 on `--bg-tertiary`) read below the Q1 4.5:1 bar as **text**; neon-glow's `#00c8ff` passes (≥7.99:1), but the theme pins its own tested `#2fd0ff`. That is why `--accent-text` and `--focus-ring` are separate, tested tokens: never substitute `--accent` for either. A custom accent always wins for fills; it wins for `--accent-text`/`--focus-ring` only when it independently clears 4.5:1 / 3:1 on every surface, otherwise those two fall back to the theme's tested value (fail closed). High Contrast always restores the theme's tested `--accent-text`/`--focus-ring`, even over a readable custom accent.

### Text and status

| Token                | dark      | neon-glow            | midnight  | light     |
| -------------------- | --------- | -------------------- | --------- | --------- |
| `--text-normal`      | `#dbdee1` | `#dfe2e6`            | `#e2e4ef` | `#2a2c31` |
| `--text-muted`       | `#a9aeb6` | `#a3a9b2`            | `#a9b0c8` | `#51545c` |
| `--text-faint`       | `#80848e` | —                    | —         | `#747f8d` |
| `--text-micro`       | `#6d6f78` | —                    | —         | `#949ba4` |
| `--text-link`        | `#4cc0ff` | `var(--accent-text)` | `#5cc8ff` | `#00658f` |
| `--text-positive`    | `#62c28c` | `#5cc389`            | —         | `#17703f` |
| `--text-warning`     | `#f2b84b` | `#f2b84b`            | —         | `#7a5500` |
| `--text-danger`      | `#ff9a9c` | `#ff8f92`            | —         | `#b3261e` |
| `--header-primary`   | `#f2f3f5` | `#f4f5f7`            | `#f4f5fa` | `#060607` |
| `--header-secondary` | `#b5bac1` | —                    | —         | `#4e5058` |

`--text-faint` and `--text-micro` are for incidental text only (decoration, separators, disabled) and are **not contrast-qualified**. Every other text token above is ≥4.5:1 on each of the four surfaces (`--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--bg-input`) in every theme, with and without High Contrast.

### Borders, status fills, and other tokens

| Token                                                           | Value                                                                                                                 | Note                                                                                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--border`                                                      | `#3f4147` (neon-glow: `rgba(0,200,255,0.08)`, light: `#e3e5e8`)                                                       | decorative separator only                                                                                                                               |
| `--border-strong`                                               | `#4e5058` (neon-glow: `rgba(0,200,255,0.15)`, light: `#cbccd1`)                                                       | decorative separator only                                                                                                                               |
| `--border-control`                                              | `#7a7f89` (neon-glow: `#5f6773`, midnight: `#6a7194`, light: `#7d838d`)                                               | the 1px edge of an input or control, ≥3:1 on `--bg-primary`/`--bg-secondary`                                                                            |
| `--border-glow`                                                 | `transparent` (neon-glow: `rgba(0,200,255,0.08)`)                                                                     | neon panel edge; decorative, invisible outside neon-glow                                                                                                |
| `--accent-primary` / `--accent-secondary` / `--accent-gradient` | `var(--accent)` / `var(--accent-hover)` / a 135° gradient of the two (neon-glow: secondary is brand purple `#7b2fff`) | brand gradient fills; the first stop follows a custom accent                                                                                            |
| `--green` / `--yellow` / `--red`                                | `#23a55a` / `#f0b232` / `#f23f43`                                                                                     | fill colours only; use `--text-positive`/`--text-warning`/`--text-danger` for text                                                                      |
| `--danger-fill` / `--danger-fill-hover`                         | `#d0302f` / `#b3272a` (light: `#c62828` / `#a61f1f`)                                                                  | destructive button fills; ≥4.5:1 with white text (`--red` itself misses that)                                                                           |
| `--on-fill`                                                     | `#ffffff`                                                                                                             | text/icons on a theme-independent fill or media scrim                                                                                                   |
| `--on-warning`                                                  | `#1e1f22`                                                                                                             | text on the `--yellow` warning fill                                                                                                                     |
| `--role-owner`/`--role-admin`/`--role-mod`/`--role-member`      | `#e74c3c` / `#f39c12` / `#2ecc71` / `#949ba4`                                                                         | server role colours; a role colour is used as text only through `readableRoleColor()` in `lib/themes.ts`, which clamps to `--text-normal` if unreadable |
| `--scrim` / `--scrim-strong` / `--scrim-hover`                  | `rgba(0,0,0,0.6)` / `rgba(0,0,0,0.85)` / `rgba(255,255,255,0.2)`                                                      | overlays on media                                                                                                                                       |

### High Contrast overrides (`app/accessibility.css`)

| Token                            | dark/neon-glow/midnight          | light                 |
| -------------------------------- | -------------------------------- | --------------------- |
| `--text-normal`                  | `#ffffff`                        | `#000000`             |
| `--text-muted`                   | `#cccccc`                        | `#2e3035`             |
| `--bg-active`                    | `rgba(255,255,255,0.15)`         | `rgba(0,0,0,0.15)`    |
| `--accent-text` / `--focus-ring` | `#a3aaf8` (neon-glow: `#2fd0ff`) | `#4150c4` / `#4752c4` |

### Rules

- Text on an accent fill is `var(--on-accent)`, never `white` or a literal hex.
- The accent used as text is `var(--accent-text)`, never `var(--accent)`.
- A focus indicator is `var(--focus-ring)`, never `var(--accent)`.
- A badge or banner with white text fills with `--danger-fill`, not `--red`.
- An input's edge is `1px solid var(--border-control)`; a fill difference alone is not a boundary. Placeholders are `--text-muted`.
- Contrast is checked against every surface a token can sit on: `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--bg-input`.
- Kept literal (deliberately not tokenized): the true-black video letterbox, each theme tile's own preview swatch, and px glyph sizes in fixed boxes (avatar initials, icon buttons, emoji).

## Typography

| Token            | Value                                                                              |
| ---------------- | ---------------------------------------------------------------------------------- |
| `--font-display` | `"Segoe UI Variable Display", "Segoe UI", "Inter Variable", system-ui, sans-serif` |
| `--font-body`    | `"Segoe UI Variable Text", "Segoe UI", "Inter Variable", system-ui, sans-serif`    |
| `--font-mono`    | `"Cascadia Code", "Consolas", monospace`                                           |

Segoe UI Variable is used on Windows; everywhere else (Linux builds) the bundled Inter Variable (`Client/src/assets/fonts/`, SIL OFL 1.1) is the fallback, declared via `@font-face` in `base.css` with `font-src` restricted to `'self'`. No font is ever fetched from a CDN.

### Scale

Every step is `calc(var(--font-size, 16px) * factor)`, so it follows the Appearance "Large Font" size (12–20px, default 16px, `--font-size` written inline on `<html>` by `appearance.ts`). The px column is the value at the 16px default.

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

Glyphs sized to a fixed box (avatar initials, icon buttons, emoji) keep literal px, not the scale.

## Spacing

4px-step scale (`tokens.css`):

| Token                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| `--space-1` … `--space-8` | `4px`, `8px`, `12px`, `16px`, `20px`, `24px`, `28px`, `32px` |

Layout constants also defined in `tokens.css`: `--sidebar-width: 240px`, `--header-height: 48px`, and the message-layout tokens `--message-group-spacing: 17px`, `--message-inline-spacing: 0`, `--avatar-size: 40px`, `--avatar-offset-left: 16px`, `--message-content-left: 72px`, `--message-content-right: 48px`.

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

**Reuse an existing component, helper or CSS class before adding a new one.**

- Shared UI components live under `Client/src/components/` (e.g. `SettingsOverlay.ts`, `EditChannelModal.ts`).
- Shared helpers live in `Client/src/lib/`: `modalFactory.ts`, `a11y.ts`, `dom.ts`, `icons.ts` (`createIcon`, the one icon source: Lucide inline SVG with a `currentColor` stroke), `context-menu.ts` (`showContextMenu`; `enableMenuKeyboard`, `createMenuItem` and `openMenuOnKeyboard` give a hand-built menu the same keyboard model), `avatar.ts` (`createAvatarElement`) and `toast.ts` (`showToast`). Settings UI adds `components/settings/helpers.ts`: `createToggle`, `appendToggleRows`, and `outcomeEl`/`showOutcome` for `.form-error`/`.form-status`/`.form-warning` with their live roles.
- Style rules live in `Client/src/styles/`, which `main.ts` imports as `tokens.css`, `base.css`, `login.css`, `app.css`, `theme-neon-glow.css`, in that order. The shared modal, button, form, checkbox and spinner classes are in `login.css` (its "MODALS (shared)" and form sections), not `app/`. `app.css` is an `@import` manifest over `app/*.css` whose order is the cascade: add rules to the owning fragment, and never reorder imports or move rules between fragments in a visual PR.
- All UI text, including `aria-label`s and toast copy, comes from an English catalog under `Client/src/i18n/`. `tests/unit/ui-strings.test.ts` fails on new literal UI text unless it is marked `// i18n-exempt: <reason>`.

| Pattern                                | Classes / factory                                                                                                                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modal dialog                           | `.modal-overlay.visible > .modal[role=dialog][aria-modal]` (`.modal-header`, `.modal-body`, `.modal-footer`)                         | Build with `createModal()` (`Client/src/lib/modalFactory.ts`): it applies dialog semantics, moves focus into the dialog, traps Tab, closes on Escape and backdrop click by default (`closeOnEscape`/`closeOnBackdrop`), and restores focus to the opener. Pass `ariaLabel`/`ariaLabelledBy`; pass `fallbackFocus` if the dialog can remove its own opener, and the owning component's `signal` so the modal tears itself down with its owner. |
| Primary/save button                    | `.btn-primary`, `.btn-modal-save`                                                                                                    | Accent fill, `--on-accent` text; `.btn-primary` has a `.loading` state with `.btn-spinner`.                                                                                                                                                                                                                                                                                                                                                   |
| Secondary/cancel button                | `.btn-modal-cancel`, `.btn-ghost`                                                                                                    | Transparent or muted background.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Destructive button                     | `.btn-danger`                                                                                                                        | `--danger-fill` background, `--on-fill` text.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Text input                             | `.form-input` (+ `.form-group`, `.form-label`, `.form-error`, `.form-status`, `.form-warning`, `.form-hint`)                         | 1px `--border-control` edge; the error state adds `.error`/`[aria-invalid="true"]`; no separate focus border or glow, since the base `--focus-ring` outline is the one ring. `.form-hint` is `--text-faint`, so it is not contrast-qualified: incidental hints only.                                                                                                                                                                          |
| Checkbox                               | `label.form-check` wrapping a native `input[type=checkbox]`                                                                          | `accent-color: var(--accent)`; the native input keeps keyboard focus and the base ring. `.form-checkbox`/`.checkbox-box` in `login.css` are unused and hide the input: do not use them.                                                                                                                                                                                                                                                       |
| Toggle switch                          | `.toggle[role=switch]` via `createToggle()` (`components/settings/helpers.ts`)                                                       | Requires a `label` option, which becomes the accessible name.                                                                                                                                                                                                                                                                                                                                                                                 |
| Settings row                           | `.setting-row`, `.setting-label`, `.setting-desc`                                                                                    | Used inside `SettingsOverlay`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Toast                                  | `.toast-container > .toast.show` with `.toast-info`/`.toast-error`/`.toast-success`/`.toast-warning`                                 | Left-border colour by kind. Show one with `showToast(message, type?, durationMs?)` from `lib/toast.ts`; `components/Toast.ts` is the single `role="status"`/`aria-live="polite"` container MainPage creates. Do not build another.                                                                                                                                                                                                            |
| Connection progress / reconnect banner | `.status-bar` (`.status-bar-fill`, `.visible`, `.indeterminate`); `.reconnecting-banner` (`.visible`, `.reconnecting-banner-action`) | `.status-bar` is the connect page's 4px accent progress strip; `.reconnecting-banner` is a `--yellow` bar with `--on-warning` text. Non-modal transient state.                                                                                                                                                                                                                                                                                |

## States (hover, focus, active, disabled, loading, empty, error)

| State                  | Pattern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hover                  | A `--bg-hover` fill or the `--accent-hover` step (e.g. `.settings-nav-item:hover` → `--bg-hover`; `.btn-primary:hover` → `--accent-hover`). `.form-input:hover` swaps its edge to the decorative `--border-strong`, which is lower-contrast than the resting `--border-control` in dark, midnight and neon-glow: do not copy it for a new control.                                                                                                                                                         |
| Focus                  | A single 2px `var(--focus-ring)` outline with a 2px offset, drawn by `base.css` on `:focus-visible` for buttons, inputs, selects, textareas, links and focusable `[tabindex]` elements. Never suppressed without a ≥2px/3:1 replacement; never `var(--accent)`. The composer draws one ring, on its outer `.message-input-box` (`:has(.msg-textarea:focus-visible)`), and the textarea draws none; login `.form-input` fields show only the base outline on the input itself.                              |
| Active                 | The `--accent-active` step (e.g. `.btn-primary:active`): darker under a white `--on-accent`, lighter under a black one. Neon-glow's is `#4dd9ff`.                                                                                                                                                                                                                                                                                                                                                          |
| Disabled               | `.btn-primary:disabled` → `--border-strong` background, `--text-faint` text, `cursor: not-allowed`. Disabled controls are exempt from the contrast bar. A _pending_ control uses `aria-busy="true"`/`aria-disabled="true"` instead of the `disabled` attribute, because disabling a focused element drops focus to `<body>`. The exceptions are the Settings account/recovery forms and the connect page's login/2FA/recovery forms, which set `disabled` and restore focus afterwards with `focusIsOurs`. |
| Loading                | `.btn-primary.loading` hides `.btn-text` and shows `.btn-spinner` (a `.spinner` div, `animation: spin`).                                                                                                                                                                                                                                                                                                                                                                                                   |
| Empty                  | No shared empty-state component: each view owns a `.<view>-empty` block (e.g. `.channel-list-empty` with `-text`/`-hint`, `.member-list-empty`, `.server-empty`). Follow that naming. The UX spec requires every data-bearing view to show a labelled empty state with a one-line "what goes here / what to do next" hint ([docs/architecture/ux/README.md](docs/architecture/ux/README.md)).                                                                                                              |
| Error                  | `.form-error` (`role="alert"` when focus does not move to the field) linked via `aria-describedby`, plus `aria-invalid="true"` and a `.error`/`[aria-invalid="true"]` border tint on the input. Colour is never the only signal: the error text says it in words. Focus stays on, or returns to, the field at fault.                                                                                                                                                                                       |
| Success/pending status | `.form-status` (`role="status"`, `--text-positive`), announced politely, not assertively.                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Responsive rules

Beta is **desktop-only**. The Tauri window has a hard minimum size of **940×500px** (`Client/src-tauri/tauri.conf.json`), and the accessibility bar requires nothing to clip or become unreachable at that minimum with 20px text and OS 200% zoom (WCAG 1.4.10 as applied to desktop). There is no mobile or tablet tier.

The only `@media` width breakpoints in `Client/src/styles/`:

| Breakpoint          | File                 | Effect                                                                                                                                                                         |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `max-width: 1200px` | `app/responsive.css` | zeroes `.member-list` padding and clips overflow; the width stays 100% (a more specific `.sidebar-members-section .member-list` rule wins), so it does not collapse to width 0 |
| `max-width: 800px`  | `app/responsive.css` | collapses `.unified-sidebar` to width 0; the header's menu button reopens it as a drawer                                                                                       |
| `max-width: 700px`  | `login.css`          | narrows `.server-panel` and `.form-container` on the connect screen                                                                                                            |

`prefers-reduced-motion: reduce` queries exist in `login.css`, `app/chat-area.css` and `app/profile-popup.css` to zero out specific animations; the app-wide mechanism is the `.reduced-motion` class (see [Accessibility](#accessibility)), not per-file media queries.

## Accessibility

The full contract is [docs/architecture/b9-ui-contract.md](docs/architecture/b9-ui-contract.md); this is the design-facing summary. It is a **WCAG 2.2 AA-oriented checklist, not a certification claim**: automated checks are the acceptance evidence (the manual screen-reader recordings were declined on 2026-09-24 and the OS 200 % zoom check was automated on 2026-09-25; see the contract's [checks](docs/architecture/b9-ui-contract.md#checks-for-a-feature-pr)).

### Thresholds (owner decision Q1)

| What                                                             | Minimum                        | Criterion                         |
| ---------------------------------------------------------------- | ------------------------------ | --------------------------------- |
| Text, placeholders, status messages                              | 4.5:1                          | WCAG 1.4.3                        |
| Large text, UI component boundaries, focus rings                 | 3:1                            | WCAG 1.4.3 / 1.4.11               |
| Pointer targets                                                  | 24×24px                        | WCAG 2.5.8                        |
| App text scale 12–20px, OS zoom 200%, the 940×500 minimum window | nothing clipped or unreachable | WCAG 1.4.10 as applied to desktop |

Disabled controls are exempt from contrast. Colour is never the only signal: an error says it is an error in words.

### Focus, keyboard, motion

- One visible focus indicator per control, ≥2px and ≥3:1, via `var(--focus-ring)` (see [States](#states-hover-focus-active-disabled-loading-empty-error)).
- Every action is reachable with Tab/Shift+Tab and activates with Enter (Space for buttons); nothing is hover-only. Dialogs trap Tab and restore focus on close. Radio groups, option grids and nav lists use roving tabindex (`setRovingTabindex`/`enableRovingNavigation` in `lib/a11y.ts`).
- Motion reduces when either the in-app **Reduce Motion** toggle or, with **Sync with OS** (on by default), the OS asks for it; neither source can force motion back on over the other. `syncOsMotionListener()` in `lib/os-motion.ts` derives the `.reduced-motion` class on `<html>` (`applyStoredAppearance()` pre-sets it from the manual preference, then calls it); never toggle the class anywhere else. `app/accessibility.css` zeroes animation and transition durations under it. Feedback never depends on an animation playing.

### Announcements

| Situation                                                  | Pattern                                                                                                                            | Politeness          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Field error after submit                                   | `.form-error` + `aria-describedby` + `aria-invalid`, focus moved to the field (add `role="alert"` only when focus does _not_ move) | assertive when live |
| Pending/success/count/background result                    | `.form-status` or `role="status"`                                                                                                  | polite              |
| Blocking failure (login error banner, incompatible server) | `role="alert"`                                                                                                                     | assertive           |
| Toasts, typing indicator                                   | existing `aria-live="polite"` regions                                                                                              | polite              |

Live regions exist in the DOM before their text changes (a region inserted already filled is skipped by screen readers). An announcement never carries hidden, private or secret content.

### Shared checks (`Client/tests/e2e/support/b9-accessibility.ts`)

Every UI PR runs these against its own journey:

| Export                           | Checks                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Q1`                             | the thresholds as constants (`Q1.text` 4.5, `Q1.nonText` 3, `Q1.focus` 3); assert against these, not literal ratios            |
| `setAppearance(page, prefs)`     | stores theme/accent/High Contrast/font size/Large Font/motion prefs, then reloads so real startup applies them                 |
| `findUnnamedControls(root)`      | every visible focusable control has an accessible name                                                                         |
| `focusIndicator(page)`           | the focused element's ring is visible, ≥2px, ≥3:1 against its background                                                       |
| `textContrast(locator, pseudo?)` | text (or `::placeholder`) against its composited background                                                                    |
| `tokenContrasts(page, pairs)`    | token pairs as the page actually resolves them                                                                                 |
| `tokenHex(page, token)`          | a token as `<body>` resolves it, as `#rrggbb` (`""` if unset)                                                                  |
| `mountSharedControls(page)`      | the shared-controls fixture (modal, form, button, toggle, status classes) in every state, including pending, error and success |

`Client/tests/e2e/b9-primitives.spec.ts` demonstrates each helper, including negative controls proving each check fails when the underlying behaviour is removed.

## Sources

- [docs/architecture/b9-ui-contract.md](docs/architecture/b9-ui-contract.md), [docs/architecture/ux/README.md](docs/architecture/ux/README.md)
- [Client/src/styles/tokens.css](Client/src/styles/tokens.css), [Client/src/styles/theme-neon-glow.css](Client/src/styles/theme-neon-glow.css), [Client/src/styles/base.css](Client/src/styles/base.css), [Client/src/styles/login.css](Client/src/styles/login.css)
- [Client/src/styles/app/accessibility.css](Client/src/styles/app/accessibility.css), [Client/src/styles/app/settings.css](Client/src/styles/app/settings.css), [Client/src/styles/app/responsive.css](Client/src/styles/app/responsive.css), [Client/src/styles/app/overlays.css](Client/src/styles/app/overlays.css), [Client/src/styles/app/composer.css](Client/src/styles/app/composer.css)
- [Client/src/components/settings/helpers.ts](Client/src/components/settings/helpers.ts), [Client/src/lib/themes.ts](Client/src/lib/themes.ts), [Client/src/lib/appearance.ts](Client/src/lib/appearance.ts), [Client/src/lib/os-motion.ts](Client/src/lib/os-motion.ts), [Client/src/lib/color-contrast.ts](Client/src/lib/color-contrast.ts)
- [Client/src/lib/modalFactory.ts](Client/src/lib/modalFactory.ts), [Client/src/lib/toast.ts](Client/src/lib/toast.ts), [Client/src/lib/icons.ts](Client/src/lib/icons.ts), [Client/src/main.ts](Client/src/main.ts)
- [Client/tests/e2e/support/b9-accessibility.ts](Client/tests/e2e/support/b9-accessibility.ts), [Client/tests/unit/ui-strings.test.ts](Client/tests/unit/ui-strings.test.ts)
- [Client/src-tauri/tauri.conf.json](Client/src-tauri/tauri.conf.json), [Client/CLAUDE.md](Client/CLAUDE.md)
