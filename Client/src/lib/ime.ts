/** True while an input method (Chinese, Japanese, Korean) owns the key: Enter
 *  commits its candidate, arrows pick one, Escape cancels. A text field that
 *  submits on Enter must ignore the key then, or it sends a half-typed value.
 *  `keyCode` 229 is the legacy signal some WebView builds send instead of
 *  `isComposing` on the commit key. */
export function isImeCommit(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}
