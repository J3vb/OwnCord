// MainPage — primary app layout after login.
// Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.

import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";

// ---------------------------------------------------------------------------
// MainPage
// ---------------------------------------------------------------------------

export function createMainPage(): MountableComponent {
  let container: Element | null = null;
  let root: HTMLDivElement;

  const abortController = new AbortController();
  const signal = abortController.signal;

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  function buildRoot(): HTMLDivElement {
    const reconnectBanner = buildReconnectBanner();
    const serverStrip = buildServerStrip();
    const channelSidebar = buildChannelSidebar();
    const chatArea = buildChatArea();
    const memberList = buildMemberList();

    // Outer wrapper holds the reconnect banner above the main flex row
    const wrapper = createElement("div", {
      style: "display:flex;flex-direction:column;height:100vh;width:100%",
    });
    wrapper.appendChild(reconnectBanner);

    // .app is the main flex row matching the mockup layout
    const app = createElement("div", { class: "app" });
    appendChildren(app, serverStrip, channelSidebar, chatArea, memberList);
    wrapper.appendChild(app);

    root = wrapper;
    return root;
  }

  function buildReconnectBanner(): HTMLDivElement {
    const banner = createElement("div", {
      class: "reconnecting-banner",
      "aria-live": "polite",
    }, "Reconnecting...");
    return banner;
  }

  function buildServerStrip(): HTMLDivElement {
    const strip = createElement("div", { class: "server-strip" });

    // Home button placeholder
    const homeBtn = createElement("div", {
      class: "server-icon active",
      style: "background: var(--accent)",
      "aria-label": "Home",
    });
    homeBtn.textContent = "H";
    homeBtn.addEventListener("click", () => {
      // placeholder: home navigation
    }, { signal });

    const separator = createElement("div", { class: "server-separator" });

    // Add server button placeholder
    const addBtn = createElement("div", {
      class: "server-icon add",
      "aria-label": "Add Server",
    });
    addBtn.textContent = "+";

    appendChildren(strip, homeBtn, separator, addBtn);
    return strip;
  }

  function buildChannelSidebar(): HTMLDivElement {
    const sidebar = createElement("div", { class: "channel-sidebar" });

    // Sidebar header (server name)
    const header = createElement("div", { class: "channel-sidebar-header" });
    const serverName = createElement("h2", {}, "Server Name");
    header.appendChild(serverName);

    // Channel list
    const channelList = createElement("div", { class: "channel-list" });

    // Placeholder category
    const category = createElement("div", { class: "category" });
    const arrow = createElement("span", { class: "category-arrow" }, "\u25BC");
    const catName = createElement("span", { class: "category-name" }, "Text Channels");
    appendChildren(category, arrow, catName);

    const categoryChannels = createElement("div", { class: "category-channels" });
    const placeholderChannel = createElement("div", { class: "channel-item active" });
    const chIcon = createElement("span", { class: "ch-icon" }, "#");
    const chName = createElement("span", { class: "ch-name" }, "general");
    appendChildren(placeholderChannel, chIcon, chName);
    categoryChannels.appendChild(placeholderChannel);

    appendChildren(channelList, category, categoryChannels);

    // Voice widget placeholder (hidden by default)
    const voiceWidget = createElement("div", { class: "voice-widget" });

    // User bar
    const userBar = buildUserBar();

    appendChildren(sidebar, header, channelList, voiceWidget, userBar);
    return sidebar;
  }

  function buildUserBar(): HTMLDivElement {
    const bar = createElement("div", { class: "user-bar" });

    const avatar = createElement("div", {
      class: "ub-avatar",
      style: "background: var(--accent)",
    }, "U");
    const statusDot = createElement("div", {
      class: "status-dot",
      style: "background: var(--green)",
    });
    avatar.appendChild(statusDot);

    const info = createElement("div", { class: "ub-info" });
    const name = createElement("div", { class: "ub-name" }, "Username");
    const status = createElement("div", { class: "ub-status" }, "Online");
    appendChildren(info, name, status);

    const controls = createElement("div", { class: "ub-controls" });
    const muteBtn = createElement("button", {
      type: "button",
      "aria-label": "Mute",
    }, "\uD83C\uDFA4");
    const deafenBtn = createElement("button", {
      type: "button",
      "aria-label": "Deafen",
    }, "\uD83C\uDFA7");
    const settingsBtn = createElement("button", {
      type: "button",
      "aria-label": "Settings",
    }, "\u2699");
    appendChildren(controls, muteBtn, deafenBtn, settingsBtn);

    appendChildren(bar, avatar, info, controls);
    return bar;
  }

  function buildChatArea(): HTMLDivElement {
    const area = createElement("div", { class: "chat-area" });

    // Chat header
    const header = createElement("div", { class: "chat-header" });
    const hash = createElement("span", { class: "ch-hash" }, "#");
    const channelName = createElement("span", { class: "ch-name" }, "general");
    const divider = createElement("div", { class: "ch-divider" });
    const topic = createElement("span", { class: "ch-topic" }, "General discussion");

    const tools = createElement("div", { class: "ch-tools" });
    const searchInput = createElement("input", {
      class: "search-input",
      type: "text",
      placeholder: "Search...",
    });
    const membersToggle = createElement("button", {
      type: "button",
      "aria-label": "Toggle member list",
    }, "\uD83D\uDC65");
    appendChildren(tools, searchInput, membersToggle);

    appendChildren(header, hash, channelName, divider, topic, tools);

    // Messages container
    const messagesContainer = createElement("div", { class: "messages-container" });

    // Typing indicator
    const typingBar = createElement("div", { class: "typing-bar" });

    // Chat input area
    const inputWrap = createElement("div", { class: "message-input-wrap" });
    const inputBox = createElement("div", { class: "message-input-box" });

    const attachBtn = createElement("button", {
      class: "input-btn",
      type: "button",
      "aria-label": "Attach file",
    }, "+");

    const textarea = createElement("textarea", {
      class: "msg-textarea",
      placeholder: "Message #general",
      rows: "1",
    });
    textarea.addEventListener("input", () => {
      // Auto-resize textarea
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }, { signal });

    const sendBtn = createElement("button", {
      class: "input-btn",
      type: "button",
      "aria-label": "Send message",
    }, "\u27A4");

    appendChildren(inputBox, attachBtn, textarea, sendBtn);
    inputWrap.appendChild(inputBox);

    appendChildren(area, header, messagesContainer, typingBar, inputWrap);
    return area;
  }

  function buildMemberList(): HTMLDivElement {
    const list = createElement("div", { class: "member-list" });

    // Placeholder role group
    const roleGroup = createElement("div", {
      class: "member-role-group",
    }, "Online \u2014 0");

    list.appendChild(roleGroup);
    return list;
  }

  // ---------------------------------------------------------------------------
  // MountableComponent
  // ---------------------------------------------------------------------------

  function mount(target: Element): void {
    container = target;
    const rootEl = buildRoot();
    container.appendChild(rootEl);
  }

  function destroy(): void {
    abortController.abort();

    if (container && root) {
      container.removeChild(root);
    }
    container = null;
  }

  return {
    mount,
    destroy,
  };
}

export type MainPage = ReturnType<typeof createMainPage>;
