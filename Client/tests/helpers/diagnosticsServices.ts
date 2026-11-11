import { vi } from "vitest";
import type { SessionScope } from "@lib/net/sessionScope";
import type { DiagnosticServices } from "@lib/net/connectionDiagnostics";

/** Healthy diagnostics services for one session; tests override what they
 *  exercise. `config` is read on every call, so a test may swap it. */
export function diagnosticServices(
  scope: SessionScope,
  stream: MediaStream,
  config: () => { host: string; token: string } = () => ({
    host: "server.test:8443",
    token: "[redacted]",
  }),
): DiagnosticServices {
  return {
    api: {
      getSession: () => scope,
      getConfig: config,
      getHealth: vi.fn().mockResolvedValue({}),
      getMe: vi.fn().mockResolvedValue({ id: 1 }),
    },
    ws: { ping: vi.fn().mockResolvedValue(undefined) },
    getRoom: vi.fn().mockReturnValue(null),
    getUserMedia: vi.fn().mockResolvedValue(stream),
    listNativeInputs: vi.fn().mockResolvedValue(null),
    probeNativeInput: vi.fn().mockResolvedValue("levels"),
  };
}

/** The native platform module with `isLinuxDesktop` made a mock that says no. */
export function platformModuleMock<T extends object>(original: T): T {
  return { ...original, isLinuxDesktop: vi.fn(() => false) };
}
