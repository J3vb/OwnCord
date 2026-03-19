use tauri::{Emitter, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Registers a global push-to-talk shortcut that emits `ptt-press` and
/// `ptt-release` events to the frontend webview.
pub fn register_push_to_talk<R: Runtime>(
    app: &tauri::AppHandle<R>,
    shortcut_str: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let shortcut: tauri_plugin_global_shortcut::Shortcut = shortcut_str.parse()?;

    // Remove any previous binding for this shortcut before registering.
    if app.global_shortcut().is_registered(shortcut) {
        app.global_shortcut().unregister(shortcut)?;
    }

    let handle = app.clone();
    app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
        let event_name = match event.state {
            ShortcutState::Pressed => "ptt-press",
            ShortcutState::Released => "ptt-release",
        };
        let _ = handle.emit(event_name, ());
    })?;

    Ok(())
}

/// Removes all registered global shortcuts.
pub fn unregister_all<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    app.global_shortcut().unregister_all()?;
    Ok(())
}
