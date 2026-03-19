mod commands;
mod credentials;
mod hotkeys;
mod ptt;
mod tray;
mod update_commands;
mod ws_proxy;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(ws_proxy::WsState::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::store_cert_fingerprint,
            commands::get_cert_fingerprint,
            ws_proxy::ws_connect,
            ws_proxy::ws_send,
            ws_proxy::ws_disconnect,
            ws_proxy::accept_cert_fingerprint,
            credentials::save_credential,
            credentials::load_credential,
            credentials::delete_credential,
            update_commands::check_client_update,
            update_commands::download_and_install_update,
            ptt::ptt_start,
            ptt::ptt_stop,
            ptt::ptt_set_key,
            ptt::ptt_get_key,
            ptt::ptt_listen_for_key,
        ])
        .setup(|app| {
            tray::create_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
