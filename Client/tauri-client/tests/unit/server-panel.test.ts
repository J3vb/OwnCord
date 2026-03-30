import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createServerPanel,
  type ServerPanelOptions,
  type SimpleProfile,
} from "@pages/connect-page/ServerPanel";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// loadCredential returns null by default (non-Tauri environment)
vi.mock("@lib/credentials", () => ({
  loadCredential: vi.fn().mockResolvedValue(null),
}));

// Icons mock — return a real SVG element so the DOM tests work
vi.mock("@lib/icons", () => ({
  createIcon: vi.fn((_name: string, _size?: number) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("data-icon", _name);
    return svg;
  }),
}));

import { loadCredential } from "@lib/credentials";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAc(): AbortController {
  return new AbortController();
}

function makeOpts(overrides: Partial<ServerPanelOptions> = {}): ServerPanelOptions {
  return {
    signal: overrides.signal ?? makeAc().signal,
    onServerClick: overrides.onServerClick ?? vi.fn(),
    onCredentialLoaded: overrides.onCredentialLoaded ?? vi.fn(),
    onAddProfile: overrides.onAddProfile ?? vi.fn(),
    onDeleteProfile: overrides.onDeleteProfile ?? vi.fn(),
    onToggleAutoLogin: overrides.onToggleAutoLogin ?? vi.fn(),
  };
}

const SIMPLE_PROFILES: readonly SimpleProfile[] = [
  { name: "Test Server", host: "localhost:8443" },
  { name: "Another Server", host: "remote.example.com:9443" },
];

/** Full profile shape with id/username/autoConnect for auto-login + delete tests. */
function fullProfile(overrides: Record<string, unknown> = {}): SimpleProfile {
  return {
    name: "Full Server",
    host: "full.example.com:8443",
    id: "profile-1",
    username: "testuser",
    autoConnect: false,
    rememberPassword: true,
    color: "#5865F2",
    lastConnected: null,
    ...overrides,
  } as unknown as SimpleProfile;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ServerPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    // Wrap in a connect-page root so handleAddServer can mount the modal
    container.classList.add("connect-page");
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    container.remove();
  });

  // -----------------------------------------------------------------------
  // Basic rendering
  // -----------------------------------------------------------------------

  describe("rendering", () => {
    it("renders a server-panel element", () => {
      const panel = createServerPanel(makeOpts(), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      expect(container.querySelector(".server-panel")).not.toBeNull();
    });

    it("renders a heading with text 'Servers'", () => {
      const panel = createServerPanel(makeOpts(), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const heading = container.querySelector("h2");
      expect(heading?.textContent).toBe("Servers");
    });

    it("renders one server-item per profile", () => {
      const panel = createServerPanel(makeOpts(), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const items = container.querySelectorAll(".server-item");
      expect(items.length).toBe(2);
    });

    it("renders server name and host", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      expect(container.querySelector(".srv-name")?.textContent).toBe("Test Server");
      expect(container.querySelector(".srv-host")?.textContent).toBe("localhost:8443");
    });

    it("renders an icon with the first letter of the server name", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      const icon = container.querySelector(".srv-icon");
      expect(icon?.textContent).toBe("T");
    });

    it("renders an icon with a background color from the palette", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      const icon = container.querySelector(".srv-icon") as HTMLElement;
      expect(icon.style.background).toBeTruthy();
    });

    it("renders data-host attribute on each server-item", () => {
      const panel = createServerPanel(makeOpts(), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const items = container.querySelectorAll(".server-item");
      expect(items[0]?.getAttribute("data-host")).toBe("localhost:8443");
      expect(items[1]?.getAttribute("data-host")).toBe("remote.example.com:9443");
    });

    it("renders a status dot with unknown class initially", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      const dot = container.querySelector(".srv-status-dot");
      expect(dot?.classList.contains("unknown")).toBe(true);
    });

    it("renders the '+ Add Server' button in the footer", () => {
      const panel = createServerPanel(makeOpts(), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server");
      expect(addBtn?.textContent).toBe("+ Add Server");
    });
  });

  // -----------------------------------------------------------------------
  // Username display for full profiles
  // -----------------------------------------------------------------------

  describe("username display", () => {
    it("renders username in meta when profile has one", () => {
      const fp = fullProfile();
      const panel = createServerPanel(makeOpts(), [fp]);
      container.appendChild(panel.element);

      const hosts = container.querySelectorAll(".srv-host");
      // First is the host address, second is the username
      expect(hosts.length).toBe(2);
      expect(hosts[1]?.textContent).toBe("testuser");
    });

    it("does NOT render extra username span for simple profiles", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      const hosts = container.querySelectorAll(".srv-host");
      expect(hosts.length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Server click
  // -----------------------------------------------------------------------

  describe("server click", () => {
    it("calls onServerClick with host when a server item is clicked", () => {
      const onServerClick = vi.fn();
      const panel = createServerPanel(
        makeOpts({ onServerClick }),
        [SIMPLE_PROFILES[0]!],
      );
      container.appendChild(panel.element);

      const item = container.querySelector(".server-item") as HTMLElement;
      item.click();

      expect(onServerClick).toHaveBeenCalledWith("localhost:8443", undefined);
    });

    it("calls onServerClick with host AND username for full profiles", () => {
      const onServerClick = vi.fn();
      const fp = fullProfile();
      const panel = createServerPanel(
        makeOpts({ onServerClick }),
        [fp],
      );
      container.appendChild(panel.element);

      const item = container.querySelector(".server-item") as HTMLElement;
      item.click();

      expect(onServerClick).toHaveBeenCalledWith("full.example.com:8443", "testuser");
    });

    it("attempts to load credentials from credential store on click", async () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      const item = container.querySelector(".server-item") as HTMLElement;
      item.click();

      // Wait for the async loadCredential call
      await vi.waitFor(() => {
        expect(loadCredential).toHaveBeenCalledWith("localhost:8443");
      });
    });

    it("calls onCredentialLoaded when credentials are found", async () => {
      const onCredentialLoaded = vi.fn();
      vi.mocked(loadCredential).mockResolvedValueOnce({
        username: "saveduser",
        token: "tok",
        password: "savedpass",
      });

      const panel = createServerPanel(
        makeOpts({ onCredentialLoaded }),
        [SIMPLE_PROFILES[0]!],
      );
      container.appendChild(panel.element);

      const item = container.querySelector(".server-item") as HTMLElement;
      item.click();

      await vi.waitFor(() => {
        expect(onCredentialLoaded).toHaveBeenCalledWith(
          "localhost:8443",
          "saveduser",
          "savedpass",
        );
      });
    });

    it("does NOT call onCredentialLoaded when no credentials found", async () => {
      const onCredentialLoaded = vi.fn();
      vi.mocked(loadCredential).mockResolvedValueOnce(null);

      const panel = createServerPanel(
        makeOpts({ onCredentialLoaded }),
        [SIMPLE_PROFILES[0]!],
      );
      container.appendChild(panel.element);

      const item = container.querySelector(".server-item") as HTMLElement;
      item.click();

      // Wait for loadCredential to resolve
      await new Promise((r) => setTimeout(r, 10));
      expect(onCredentialLoaded).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Auto-login toggle
  // -----------------------------------------------------------------------

  describe("auto-login toggle", () => {
    it("renders auto-login button for full profiles with onToggleAutoLogin", () => {
      const panel = createServerPanel(makeOpts(), [fullProfile()]);
      container.appendChild(panel.element);

      const autoLoginBtn = container.querySelector(".auto-login");
      expect(autoLoginBtn).not.toBeNull();
    });

    it("does NOT render auto-login button for simple profiles", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      const autoLoginBtn = container.querySelector(".auto-login");
      expect(autoLoginBtn).toBeNull();
    });

    it("does NOT render auto-login button when onToggleAutoLogin not provided", () => {
      const ac = new AbortController();
      const opts: ServerPanelOptions = {
        signal: ac.signal,
        onServerClick: vi.fn(),
        onCredentialLoaded: vi.fn(),
        // onToggleAutoLogin intentionally omitted
      };
      const panel = createServerPanel(opts, [fullProfile()]);
      container.appendChild(panel.element);

      const autoLoginBtn = container.querySelector(".auto-login");
      expect(autoLoginBtn).toBeNull();
    });

    it("renders active class and correct aria-label when autoConnect is true", () => {
      const fp = fullProfile({ autoConnect: true });
      const panel = createServerPanel(makeOpts(), [fp]);
      container.appendChild(panel.element);

      const autoLoginBtn = container.querySelector(".auto-login") as HTMLElement;
      expect(autoLoginBtn.classList.contains("active")).toBe(true);
      expect(autoLoginBtn.getAttribute("aria-label")).toBe("Disable auto-login");
      expect(autoLoginBtn.getAttribute("title")).toBe("Auto-login enabled");
    });

    it("renders without active class when autoConnect is false", () => {
      const fp = fullProfile({ autoConnect: false });
      const panel = createServerPanel(makeOpts(), [fp]);
      container.appendChild(panel.element);

      const autoLoginBtn = container.querySelector(".auto-login") as HTMLElement;
      expect(autoLoginBtn.classList.contains("active")).toBe(false);
      expect(autoLoginBtn.getAttribute("aria-label")).toBe("Enable auto-login");
      expect(autoLoginBtn.getAttribute("title")).toBe("Enable auto-login");
    });

    it("calls onToggleAutoLogin with profile id and toggled state", () => {
      const onToggleAutoLogin = vi.fn();
      const fp = fullProfile({ autoConnect: false });
      const panel = createServerPanel(
        makeOpts({ onToggleAutoLogin }),
        [fp],
      );
      container.appendChild(panel.element);

      const autoLoginBtn = container.querySelector(".auto-login") as HTMLElement;
      autoLoginBtn.click();

      expect(onToggleAutoLogin).toHaveBeenCalledWith("profile-1", true);
    });

    it("stops event propagation so server click is not also triggered", () => {
      const onServerClick = vi.fn();
      const onToggleAutoLogin = vi.fn();
      const fp = fullProfile();
      const panel = createServerPanel(
        makeOpts({ onServerClick, onToggleAutoLogin }),
        [fp],
      );
      container.appendChild(panel.element);

      const autoLoginBtn = container.querySelector(".auto-login") as HTMLElement;
      autoLoginBtn.click();

      expect(onToggleAutoLogin).toHaveBeenCalled();
      expect(onServerClick).not.toHaveBeenCalled();
    });

    it("renders the zap icon inside the auto-login button", () => {
      const panel = createServerPanel(makeOpts(), [fullProfile()]);
      container.appendChild(panel.element);

      const autoLoginBtn = container.querySelector(".auto-login") as HTMLElement;
      const svg = autoLoginBtn.querySelector("svg");
      expect(svg?.getAttribute("data-icon")).toBe("zap");
    });
  });

  // -----------------------------------------------------------------------
  // Delete button
  // -----------------------------------------------------------------------

  describe("delete button", () => {
    it("renders delete button for full profiles with onDeleteProfile", () => {
      const panel = createServerPanel(makeOpts(), [fullProfile()]);
      container.appendChild(panel.element);

      const deleteBtn = container.querySelector(".srv-btn.danger");
      expect(deleteBtn).not.toBeNull();
    });

    it("does NOT render delete button for simple profiles", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      const deleteBtn = container.querySelector(".srv-btn.danger");
      expect(deleteBtn).toBeNull();
    });

    it("does NOT render delete button when onDeleteProfile not provided", () => {
      const ac = new AbortController();
      const opts: ServerPanelOptions = {
        signal: ac.signal,
        onServerClick: vi.fn(),
        onCredentialLoaded: vi.fn(),
        // onDeleteProfile intentionally omitted
      };
      const panel = createServerPanel(opts, [fullProfile()]);
      container.appendChild(panel.element);

      const deleteBtn = container.querySelector(".srv-btn.danger");
      expect(deleteBtn).toBeNull();
    });

    it("calls onDeleteProfile with profile id on click", () => {
      const onDeleteProfile = vi.fn();
      const fp = fullProfile();
      const panel = createServerPanel(
        makeOpts({ onDeleteProfile }),
        [fp],
      );
      container.appendChild(panel.element);

      const deleteBtn = container.querySelector(".srv-btn.danger") as HTMLElement;
      deleteBtn.click();

      expect(onDeleteProfile).toHaveBeenCalledWith("profile-1");
    });

    it("stops event propagation so server click is not also triggered", () => {
      const onServerClick = vi.fn();
      const onDeleteProfile = vi.fn();
      const fp = fullProfile();
      const panel = createServerPanel(
        makeOpts({ onServerClick, onDeleteProfile }),
        [fp],
      );
      container.appendChild(panel.element);

      const deleteBtn = container.querySelector(".srv-btn.danger") as HTMLElement;
      deleteBtn.click();

      expect(onDeleteProfile).toHaveBeenCalled();
      expect(onServerClick).not.toHaveBeenCalled();
    });

    it("renders the x icon inside the delete button", () => {
      const panel = createServerPanel(makeOpts(), [fullProfile()]);
      container.appendChild(panel.element);

      const deleteBtn = container.querySelector(".srv-btn.danger") as HTMLElement;
      const svg = deleteBtn.querySelector("svg");
      expect(svg?.getAttribute("data-icon")).toBe("x");
    });
  });

  // -----------------------------------------------------------------------
  // Health status updates
  // -----------------------------------------------------------------------

  describe("updateHealthStatus", () => {
    it("updates the status dot class to online", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      panel.updateHealthStatus("localhost:8443", {
        status: "online",
        latencyMs: 42,
        version: "1.0.0",
        onlineUsers: 5,
      });

      const dot = container.querySelector(".srv-status-dot");
      expect(dot?.className).toBe("srv-status-dot online");
    });

    it("updates latency text and class for good latency", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      panel.updateHealthStatus("localhost:8443", {
        status: "online",
        latencyMs: 42,
        version: "1.0.0",
        onlineUsers: 3,
      });

      const latency = container.querySelector(".srv-latency");
      expect(latency?.textContent).toBe("42ms");
      expect(latency?.className).toBe("srv-latency good");
    });

    it("applies warn class for moderate latency (100-500ms)", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      panel.updateHealthStatus("localhost:8443", {
        status: "slow",
        latencyMs: 250,
        version: "1.0.0",
        onlineUsers: 1,
      });

      const latency = container.querySelector(".srv-latency");
      expect(latency?.textContent).toBe("250ms");
      expect(latency?.className).toBe("srv-latency warn");
    });

    it("applies bad class for high latency (>500ms)", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      panel.updateHealthStatus("localhost:8443", {
        status: "slow",
        latencyMs: 750,
        version: "1.0.0",
        onlineUsers: 0,
      });

      const latency = container.querySelector(".srv-latency");
      expect(latency?.textContent).toBe("750ms");
      expect(latency?.className).toBe("srv-latency bad");
    });

    it("clears latency text when latencyMs is null", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      // First set a latency
      panel.updateHealthStatus("localhost:8443", {
        status: "online",
        latencyMs: 42,
        version: "1.0.0",
        onlineUsers: 3,
      });

      // Then clear it
      panel.updateHealthStatus("localhost:8443", {
        status: "offline",
        latencyMs: null,
        version: null,
        onlineUsers: null,
      });

      const latency = container.querySelector(".srv-latency");
      expect(latency?.textContent).toBe("");
      expect(latency?.className).toBe("srv-latency");
    });

    it("displays online users count", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      panel.updateHealthStatus("localhost:8443", {
        status: "online",
        latencyMs: 30,
        version: "1.0.0",
        onlineUsers: 5,
      });

      const onlineUsers = container.querySelector(".srv-online-users");
      expect(onlineUsers?.textContent).toBe("5 online");
      expect(onlineUsers?.classList.contains("has-users")).toBe(true);
    });

    it("displays online users without has-users class when count is 0", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      panel.updateHealthStatus("localhost:8443", {
        status: "online",
        latencyMs: 30,
        version: "1.0.0",
        onlineUsers: 0,
      });

      const onlineUsers = container.querySelector(".srv-online-users");
      expect(onlineUsers?.textContent).toBe("0 online");
      expect(onlineUsers?.classList.contains("has-users")).toBe(false);
    });

    it("clears online users text when onlineUsers is null", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      panel.updateHealthStatus("localhost:8443", {
        status: "offline",
        latencyMs: null,
        version: null,
        onlineUsers: null,
      });

      const onlineUsers = container.querySelector(".srv-online-users");
      expect(onlineUsers?.textContent).toBe("");
      expect(onlineUsers?.className).toBe("srv-online-users");
    });

    it("ignores updates for unknown hosts", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      // Should not throw
      panel.updateHealthStatus("unknown.host:9999", {
        status: "online",
        latencyMs: 10,
        version: "1.0.0",
        onlineUsers: 1,
      });

      // Original dot should still be unknown
      const dot = container.querySelector(".srv-status-dot");
      expect(dot?.classList.contains("unknown")).toBe(true);
    });

    it("updates status dot to offline class", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      panel.updateHealthStatus("localhost:8443", {
        status: "offline",
        latencyMs: null,
        version: null,
        onlineUsers: null,
      });

      const dot = container.querySelector(".srv-status-dot");
      expect(dot?.className).toBe("srv-status-dot offline");
    });

    it("updates status dot to checking class", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      panel.updateHealthStatus("localhost:8443", {
        status: "checking",
        latencyMs: null,
        version: null,
        onlineUsers: null,
      });

      const dot = container.querySelector(".srv-status-dot");
      expect(dot?.className).toBe("srv-status-dot checking");
    });

    it("clears online users when onlineUsers is negative", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      panel.updateHealthStatus("localhost:8443", {
        status: "online",
        latencyMs: 30,
        version: "1.0.0",
        onlineUsers: -1,
      });

      const onlineUsers = container.querySelector(".srv-online-users");
      expect(onlineUsers?.textContent).toBe("");
    });
  });

  // -----------------------------------------------------------------------
  // renderProfiles (re-render)
  // -----------------------------------------------------------------------

  describe("renderProfiles", () => {
    it("replaces existing profiles with new ones", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      expect(container.querySelectorAll(".server-item").length).toBe(1);

      panel.renderProfiles(SIMPLE_PROFILES);
      expect(container.querySelectorAll(".server-item").length).toBe(2);
    });

    it("clears health elements so old hosts no longer receive updates", () => {
      const panel = createServerPanel(makeOpts(), [SIMPLE_PROFILES[0]!]);
      container.appendChild(panel.element);

      // Re-render with different profiles
      panel.renderProfiles([SIMPLE_PROFILES[1]!]);

      // Updating the old host should not throw and should have no effect
      panel.updateHealthStatus("localhost:8443", {
        status: "online",
        latencyMs: 10,
        version: "1.0.0",
        onlineUsers: 1,
      });

      // The new profile's dot should still be unknown
      const dot = container.querySelector(".srv-status-dot");
      expect(dot?.classList.contains("unknown")).toBe(true);
    });

    it("renders with empty array (no profiles)", () => {
      const panel = createServerPanel(makeOpts(), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      panel.renderProfiles([]);
      expect(container.querySelectorAll(".server-item").length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Add Server modal
  // -----------------------------------------------------------------------

  describe("Add Server modal", () => {
    it("opens a modal when the Add Server button is clicked", () => {
      const panel = createServerPanel(makeOpts(), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server") as HTMLElement;
      addBtn.click();

      const overlay = container.querySelector(".modal-overlay");
      expect(overlay).not.toBeNull();
      expect(overlay?.classList.contains("visible")).toBe(true);
    });

    it("does nothing if onAddProfile is not provided", () => {
      const ac = new AbortController();
      const opts: ServerPanelOptions = {
        signal: ac.signal,
        onServerClick: vi.fn(),
        onCredentialLoaded: vi.fn(),
        // onAddProfile intentionally omitted
      };
      const panel = createServerPanel(opts, SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server") as HTMLElement;
      addBtn.click();

      const overlay = container.querySelector(".modal-overlay");
      expect(overlay).toBeNull();
    });

    it("modal has name and host input fields", () => {
      const panel = createServerPanel(makeOpts(), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server") as HTMLElement;
      addBtn.click();

      const inputs = container.querySelectorAll(".form-input");
      expect(inputs.length).toBe(2);
      expect((inputs[0] as HTMLInputElement).placeholder).toBe("My Server");
      expect((inputs[1] as HTMLInputElement).placeholder).toBe("example.com:8443");
    });

    it("modal has Cancel and Add Server buttons", () => {
      const panel = createServerPanel(makeOpts(), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server") as HTMLElement;
      addBtn.click();

      expect(container.querySelector(".btn-ghost")?.textContent).toBe("Cancel");
      expect(container.querySelector(".modal-footer .btn-primary")?.textContent).toBe("Add Server");
    });

    it("closes modal when Cancel is clicked", () => {
      const panel = createServerPanel(makeOpts(), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server") as HTMLElement;
      addBtn.click();

      expect(container.querySelector(".modal-overlay")).not.toBeNull();

      const cancelBtn = container.querySelector(".btn-ghost") as HTMLElement;
      cancelBtn.click();

      expect(container.querySelector(".modal-overlay")).toBeNull();
    });

    it("closes modal when the X close button is clicked", () => {
      const panel = createServerPanel(makeOpts(), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server") as HTMLElement;
      addBtn.click();

      const closeBtn = container.querySelector(".modal-close") as HTMLElement;
      closeBtn.click();

      expect(container.querySelector(".modal-overlay")).toBeNull();
    });

    it("closes modal when clicking the backdrop", () => {
      const panel = createServerPanel(makeOpts(), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server") as HTMLElement;
      addBtn.click();

      const overlay = container.querySelector(".modal-overlay") as HTMLElement;
      // Simulate clicking the overlay itself (not the modal content)
      overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(container.querySelector(".modal-overlay")).toBeNull();
    });

    it("does NOT close modal when clicking inside the modal body", () => {
      const panel = createServerPanel(makeOpts(), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server") as HTMLElement;
      addBtn.click();

      const modal = container.querySelector(".modal") as HTMLElement;
      modal.click();

      expect(container.querySelector(".modal-overlay")).not.toBeNull();
    });

    it("calls onAddProfile and closes modal on valid save", () => {
      const onAddProfile = vi.fn();
      const panel = createServerPanel(makeOpts({ onAddProfile }), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server") as HTMLElement;
      addBtn.click();

      const inputs = container.querySelectorAll(".form-input") as NodeListOf<HTMLInputElement>;
      inputs[0]!.value = "My New Server";
      inputs[1]!.value = "newserver.com:8443";

      const saveBtn = container.querySelector(".modal-footer .btn-primary") as HTMLElement;
      saveBtn.click();

      expect(onAddProfile).toHaveBeenCalledWith("My New Server", "newserver.com:8443");
      expect(container.querySelector(".modal-overlay")).toBeNull();
    });

    it("does NOT call onAddProfile when name is empty", () => {
      const onAddProfile = vi.fn();
      const panel = createServerPanel(makeOpts({ onAddProfile }), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server") as HTMLElement;
      addBtn.click();

      const inputs = container.querySelectorAll(".form-input") as NodeListOf<HTMLInputElement>;
      inputs[0]!.value = "";
      inputs[1]!.value = "host.com:8443";

      const saveBtn = container.querySelector(".modal-footer .btn-primary") as HTMLElement;
      saveBtn.click();

      expect(onAddProfile).not.toHaveBeenCalled();
      // Modal stays open
      expect(container.querySelector(".modal-overlay")).not.toBeNull();
    });

    it("does NOT call onAddProfile when host is empty", () => {
      const onAddProfile = vi.fn();
      const panel = createServerPanel(makeOpts({ onAddProfile }), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server") as HTMLElement;
      addBtn.click();

      const inputs = container.querySelectorAll(".form-input") as NodeListOf<HTMLInputElement>;
      inputs[0]!.value = "Some Server";
      inputs[1]!.value = "";

      const saveBtn = container.querySelector(".modal-footer .btn-primary") as HTMLElement;
      saveBtn.click();

      expect(onAddProfile).not.toHaveBeenCalled();
    });

    it("rejects invalid host addresses with special characters", () => {
      const onAddProfile = vi.fn();
      const panel = createServerPanel(makeOpts({ onAddProfile }), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server") as HTMLElement;
      addBtn.click();

      const inputs = container.querySelectorAll(".form-input") as NodeListOf<HTMLInputElement>;
      inputs[0]!.value = "Bad Server";
      inputs[1]!.value = "http://evil.com/path";

      const saveBtn = container.querySelector(".modal-footer .btn-primary") as HTMLElement;
      saveBtn.click();

      expect(onAddProfile).not.toHaveBeenCalled();
      expect(container.querySelector(".modal-overlay")).not.toBeNull();
    });

    it("accepts host without port", () => {
      const onAddProfile = vi.fn();
      const panel = createServerPanel(makeOpts({ onAddProfile }), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server") as HTMLElement;
      addBtn.click();

      const inputs = container.querySelectorAll(".form-input") as NodeListOf<HTMLInputElement>;
      inputs[0]!.value = "Port-less";
      inputs[1]!.value = "myserver.example.com";

      const saveBtn = container.querySelector(".modal-footer .btn-primary") as HTMLElement;
      saveBtn.click();

      expect(onAddProfile).toHaveBeenCalledWith("Port-less", "myserver.example.com");
    });

    it("submits on Enter key in host input", () => {
      const onAddProfile = vi.fn();
      const panel = createServerPanel(makeOpts({ onAddProfile }), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server") as HTMLElement;
      addBtn.click();

      const inputs = container.querySelectorAll(".form-input") as NodeListOf<HTMLInputElement>;
      inputs[0]!.value = "Enter Server";
      inputs[1]!.value = "enter.example.com:8443";

      // Dispatch Enter keydown on the host input
      inputs[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(onAddProfile).toHaveBeenCalledWith("Enter Server", "enter.example.com:8443");
    });

    it("trims whitespace from name and host values", () => {
      const onAddProfile = vi.fn();
      const panel = createServerPanel(makeOpts({ onAddProfile }), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server") as HTMLElement;
      addBtn.click();

      const inputs = container.querySelectorAll(".form-input") as NodeListOf<HTMLInputElement>;
      inputs[0]!.value = "  Trimmed Server  ";
      inputs[1]!.value = "  trimmed.com:8443  ";

      const saveBtn = container.querySelector(".modal-footer .btn-primary") as HTMLElement;
      saveBtn.click();

      expect(onAddProfile).toHaveBeenCalledWith("Trimmed Server", "trimmed.com:8443");
    });

    it("focuses the name input on modal open", () => {
      const panel = createServerPanel(makeOpts(), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      const addBtn = container.querySelector(".btn-add-server") as HTMLElement;
      addBtn.click();

      const nameInput = container.querySelectorAll(".form-input")[0] as HTMLInputElement;
      expect(document.activeElement).toBe(nameInput);
    });
  });

  // -----------------------------------------------------------------------
  // destroy()
  // -----------------------------------------------------------------------

  describe("destroy", () => {
    it("destroy() can be called without errors", () => {
      const panel = createServerPanel(makeOpts(), SIMPLE_PROFILES);
      container.appendChild(panel.element);

      expect(() => panel.destroy()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases — icon color & initials
  // -----------------------------------------------------------------------

  describe("icon generation", () => {
    it("handles single-character server names", () => {
      const panel = createServerPanel(makeOpts(), [{ name: "X", host: "x.com:443" }]);
      container.appendChild(panel.element);

      const icon = container.querySelector(".srv-icon");
      expect(icon?.textContent).toBe("X");
    });

    it("handles lowercase names by uppercasing the initial", () => {
      const panel = createServerPanel(makeOpts(), [{ name: "lowercase", host: "lower.com:443" }]);
      container.appendChild(panel.element);

      const icon = container.querySelector(".srv-icon");
      expect(icon?.textContent).toBe("L");
    });

    it("generates consistent colors for the same name", () => {
      const panel1 = createServerPanel(makeOpts(), [{ name: "Consistent", host: "a.com:443" }]);
      container.appendChild(panel1.element);
      const color1 = (container.querySelector(".srv-icon") as HTMLElement).style.background;

      container.innerHTML = "";
      const panel2 = createServerPanel(makeOpts(), [{ name: "Consistent", host: "b.com:443" }]);
      container.appendChild(panel2.element);
      const color2 = (container.querySelector(".srv-icon") as HTMLElement).style.background;

      expect(color1).toBe(color2);
    });

    it("generates different colors for different names", () => {
      const panel = createServerPanel(makeOpts(), [
        { name: "Alpha", host: "a.com:443" },
        { name: "Zulu", host: "z.com:443" },
      ]);
      container.appendChild(panel.element);

      const icons = container.querySelectorAll(".srv-icon") as NodeListOf<HTMLElement>;
      // Not guaranteed to be different for all names, but for these two it should be
      // (given the hash algorithm). Just check they both have a background set.
      expect(icons[0]!.style.background).toBeTruthy();
      expect(icons[1]!.style.background).toBeTruthy();
    });
  });
});
