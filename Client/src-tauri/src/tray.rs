use tauri::{
    menu::{Menu, MenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, Runtime,
};

use crate::text;

/// The tray icon's id, so `unread_badge` can reach it to set the tooltip.
pub const TRAY_ID: &str = "main";

const SHOW_HIDE_ID: &str = "show_hide";
const STATUS_ONLINE_ID: &str = "status_online";
const STATUS_IDLE_ID: &str = "status_idle";
const STATUS_DND_ID: &str = "status_dnd";
const STATUS_OFFLINE_ID: &str = "status_offline";
const OPEN_LOGS_ID: &str = "open_logs";
const MUTE_ID: &str = "voice_mute";
const DEAFEN_ID: &str = "voice_deafen";
const QUIT_ID: &str = "quit";

/// One menu item: its event id and its label from the text table.
type Item = (&'static str, &'static str);

/// The tray's menu, top to bottom, and its tooltip. `create_tray` builds
/// exactly this, so every label it shows comes from `text.rs`.
struct TrayMenu {
    show_hide: Item,
    status: &'static str,
    statuses: [Item; 4],
    /// U6: toggle the microphone and the call audio without focusing the app.
    /// Every platform gets these; the global Ctrl+Shift+M/Ctrl+Shift+D path is a separate,
    /// display-server-dependent extra.
    voice: [Item; 2],
    open_logs: Item,
    quit: Item,
    tooltip: &'static str,
}

fn tray_menu() -> TrayMenu {
    TrayMenu {
        show_hide: (SHOW_HIDE_ID, text::TRAY_SHOW_HIDE),
        status: text::TRAY_STATUS,
        statuses: [
            (STATUS_ONLINE_ID, text::TRAY_STATUS_ONLINE),
            (STATUS_IDLE_ID, text::TRAY_STATUS_IDLE),
            (STATUS_DND_ID, text::TRAY_STATUS_DND),
            (STATUS_OFFLINE_ID, text::TRAY_STATUS_OFFLINE),
        ],
        voice: [(MUTE_ID, text::TRAY_MUTE), (DEAFEN_ID, text::TRAY_DEAFEN)],
        open_logs: (OPEN_LOGS_ID, text::TRAY_OPEN_LOGS),
        quit: (QUIT_ID, text::TRAY_QUIT),
        tooltip: text::TRAY_TOOLTIP,
    }
}

pub fn create_tray<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), tauri::Error> {
    let spec = tray_menu();
    let item = |(id, label): Item| MenuItem::with_id(app, id, label, true, None::<&str>);

    let show_hide = item(spec.show_hide)?;
    let [online, idle, dnd, offline] = spec.statuses.map(item);
    let status_submenu = Submenu::with_items(
        app,
        spec.status,
        true,
        &[&online?, &idle?, &dnd?, &offline?],
    )?;
    let open_logs = item(spec.open_logs)?;
    let [mute, deafen] = spec.voice.map(item);
    let quit = item(spec.quit)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_hide,
            &status_submenu,
            &mute?,
            &deafen?,
            &open_logs,
            &quit,
        ],
    )?;

    let app_handle = app.clone();
    let app_handle_menu = app.clone();

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(
            app.default_window_icon()
                .cloned()
                .unwrap_or_else(|| tauri::image::Image::new(&[], 1, 1)),
        )
        .menu(&menu)
        .tooltip(spec.tooltip)
        .on_tray_icon_event(move |_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window_visibility(&app_handle);
            }
        })
        .on_menu_event(move |_tray, event| {
            handle_menu_event(&app_handle_menu, event.id().as_ref());
        })
        .build(app)?;

    Ok(())
}

fn toggle_window_visibility<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let minimized = window.is_minimized().unwrap_or(false);
        if window.is_visible().unwrap_or(false) && !minimized {
            let _ = window.hide();
        } else {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn handle_menu_event<R: Runtime>(app_handle: &tauri::AppHandle<R>, id: &str) {
    match id {
        SHOW_HIDE_ID => toggle_window_visibility(app_handle),
        STATUS_ONLINE_ID => emit_status_change(app_handle, "online"),
        STATUS_IDLE_ID => emit_status_change(app_handle, "idle"),
        STATUS_DND_ID => emit_status_change(app_handle, "dnd"),
        STATUS_OFFLINE_ID => emit_status_change(app_handle, "offline"),
        OPEN_LOGS_ID => open_log_folder(app_handle),
        MUTE_ID => emit_voice_shortcut(app_handle, "mute"),
        DEAFEN_ID => emit_voice_shortcut(app_handle, "deafen"),
        QUIT_ID => {
            app_handle.exit(0);
        }
        _ => {}
    }
}

/// Open the directory the Rust log is written to, so a user whose window never
/// came up still has a route to the file that explains why.
fn open_log_folder<R: Runtime>(app: &tauri::AppHandle<R>) {
    use tauri_plugin_opener::OpenerExt;
    let opened = app
        .path()
        .app_log_dir()
        .map_err(|e| e.to_string())
        .and_then(|dir| {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            app.opener()
                .open_path(dir.to_string_lossy(), None::<&str>)
                .map_err(|e| e.to_string())
        });
    if let Err(e) = opened {
        log::warn!("[tray] cannot open the log folder: {e}");
    }
}

fn emit_status_change<R: Runtime>(app: &tauri::AppHandle<R>, status: &str) {
    let _ = app.emit("status-change", status);
}

/// U6: a tray Mute/Deafen pick. The renderer toggles the matching control; it
/// is the same event the global voice-shortcut poller emits, so both paths run
/// one handler.
fn emit_voice_shortcut<R: Runtime>(app: &tauri::AppHandle<R>, action: &str) {
    let _ = app.emit("voice-shortcut", action);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_and_tooltip_come_from_the_text_table() {
        let menu = tray_menu();
        assert_eq!(menu.show_hide, (SHOW_HIDE_ID, text::TRAY_SHOW_HIDE));
        assert_eq!(menu.status, text::TRAY_STATUS);
        assert_eq!(
            menu.statuses,
            [
                (STATUS_ONLINE_ID, text::TRAY_STATUS_ONLINE),
                (STATUS_IDLE_ID, text::TRAY_STATUS_IDLE),
                (STATUS_DND_ID, text::TRAY_STATUS_DND),
                (STATUS_OFFLINE_ID, text::TRAY_STATUS_OFFLINE),
            ]
        );
        assert_eq!(menu.open_logs, (OPEN_LOGS_ID, text::TRAY_OPEN_LOGS));
        assert_eq!(
            menu.voice,
            [(MUTE_ID, text::TRAY_MUTE), (DEAFEN_ID, text::TRAY_DEAFEN)]
        );
        assert_eq!(menu.quit, (QUIT_ID, text::TRAY_QUIT));
        assert_eq!(menu.tooltip, text::TRAY_TOOLTIP);
    }
}
