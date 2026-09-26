use tauri::{
    menu::{Menu, MenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, Runtime,
};

use crate::text;

const SHOW_HIDE_ID: &str = "show_hide";
const STATUS_ONLINE_ID: &str = "status_online";
const STATUS_IDLE_ID: &str = "status_idle";
const STATUS_DND_ID: &str = "status_dnd";
const STATUS_OFFLINE_ID: &str = "status_offline";
const QUIT_ID: &str = "quit";

/// One menu item: its event id and its label from the text table.
type Item = (&'static str, &'static str);

/// The tray's menu, top to bottom, and its tooltip. `create_tray` builds
/// exactly this, so every label it shows comes from `text.rs`.
struct TrayMenu {
    show_hide: Item,
    status: &'static str,
    statuses: [Item; 4],
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
    let quit = item(spec.quit)?;

    let menu = Menu::with_items(app, &[&show_hide, &status_submenu, &quit])?;

    let app_handle = app.clone();
    let app_handle_menu = app.clone();

    TrayIconBuilder::new()
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
        QUIT_ID => {
            app_handle.exit(0);
        }
        _ => {}
    }
}

fn emit_status_change<R: Runtime>(app: &tauri::AppHandle<R>, status: &str) {
    let _ = app.emit("status-change", status);
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
        assert_eq!(menu.quit, (QUIT_ID, text::TRAY_QUIT));
        assert_eq!(menu.tooltip, text::TRAY_TOOLTIP);
    }
}
