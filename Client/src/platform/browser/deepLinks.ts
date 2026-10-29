// Browser deep links: the one link a page receives is `?invite=<code>`
// on its own URL (the web form of an invite link). It is read once at `init`,
// handed to `onInvite`, and removed from the address bar so a reload or a
// copied URL does not replay it. Other parameters and the hash stay. The web
// build has no owncord:// handler and no message permalinks, so `onMessage`
// is never called.
import type { DeepLinks } from "../contracts/deepLinks";

const INVITE_PARAM = "invite";

export const deepLinks: DeepLinks = {
  async init(onInvite: (code: string, host?: string) => void): Promise<void> {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get(INVITE_PARAM);
    if (raw === null) return;
    url.searchParams.delete(INVITE_PARAM);
    try {
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // The address bar cannot be rewritten (sandboxed frame): the code is
      // still delivered, it only stays in the URL.
    }
    const code = raw.trim();
    if (code !== "") onInvite(code, undefined);
  },
};
