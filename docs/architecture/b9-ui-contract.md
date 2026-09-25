# B9 shared UI contract

**Status:** in force from B9-2, 2026-09-23.
**Decisions:** owner Q1 (accessibility acceptance), Q8 (theme and custom
accent), with the 2026-09-23 Q8 clarification, and Q13 (visual direction: Refined
Neon), in
[b9-unified-experience-accessibility-polish.prd.md](../plans/b9-unified-experience-accessibility-polish.prd.md#open-questions).
**Evidence:** [b9-shared-a11y-evidence-2026-09-23.md](../plans/b9-shared-a11y-evidence-2026-09-23.md).

Every B9 feature PR builds its screens from the tokens and patterns below and
runs the shared checks in `Client/tests/e2e/support/b9-accessibility.ts`
against its own journey. The bar is Q1's WCAG 2.2 AA-oriented checklist, not a
certification claim. Automated checks supplement the owner's review; the owner
**declined the native NVDA/Orca recordings on 2026-09-24**, so the automated
checks and the owner OS 200 % zoom checks are the acceptance evidence and no
lane is blocked by the absent recordings.

Four interpretations of Q1/Q8 made while implementing B9-2 were accepted by
the owner on 2026-09-23:

1. "Contrast against the theme background" means the minimum over all four
   surfaces the accent can sit on (see [Colour tokens](#colour-tokens)).
2. **Sync with OS** defaults to on, and motion is reduced when either the OS
   or the in-app toggle asks (see [Motion](#motion)).
3. `--text-faint` and `--text-micro` are for incidental text only, and are
   measured but not qualified.
4. The Q8 fallback target is the theme's tested `--accent-text`/`--focus-ring`
   token. Since Q13 it is `#2fd0ff` on neon-glow, `#a3aaf8` on dark and
   midnight, and on light `#4150c4` as text and `#4752c4` as the focus ring.
   The default fill accents (`#00c8ff`, `#5865f2`, light's `#4f5bd5`) are
   below Q1 as text on at least one of their surfaces.

## Thresholds (Q1)

| What                                                                             | Minimum                        | Criterion                         |
| -------------------------------------------------------------------------------- | ------------------------------ | --------------------------------- |
| Text, including placeholders and status messages                                 | 4.5:1                          | WCAG 1.4.3                        |
| Large text, UI component boundaries, focus rings                                 | 3:1                            | WCAG 1.4.3/1.4.11                 |
| Pointer targets                                                                  | 24×24px                        | WCAG 2.5.8                        |
| App text scale 12–20px with Large Font, OS zoom 200%, the 940×500 minimum window | nothing clipped or unreachable | WCAG 1.4.10 as applied to desktop |

Disabled controls are exempt from contrast, as WCAG allows. Colour is never
the only signal: an error says it is an error in words.

## Colour tokens

`Client/src/styles/tokens.css` holds the dark defaults, which midnight shares
where its `THEMES` entry does not override them, and light's accent fills
(`body.theme-light`). `theme-neon-glow.css` and the midnight and light entries
in `components/settings/helpers.ts` `THEMES` override them.
`app/accessibility.css` holds High Contrast. A "surface" is any of
`--bg-primary`, `--bg-secondary`, `--bg-tertiary` and `--bg-input`. The values
are the owner's Q13 direction A, Refined Neon.

| Token                                                                     | Use                                                    | Qualified                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| `--text-normal`, `--text-muted`, `--header-primary`, `--header-secondary` | body text, secondary text, headings                    | ≥ 4.5:1 on every surface, every theme, High Contrast       |
| `--text-link`                                                             | links                                                  | same                                                       |
| `--text-positive`, `--text-warning`, `--text-danger`                      | success, warning and error **text**                    | same                                                       |
| `--accent-text`                                                           | the accent used as text (selected item, active option) | same, including every preset accent                        |
| `--focus-ring`                                                            | every focus indicator                                  | ≥ 3:1 on every surface                                     |
| `--on-accent`                                                             | text or icons on an accent fill                        | ≥ 4.5:1 on `--accent`, `--accent-hover`, `--accent-active` |
| `--danger-fill`, `--danger-fill-hover`                                    | destructive button fills (white text)                  | ≥ 4.5:1 with white                                         |
| `--border-control`                                                        | the 1px edge of an input or other control              | ≥ 3:1 on `--bg-primary` and `--bg-secondary` (1.4.11)      |
| `--on-fill`, `--on-warning`                                               | text on a theme-independent fill or media scrim        | white on `--danger-fill`; `--on-warning` on `--yellow`     |
| `--text-faint`, `--text-micro`                                            | incidental text only: decoration, separators, disabled | **not qualified**                                          |

Rules:

- Text on an accent fill is `var(--on-accent)`, never `white` or `#fff`.
- The accent as text is `var(--accent-text)`, never `var(--accent)`.
- A focus indicator is `var(--focus-ring)`, never `var(--accent)`.
- `--red`, `--green` and `--yellow` are fill colours. For text, use the
  `--text-*` status tokens. A badge or banner with white text fills with
  `--danger-fill`, not `--red`.
- An input's edge is `1px solid var(--border-control)`; a fill difference
  alone is not a boundary. Placeholders are `--text-muted`.
- A role colour (server-set) is text only through `readableRoleColor()` in
  `lib/themes.ts`: the colour where it reads at 4.5:1 on every surface,
  otherwise `--text-normal`, with the same math as `--accent-text`. The element
  keeps the raw colour in `data-role-color`, and a theme switch re-clamps it.
- Style sheets use tokens, not literals: colours from the tables above,
  shadows `--shadow-sm/md/lg`, media scrims `--scrim`, `--bg-overlay`,
  `--scrim-strong` and `--scrim-hover`, radii `--radius-sm/md/lg/pill/circle`
  (4 / 8 / 12 / pill), spacing `--space-1..8` (4px steps), and text sizes
  `--font-size-xxs..xxl` and `--font-size-display`, which follow the app text
  scale. Kept literals are deliberate: true-black video letterbox, each theme
  tile's own preview colours, and px glyph sizes in fixed boxes (avatar
  initials, icon buttons, emoji).
- Do not use `--text-faint` or `--text-micro` for text a user needs to read.
  Their ~78 existing uses predate B9-2, and the feature polish milestones
  (B9-21..B9-24) review them. Qualifying these tokens at 4.5:1 would make
  them the same colour as `--text-muted`, so B9-2 records them instead.

### Custom accent (Q8)

`applyAccent()` in `Client/src/lib/themes.ts` is the only writer of the
accent's inline tokens. The math lives in `Client/src/lib/color-contrast.ts`.

- **Fills** always take the user's colour.
- **`--on-accent`** is white or black, whichever contrasts more with the
  accent (WCAG relative luminance). Black rather than a softer near-black
  guarantees ≥ 4.58:1 on any accent.
- **`--accent-hover`** and **`--accent-active`** mix the accent 15% and 30%
  away from `--on-accent`: darker under white text, lighter under black. Their
  contrast with the text therefore only rises.
- **`--accent-text`** is the user's colour only if it reaches 4.5:1 on every
  surface.
- **`--focus-ring`** is the user's colour only if it reaches 3:1 on every
  surface.
- Below either threshold, that use keeps the theme's tested colour. An
  unreadable surface also falls back (fail closed). This split by use is the
  owner's 2026-09-23 clarification of Q8 aligning it with Q1.
- **High Contrast** restores every theme's tested `--accent-text` and
  `--focus-ring`, even over a readable custom accent.
- The Appearance tab discloses this under the accent input.

## Typography

`--font-body` and `--font-display` are Segoe UI Variable on Windows and the
bundled Inter Variable (`Client/src/assets/fonts/`, SIL OFL 1.1, licence
beside it) everywhere else. The `@font-face` is in `base.css`; font-src is
`'self'`, and no font is ever fetched from a CDN.

## Focus

- `base.css` draws a 2px `--focus-ring` outline, offset 2px, on
  `:focus-visible` for buttons, inputs, selects, textareas, links and every
  `[tabindex]` element except `tabindex="-1"` containers. Do not suppress it.
  If a control needs a different shape, replace the outline with another
  indicator of at least 2px at 3:1. Never remove it without a replacement.
  The `[tabindex]` part is wrapped in `:where()`, so a component
  `.x:focus-visible` rule overrides it; for the same reason, never set
  `outline: none` outside a `:focus-visible` rule on a `[tabindex]` widget.
- The composer draws one ring: `.message-input-box` takes the textarea's
  `--focus-ring` outline around the whole box, and the textarea draws none.
  Login fields likewise show only the base outline, with no focus glow.
- Dialogs use `createModal` (`Client/src/lib/modalFactory.ts`). It applies
  `role="dialog"` and `aria-modal`, traps Tab, closes on Escape, and restores
  focus to the opener on close.
  - Pass `ariaLabel` or `ariaLabelledBy` to name the dialog.
  - Pass `fallbackFocus` when the dialog can remove its own opener (deleting
    the row that opened it). Otherwise focus drops to `<body>`.
- Pending states keep focus where it is. Mark a busy button with
  `aria-busy="true"` and `aria-disabled="true"`, not `disabled`: disabling
  the focused button moves focus to `<body>`. Exception: the Settings
  account and recovery forms and the connect page's login, 2FA and recovery
  forms still set `disabled` and, once the request settles, put focus back
  with `focusIsOurs` (`lib/dom.ts`).
- After an error, focus stays on or returns to the field at fault.

## Keyboard

| Control                                       | Keys                                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every action                                  | reachable with Tab/Shift+Tab; activates with Enter (and Space for buttons); nothing is hover-only                                                                           |
| Dialog                                        | Tab cycles inside; Escape closes and restores focus                                                                                                                         |
| Switch (`createToggle`)                       | Enter or Space toggles; `label` is required and becomes the accessible name                                                                                                 |
| Radio group, grid of options, navigation list | `setRovingTabindex` + `enableRovingNavigation` (`lib/a11y.ts`): one Tab stop, arrows/Home/End move, Enter/Space choose; a stacked list passes `"vertical"` for ArrowUp/Down |
| Combobox over a listbox                       | as the quick switcher: `aria-controls`, `aria-activedescendant`                                                                                                             |

## Announcements

| Situation                                                                                  | Pattern                                                                                                                                                                                                                                                                                       | Politeness          |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| A field error after submit                                                                 | `.form-error` whose id is in the input's `aria-describedby`, `aria-invalid="true"` on the input, and focus moved to the input with no live role. Add `role="alert"` only when focus does not move (the field already has focus, or focus stays on the submit), so the error is announced once | assertive when live |
| Pending ("Saving…"), success, a count or a background result                               | `.form-status` or another element with `role="status"` (or `aria-live="polite"`)                                                                                                                                                                                                              | polite              |
| A blocking failure that stops the journey (the login error banner, an incompatible server) | `role="alert"`                                                                                                                                                                                                                                                                                | assertive           |
| Toasts, typing indicator                                                                   | the existing `aria-live="polite"` regions                                                                                                                                                                                                                                                     | polite              |

Live regions exist in the DOM before their text changes. Screen readers skip
a region that is inserted already filled. An announcement never carries
hidden, private or secret content: no message bodies from gated content, no
tokens, no keys.

## Motion

Motion is reduced when the in-app **Reduce Motion** toggle is on, or when
**Sync with OS** is on and the OS asks for it. Sync with OS defaults to on.
Either source can reduce motion, and neither can force it back on over the
other. `lib/os-motion.ts` is the single writer of the `reduced-motion` class
on `<html>`, and `app/accessibility.css` zeroes animation and transition
durations under it. Feedback never depends on an animation playing.

## Teardown ownership

Listeners belong to the owning component's `AbortSignal` or `Disposable`.
`createModal` takes a `signal` and tears itself down, restoring focus, when
the signal aborts. The lifecycle rules are in `Client/CLAUDE.md` (B7-11).

## Checks for a feature PR

From `Client/tests/e2e/support/b9-accessibility.ts`:

| Helper                            | What it checks                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `setAppearance(page, prefs)`      | stores theme, accent, High Contrast, font size, Large Font and motion prefs, then reloads so startup applies them |
| `findUnnamedControls(root)`       | every visible focusable control under `root` has an accessible name                                               |
| `focusIndicator(page)`            | the focused element's ring is visible, at least 2px, and 3:1 against its background                               |
| `keyboardReachable(page, target)` | Tab from the top of the document reaches `target`; a named control can still be unfocusable                       |
| `textContrast(locator, pseudo?)`  | text (or `::placeholder`) against its composited background                                                       |
| `tokenContrasts(page, pairs)`     | token pairs as the page resolves them                                                                             |
| `mountSharedControls(page)`       | the shared-controls fixture, including its pending, error and success states                                      |

`Client/tests/e2e/b9-primitives.spec.ts` shows each one in use, including
the negative controls that prove each check fails when its behaviour is
removed.

The OS 200 % zoom/reflow check is automated in
`Client/tests/e2e/support/b9-zoom.ts` (`ZOOM_VIEWPORT`, `auditReflow`,
`expectScreenReflows`): each screen is rendered at a 640×400 CSS viewport — the
layout a 1280×800 window shows at 200 % page zoom — and asserted to have no
horizontal page scroll, no vertical scroll area that also scrolls sideways, no
text or control clipped without an intended scroll area, no control painted
over, and every primary action reachable, with one screenshot per screen.
`Client/tests/e2e/b9-zoom.spec.ts` opens every screen through the entry point a
zoomed user actually has, after zooming.

Screens that pass at 200 %: the connect page (B9-18), the shell's message
surface, history and composer (B9-3, 18, 19, 21, 22), the search overlay, the
report dialog (B9-10), and every settings tab the connect page's Settings gear
(`button.settings-gear`) opens except Logs — Appearance, Notifications, Text &
Images, Accessibility, Voice & Audio, Keybinds and Advanced (B9-20, 23).

Failing at 200 %: the Logs tab's controls row (`LogsTab.ts`) does not wrap, so
its Copy All, Clear Logs and Refresh buttons push `.settings-content` into a
sideways scroll at 640 CSS px. The spec records it as `test.fail` until the
row is fixed.

Blocked on navigation: below 800 CSS px `responsive.css` collapses
`.unified-sidebar` to zero width with no toggle. Channels stay reachable
through the Ctrl+K quick switcher (`OverlayManagers.ts`), but DMs and the
sidebar itself do not, and neither does any screen whose only entry point lives
there. Those screens are `test.fixme`, each naming its entry point, until B8's
responsive navigation lands: the Message Requests inbox and its Block confirm
(B9-5, 6), My reports (the second half of B9-10), the Moderation Center
queue, review, actions and ban confirm (B9-11, 12, 13, 14), the appeal review
(B9-17), the signed-in Account pane (B9-20, 23; the user-bar Settings
button), and the sidebar navigation half of B9-18 and B9-21. Their 200 %
evidence is still open.
