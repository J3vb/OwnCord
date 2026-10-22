// The desktop app is not bound to one server: the user adds as many as they
// like, so there is no fixed host.
import type { ServerScope } from "../contracts/serverScope";

export const serverScope: ServerScope = { fixedHost: null };
