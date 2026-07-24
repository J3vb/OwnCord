mod commands;
mod constants;
mod credentials;
mod http_proxy;
mod livekit_proxy;
mod ptt;
mod tofu;
mod tray;
mod update_commands;
mod ws_proxy;

// Only used by the desktop-only single-instance closure below.
#[cfg(desktop)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // The single-instance plugin MUST be registered first: a second launch is
    // forwarded to the running instance (which we focus) instead of opening a
    // duplicate window with a second WS connection / tray icon. With its
    // "deep-link" feature this also routes an owncord:// link to the running app.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // Desktop-only convenience plugins. window-state auto-saves/restores window
    // geometry (off-screen correction lives in the frontend); autostart backs
    // the "launch on login" toggle; deep-link registers the owncord:// scheme.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&'static str>>,
        ))
        .plugin(tauri_plugin_deep_link::init());

    match builder
        .manage(ws_proxy::WsState::new())
        .manage(livekit_proxy::LiveKitProxyState::new())
        .manage(http_proxy::HttpProxyState::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::store_cert_fingerprint,
            commands::get_cert_fingerprint,
            commands::store_identity_pin,
            commands::get_identity_pin,
            ws_proxy::ws_connect,
            ws_proxy::ws_send,
            ws_proxy::ws_disconnect,
            ws_proxy::accept_cert_fingerprint,
            credentials::save_credential,
            credentials::load_credential,
            credentials::delete_credential,
            credentials::save_identity_key,
            credentials::load_identity_key,
            credentials::delete_identity_key,
            update_commands::check_client_update,
            update_commands::download_and_install_update,
            ptt::ptt_start,
            ptt::ptt_stop,
            ptt::ptt_set_key,
            ptt::ptt_get_key,
            ptt::ptt_listen_for_key,
            livekit_proxy::start_livekit_proxy,
            livekit_proxy::stop_livekit_proxy,
            http_proxy::start_http_proxy,
            http_proxy::stop_http_proxy,
            #[cfg(feature = "devtools")]
            commands::open_devtools,
        ])
        .setup(|app| {
            // Initialize Rust logging (controlled by RUST_LOG env var, defaults to info).
            // try_init avoids panic if another logger (e.g. a Tauri plugin) registered first.
            let _ = env_logger::Builder::from_env(
                env_logger::Env::default().default_filter_or("info"),
            )
            .format_timestamp_millis()
            .try_init();

            tray::create_tray(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
    {
        Ok(app) => {
            app.run(|_app, event| {
                if let tauri::RunEvent::Exit = event {
                    // Stop the PTT polling thread before the process tears down.
                    // This ensures the AppHandle held inside the thread is released
                    // cleanly and the thread does not call app.emit on a dead runtime.
                    ptt::ptt_stop_internal();
                }
            });
        }
        Err(e) => {
            eprintln!("Fatal startup error: {e}");
            #[cfg(not(target_os = "linux"))]
            rfd::MessageDialog::new()
                .set_title("OwnCord failed to start")
                .set_description(format!(
                    "The application encountered a startup error and cannot continue.\n\n{e}"
                ))
                .set_level(rfd::MessageLevel::Error)
                .show();
            std::process::exit(1);
        }
    }
}
