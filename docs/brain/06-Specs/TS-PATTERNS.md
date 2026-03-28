# TypeScript Client Coding Patterns

Definitive reference for writing OwnCord Tauri v2 client code.
Every pattern below is extracted from the real codebase. When in
doubt, follow what you see here. When adding new code, match the
existing patterns exactly.

---

## Table of Contents

1. [Module Organization](#1-module-organization)
2. [Component Pattern](#2-component-pattern)
3. [DOM Manipulation](#3-dom-manipulation)
4. [Reactive Store Pattern](#4-reactive-store-pattern)
5. [Disposable Pattern](#5-disposable-pattern)
6. [WebSocket and Dispatcher](#6-websocket-and-dispatcher)
7. [REST API Client](#7-rest-api-client)
8. [IPC Patterns (Tauri Invoke)](#8-ipc-patterns-tauri-invoke)
9. [Rate Limiting](#9-rate-limiting)
10. [Permission Checking](#10-permission-checking)
11. [Type Definitions and Interfaces](#11-type-definitions-and-interfaces)
12. [CSS Class Management](#12-css-class-management)
13. [Event Delegation and Handling](#13-event-delegation-and-handling)
14. [Cleanup and Disposal Patterns](#14-cleanup-and-disposal-patterns)
15. [Error Handling](#15-error-handling)
16. [Logging](#16-logging)
17. [Preferences and localStorage](#17-preferences-and-localstorage)
18. [Import Conventions](#18-import-conventions)
19. [Testing Patterns](#19-testing-patterns)

---

## 1. Module Organization

### Directory structure

```text
src/
  main.ts              # Entry point: global handlers, router, service wiring
  lib/                 # Core services and utilities (no DOM, no UI)
    api.ts             # REST client (factory function)
    ws.ts              # WebSocket client (factory function)
    dispatcher.ts      # WS event -> store action wiring
    store.ts           # Reactive store factory
    disposable.ts      # Lifecycle cleanup manager
    dom.ts             # Safe DOM helpers
    safe-render.ts     # Error boundary + MountableComponent interface
    rate-limiter.ts    # Sliding-window rate limiter
    permissions.ts     # Bitfield permission checks
    logger.ts          # Scoped structured logger
    types.ts           # ALL protocol types (WS, REST, permissions)
    icons.ts           # SVG icon factory functions
    themes.ts          # Theme manager (apply/restore/export)
    router.ts          # Minimal page router
    credentials.ts     # Tauri credential store wrappers
    livekitSession.ts  # LiveKit voice/video session manager (class)
    connectionStats.ts # WebRTC stats polling
    ptt.ts             # Push-to-talk (Rust GetAsyncKeyState)
    notifications.ts   # Desktop notification + sound
    tenor.ts           # Tenor GIF API client
    profiles.ts        # Server profile manager
    window-state.ts    # Tauri window position/size persistence
  stores/              # Reactive state stores
    auth.store.ts      # Auth token, user, server info
    channels.store.ts  # Channel list, active channel, unread counts
    members.store.ts   # Online members, typing state
    messages.store.ts  # Message cache per channel
    voice.store.ts     # Voice channel state, local controls
    dm.store.ts        # Direct message channels
    ui.store.ts        # UI state (settings open, transient errors)
  components/          # Reusable UI components
    VoiceWidget.ts     # Voice controls bar
    TypingIndicator.ts # "X is typing..." indicator
    MessageInput.ts    # Chat input with attachments, GIF, emoji
    MessageList.ts     # Virtualized message list
    MemberList.ts      # Online member sidebar
    SettingsOverlay.ts # Full-screen settings modal
    Toast.ts           # Toast notification container
    ServerBanner.ts    # Reconnecting/restart banner
    VideoGrid.ts       # Video tile grid
    ...
  pages/               # Top-level page orchestrators
    ConnectPage.ts     # Login/register page
    MainPage.ts        # Primary app layout after login
    main-page/         # MainPage sub-orchestrators
      SidebarArea.ts   # Sidebar composition
      ChatArea.ts      # Chat area composition
      ChannelController.ts  # Mount/destroy per-channel components
      MessageController.ts  # Message loading logic
      ReactionController.ts # Reaction handling
      VideoModeController.ts # Chat/video mode switching
    connect-page/      # ConnectPage sub-components
      ServerPanel.ts   # Server profile list
      LoginForm.ts     # Login/register form
  styles/              # CSS files
    tokens.css         # Design tokens (colors, spacing, typography)
    base.css           # Reset and body defaults
    login.css          # ConnectPage styles
    app.css            # MainPage styles
    theme-neon-glow.css # OC Neon Glow theme
```

### Module roles and boundaries

| Layer | Creates DOM? | Imports stores? | Imports lib? |
|-------|-------------|----------------|-------------|
| `lib/` | Never (except `dom.ts`) | Rarely (dispatcher only) | Yes |
| `stores/` | Never | Yes (cross-store reads) | `lib/store.ts` only |
| `components/` | Yes | Yes (read + subscribe) | Yes |
| `pages/` | Yes (composition only) | Yes | Yes |

### Factory function pattern

Almost everything is a factory function, not a class. The sole
exception is `LiveKitSession` in `lib/livekitSession.ts` and
`Disposable` / `RateLimiter` which are utility classes.

```ts
// Factory function — returns an object literal, no `new` keyword
export function createMyService(config: MyConfig) {
  // Private state lives in closure
  let state = initialState;

  // Private functions
  function doSomething(): void { /* ... */ }

  // Return public API as object literal
  return {
    publicMethod(): void { doSomething(); },
    getState(): MyState { return state; },
  };
}

// Type alias derived from the factory return type
export type MyService = ReturnType<typeof createMyService>;
```

This pattern is used by: `createStore`, `createWsClient`,
`createApiClient`, `createRouter`, `createRateLimiterSet`,
`createLogger`, every component factory, and every page factory.

### Derived types from factory return

Instead of defining a separate interface for the return type,
use `ReturnType<typeof factory>`:

```ts
export function createWsClient() { /* ... */ }
export type WsClient = ReturnType<typeof createWsClient>;

export function createApiClient(config: ApiClientConfig, onUnauthorized?: OnUnauthorized) { /* ... */ }
export type ApiClient = ReturnType<typeof createApiClient>;

export function createMainPage(options: MainPageOptions): MountableComponent { /* ... */ }
export type MainPage = ReturnType<typeof createMainPage>;
```

---

## 2. Component Pattern

Components are factory functions returning `MountableComponent`.
Never use classes for components.

### MountableComponent interface

From `lib/safe-render.ts`:

```ts
export interface MountableComponent {
  mount(container: Element): void;
  destroy?(): void;
}
```

### Two cleanup styles

| Style | When to use | Example files |
|-------|-------------|---------------|
| `AbortController` + manual `unsubs[]` | Components with WS listeners, timers, stats pollers, or manual store subscriptions | `VoiceWidget.ts`, `MessageList.ts`, `MainPage.ts` |
| `Disposable` | Components that only need store subscriptions and DOM events | `TypingIndicator.ts`, `MemberList.ts` |

### Complete template (AbortController style)

This is the most common pattern, used when a component has WS
listeners, intervals, or complex lifecycle management:

```ts
import { createElement, appendChildren, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { createLogger } from "@lib/logger";
import { someStore } from "@stores/some.store";

const log = createLogger("my-component");

export interface MyComponentOptions {
  readonly channelId: number;
  readonly onAction: () => void;
}

export function createMyComponent(options: MyComponentOptions): MountableComponent {
  const ac = new AbortController();
  const signal = ac.signal;
  const unsubs: Array<() => void> = [];
  let root: HTMLDivElement | null = null;

  function render(): void {
    if (root === null) return;
    const state = someStore.getState();
    // ... update DOM from state
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "my-component" });

    const btn = createElement("button", { class: "action-btn" }, "Click");
    btn.addEventListener("click", options.onAction, { signal });

    appendChildren(root, btn);

    render();

    unsubs.push(
      someStore.subscribeSelector(
        (s) => s.relevantField,
        () => render(),
      ),
    );

    container.appendChild(root);
  }

  function destroy(): void {
    ac.abort();
    for (const unsub of unsubs) {
      unsub();
    }
    unsubs.length = 0;
    root?.remove();
    root = null;
  }

  return { mount, destroy };
}
```

### Complete template (Disposable style)

Cleaner when you only need store subscriptions and DOM events:

```ts
import { createElement, clearChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { Disposable } from "@lib/disposable";
import { membersStore } from "@stores/members.store";

export function createMyWidget(): MountableComponent {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;

  function updateFromState(): void {
    if (root === null) return;
    clearChildren(root);
    // ... rebuild DOM
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "my-widget" });
    updateFromState();

    disposable.onStoreChange(
      membersStore,
      (s) => s.members,
      () => { updateFromState(); },
    );

    container.appendChild(root);
  }

  function destroy(): void {
    disposable.destroy();
    if (root !== null) {
      root.remove();
      root = null;
    }
  }

  return { mount, destroy };
}
```

### Real example: VoiceWidget (AbortController style)

Shows the full pattern with intervals, pollers, WS-level state,
button controls, and multi-store subscriptions:

```ts
export function createVoiceWidget(options: VoiceWidgetOptions): MountableComponent {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;
  let channelNameEl: HTMLSpanElement | null = null;
  let muteBtn: HTMLButtonElement | null = null;
  // ... more element refs

  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let statsPoller: ConnectionStatsPoller | null = null;
  const unsubs: Array<() => void> = [];

  function render(): void {
    if (root === null || channelNameEl === null) return;
    const voice = voiceStore.getState();
    const channelId = voice.currentChannelId;

    if (channelId === null) {
      root.classList.remove("visible");
      stopStatsPoller();
      stopElapsedTimer();
      return;
    }

    root.classList.add("visible");
    startStatsPoller();
    startElapsedTimer();

    const channel = channelsStore.getState().channels.get(channelId);
    setText(channelNameEl, channel?.name ?? "Voice Channel");

    // Toggle button active states
    muteBtn?.classList.toggle("active-ctrl", voice.localMuted);
    if (muteBtn) {
      swapIcon(muteBtn, voice.localMuted ? "mic-off" : "mic");
      muteBtn.setAttribute("aria-pressed", String(voice.localMuted));
    }
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "voice-widget", "data-testid": "voice-widget" });
    // ... build DOM tree

    render();

    // Multi-field selector with custom equality
    unsubs.push(voiceStore.subscribeSelector(
      (s) => ({
        channelId: s.currentChannelId,
        muted: s.localMuted,
        deafened: s.localDeafened,
        camera: s.localCamera,
        screenshare: s.localScreenshare,
      }),
      () => render(),
      (a, b) =>
        a.channelId === b.channelId &&
        a.muted === b.muted &&
        a.deafened === b.deafened &&
        a.camera === b.camera &&
        a.screenshare === b.screenshare,
    ));

    // Cross-store subscription
    unsubs.push(channelsStore.subscribeSelector(
      (s) => s.channels,
      () => render(),
    ));

    container.appendChild(root);
  }

  function destroy(): void {
    stopStatsPoller();
    stopElapsedTimer();
    ac.abort();
    for (const unsub of unsubs) { unsub(); }
    unsubs.length = 0;
    root?.remove();
    root = null;
    channelNameEl = null;
    muteBtn = null;
    // ... null out all element refs
  }

  return { mount, destroy };
}
```

### Real example: TypingIndicator (Disposable style)

Minimal component with store subscription and conditional DOM rebuild:

```ts
export function createTypingIndicator(
  options: TypingIndicatorOptions,
): MountableComponent {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;

  function updateFromState(): void {
    if (root === null) return;
    const allTyping = getTypingUsers(options.channelId);
    const filtered = allTyping.filter((u) => u.id !== options.currentUserId);

    clearChildren(root);

    if (filtered.length > 0) {
      const dots = createElement("span", { class: "typing-dots" });
      appendChildren(dots,
        createElement("span", {}),
        createElement("span", {}),
        createElement("span", {}),
      );
      root.appendChild(dots);
      root.appendChild(document.createTextNode(` ${formatTypingText(filtered)}`));
    }
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "typing-bar" });
    updateFromState();

    disposable.onStoreChange(
      membersStore,
      (s) => s.typingUsers,
      () => { updateFromState(); },
    );

    container.appendChild(root);
  }

  function destroy(): void {
    disposable.destroy();
    if (root !== null) {
      root.remove();
      root = null;
    }
  }

  return { mount, destroy };
}
```

### Settings tabs -- simplified pattern

Settings tabs receive an `AbortSignal` from the parent
`SettingsOverlay` and return a plain `HTMLDivElement`
(not a `MountableComponent`):

```ts
import { createElement, appendChildren } from "@lib/dom";
import { loadPref, savePref, createToggle } from "./helpers";

export function buildMySettingsTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });

  const isOn = loadPref<boolean>("myPref", true);
  const toggle = createToggle(isOn, {
    signal,
    onChange: (nowOn) => { savePref("myPref", nowOn); },
  });

  appendChildren(section, toggle);
  return section;
}
```

### Page orchestrator pattern

Pages (MainPage, ConnectPage) compose child components, wire
services, and manage the overall lifecycle. They track all child
components and unsubscribe functions for cleanup:

```ts
export function createMainPage(options: MainPageOptions): MountableComponent {
  const { ws, api } = options;
  const limiters = createRateLimiterSet();

  let container: Element | null = null;
  let root: HTMLDivElement | null = null;
  let children: MountableComponent[] = [];
  let unsubscribers: Array<() => void> = [];

  function mount(target: Element): void {
    container = target;
    root = createElement("div", { style: "display:flex;..." });

    // Create and wire sub-components
    const sidebar = createSidebarArea({ ws, api, limiters, ... });
    children.push(...sidebar.children);
    unsubscribers.push(...sidebar.unsubscribers);

    const chatArea = createChatArea({ api, ... });
    children.push(...chatArea.children);
    unsubscribers.push(...chatArea.unsubscribers);

    // Mount settings overlay, toast, etc.
    const settingsOverlay = createSettingsOverlay({ ... });
    settingsOverlay.mount(root);
    children.push(settingsOverlay);

    container.appendChild(root);

    // Subscribe to store changes for routing
    const unsubChannels = channelsStore.subscribeSelector(
      (s) => s.activeChannelId,
      () => { /* mount new channel */ },
    );
    unsubscribers.push(unsubChannels);
  }

  function destroy(): void {
    // Destroy all children (components)
    for (const child of children) {
      try { child.destroy?.(); }
      catch (err) { log.error("Child destroy error", err); }
    }
    children = [];

    // Unsubscribe all listeners
    for (const unsub of unsubscribers) {
      try { unsub(); }
      catch (err) { log.error("Unsubscribe error", err); }
    }
    unsubscribers = [];

    root?.remove();
    root = null;
    container = null;
  }

  return { mount, destroy };
}
```

### Sub-orchestrator pattern

Sub-orchestrators (SidebarArea, ChatArea) return the DOM element
plus arrays of children and unsubscribers for the parent to
manage:

```ts
export interface SidebarAreaResult {
  readonly sidebarWrapper: HTMLDivElement;
  readonly children: MountableComponent[];
  readonly unsubscribers: Array<() => void>;
}

export function createSidebarArea(options: SidebarAreaOptions): SidebarAreaResult {
  const children: MountableComponent[] = [];
  const unsubscribers: Array<() => void> = [];

  const sidebarWrapper = createElement("div", { class: "sidebar-wrapper" });

  // Build sub-components, push to children/unsubscribers
  const voiceWidget = createVoiceWidget({ ... });
  voiceWidget.mount(sidebarWrapper);
  children.push(voiceWidget);

  return { sidebarWrapper, children, unsubscribers };
}
```

### Extended page pattern (ConnectPage)

ConnectPage extends `MountableComponent` with additional methods
for external control. The return type is an intersection:

```ts
export function createConnectPage(
  callbacks: ConnectPageCallbacks,
  initialProfiles?: readonly SimpleProfile[],
): MountableComponent & {
  showTotp(): void;
  showConnecting(): void;
  showError(message: string): void;
  resetToIdle(): void;
  updateHealthStatus(host: string, status: HealthStatus): void;
  getRememberPassword(): boolean;
  getPassword(): string;
  refreshProfiles(profiles: readonly SimpleProfile[]): void;
  selectServer(host: string, username?: string): void;
} {
  // ... implementation

  return {
    mount,
    destroy,
    showTotp: () => loginForm.showTotp(),
    showConnecting: () => loginForm.showConnecting(),
    showError: (message: string) => loginForm.showError(message),
    resetToIdle: () => loginForm.resetToIdle(),
    refreshProfiles(profiles) { serverPanel.renderProfiles(profiles); },
    selectServer(host, username) { /* ... */ },
  };
}
```

---

## 3. DOM Manipulation

All helpers live in `lib/dom.ts`. Never use `innerHTML` with
user content. Never use `document.createElement` directly --
always use the `createElement` helper.

### Creating elements

```ts
import { createElement, setText, appendChildren, clearChildren, qs, qsa } from "@lib/dom";

// Tag + attributes + text content
const heading = createElement("h2", { class: "section-title" }, "General");

// Nested structure
const row = createElement("div", { class: "setting-row" });
const label = createElement("div", { class: "setting-label" }, "Theme");
const desc = createElement("div", { class: "setting-desc" }, "Choose your theme");
appendChildren(row, label, desc);
```

### createElement implementation

The `class` attribute is handled specially via `el.className`
for performance. All other attributes use `setAttribute`:

```ts
export function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  textContent?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") {
        el.className = value;
      } else {
        el.setAttribute(key, value);
      }
    }
  }
  if (textContent !== undefined) {
    el.textContent = textContent;
  }
  return el;
}
```

### Buttons and inputs

```ts
const btn = createElement("button", { class: "btn-primary" }, "Save");
btn.addEventListener("click", () => { /* ... */ }, { signal });

const input = createElement("input", {
  class: "text-input",
  type: "text",
  placeholder: "Search...",
});
input.addEventListener("input", (e) => {
  const value = (e.target as HTMLInputElement).value;
}, { signal });
```

### Updating text safely

```ts
// Always use setText or textContent -- never innerHTML with user data
setText(el, user.username);
```

### Querying within a subtree

```ts
const header = qs(".channel-header", root);   // single element or null
const items = qsa(".member-item", root);       // Element[]
```

### Clearing and rebuilding

The `clearChildren` function safely removes all children by
walking `firstChild`:

```ts
clearChildren(container);
// ... rebuild children from scratch
```

### appendChildren accepts strings

```ts
// Strings are automatically wrapped in TextNodes
appendChildren(row, "Label: ", valueEl, " units");
```

### Data attributes for test IDs

Components use `data-testid` attributes for E2E test selectors:

```ts
root = createElement("div", {
  class: "voice-widget",
  "data-testid": "voice-widget",
});
```

### ARIA attributes for accessibility

```ts
const btn = createElement("button", {
  "aria-label": "Mute",
  "aria-pressed": "false",
});
// Update dynamically:
btn.setAttribute("aria-pressed", String(voice.localMuted));
```

### HTML escape for safe string interpolation

When building HTML strings (rare, prefer DOM APIs), use
`escapeHtml`:

```ts
import { escapeHtml } from "@lib/dom";

// Only needed when you MUST use innerHTML (e.g., syntax highlighting)
el.innerHTML = `<code>${escapeHtml(codeBlock)}</code>`;
```

---

## 4. Reactive Store Pattern

Stores use `createStore` from `lib/store.ts`. State is always
immutable. Notifications are batched via `queueMicrotask`.

### Store interface

```ts
export interface Store<T> {
  getState(): T;
  setState(updater: (prev: T) => T): void;
  subscribe(listener: (state: T) => void): () => void;
  subscribeSelector<S>(
    selector: (state: T) => S,
    listener: (selected: S) => void,
    isEqual?: (a: S, b: S) => boolean,
  ): () => void;
  select<S>(selector: (state: T) => S): S;
  flush(): void;
}
```

### Creating a store

State interfaces have all fields marked `readonly`. Initial state
uses fresh collections (never share references):

```ts
import { createStore } from "@lib/store";

export interface ChannelsState {
  readonly channels: ReadonlyMap<number, Channel>;
  readonly activeChannelId: number | null;
}

const INITIAL_STATE: ChannelsState = {
  channels: new Map(),
  activeChannelId: null,
};

export const channelsStore = createStore<ChannelsState>(INITIAL_STATE);
```

### Immutable state updates

Every `setState` call must return a new object. Never mutate the
previous state.

**Scalar field update:**

```ts
myStore.setState((prev) => ({ ...prev, activeId: 42 }));
```

**Map -- add/update an entry (shallow copy, then set):**

```ts
export function addChannel(channel: ChannelCreatePayload): void {
  channelsStore.setState((prev) => {
    const next = new Map(prev.channels);
    next.set(channel.id, {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      category: channel.category,
      position: channel.position,
      unreadCount: 0,
      lastMessageId: null,
    });
    return { ...prev, channels: next };
  });
}
```

**Map -- update an existing entry:**

```ts
export function updateChannel(update: ChannelUpdatePayload): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(update.id);
    if (existing === undefined) return prev;  // No-op if not found
    const updated: Channel = {
      ...existing,
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.position !== undefined ? { position: update.position } : {}),
    };
    const next = new Map(prev.channels);
    next.set(update.id, updated);
    return { ...prev, channels: next };
  });
}
```

**Map -- remove an entry:**

```ts
export function removeChannel(id: number): void {
  channelsStore.setState((prev) => {
    const next = new Map(prev.channels);
    next.delete(id);
    return {
      ...prev,
      channels: next,
      activeChannelId: prev.activeChannelId === id ? null : prev.activeChannelId,
    };
  });
}
```

**Nested maps (voice store -- channelId -> userId -> VoiceUser):**

```ts
export function updateVoiceState(payload: VoiceStatePayload): void {
  voiceStore.setState((prev) => {
    const nextChannels = new Map(prev.voiceUsers);
    const existingChannel = prev.voiceUsers.get(payload.channel_id);
    const nextUsers = new Map(existingChannel ?? []);

    nextUsers.set(payload.user_id, {
      userId: payload.user_id,
      username: payload.username,
      muted: payload.muted,
      deafened: payload.deafened,
      speaking: payload.speaking,
      camera: payload.camera,
      screenshare: payload.screenshare,
    });

    nextChannels.set(payload.channel_id, nextUsers);
    return { ...prev, voiceUsers: nextChannels };
  });
}
```

**No-op guard -- return `prev` unchanged to avoid notifications:**

```ts
export function incrementUnread(channelId: number): void {
  channelsStore.setState((prev) => {
    if (prev.activeChannelId === channelId) return prev;  // Skip if active
    const existing = prev.channels.get(channelId);
    if (existing === undefined) return prev;               // Skip if unknown
    const updated: Channel = { ...existing, unreadCount: existing.unreadCount + 1 };
    const next = new Map(prev.channels);
    next.set(channelId, updated);
    return { ...prev, channels: next };
  });
}
```

### Subscribing to state changes

**Full state subscription (fires on every change):**

```ts
const unsub = myStore.subscribe((state) => { /* ... */ });
```

**Selector subscription (fires only when selected slice changes):**

Default equality is `shallowEqual` -- handles objects, arrays,
Maps, and Sets with top-level identity comparison:

```ts
const unsub = myStore.subscribeSelector(
  (s) => s.activeId,
  (activeId) => { render(); },
);
```

**Custom equality for compound selectors:**

When your selector returns a new object literal each time (which
would defeat reference equality), provide a custom comparator:

```ts
const unsub = voiceStore.subscribeSelector(
  (s) => ({
    channelId: s.currentChannelId,
    muted: s.localMuted,
    deafened: s.localDeafened,
    camera: s.localCamera,
    screenshare: s.localScreenshare,
  }),
  () => render(),
  (a, b) =>
    a.channelId === b.channelId &&
    a.muted === b.muted &&
    a.deafened === b.deafened &&
    a.camera === b.camera &&
    a.screenshare === b.screenshare,
);
```

**Important**: Selectors must return stable references for
unchanged data. A selector like `s => ({ ...s.users })` creates
a new object every time and fires on every update. Instead use
`s => s.users` to return the existing reference, or pass a
custom `isEqual`.

### Synchronous reads

```ts
// Derived value via selector
const activeId = myStore.select((s) => s.activeId);
const channel = channelsStore.select((s) => s.channels.get(42) ?? null);

// Direct state access
const channel = channelsStore.getState().channels.get(42);
```

### Batching

Multiple `setState` calls in the same tick produce one
notification via `queueMicrotask`:

```ts
myStore.setState((prev) => ({ ...prev, fieldA: 1 }));
myStore.setState((prev) => ({ ...prev, fieldB: 2 }));
// Subscribers fire once with both changes applied
```

### Store action functions

Each store module exports named action functions that wrap
`store.setState`. Components and dispatchers call these
functions -- they never call `setState` on foreign stores:

```ts
// channels.store.ts exports:
export function setChannels(channels: readonly ReadyChannel[]): void { /* ... */ }
export function addChannel(channel: ChannelCreatePayload): void { /* ... */ }
export function setActiveChannel(id: number | null): void { /* ... */ }
export function incrementUnread(channelId: number): void { /* ... */ }

// voice.store.ts exports:
export function joinVoiceChannel(channelId: number): void { /* ... */ }
export function leaveVoiceChannel(): void { /* ... */ }
export function setLocalMuted(muted: boolean): void { /* ... */ }
```

### Reset function

Every store exports a reset function for logout/test cleanup:

```ts
export function resetVoiceStore(): void {
  voiceStore.setState(() => ({
    currentChannelId: null,
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
    localCamera: false,
    localScreenshare: false,
    joinedAt: null,
  }));
}
```

### Derived selectors

Complex read operations are exported as selector functions:

```ts
export function getActiveChannel(): Channel | null {
  return channelsStore.select((s) => {
    if (s.activeChannelId === null) return null;
    return s.channels.get(s.activeChannelId) ?? null;
  });
}

export function getChannelsByCategory(): Map<string | null, Channel[]> {
  return channelsStore.select((s) => {
    const grouped = new Map<string | null, Channel[]>();
    for (const channel of s.channels.values()) {
      if (channel.type === "dm") continue;
      const existing = grouped.get(channel.category);
      if (existing !== undefined) { existing.push(channel); }
      else { grouped.set(channel.category, [channel]); }
    }
    for (const channels of grouped.values()) {
      channels.sort((a, b) => a.position - b.position);
    }
    return grouped;
  });
}

export function getChannelVoiceUsers(channelId: number): readonly VoiceUser[] {
  return voiceStore.select((s) => {
    const channelUsers = s.voiceUsers.get(channelId);
    if (!channelUsers) return [];
    return Array.from(channelUsers.values());
  });
}
```

### shallowEqual export

`shallowEqual` is exported from `lib/store.ts` for custom
equality checks outside stores. It handles plain objects, arrays,
Maps, and Sets:

```ts
import { shallowEqual } from "@lib/store";

if (!shallowEqual(prevProps, nextProps)) { rerender(); }
```

### flush() for tests

`flush()` forces pending notifications to fire synchronously:

```ts
myStore.setState((prev) => ({ ...prev, count: 1 }));
myStore.flush(); // subscribers fire immediately, no microtask wait
```

---

## 5. Disposable Pattern

`Disposable` from `lib/disposable.ts` manages lifecycle cleanup
automatically. It wraps an `AbortController`, a cleanup array,
and provides helpers for common subscription patterns.

### Full implementation

```ts
export class Disposable {
  private readonly cleanups: CleanupFn[] = [];
  private readonly ac = new AbortController();
  private destroyed = false;

  get signal(): AbortSignal { return this.ac.signal; }

  addCleanup(fn: CleanupFn): void {
    if (this.destroyed) { fn(); return; }  // Run immediately if already destroyed
    this.cleanups.push(fn);
  }

  onStoreChange<S, R>(
    store: { subscribeSelector(...): () => void },
    selector: (s: S) => R,
    callback: (val: R) => void,
  ): void {
    const unsub = store.subscribeSelector(selector, callback);
    this.addCleanup(unsub);
  }

  onEvent<K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window | Document,
    event: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(event, handler as EventListener, {
      ...options,
      signal: this.ac.signal,
    });
  }

  onInterval(fn: () => void, ms: number): void {
    const id = setInterval(fn, ms);
    this.addCleanup(() => clearInterval(id));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ac.abort();
    for (const fn of this.cleanups) { fn(); }
    this.cleanups.length = 0;
  }
}
```

### Usage in components

```ts
const d = new Disposable();

// Store subscription -- auto-unsubscribes on destroy
d.onStoreChange(myStore, (s) => s.items, (items) => {
  rebuildList(items);
});

// DOM event -- auto-removed via AbortSignal
d.onEvent(button, "click", () => { handleClick(); });

// Also works with window and document
d.onEvent(window, "resize", () => { recalcLayout(); });

// Interval -- auto-cleared
d.onInterval(() => { checkForUpdates(); }, 30_000);

// Custom cleanup
d.addCleanup(() => { externalLib.dispose(); });

// Access the AbortSignal directly for raw addEventListener
someElement.addEventListener("scroll", handler, { signal: d.signal });

// Tear everything down at once
d.destroy();
```

---

## 6. WebSocket and Dispatcher

### WsClient (lib/ws.ts)

Created via `createWsClient()` factory. Uses Tauri IPC
(`ws_connect`/`ws_send`/`ws_disconnect` commands + events) to
proxy WSS through Rust, bypassing self-signed cert issues in
the webview.

**Connection state machine:**

```
disconnected -> connecting -> authenticating -> connected
                                    |              |
                                    v              v
                              auth_error     reconnecting
                              (-> disconnected)    |
                                              (-> connecting)
```

**Dynamic Tauri API loading:**

The WS client dynamically imports Tauri APIs to avoid import
errors in test/browser environments:

```ts
let tauriInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
let tauriListen: ((event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>) | null = null;

async function ensureTauriApis(): Promise<void> {
  if (tauriInvoke !== null) return;
  try {
    const core = await import("@tauri-apps/api/core");
    const event = await import("@tauri-apps/api/event");
    tauriInvoke = core.invoke;
    tauriListen = event.listen;
  } catch {
    log.warn("Tauri APIs not available");
  }
}
```

**Type-safe message dispatch:**

```ts
export type WsListener<T extends ServerMessage["type"]> = (
  payload: Extract<ServerMessage, { type: T }>["payload"],
  id?: string,
) => void;
```

**Listening to server messages:**

```ts
const unsub = ws.on("chat_message", (payload) => {
  // payload is typed as ChatMessagePayload
  console.log(payload.content, payload.user.username);
});
```

**Sending client messages:**

```ts
ws.send({
  type: "chat_send",
  payload: {
    channel_id: 1,
    content: "Hello",
    reply_to: null,
    attachments: [],
  },
});
// Returns a UUID string (the message envelope ID)
```

**Connection lifecycle:**

```ts
ws.connect({ host: "192.168.1.10:8443", token: authToken });
ws.disconnect();   // Intentional close -- resets lastSeq
ws.getState();     // Returns current ConnectionState
```

**Connection state change listener:**

```ts
ws.onStateChange((state) => {
  // state: "disconnected" | "connecting" | "authenticating" | "connected" | "reconnecting"
});
```

**Reconnection with exponential backoff:**

The WS client automatically reconnects on unintentional
disconnects using exponential backoff (1s, 2s, 4s, 8s, ...,
max 30s). `lastSeq` is preserved across reconnects for server-
side event replay. `disconnect()` resets `lastSeq`.

**Heartbeat:**

A 30-second heartbeat interval sends `{ type: "ping", payload: {} }`
to keep the connection alive.

**TOFU certificate events:**

```ts
ws.onCertMismatch((evt) => {
  // evt.host, evt.fingerprint, evt.status, evt.storedFingerprint
  // Show warning modal, call ws.acceptCertFingerprint() if user accepts
});
```

### Dispatcher (lib/dispatcher.ts)

The dispatcher is the single wiring point between WS events and
store actions. Components should NOT call store actions from WS
events directly.

```ts
import { wireDispatcher } from "@lib/dispatcher";

const cleanupDispatcher = wireDispatcher(ws);

// On disconnect:
cleanupDispatcher();
```

**Internal structure -- each WS message type maps to store actions:**

```ts
export function wireDispatcher(ws: WsClient): DispatcherCleanup {
  const unsubs: Array<() => void> = [];

  unsubs.push(ws.on("auth_ok", (payload) => {
    setAuth(authStore.getState().token ?? "", payload.user, payload.server_name, payload.motd);
  }));

  unsubs.push(ws.on("ready", (payload) => {
    setChannels(payload.channels);
    setMembers(payload.members);
    setVoiceStates(payload.voice_states);
    // Auto-select first text channel if none active
    // Populate DM channels
  }));

  unsubs.push(ws.on("chat_message", (payload) => {
    addMessage(payload);
    incrementUnread(payload.channel_id);
    updateDmLastMessage(payload.channel_id, ...);
    notifyIncomingMessage(payload);
  }));

  // ... 20+ more event handlers

  return () => {
    for (const unsub of unsubs) { unsub(); }
  };
}
```

### Cleanup in components

Always collect WS unsub functions and call them in `destroy()`:

```ts
const unsubs: Array<() => void> = [];

// In mount:
unsubs.push(ws.on("typing", (payload) => { /* ... */ }));
unsubs.push(ws.onStateChange((state) => { /* ... */ }));

// In destroy:
for (const unsub of unsubs) { unsub(); }
unsubs.length = 0;
```

---

## 7. REST API Client

The REST client lives in `lib/api.ts`. Uses Tauri's HTTP plugin
to bypass self-signed cert issues in the webview.

### Factory creation and configuration

```ts
import { createApiClient, ApiClientError } from "@lib/api";

const api = createApiClient(
  { host: "192.168.1.10:8443" },
  () => { /* onUnauthorized callback */ },
);

// After login, set the token
api.setConfig({ token: authToken });
```

### Internal request flow

All requests go through a shared `doFetch` function that handles:

1. Building the URL from `host + /api/v1 + path`
2. Adding `Authorization: Bearer <token>` header
3. Adding `danger: { acceptInvalidCerts: true }` for self-signed certs
4. Parsing error responses into `ApiClientError`
5. Calling `onUnauthorized` on 401 responses
6. Returning `undefined` for 204 No Content

```ts
async function doFetch<T>(
  label: string,
  urlBase: string,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const url = `${urlBase}${path}`;
  const init = {
    method,
    headers: headers(),
    signal,
    danger: { acceptInvalidCerts: true, acceptInvalidHostnames: false },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init as RequestInit);
  // Error handling...
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
```

### ApiClientError class

```ts
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}
```

### Making requests

All methods accept an optional `AbortSignal` as the last argument:

```ts
const messages = await api.getMessages(channelId, { before: 100, limit: 50 });
const health = await api.getHealth();
await api.login(username, password);
await api.uploadFile(file);
```

### Error handling

```ts
try {
  await api.login(username, password);
} catch (err) {
  if (err instanceof ApiClientError) {
    // err.status  -- HTTP status code (401, 404, etc.)
    // err.code    -- server error code ("UNAUTHORIZED", "RATE_LIMITED", etc.)
    // err.message -- human-readable message
    log.error("Login failed", { status: err.status, code: err.code });
  }
}
```

### File uploads

File uploads use `FormData` without an explicit `Content-Type`
header (browser sets the multipart boundary):

```ts
async uploadFile(file: File, signal?: AbortSignal): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  const h: Record<string, string> = {};
  if (config.token) { h["Authorization"] = `Bearer ${config.token}`; }
  // Don't set Content-Type -- browser sets multipart boundary
  const res = await fetch(url, { method: "POST", headers: h, body: formData, signal, ... });
  // ...
}
```

### Admin routes

Admin routes use a separate base URL (`/admin/api`):

```ts
function adminBaseUrl(): string {
  return `https://${config.host}/admin/api`;
}

adminCreateChannel(data, signal): Promise<ChannelResponse> {
  return adminRequest<ChannelResponse>("POST", "/channels", data, signal);
}
```

---

## 8. IPC Patterns (Tauri Invoke)

### Dynamic import pattern

Tauri APIs are loaded dynamically to avoid import errors in
test/browser environments:

```ts
let tauriInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

async function ensureTauriApis(): Promise<void> {
  if (tauriInvoke !== null) return;
  try {
    const core = await import("@tauri-apps/api/core");
    tauriInvoke = core.invoke;
  } catch {
    log.warn("Tauri APIs not available");
  }
}
```

### Tauri event listening

Tauri events return an unsubscribe function (Promise-based).
These are collected and cleaned up:

```ts
const eventUnsubs: Array<() => void> = [];

async function setupEventListeners(): Promise<void> {
  if (tauriListen === null) return;

  const unsubMsg = await tauriListen("ws-message", (e) => {
    handleMessage(e.payload as string);
  });
  eventUnsubs.push(unsubMsg);

  const unsubState = await tauriListen("ws-state", (e) => {
    const rustState = e.payload as string;
    // Handle state change
  });
  eventUnsubs.push(unsubState);
}

function cleanupEventListeners(): void {
  for (const unsub of eventUnsubs) {
    try {
      const result = unsub() as unknown;
      // Unsub may return a rejected promise if the Tauri resource
      // was already invalidated -- safe to ignore
      if (result instanceof Promise) { result.catch(() => {}); }
    } catch { /* safe to ignore */ }
  }
  eventUnsubs.length = 0;
}
```

### Invoke pattern for commands

```ts
// Send WS message through Rust proxy
tauriInvoke("ws_send", { message: json }).catch((err) => {
  log.error("ws_send failed", err);
});

// Connect WS through Rust proxy
await tauriInvoke("ws_connect", { url: wsUrl });

// Open DevTools
void import("@tauri-apps/api/core").then(({ invoke }) => {
  void invoke("open_devtools");
});
```

### Plugin usage

```ts
// HTTP plugin (bypasses self-signed cert issues)
import { fetch } from "@tauri-apps/plugin-http";

// Opener plugin (open URLs in default browser)
import { openUrl } from "@tauri-apps/plugin-opener";
void openUrl(href);
```

---

## 9. Rate Limiting

### RateLimiter class

Sliding-window rate limiter with per-key tracking. Uses
immutable state internally:

```ts
export class RateLimiter {
  private readonly config: Readonly<RateLimiterConfig>;
  private state: ReadonlyMap<string, KeyState>;

  constructor(config: RateLimiterConfig) {
    this.config = Object.freeze({ ...config });
    this.state = new Map();
  }

  tryConsume(key?: string): boolean {
    // Prune expired timestamps, check capacity, add new timestamp
    // Returns true if allowed, false if rate-limited
  }

  reset(key?: string): void { /* Reset single key */ }
  resetAll(): void { /* Clear all state */ }
  getRemainingMs(key?: string): number { /* Ms until next allowed action */ }
}
```

### Immutable internal state

The rate limiter uses `Object.freeze` and creates new Maps/arrays
on every mutation:

```ts
tryConsume(key?: string): boolean {
  const k = key ?? DEFAULT_KEY;
  const now = Date.now();
  const cleaned = this.pruneAll(now);  // Returns new map
  const entry = cleaned.get(k);
  const timestamps = entry?.timestamps ?? [];

  if (timestamps.length >= this.config.maxTokens) {
    this.state = cleaned;
    return false;
  }

  const newEntry: KeyState = { timestamps: [...timestamps, now] };
  const next = new Map(cleaned);
  next.set(k, Object.freeze(newEntry));
  this.state = next;
  return true;
}
```

### Pre-configured limiters

Factory functions matching PROTOCOL.md rate limits:

```ts
createChatLimiter()       // 10 per second
createTypingLimiter()     // 1 per 3 seconds (use channel ID as key)
createPresenceLimiter()   // 1 per 10 seconds
createReactionLimiter()   // 5 per second
createVoiceLimiter()      // 20 per second
createVideoCameraLimiter() // 2 per second
createSoundboardLimiter() // 1 per 3 seconds
```

### Bundled limiter set

```ts
export interface RateLimiterSet {
  readonly chat: RateLimiter;
  readonly typing: RateLimiter;
  readonly presence: RateLimiter;
  readonly reactions: RateLimiter;
  readonly voice: RateLimiter;
  readonly voiceVideo: RateLimiter;
  readonly soundboard: RateLimiter;
}

// Created once in MainPage.mount():
const limiters = createRateLimiterSet();
```

### Usage in components

```ts
// Before sending a typing event:
if (!limiters.typing.tryConsume(String(channelId))) {
  return; // Rate limited, skip silently
}
ws.send({ type: "typing", payload: { channel_id: channelId } });
```

---

## 10. Permission Checking

### Permission enum (bitfield)

The only real enum in the codebase. Defined in `lib/types.ts`:

```ts
export enum Permission {
  SEND_MESSAGES   = 0x1,
  READ_MESSAGES   = 0x2,
  ATTACH_FILES    = 0x20,
  ADD_REACTIONS   = 0x40,
  USE_SOUNDBOARD  = 0x100,
  CONNECT_VOICE   = 0x200,
  SPEAK_VOICE     = 0x400,
  USE_VIDEO       = 0x800,
  SHARE_SCREEN    = 0x1000,
  MANAGE_MESSAGES = 0x10000,
  MANAGE_CHANNELS = 0x20000,
  KICK_MEMBERS    = 0x40000,
  BAN_MEMBERS     = 0x80000,
  MUTE_MEMBERS    = 0x100000,
  MANAGE_ROLES    = 0x1000000,
  MANAGE_SERVER   = 0x2000000,
  MANAGE_INVITES  = 0x4000000,
  VIEW_AUDIT_LOG  = 0x8000000,
  ADMINISTRATOR   = 0x40000000,
}
```

### Permission check functions

From `lib/permissions.ts`:

```ts
import { Permission } from './types';

// Single permission check (ADMINISTRATOR always passes)
export function hasPermission(userPerms: number, perm: Permission): boolean {
  if ((userPerms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR) return true;
  return (userPerms & perm) === perm;
}

// Any of the listed permissions
export function hasAnyPermission(userPerms: number, ...perms: Permission[]): boolean {
  if ((userPerms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR) return true;
  return perms.some((p) => (userPerms & p) === p);
}

// All of the listed permissions
export function hasAllPermissions(userPerms: number, ...perms: Permission[]): boolean {
  if ((userPerms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR) return true;
  return perms.every((p) => (userPerms & p) === p);
}

// Channel-level overrides: remove deny bits first, then add allow bits
export function computeEffective(basePerms: number, allow: number, deny: number): number {
  if ((basePerms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR) return ALL_PERMISSIONS;
  return (basePerms & ~deny) | allow;
}

// Shorthand for ADMINISTRATOR check
export function isAdministrator(userPerms: number): boolean {
  return (userPerms & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR;
}
```

### Usage pattern

```ts
import { hasPermission, isAdministrator } from "@lib/permissions";
import { Permission } from "@lib/types";

const perms = authStore.getState().user?.permissions ?? 0;

if (hasPermission(perms, Permission.MANAGE_CHANNELS)) {
  // Show channel management UI
}

if (isAdministrator(perms)) {
  // Show admin-only features
}
```

---

## 11. Type Definitions and Interfaces

All protocol types live in `lib/types.ts`. This is the single
source of truth for WS messages, REST responses, and data shapes.

### Interface fields are always `readonly`

```ts
export interface Channel {
  readonly id: number;
  readonly name: string;
  readonly type: ChannelType;
}

export interface VoiceUser {
  readonly userId: number;
  readonly username: string;
  readonly muted: boolean;
  readonly deafened: boolean;
  readonly speaking: boolean;
  readonly camera: boolean;
  readonly screenshare: boolean;
}
```

### Enums as string literal unions

Prefer literal unions over TypeScript enums:

```ts
export type UserStatus = "online" | "idle" | "dnd" | "offline";
export type ChannelType = "text" | "voice" | "announcement" | "dm";
export type VoiceQuality = "low" | "medium" | "high";
export type ReactionAction = "add" | "remove";
```

### Error codes as string literal unions

```ts
export type WsErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_INPUT"
  | "SERVER_ERROR"
  | "CHANNEL_FULL"
  | "VOICE_ERROR"
  | "VIDEO_LIMIT";

export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_INPUT"
  | "CONFLICT"
  | "TOO_LARGE"
  | "SERVER_ERROR"
  | "UNKNOWN";
```

### Component options as `readonly` interfaces

```ts
export interface VoiceWidgetOptions {
  readonly onDisconnect: () => void;
  readonly onMuteToggle: () => void;
  readonly onDeafenToggle: () => void;
  readonly onCameraToggle: () => void;
  readonly onScreenshareToggle: () => void;
}

export interface MainPageOptions {
  readonly ws: WsClient;
  readonly api: ApiClient;
}

export interface ConnectPageCallbacks {
  onLogin(host: string, username: string, password: string): Promise<void>;
  onRegister(host: string, username: string, password: string, inviteCode: string): Promise<void>;
  onTotpSubmit(code: string): Promise<void>;
}
```

### Server payload types vs client state types

Server payloads use snake_case fields (matching Go JSON):

```ts
export interface ReadyChannel {
  readonly id: number;
  readonly name: string;
  readonly type: ChannelType;
  readonly category: string | null;
  readonly position: number;
  readonly unread_count?: number;
  readonly last_message_id?: number;
}
```

Client state types use camelCase:

```ts
export interface Channel {
  readonly id: number;
  readonly name: string;
  readonly type: ChannelType;
  readonly category: string | null;
  readonly position: number;
  readonly unreadCount: number;
  readonly lastMessageId: number | null;
}
```

The store action functions handle the conversion:

```ts
export function setChannels(channels: readonly ReadyChannel[]): void {
  const map = new Map<number, Channel>();
  for (const ch of channels) {
    map.set(ch.id, {
      id: ch.id,
      name: ch.name,
      type: ch.type,
      category: ch.category,
      position: ch.position,
      unreadCount: ch.unread_count ?? 0,      // snake_case -> camelCase
      lastMessageId: ch.last_message_id ?? null,
    });
  }
  channelsStore.setState((prev) => ({ ...prev, channels: map }));
}
```

### Embedded objects

```ts
export interface MessageUser {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
}

export interface Attachment {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly mime: string;
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
}
```

---

## 12. CSS Class Management

### Design tokens

All design tokens live in `styles/tokens.css`. Never hardcode
colors or spacing.

**Backgrounds:**

```css
background: var(--bg-primary);     /* #313338 -- main content area */
background: var(--bg-secondary);   /* #2b2d31 -- sidebars */
background: var(--bg-tertiary);    /* #1e1f22 -- deepest bg */
background: var(--bg-input);       /* #383a40 -- text inputs */
background: var(--bg-hover);       /* #35373c -- hover state */
background: var(--bg-active);      /* #404249 -- active/pressed state */
background: var(--bg-overlay);     /* rgba(0,0,0,0.7) -- modal backdrop */
```

**Text:**

```css
color: var(--text-normal);   /* #dbdee1 -- body text */
color: var(--text-muted);    /* #949ba4 -- secondary text */
color: var(--text-faint);    /* #80848e -- timestamps, hints */
color: var(--text-link);     /* #00a8fc -- links */
color: var(--text-positive); /* #23a55a -- success */
color: var(--text-warning);  /* #f0b232 -- warnings */
color: var(--text-danger);   /* #f23f43 -- errors, destructive */
```

**Accent:**

```css
background: var(--accent);        /* #5865f2 -- primary buttons */
background: var(--accent-hover);  /* #4752c4 */
background: var(--accent-active); /* #3c45a5 */
```

**Typography:**

```css
font-family: var(--font-display);  /* headings */
font-family: var(--font-body);     /* body text */
font-family: var(--font-mono);     /* code blocks */

font-size: var(--font-size-xxs);   /* 10px */
font-size: var(--font-size-xs);    /* 12px */
font-size: var(--font-size-sm);    /* 13px -- default body */
font-size: var(--font-size-md);    /* 14px */
font-size: var(--font-size-lg);    /* 16px */
font-size: var(--font-size-xl);    /* 20px */
font-size: var(--font-size-xxl);   /* 24px */
```

**Radii:**

```css
border-radius: var(--radius-sm);     /* 4px */
border-radius: var(--radius-md);     /* 8px */
border-radius: var(--radius-lg);     /* 16px */
border-radius: var(--radius-pill);   /* 24px */
border-radius: var(--radius-circle); /* 50% */
```

**Transitions:**

```css
transition: background var(--transition-fast);    /* 100ms */
transition: opacity var(--transition-normal);      /* 170ms */
transition: transform var(--transition-slow);      /* 200ms */
```

**Layout constants:**

```css
width: var(--sidebar-width);   /* 240px */
height: var(--header-height);  /* 48px */
```

**Status and role colors:**

```css
color: var(--green);       /* #23a55a -- online */
color: var(--yellow);      /* #f0b232 -- idle */
color: var(--red);         /* #f23f43 -- dnd / error */

color: var(--role-owner);  /* #e74c3c */
color: var(--role-admin);  /* #f39c12 */
color: var(--role-mod);    /* #2ecc71 */
color: var(--role-member); /* #949ba4 */
```

### Toggle pattern with classList

```ts
// Toggle a CSS class based on state
muteBtn?.classList.toggle("active-ctrl", voice.localMuted);
root.classList.toggle("visible", channelId !== null);

// Add/remove visibility
root.classList.add("visible");
root.classList.remove("visible");
```

### Compact mode

Toggled via a CSS class on `<body>`:

```ts
document.body.classList.toggle("compact-mode", isCompact);
```

### Theme application

```ts
// Themes apply via a CSS class on <body>
document.body.classList.remove("theme-dark", "theme-neon-glow");
document.body.classList.add("theme-neon-glow");

// Accent color overrides use a CSS custom property
document.body.style.setProperty("--accent", "#ff6b2b");
```

### Inline styles (rare, only for dynamic values)

Inline styles are only used for values that cannot be expressed
as CSS classes (dynamic widths, positions):

```ts
root = createElement("div", {
  style: "display:flex;flex-direction:column;height:100vh;width:100%",
});

// Dynamic color
pingLabel.style.color = QUALITY_COLORS[stats.quality];
rttEl.style.fontWeight = "600";
```

---

## 13. Event Delegation and Handling

### Always pass `{ signal }` to addEventListener

Every `addEventListener` call must include an `AbortSignal` for
automatic cleanup:

```ts
// AbortController style
const ac = new AbortController();
btn.addEventListener("click", handler, { signal: ac.signal });
// ac.abort() removes all listeners

// Disposable style
disposable.onEvent(btn, "click", handler);
// disposable.destroy() removes all listeners
```

### Global event handlers in main.ts

Application-wide event handlers are registered once at startup:

```ts
// Disable browser context menu
document.addEventListener("contextmenu", (e) => { e.preventDefault(); });

// DevTools shortcut
document.addEventListener("keydown", (e) => {
  if (e.key === "F12" || (e.ctrlKey && e.shiftKey && e.key === "I")) {
    e.preventDefault();
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke("open_devtools");
    });
  }
});

// External link handler (event delegation on document)
document.addEventListener("click", (e) => {
  const link = (e.target as HTMLElement).closest("a[target='_blank']") as HTMLAnchorElement | null;
  if (link === null) return;
  e.preventDefault();
  void openUrl(link.href);
});
```

### Event delegation pattern

Use `closest()` for delegated event handling instead of attaching
listeners to every child element:

```ts
container.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement).closest("[data-action]");
  if (target === null) return;
  const action = target.getAttribute("data-action");
  switch (action) {
    case "delete": handleDelete(); break;
    case "edit": handleEdit(); break;
  }
}, { signal });
```

### Keyboard event handling

```ts
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
  if (e.key === "Escape") {
    handleCancel();
  }
}, { signal });
```

### Window lifecycle events

```ts
// Best-effort cleanup on window close
window.addEventListener("beforeunload", () => {
  const voice = voiceStore.getState();
  if (voice.currentChannelId !== null) {
    voiceSessionLeave(false);
    ws.send({ type: "voice_leave", payload: {} });
  }
});
```

---

## 14. Cleanup and Disposal Patterns

### Three-level cleanup hierarchy

1. **AbortController** -- removes all DOM event listeners at once
2. **unsubs array** -- store subscriptions, WS listeners, Tauri event listeners
3. **Manual cleanup** -- intervals, pollers, child components, DOM removal

### Standard destroy() implementation

```ts
function destroy(): void {
  // 1. Stop async operations
  stopStatsPoller();
  stopElapsedTimer();

  // 2. Abort all DOM event listeners
  ac.abort();

  // 3. Unsubscribe store/WS listeners
  for (const unsub of unsubs) { unsub(); }
  unsubs.length = 0;

  // 4. Remove DOM
  root?.remove();

  // 5. Null out all references (prevents stale access)
  root = null;
  channelNameEl = null;
  muteBtn = null;
}
```

### Page-level cleanup with error protection

Pages wrap child destruction in try/catch because individual
components might throw:

```ts
function destroy(): void {
  try {
    channelCtrl?.destroyChannel();
    channelCtrl = null;

    for (const child of children) {
      try { child.destroy?.(); }
      catch (err) { log.error("Child destroy error", err); }
    }
    children = [];

    for (const unsub of unsubscribers) {
      try { unsub(); }
      catch (err) { log.error("Unsubscribe error", err); }
    }
    unsubscribers = [];
  } finally {
    // DOM removal happens even if cleanup throws
    root?.remove();
    root = null;
    container = null;
  }
}
```

### Tauri event cleanup (suppressed rejections)

Tauri event unsubscribe functions may return rejected promises
if the resource was already invalidated:

```ts
function cleanupEventListeners(): void {
  for (const unsub of eventUnsubs) {
    try {
      const result = unsub() as unknown;
      if (result instanceof Promise) {
        result.catch(() => {}); // Suppressed -- resource already freed
      }
    } catch { /* safe to ignore */ }
  }
  eventUnsubs.length = 0;
}
```

### Module-level cleanup (LiveKit session)

Some modules maintain module-level state that must be cleaned
up on logout:

```ts
// MainPage.destroy():
voiceCleanupAll(); // Tears down room, callbacks, ws ref, serverHost
```

---

## 15. Error Handling

### Error narrowing pattern

```ts
try {
  await api.getMessages(channelId);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : "Unknown error";
  log.error("Failed to fetch messages", { channelId, error: msg });
}
```

### API error handling

```ts
try {
  await api.login(username, password);
} catch (err) {
  if (err instanceof ApiClientError) {
    log.error("Login failed", { status: err.status, code: err.code });
    // User-facing error message:
    showError(err.message);
  }
}
```

### Toast-based user feedback

Components show errors to users via the toast container:

```ts
try {
  await api.changePassword(oldPassword, newPassword);
  toast?.show("Password changed successfully", "success");
} catch (err) {
  const msg = err instanceof Error ? err.message : "Failed to change password";
  toast?.show(msg, "error");
  throw err; // Re-throw so the caller knows it failed
}
```

### Error boundary (safeMount)

Always use `safeMount` instead of `component.mount()` directly:

```ts
import { safeMount } from "@lib/safe-render";

safeMount(component, container);
```

On error, `safeMount` renders a styled error box:

```ts
export function safeMount(component: MountableComponent, container: Element): void {
  try {
    component.mount(container);
  } catch (err) {
    log.error("Component mount failed", err);
    renderFallback(container, err);
  }
}
```

### Global error handlers

Called once at app startup:

```ts
import { installGlobalErrorHandlers } from "@lib/safe-render";
installGlobalErrorHandlers();
```

Catches uncaught errors and unhandled promise rejections. Benign
Tauri resource cleanup rejections are downgraded to debug:

```ts
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error
    ? event.reason.stack ?? event.reason.message
    : String(event.reason);

  // Tauri plugin-http GC cleanup -- cosmetic, downgrade to debug
  if (typeof reason === "string" && /resource id .+ is invalid/.test(reason)) {
    log.debug("Tauri resource already freed (benign)", { reason });
    return;
  }

  log.error("Unhandled promise rejection", { reason });
});
```

### WS listener error isolation

WS dispatch wraps each listener in try/catch so one failing
listener does not break others:

```ts
function dispatch(msg: ServerMessage): void {
  const typeListeners = listeners.get(msg.type);
  for (const listener of typeListeners) {
    try {
      listener(msg.payload, msg.id);
    } catch (err) {
      log.error(`Listener error for ${msg.type}`, err);
    }
  }
}
```

---

## 16. Logging

### Scoped logger creation

Every file gets a scoped logger:

```ts
import { createLogger } from "@lib/logger";
const log = createLogger("my-component");
```

### Log levels

```ts
log.debug("Rendering items", { count: items.length });
log.info("Channel switched", { channelId: 42 });
log.warn("Message exceeds size limit", { size: raw.length });
log.error("Failed to load messages", { channelId, error: String(err) });
```

### Structured data -- pass objects, not string interpolation

```ts
// CORRECT
log.info("Member joined", { userId: payload.user.id, username: payload.user.username });

// WRONG
log.info(`Member ${payload.user.username} joined`);
```

### Error serialization

The logger automatically serializes `Error` objects (message +
stack) since `JSON.stringify` does not include those by default:

```ts
function serializeData(data: unknown): unknown {
  if (data instanceof Error) {
    return { error: data.message, stack: data.stack };
  }
  // ... handle nested errors in objects
}
```

### Circular buffer

The logger stores entries in a 500-entry circular buffer
accessible via `getLogBuffer()` (used by the Logs settings tab):

```ts
export function getLogBuffer(): readonly LogEntry[] {
  return logBuffer;
}
```

### Log listener registration

External consumers (e.g., file-based logging via Tauri) can
subscribe:

```ts
const unsub = addLogListener((entry) => {
  // Write to file, send to telemetry, etc.
});
```

---

## 17. Preferences and localStorage

### Reading and writing preferences

Helpers live in `components/settings/helpers.ts`:

```ts
import { loadPref, savePref } from "@components/settings/helpers";

// Always provide a default value
const isEnabled = loadPref<boolean>("desktopNotifications", true);
const fontSize = loadPref<number>("fontSize", 14);

// Write
savePref("desktopNotifications", false);
```

### Storage prefix

All keys are prefixed with `owncord:settings:` in localStorage.

### Cross-tab notification

`savePref` dispatches a `CustomEvent("owncord:pref-change")` on
`window` so same-tab listeners can react (the native `storage`
event only fires cross-tab).

### Toggle helper

`createToggle` builds an accessible toggle switch with ARIA
attributes and keyboard support:

```ts
const toggle = createToggle(loadPref("myPref", true), {
  signal,
  onChange: (nowOn) => { savePref("myPref", nowOn); },
});
```

### sessionStorage for transient state

Used for cross-page data transfer (e.g., quick-switch):

```ts
// Set in QuickSwitchOverlay:
sessionStorage.setItem("owncord:quick-switch-target", host);

// Read in main.ts after page transition:
const target = sessionStorage.getItem("owncord:quick-switch-target");
sessionStorage.removeItem("owncord:quick-switch-target");
```

---

## 18. Import Conventions

### Path aliases (from tsconfig.json)

```ts
import { createElement } from "@lib/dom";
import { myStore } from "@stores/my.store";
import { MyComponent } from "@components/MyComponent";
import { MainPage } from "@pages/MainPage";
import "@styles/tokens.css";
```

### Import ordering

```ts
// 1. Type imports (import type)
import type { MountableComponent } from "@lib/safe-render";
import type { Channel } from "@stores/channels.store";

// 2. Library imports
import { createElement, appendChildren, setText } from "@lib/dom";
import { createLogger } from "@lib/logger";
import { Disposable } from "@lib/disposable";

// 3. Store imports
import { channelsStore, setActiveChannel } from "@stores/channels.store";
import { membersStore } from "@stores/members.store";

// 4. Component imports
import { createTypingIndicator } from "@components/TypingIndicator";

// 5. Style imports
import "@styles/tokens.css";
```

### Re-exports for public API stability

Sub-modules re-export types through their parent module so
external callers don't need to know the internal file structure:

```ts
// ConnectPage.ts re-exports types from sub-modules
export type { FormState, FormMode } from "./connect-page/LoginForm";
export type { SimpleProfile } from "./connect-page/ServerPanel";
```

---

## 19. Testing Patterns

### Framework and configuration

- **Framework**: Vitest with jsdom environment
- **Config**: `vitest.config.ts` at the project root
- **Coverage provider**: V8
- **Coverage thresholds**: 75% statements, branches, functions, lines

### File locations and naming

```text
tests/
  unit/           # *.test.ts -- unit tests for individual modules
  integration/    # *.test.ts -- cross-module integration tests
  e2e/            # *.spec.ts -- Playwright browser-based E2E tests
  helpers/        # Shared test utilities
    mock-ws.ts    # Mock WS client
    test-utils.ts # Store reset + async helpers
    fixtures.ts   # Test data factories
```

### Store reset between tests

```ts
import { resetAllStores } from "../helpers/test-utils";

beforeEach(() => {
  resetAllStores();
});
```

### Mock WebSocket client

```ts
import { createMockWsClient } from "../helpers/mock-ws";

const ws = createMockWsClient();

// Simulate a server message
ws.simulateMessage("chat_message", { id: 1, channel_id: 1, ... });

// Simulate connection state change
ws.simulateStateChange("reconnecting");

// Inspect outbound sends
expect(ws.getSentMessages()).toHaveLength(1);
expect(ws.lastSent?.type).toBe("chat_send");

// Clear sent buffer
ws.clearSent();
```

### Test data factories

```ts
import { makeMessage, makeMember, makeChannel, makeReadyPayload } from "../helpers/fixtures";

const msg = makeMessage({ id: 42, content: "custom" });
const member = makeMember({ username: "alice", status: "idle" });
const channel = makeChannel({ id: 5, name: "voice-lobby", type: "voice" });
const ready = makeReadyPayload();
```

### Component testing pattern

```ts
describe("VoiceWidget", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetAllStores();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders hidden when not connected", () => {
    const widget = createVoiceWidget({ onDisconnect: vi.fn(), ... });
    widget.mount(container);

    const root = container.querySelector('[data-testid="voice-widget"]');
    expect(root).not.toBeNull();
    expect(root!.classList.contains("visible")).toBe(false);

    widget.destroy?.();
  });
});
```

### Mocking Tauri APIs

```ts
const { mockInvoke, mockListen } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockListen: vi.fn(async (event, handler) => {
    return () => {};
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mockListen }));
```

### Async store waiting

```ts
import { waitForStoreUpdate } from "../helpers/test-utils";

await waitForStoreUpdate(authStore, (s) => s.isAuthenticated);
```

### Synchronous flushing

```ts
myStore.setState((prev) => ({ ...prev, count: 1 }));
myStore.flush(); // fire subscribers synchronously, no microtask wait
```

### Coverage configuration

Excludes Tauri-specific modules that cannot run in jsdom:

```ts
coverage: {
  provider: "v8",
  include: ["src/**/*.ts"],
  exclude: [
    "src/main.ts",
    "src/**/*.d.ts",
    "src/lib/window-state.ts",
    "src/lib/credentials.ts",
    "src/lib/audio.ts",
    "src/lib/vad.ts",
    "src/lib/webrtc.ts",
    "src/lib/voiceSession.ts",
    "src/lib/noise-suppression.ts",
    "src/lib/updater.ts",
    "src/pages/MainPage.ts",
    "src/components/UpdateNotifier.ts",
  ],
  thresholds: {
    statements: 75,
    branches: 75,
    functions: 75,
    lines: 75,
  },
}
```
