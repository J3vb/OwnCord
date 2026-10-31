// The zoom the webview was last set to. The native drag position is in
// webview pixels, which the page's CSS pixels are scaled by.
let zoom = 1;

export function noteWebviewZoom(scale: number): void {
  if (Number.isFinite(scale) && scale > 0) zoom = scale;
}

export function webviewZoom(): number {
  return zoom;
}
