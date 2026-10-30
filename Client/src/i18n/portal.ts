import { defineCatalog } from "./format";

/**
 * The single-server web portal's copy. Only branches written behind
 * `__OWNCORD_WEB__` read it, so the desktop build drops them, and this module
 * with them: that is why it is not part of connect.ts, whose data sits in the
 * startup chunk and cannot be tree-shaken. The call is marked pure so the
 * bundler may drop an unread catalog.
 */
export const portalText = /* @__PURE__ */ defineCatalog("portal", {
  "login.stayLoggedIn": "Stay signed in",
  "login.subtitle": "Sign in to {server}",

  "userBar.signOut": "Sign out",

  "incompatible.reload": "Reload page",

  "insecure.title": "A secure connection is required",
  "insecure.body":
    "OwnCord can only sign you in over a secure connection (https). Open this server at its https address, or ask its administrator to turn on https.",
});
