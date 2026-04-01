# Design System — OwnCord

## Product Context
- **What this is:** Self-hosted Windows chat platform with voice, video, DMs, and text channels
- **Who it's for:** Gamers and small groups who want Discord-like features on their own hardware
- **Space/industry:** Self-hosted communication (peers: Discord, TeamSpeak, Revolt, Element)
- **Project type:** Desktop app (Tauri v2 — Rust backend, TypeScript frontend)

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian with Neon accents
- **Decoration level:** Intentional — subtle border glow (`--border-glow`), gradient accents, no heavy textures or patterns. The glow IS the decoration.
- **Mood:** A dark room with neon light strips. Function-first, data-dense, but with personality. Not sterile, not flashy — purposeful.
- **Reference sites:** Discord (layout conventions), Revolt (theming depth), TeamSpeak (audio-first UX)

## Typography
- **Display/Hero:** Segoe UI Variable Display — Windows-native, sharpest rendering on the target platform
- **Body:** Segoe UI Variable Text — consistent with Display, optimized for readability at small sizes
- **UI/Labels:** Same as body (10-12px uppercase with letter-spacing for section headers)
- **Data/Tables:** Segoe UI Variable Text with `font-variant-numeric: tabular-nums` — aligned columns
- **Code:** Cascadia Code — ships with Windows Terminal, ligature support
- **Loading:** No web fonts. System-native stack: `"Segoe UI Variable Display/Text", "Segoe UI", system-ui, sans-serif`
- **Scale:**
  - `--font-size-xxs`: 10px (micro labels, section headers)
  - `--font-size-xs`: 12px (timestamps, muted text, channel descriptions)
  - `--font-size-sm`: 13px (secondary content, voice user names)
  - `--font-size-md`: 14px (body text, messages, input fields)
  - `--font-size-lg`: 16px (channel names, headings)
  - `--font-size-xl`: 20px (page titles, modal headers)
  - `--font-size-xxl`: 24px (hero text, onboarding)

## Color
- **Approach:** Balanced — primary + secondary accent with full semantic palette
- **Primary accent:** `#00c8ff` (cyan) — the OwnCord signature. Used for links, focus rings, active states
- **Secondary accent:** `#7b2fff` (purple) — paired with cyan in gradient. Used for hover accent, gradient endpoints
- **Accent gradient:** `linear-gradient(135deg, #00c8ff, #7b2fff)` — the brand signature. Used on primary buttons, hero text, logo
- **Neutrals (Neon Glow theme):**
  - `#0d0e10` bg-tertiary (deepest — app shell)
  - `#111214` bg-secondary (sidebar, panels)
  - `#1a1b1e` bg-primary (main content area)
  - `#1f2023` bg-hover
  - `#252629` bg-input
  - `#2a2b2e` bg-active
- **Text hierarchy:**
  - `#f2f3f5` header-primary (brightest — page titles)
  - `#b5bac1` header-secondary (section headers)
  - `#dbdee1` text-normal (body text)
  - `#949ba4` text-muted (secondary info)
  - `#80848e` text-faint (timestamps, placeholders)
  - `#6d6f78` text-micro (lowest contrast)
- **Semantic:**
  - Success: `#23a55a` (green — online, speaking, connected)
  - Warning: `#f0b232` (yellow — poor connection, caution)
  - Danger: `#f23f43` (red — error, disconnect, deafened)
  - Info: `#00c8ff` (cyan — accent doubles as info)
- **Border glow:** `rgba(0, 200, 255, 0.08)` — subtle neon border treatment on panels and inputs. Increases to `0.15` on `:focus` and strong borders.
- **Dark mode:** This IS dark mode. The default theme uses Discord-standard dark tokens. Neon Glow deepens the blacks and adds cyan border glow. User can override accent via accent color picker.

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable (not compact, not spacious — matches Discord)
- **Scale:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64)
- **Key dimensions:**
  - Sidebar width: 240px
  - Header height: 48px
  - Avatar size: 40px (messages), 24px (voice users, member list)
  - Message group spacing: 17px
  - Message content left offset: 72px (avatar + padding)

## Layout
- **Approach:** Grid-disciplined — fixed sidebar + flexible content area. Discord conventions.
- **Grid:** Sidebar (240px fixed) | Content (flex) | Optional member list (240px, collapsible)
- **Max content width:** None (fills available space minus sidebar)
- **Border radius:**
  - `--radius-sm`: 4px (buttons, inputs, small elements)
  - `--radius-md`: 8px (cards, panels, modals)
  - `--radius-lg`: 16px (large containers, settings panel)
  - `--radius-pill`: 24px (badges, pills, tags)
  - `--radius-circle`: 50% (avatars)

## Motion
- **Approach:** Minimal-functional — only transitions that aid comprehension. Chat apps need speed, not spectacle.
- **Easing:** All use `ease` (CSS default). No custom cubic-bezier needed.
- **Duration:**
  - `--transition-fast`: 100ms (icon swaps, hover states, speaking indicators)
  - `--transition-normal`: 170ms (panel transitions, button state changes)
  - `--transition-slow`: 200ms (modal open/close, overlay fade)
- **Animations:**
  - Speaker glow pulse: `1.5s ease-in-out infinite` on `box-shadow` (green → brighter green → green)
  - VAD meter bars: 50ms updates (matches audio analysis frame rate)
  - Settings panel: scale animation on open (existing)
  - Toast: slide-in from top-right, auto-dismiss after 5s

## Voice-Specific Design Tokens

These extend the base system for voice/video UI elements:

- **Speaker indicator (speaking):** `box-shadow: 0 0 0 2px var(--green), 0 0 8px rgba(35, 165, 90, 0.3)` with pulse animation
- **Connection quality colors:** excellent = `--green`, fair = `--yellow`, poor/bad = `--red`
- **VAD meter bars:** 4 bars, 4px wide, 12px max height. Active = `--green`, inactive = `--text-faint`
- **Grant Mic button:** `background: var(--accent)`, white text, full-width in voice widget
- **Reconnect button:** Same styling as Grant Mic
- **Quality warning banner:** `background: rgba(240, 178, 50, 0.08)`, `color: var(--yellow)`, `border-top: 1px solid rgba(240, 178, 50, 0.15)`
- **Volume slider tooltip:** Shows percentage on hover (e.g., "75%")

## Theming
- **Base theme:** Discord-standard dark tokens in `tokens.css`
- **Neon Glow theme:** Override class `body.theme-neon-glow` deepens backgrounds, adds cyan border glow, sets cyan-purple gradient accent
- **Accent override:** User can pick any accent color via color picker. `--accent-primary` and `--accent-gradient` derive from the user's choice.
- **Custom themes:** JSON import/export with CSS value sanitization (no CSS injection)

## Accessibility
- All interactive elements: `aria-label` + keyboard focusable
- Toggle buttons: `aria-pressed` attribute
- Status regions: `role="status"` + `aria-live="polite"`
- Alert toasts: `role="alert"` + `aria-live="assertive"`
- Decorative elements (VAD meter): `aria-hidden="true"`
- Minimum touch/click target: 32px (buttons), 44px recommended for primary actions
- Color contrast: all text tokens meet WCAG AA against their intended backgrounds

## Components

### Popover (anchored)
- **Position:** Anchored to trigger element. Flip horizontally/vertically when <100px from viewport edge. Clamp to viewport bounds.
- **Dimensions:** Content-driven, min-width 200px
- **Background:** `--bg-secondary` (#111214)
- **Border:** 1px `--border-glow` (rgba(0, 200, 255, 0.08))
- **Radius:** `--radius-md` (8px)
- **Shadow:** `0 8px 16px rgba(0, 0, 0, 0.24)` (elevation-medium)
- **Animation:** Fade + scale from 0.95 → 1.0 over 100ms (`--transition-fast`)
- **Dismiss:** Outside click (mousedown on overlay), Escape key
- **A11y:** `role="dialog"`, `aria-modal="true"`, `aria-label` required. Focus trap with Tab/Shift+Tab cycling. Return focus to trigger element on close.
- **First implementation:** `UserProfilePopup.ts` (300px wide, user profile content)
- **Reuse for:** Context menus, message action menus, future feature popovers

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-28 | Initial design system created | Formalized existing tokens.css + theme-neon-glow.css via /design-consultation. No new design — documented what exists. |
| 2026-03-28 | Speaker indicator: pulsing green glow | Current flat ring (2px box-shadow) lacks animation. Added pulse keyframes + outer glow for visibility. Matches Discord's animated green ring. |
| 2026-03-28 | Windows-native typography only | Segoe UI Variable is the sharpest font on Windows. No web font loading latency. Risk: cross-platform would need fallback stack. |
| 2026-03-28 | Neon gradient as brand identity | Cyan-to-purple gradient distinguishes OwnCord from Discord (blurple), Slack (aubergine), TeamSpeak (blue). |
| 2026-04-01 | Popover component pattern | Anchored popovers for UserProfilePopup. Edge-flip positioning, focus trap, fade+scale animation. Documented as reusable pattern for future context menus. |
| 2026-04-01 | DM Profile Sidebar: right panel 340px | Same slot as member list (hidden in DM mode). Slide-in 170ms. Toggle via DM header click. Local-only Note field. |
