// Desktop binding for the ExternalContentBroker suite: `platform/desktop`'s
// broker. The binding reads `invoke` per call through its own dynamic import,
// so toggling the live value below moves it between "answers" / "refuses" /
// "unavailable" with no module reset — the same getter trick the settings
// binding uses.
import { vi } from "vitest";
import type { ExternalContentBroker } from "../../../src/platform/contracts/externalContent";
import { describeExternalContentSuite } from "./externalContent.suite";

const core: {
  invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined;
} = { invoke: undefined };

vi.mock("@tauri-apps/api/core", () => ({
  get invoke() {
    return core.invoke;
  },
}));

const mod = await import("../../../src/platform/desktop/externalContent");
const desktopBinding: ExternalContentBroker = mod.externalContent;

const asked: { partition: string; target: string }[] = [];

function recording(answer: () => Promise<unknown>) {
  return (_cmd: string, args?: Record<string, unknown>) => {
    asked.push({
      partition: String(args?.partition),
      target: String(args?.url ?? args?.handle),
    });
    return answer();
  };
}

describeExternalContentSuite(async () => {
  core.invoke = undefined;
  asked.length = 0;
  return {
    subject: desktopBinding,
    native: {
      answers(value: unknown) {
        core.invoke = recording(() => Promise.resolve(value));
      },
      refuses(error: unknown) {
        core.invoke = recording(() => Promise.reject(error));
      },
      unavailable() {
        core.invoke = undefined;
      },
      asked: () => [...asked],
    },
  };
});
