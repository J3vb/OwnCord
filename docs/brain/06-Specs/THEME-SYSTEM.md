# Theme System

## Complete Architecture Specification

*Created: 2026-03-28 | Status: IMPLEMENTED | Related: [[CLIENT-ARCHITECTURE]]*

---

## 1. Executive Summary

OwnCord's theme system provides built-in themes applied via CSS
class on `<body>` and custom themes via JSON import that override
CSS custom properties inline. An accent color picker allows further
override of the `--accent` variable on top of any theme. Theme
and accent state are persisted to localStorage and restored on
app startup.

---

## 2. Architecture Overview

```
  +---------------------------+        +----------------------------+
  |    themes.ts (Manager)    |        |     CSS Files              |
  |                           |        |                            |
  |  applyThemeByName(name)   |------> |  tokens.css (defaults)     |
  |  restoreTheme()           |        |  theme-neon-glow.css       |
  |  listThemeNames()         |        |  (body.theme-X overrides)  |
  |  saveCustomTheme(theme)   |        |                            |
  |  loadCustomTheme(name)    |        +----------------------------+
  |  deleteCustomTheme(name)  |
  |  exportTheme(theme)       |        +----------------------------+
  |  getActiveThemeName()     |        |    AppearanceTab.ts        |
  |                           |        |                            |
  +-----------+---------------+        |  Theme selector dropdown   |
              |                        |  Accent color picker       |
              v                        |  Import/Export buttons     |
  +---------------------------+        +----------------------------+
  |     localStorage          |
  |                           |
  |  owncord:theme:active     |  <-- Active theme name
  |  owncord:theme:custom:X   |  <-- Custom theme JSON
  |  owncord:pref:accentColor |  <-- Accent color override
  +---------------------------+
```

---

## 3. Theme Manager API

**File:** `Client/tauri-client/src/lib/themes.ts`

### 3.1 Core Functions

| Function | Purpose | Return |
|----------|---------|--------|
| `applyThemeByName(name)` | Apply built-in or custom theme | void |
| `getActiveThemeName()` | Get current theme name | string (default: "neon-glow") |
| `listThemeNames()` | List all available themes | readonly string[] |
| `restoreTheme()` | Restore theme + accent on startup | void |
| `saveCustomTheme(theme)` | Persist custom theme to localStorage | void |
| `loadCustomTheme(name)` | Load custom theme from localStorage | OwnCordTheme | null |
| `deleteCustomTheme(name)` | Remove custom theme, fallback if active | void |
| `exportTheme(theme)` | Serialize to JSON string | string |

### 3.2 OwnCordTheme Interface

```typescript
interface OwnCordTheme {
  readonly name: string;
  readonly author: string;
  readonly version: string;
  readonly colors: Readonly<Record<string, string>>;
}
```

The `colors` object maps CSS custom property names (including `--`
prefix) to CSS values. Example:

```json
{
  "name": "my-theme",
  "author": "user",
  "version": "1.0.0",
  "colors": {
    "--bg-primary": "#1a1b1e",
    "--bg-secondary": "#111214",
    "--accent": "#ff6b6b",
    "--text-normal": "#e0e0e0"
  }
}
```

---

## 4. Built-In Themes

| Name | CSS Class | Description |
|------|-----------|-------------|
| `dark` | `body.theme-dark` | Default dark theme (Discord-like) |
| `neon-glow` | `body.theme-neon-glow` | OC brand theme -- cyan/purple gradient |
| `midnight` | `body.theme-midnight` | Deep blue-black theme |
| `light` | `body.theme-light` | Light theme |

**Default theme:** `neon-glow` (the OwnCord brand identity).

### 4.1 OC Neon Glow Theme

**File:** `Client/tauri-client/src/styles/theme-neon-glow.css`

```css
body.theme-neon-glow {
  /* Backgrounds -- deeper, darker */
  --bg-tertiary:   #0d0e10;
  --bg-secondary:  #111214;
  --bg-primary:    #1a1b1e;
  --bg-input:      #252629;
  --bg-hover:      #1f2023;
  --bg-active:     #2a2b2e;

  /* Accent -- defaults to OC cyan, overridable by accent picker */
  --accent:         #00c8ff;
  --accent-hover:   #7b2fff;
  --accent-active:  #6620e0;
  --accent-primary: var(--accent);
  --accent-secondary: var(--accent-hover);
  --accent-gradient: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));

  /* Border glow -- derived from accent */
  --border:      rgba(0, 200, 255, 0.08);
  --border-strong: rgba(0, 200, 255, 0.15);
  --border-glow: rgba(0, 200, 255, 0.08);

  /* Text link follows accent */
  --text-link: var(--accent);

  /* Semantic colors */
  --color-success: #23a55a;
  --color-warning: #f0b232;
  --color-danger:  #f23f43;
}
```

The neon-glow theme uses CSS custom property indirection
(`--accent-primary: var(--accent)`) so the accent color picker
can override `--accent` and all derived values update automatically.

---

## 5. Theme Application Flow

### 5.1 Built-In Theme

```
applyThemeByName("neon-glow"):
  1. Remove all existing `theme-*` classes from body
  2. Remove all inline `--*` CSS custom properties from body.style
  3. Check if name is in BUILT_IN_THEMES array
  4. Yes: add `theme-neon-glow` class to body
  5. Save to localStorage: owncord:theme:active = "neon-glow"
```

### 5.2 Custom Theme

```
applyThemeByName("my-custom"):
  1. Remove all existing `theme-*` classes from body
  2. Remove all inline `--*` CSS custom properties from body.style
  3. Check if name is in BUILT_IN_THEMES array -> No
  4. Load from localStorage: owncord:theme:custom:my-custom
  5. Parse JSON, validate shape (name: string, colors: object required;
     author + version not validated at load time)
  6. Add `theme-custom` class to body
  7. For each (prop, value) in theme.colors:
     a. Validate prop starts with "--" and has valid ident name
     b. Validate value contains only safe CSS characters
        (allowlist: [\w\s#().,%+\-/])
     c. Set body.style.setProperty(prop, value)
  8. Save to localStorage: owncord:theme:active = "my-custom"
```

### 5.3 Security: CSS Injection Prevention

Custom theme values are validated against an allowlist regex:

```typescript
// Property name: must be --{valid-css-ident}
if (!prop.startsWith("--") || !/^[a-zA-Z_][\w-]*$/.test(prop.slice(2))) continue;
// Value: only permit safe CSS color/sizing characters
if (!/^[\w\s#().,%+\-/]+$/.test(value)) continue;
```

This blocks:
- `url()` (no external resource loading)
- `expression()` (no IE script injection)
- Semicolons, braces, `!important` (no CSS injection)
- Any non-alphanumeric/safe characters

---

## 6. Accent Color Override

### 6.1 How It Works

The accent color picker in AppearanceTab lets users override the
`--accent` CSS variable on top of any theme. This is applied as
an inline style on both `document.documentElement` and
`document.body`:

```typescript
document.documentElement.style.setProperty("--accent", "#ff6b6b");
document.body.style.setProperty("--accent", "#ff6b6b");
```

Because inline styles have higher specificity than CSS class rules,
the accent override wins over the theme's `--accent` value.

### 6.2 Persistence

Saved to localStorage as `owncord:pref:accentColor` (JSON string).

### 6.3 Restore Order

In `restoreTheme()`:
1. Apply the saved theme (by name)
2. Then apply the accent color override

The accent must be applied AFTER the theme so it wins via inline
style specificity.

### 6.4 Validation on Restore

```typescript
const accent = JSON.parse(raw);
if (typeof accent === "string" && /^#[\da-fA-F]{3,8}$/.test(accent)) {
  // Apply -- only valid hex colors accepted
}
```

---

## 7. Theme Lifecycle

### 7.1 App Startup

```
main.ts:
  restoreTheme()
    |
    +--> applyThemeByName(getActiveThemeName())
    |     // Applies CSS class or custom properties
    |
    +--> Restore accent color from owncord:pref:accentColor
          // Inline style override on html + body
```

### 7.2 User Changes Theme

```
AppearanceTab -> theme selector dropdown:
  applyThemeByName(selectedName)
    // Removes old theme class, applies new one
    // Persists to owncord:theme:active
```

### 7.3 User Changes Accent Color

```
AppearanceTab -> accent color picker:
  1. document.documentElement.style.setProperty("--accent", color)
  2. document.body.style.setProperty("--accent", color)
  3. savePref("accentColor", color)
```

### 7.4 Custom Theme Import

```
AppearanceTab -> Import button:
  1. Open file dialog (Tauri plugin-dialog)
  2. Read JSON file
  3. Parse as OwnCordTheme
  4. saveCustomTheme(theme)
  5. applyThemeByName(theme.name)
```

### 7.5 Custom Theme Export

```
AppearanceTab -> Export button:
  1. loadCustomTheme(name)
  2. exportTheme(theme) -> JSON string
  3. Save to file (Tauri plugin-fs)
```

### 7.6 Custom Theme Deletion

```
deleteCustomTheme(name):
  1. Remove from localStorage
  2. If it was the active theme:
     applyThemeByName("dark")  // Fallback
```

---

## 8. CSS Custom Properties (Theme Contract)

All themes must provide these CSS custom properties. The default
values come from `tokens.css` and are overridden by theme classes
or custom inline styles.

| Property | Purpose | Example (neon-glow) |
|----------|---------|-------------------|
| `--bg-tertiary` | Deepest background | `#0d0e10` |
| `--bg-secondary` | Sidebar/panel background | `#111214` |
| `--bg-primary` | Main content background | `#1a1b1e` |
| `--bg-input` | Input field background | `#252629` |
| `--bg-hover` | Hover state background | `#1f2023` |
| `--bg-active` | Active/selected background | `#2a2b2e` |
| `--accent` | Primary accent color | `#00c8ff` |
| `--accent-hover` | Accent hover state | `#7b2fff` |
| `--accent-active` | Accent active/pressed | `#6620e0` |
| `--accent-primary` | Primary accent (often = `--accent`) | `var(--accent)` |
| `--accent-secondary` | Secondary accent for gradients | `var(--accent-hover)` |
| `--accent-gradient` | Accent gradient for headers/buttons | `linear-gradient(135deg, ...)` |
| `--border` | Default border color | `rgba(0, 200, 255, 0.08)` |
| `--border-strong` | Emphasized border | `rgba(0, 200, 255, 0.15)` |
| `--border-glow` | Glowing border effect | `rgba(0, 200, 255, 0.08)` |
| `--text-normal` | Primary text color | `#dcddde` |
| `--text-micro` | Subtle/muted text | `#72767d` |
| `--text-link` | Link text color | `var(--accent)` |
| `--green` | Online/success color | `#23a559` |
| `--yellow` | Idle/warning color | `#f0b232` |
| `--red` | DND/danger/error color | `#f23f43` |
| `--color-success` | Semantic success | `#23a55a` |
| `--color-warning` | Semantic warning | `#f0b232` |
| `--color-danger` | Semantic danger | `#f23f43` |

---

## 9. Compact Mode (Related)

A CSS-only layout option: adding `.compact-mode` to `<body>`
reduces spacing, avatar sizes, and font sizes throughout the app.
This is independent of theming but often used alongside dark themes.

---

## 10. Files Reference

| File | Role |
|------|------|
| `Client/tauri-client/src/lib/themes.ts` | Theme manager (apply, save, load, delete, export) |
| `Client/tauri-client/src/styles/tokens.css` | Default CSS custom property values |
| `Client/tauri-client/src/styles/theme-neon-glow.css` | Neon Glow theme overrides |
| `Client/tauri-client/src/styles/app.css` | App-wide styles using CSS custom properties |
| `Client/tauri-client/src/components/settings/AppearanceTab.ts` | Theme selector, accent picker, import/export UI |
| `Client/tauri-client/src/main.ts` | Calls `restoreTheme()` on startup |

---

## 11. Implementation Status

| Component | Status |
|-----------|--------|
| Built-in themes (dark, neon-glow, midnight, light) | DONE |
| Theme manager (apply, list, save, load, delete) | DONE |
| Custom theme JSON import/export | DONE |
| CSS injection prevention (value allowlist) | DONE |
| Accent color picker override | DONE |
| Accent color persistence + restore | DONE |
| Theme + accent restore on startup | DONE |
| Compact mode | DONE |
| Custom theme deletion with fallback | DONE |
| AppearanceTab UI | DONE |

---

## 12. Known Limitations

1. **No live preview:** Themes are applied immediately; there is no
   preview-before-apply mode.
2. **No theme marketplace/sharing:** Custom themes are local to
   each client instance. No server-side theme storage or sharing.
3. **Accent-only override:** Only `--accent` can be overridden via
   the color picker. Other properties require a custom theme JSON.
4. **No gradient override:** The accent color picker only sets a
   solid `--accent` color. To change the gradient, a custom theme
   must override `--accent-gradient`.
5. **localStorage-only:** Theme state is not synced across devices
   or backed up. Clearing browser storage loses custom themes.
6. **No dark/light mode auto-detection:** No support for
   `prefers-color-scheme` media query. Theme must be selected
   manually.
