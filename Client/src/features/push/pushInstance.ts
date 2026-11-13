/** Which push registration belongs to which account, and this device's label. */

/** One registration per account on a server: two accounts on one server never
 *  share an endpoint, so one never sees the other's pushes. */
export function pushInstance(host: string, userId: number): string {
  return `${host}#${userId}`;
}

/** The label the server keeps for this device: `android:` and the phone's
 *  model when the WebView still reports it (a reduced user agent says "K"). */
export function deviceLabel(userAgent: string): string {
  const model = /Android [^;)]*; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(userAgent)?.[1]?.trim();
  const name = model === undefined || model === "K" || model === "" ? "phone" : model;
  // The server refuses control characters and anything over 64 characters.
  return `android:${name}`.replace(/\p{Cc}/gu, "").slice(0, 64);
}
