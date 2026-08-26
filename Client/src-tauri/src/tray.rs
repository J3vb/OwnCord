use tauri::{
    menu::{Menu, MenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, Runtime,
};

const SHOW_HIDE_ID: &str = "show_hide";
const STATUS_ONLINE_ID: &str = "status_online";
const STATUS_IDLE_ID: &str = "status_idle";
const STATUS_DND_ID: &str = "status_dnd";
const STATUS_OFFLINE_ID: &str = "status_offline";
const QUIT_ID: &str = "quit";

pub fn create_tray<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), tauri::Error> {
    let show_hide = MenuItem::with_id(app, SHOW_HIDE_ID, "Show/Hide", true, None::<&str>)?;

    let status_online =
        MenuItem::with_id(app, STATUS_ONLINE_ID, "Online", true, None::<&str>)?;
    let status_idle = MenuItem::with_id(app, STATUS_IDLE_ID, "Idle", true, None::<&str>)?;
    let status_dnd = MenuItem::with_id(app, STATUS_DND_ID, "Do Not Disturb", true, None::<&str>)?;
    let status_offline =
        MenuItem::with_id(app, STATUS_OFFLINE_ID, "Offline", true, None::<&str>)?;

    let status_submenu = Submenu::with_items(
        app,
        "Status",
        true,
        &[
            &status_online,
            &status_idle,
            &status_dnd,
            &status_offline,
        ],
    )?;

    let quit = MenuItem::with_id(app, QUIT_ID, "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_hide, &status_submenu, &quit])?;

    let app_handle = app.clone();
    let app_handle_menu = app.clone();

    TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| tauri::image::Image::new(&[], 1, 1)))
        .menu(&menu)
        .tooltip("OwnCord")
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
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
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
