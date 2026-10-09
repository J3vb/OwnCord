function guard(e: Event): void {
  if ((e as DragEvent).dataTransfer?.types.includes("Files") === true) e.preventDefault();
}

/**
 * Cancel the default of a file dragged in from the OS. The main window runs
 * with the native drag-drop handler off (tauri.conf.json) so the composer sees
 * HTML5 drops; the webview's own default would then navigate to the file when
 * it lands where nothing listens (the connect page, a modal).
 */
export function installFileDropGuard(signal: AbortSignal): void {
  document.addEventListener("dragover", guard, { signal });
  document.addEventListener("drop", guard, { signal });
}
