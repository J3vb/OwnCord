// Silent loggers, as sidebarAreaMocks.ts's, except that the "deck" logger's
// methods are shared spies a suite can assert on. Import it after
// sidebarAreaMockSetup and before anything that creates the "deck" logger:
// the mock is registered when this module runs, and replaces that setup's.
import { vi } from "vitest";
import { loggerMock } from "./loggerMock";

const silent = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** The methods of every logger created for the "deck" component. */
export const deckLog = silent();

vi.doMock("@lib/logger", () =>
  loggerMock({ buffer: true, createLogger: (tag) => (tag === "deck" ? deckLog : silent()) }),
);
