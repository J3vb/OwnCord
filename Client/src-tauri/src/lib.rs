mod active_session;
mod commands;
// Test-only: gates over tauri.conf.json and the source text itself.
#[cfg(test)]
mod config_gates;
mod constants;
#[cfg(target_os = "linux")]
mod crash_log;
mod credentials;
#[cfg(target_os = "linux")]
mod deb_install;
mod diagnostics;
#[cfg(windows)]
mod dpapi;
#[cfg(target_os = "linux")]
mod exit_watch;
mod external_content;
mod external_open;
#[cfg(not(windows))]
mod fallback_crypto;
mod game_activity;
mod http_pool;
mod http_proxy;
mod idle;
#[cfg(target_os = "linux")]
mod idle_wayland;
mod json_store;
#[cfg(target_os = "linux")]
mod linux_media;
#[cfg(target_os = "linux")]
mod linux_spellcheck;
mod livekit_proxy;
mod media_activity;
// Message notifications that open their message on click (the plugin's desktop
// backend drops clicks). Desktop-only: the plugin's mobile backend has its own
// action callback.
#[cfg(desktop)]
mod message_notification;
#[cfg(target_os = "linux")]
mod mouse_buttons;
#[cfg(target_os = "linux")]
mod notification_bus;
#[cfg(desktop)]
mod popout;
#[cfg(target_os = "linux")]
mod portal_app_id;
#[cfg(target_os = "linux")]
mod portal_shortcuts;
// Public: `examples/native_voice_interop.rs` drives the same session code.
#[cfg(target_os = "linux")]
pub mod native_voice;
mod proxy_common;
mod ptt;
mod secret_store;
mod shortcuts;
mod sync;
mod text;
mod tofu;
#[cfg(desktop)]
mod tray;
#[cfg(desktop)]
mod unread_badge;
mod update_commands;
#[cfg(target_os = "linux")]
mod window_activation;
#[cfg(desktop)]
mod window_prefs;
// Command set exists on every target (unavailable off Windows); only the
// Win32 capture inside is `cfg(windows)`.
mod windows_app_audio;
#[cfg(windows)]
mod windows_media;
#[cfg(windows)]
mod windows_share_bar;
mod ws_proxy;

/// Map the RUST_LOG env var to a global level filter for the log plugin.
/// ponytail: only the simple global form is honoured ("debug", "info", …);
/// per-module directives like "ws_proxy=debug" fall back to Info. Add a real
/// parser only if per-module control is actually needed.
fn log_level_from_env() -> log::LevelFilter {
    match std::env::var("RUST_LOG")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "trace" => log::LevelFilter::Trace,
        "debug" => log::LevelFilter::Debug,
        "warn" => log::LevelFilter::Warn,
        "error" => log::LevelFilter::Error,
        "off" => log::LevelFilter::Off,
        _ => log::LevelFilter::Info,
    }
}

/// Stdout log target that drops a line it cannot write. The plugin's own
/// Stdout target falls back to stderr and panics when that fails too, so a
/// closed terminal or pipe aborted the app (the panic hook logs through the
/// same target).
fn stdout_log_dispatch() -> tauri_plugin_log::fern::Dispatch {
    tauri_plugin_log::fern::Dispatch::new().chain(tauri_plugin_log::fern::Output::call(|record| {
        write_log_line(&mut std::io::stdout().lock(), record.args())
    }))
}

fn write_log_line(out: &mut impl std::io::Write, line: &std::fmt::Arguments) {
    let _ = writeln!(out, "{line}").and_then(|()| out.flush());
}

#[cfg(target_os = "linux")]
fn native_voice_state() -> native_voice::NativeVoiceState {
    native_voice::NativeVoiceState::new()
}
/// Off Linux the webview's own WebRTC handles voice; an empty placeholder keeps
/// the builder chain identical on every platform. A unit struct, not `()`:
/// clippy rejects both `-> ()` and passing a unit value to `.manage`.
#[cfg(not(target_os = "linux"))]
struct NoNativeVoice;
#[cfg(not(target_os = "linux"))]
fn native_voice_state() -> NoNativeVoice {
    NoNativeVoice
}

/// The app-sound registry; off Linux the sounds stay in the webview.
#[cfg(target_os = "linux")]
fn app_sounds_state() -> native_voice::app_sound::AppSounds {
    native_voice::app_sound::AppSounds::default()
}
#[cfg(not(target_os = "linux"))]
struct NoAppSounds;
#[cfg(not(target_os = "linux"))]
fn app_sounds_state() -> NoAppSounds {
    NoAppSounds
}

/// Whether a forwarded single-instance launch should restore the main window.
///
/// Once an installer is launching the old process must not take handoffs: the
/// plugin has already hidden the window and is blocked in `ShellExecuteW`, so
/// re-showing it puts the old version on screen for the whole install gap
/// (the reported "old version stays up for ~90 s" symptom).
#[cfg(desktop)]
fn should_restore_on_second_launch(installer_launching: bool) -> bool {
    !installer_launching
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First, so a panic anywhere after the log plugin starts reaches the log.
    diagnostics::install_panic_hook();
    #[cfg(target_os = "linux")]
    window_activation::stash_launch_token();
    let builder = tauri::Builder::default();

    // The single-instance plugin MUST be registered first: a second launch is
    // forwarded to the running instance (which we focus) instead of opening a
    // duplicate window with a second WS connection / tray icon. With its
    // "deep-link" feature this also routes an owncord:// link to the running app.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        let launching = update_commands::installer_launching();
        log::info!(
            "[update] second-instance launch forwarded (update in progress: {}, installer launching: {launching})",
            update_commands::update_in_progress()
        );
        if should_restore_on_second_launch(launching) {
            #[cfg(target_os = "linux")]
            let token = window_activation::take_forwarded_token();
            #[cfg(not(target_os = "linux"))]
            let token = None;
            message_notification::focus_main_window_with(app, token);
        }
    }));

    let builder = builder
        // Log plugin registered early so logging is available to everything
        // after it. Writes to stdout (dev) and a rotating file in the OS
        // app-log dir so a shipped user — whose release build has no console —
        // can retrieve logs. `clear_targets` drops the builder's defaults (a
        // second stdout and an `OwnCord.log` copy of the file).
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Dispatch(stdout_log_dispatch()),
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("owncord-client".into()),
                    },
                ))
                .level(log_level_from_env())
                .max_file_size(10_000_000) // 10 MB rolling file (default 40 KB is too small)
                // Keep the two previous files (owncord-client_<date>.log): the
                // default KeepOne deletes the whole log at each rollover.
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(2))
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    #[cfg(target_os = "android")]
    let builder = builder.plugin(update_commands::android::init());

    // Desktop-only convenience plugins. window-state auto-saves/restores window
    // geometry (off-screen correction lives in the frontend); autostart backs
    // the "launch on login" toggle; deep-link registers the owncord:// scheme.
    #[cfg(desktop)]
    let builder = builder
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // A pop-out opens where window.open places it, never restored
                // full screen.
                .with_filter(|label| label == "main")
                // Not the visible flag: the app can quit while the window is
                // hidden in the tray, and restoring "hidden" at the next launch
                // would start it with no window.
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            // A login launch carries the flag; `startMinimized` decides what it
            // does (window_prefs.rs).
            Some(vec![window_prefs::MINIMIZED_ARG]),
        ))
        .plugin(tauri_plugin_deep_link::init());

    match builder
        .manage(json_store::JsonStores::default())
        .manage(diagnostics::FrontendReady::new())
        .manage(active_session::ActiveSession::new())
        .manage(ws_proxy::WsState::new())
        .manage(livekit_proxy::LiveKitProxyState::new())
        .manage(http_proxy::HttpProxyState::new())
        .manage(external_content::ExternalContentState::new())
        .manage(native_voice_state())
        .manage(app_sounds_state())
        .manage(windows_app_audio::AppAudioState::new())
        .invoke_handler(tauri::generate_handler![
            diagnostics::frontend_ready,
            #[cfg(desktop)]
            window_prefs::get_window_prefs,
            #[cfg(desktop)]
            window_prefs::set_window_pref,
            #[cfg(desktop)]
            window_prefs::show_next_launch,
            commands::get_settings,
            commands::save_settings,
            commands::get_cert_fingerprint,
            #[cfg(desktop)]
            message_notification::notify_message,
            #[cfg(desktop)]
            message_notification::clear_call_notification,
            #[cfg(desktop)]
            unread_badge::set_unread_badge,
            commands::store_identity_pin,
            commands::get_identity_pin,
            ws_proxy::ws_connect,
            ws_proxy::ws_send,
            ws_proxy::ws_disconnect,
            ws_proxy::accept_cert_fingerprint,
            credentials::save_credential,
            credentials::load_credential,
            credentials::login_with_saved_password,
            credentials::delete_credential,
            credentials::save_identity_key,
            credentials::load_identity_key,
            credentials::delete_identity_key,
            credentials::save_pending_messages,
            credentials::load_pending_messages,
            credentials::delete_pending_messages,
            update_commands::check_client_update,
            #[cfg(desktop)]
            update_commands::download_and_install_update,
            #[cfg(target_os = "android")]
            update_commands::android::download_and_install_update,
            ptt::ptt_start,
            ptt::ptt_stop,
            ptt::ptt_set_key,
            ptt::ptt_polling_supported,
            ptt::ptt_listen_for_key,
            shortcuts::voice_shortcuts_start,
            shortcuts::voice_shortcuts_supported,
            shortcuts::voice_shortcuts_set_keys,
            shortcuts::global_keys_status,
            shortcuts::global_keys_portal_bind,
            shortcuts::global_keys_portal_configure,
            livekit_proxy::start_livekit_proxy,
            livekit_proxy::stop_livekit_proxy,
            http_proxy::start_http_proxy,
            http_proxy::stop_http_proxy,
            external_content::external_preview,
            external_content::external_image,
            idle::system_idle_ms,
            game_activity::detect_game,
            game_activity::list_running_programs,
            media_activity::detect_media,
            windows_app_audio::app_audio_available,
            windows_app_audio::start_app_audio,
            windows_app_audio::stop_app_audio,
            #[cfg(desktop)]
            tray::open_log_folder,
            external_open::open_external_url,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_build_info,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_key,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_clear_key,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_connect,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_disconnect,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_microphone,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_ptt_gated,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_voice_gate,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_input_gain,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_audio_processing,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_subscribed,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_video_view,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_volume,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_screenshare_volume,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_debug_info,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_get_stats,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_list_devices,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_device,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_watch_devices,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_play_sound,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_stop_sound,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_list_cameras,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_camera_support,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_video_codecs,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_start_camera,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_publish_camera,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_unpublish_camera,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_stop_camera,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_start_camera_preview,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_stop_camera_preview,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_start_mic_test,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_update_mic_test,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_stop_mic_test,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_screen_sources,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_start_screen,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_publish_screen,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_unpublish_screen,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_publish_screen_audio,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_unpublish_screen_audio,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_stop_screen,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_change_camera,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_change_screen,
            #[cfg(target_os = "linux")]
            native_voice::native_voice_set_screen_quality,
            #[cfg(feature = "devtools")]
            commands::open_devtools,
        ])
        .setup(|app| {
            // A setup error makes Tauri panic inside run(), past the Err arm
            // below, so it gets the same dialog here first.
            setup_app(app).inspect_err(|e| show_startup_failure(&e.to_string()))
        })
        .build(tauri::generate_context!())
    {
        Ok(app) => {
            app.run(|_app, event| {
                if let tauri::RunEvent::ExitRequested { code, .. } = &event {
                    match *code {
                        Some(tauri::RESTART_EXIT_CODE) => {
                            log::info!("[exit] restart requested by the app")
                        }
                        Some(code) => log::info!("[exit] exit requested by the app (code {code})"),
                        None => log::info!("[exit] exit requested: the last window closed"),
                    }
                }
                if let tauri::RunEvent::Exit = event {
                    #[cfg(target_os = "linux")]
                    exit_watch::note_exit("event loop finished");
                    #[cfg(not(target_os = "linux"))]
                    log::info!("[exit] event loop finished; normal exit");
                    // Stop the PTT polling thread before the process tears down.
                    // This ensures the AppHandle held inside the thread is released
                    // cleanly and the thread does not call app.emit on a dead runtime.
                    ptt::ptt_stop_internal();
                    // Same for the global voice-shortcut poller.
                    shortcuts::voice_shortcuts_stop_internal();
                    // And the Wayland portal thread: closes its session and
                    // joins.
                    #[cfg(target_os = "linux")]
                    portal_shortcuts::stop_internal();
                }
            });
        }
        Err(e) => {
            show_startup_failure(&e.to_string());
            std::process::exit(1);
        }
    }
}

/// Builds the main window, tray and native hooks once the app exists.
fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(desktop)]
    use tauri::Manager as _;
    // Rust logging is initialized by tauri_plugin_log (registered above).
    // Record the version and PID first: paired with the "[update]
    // installer launching" line, they bound the install gap a report
    // describes (time from that line to this startup line).
    log::info!(
        "[startup] OwnCord {} starting (pid {})",
        app.package_info().version,
        std::process::id()
    );
    // A native crash (signal, or GDK's exit on an X error) leaves no
    // panic: give it a last log line. After GTK init, so GDK's X
    // handlers are the ones it chains to.
    #[cfg(target_os = "linux")]
    if let Ok(dir) = tauri::Manager::path(app).app_log_dir() {
        crash_log::install(&dir.join("owncord-client.log"));
        // A run that ends without a trace (SIGKILL) is reported by
        // the next start; freezes and memory are logged as they happen.
        exit_watch::start(app.handle(), &dir, &app.package_info().version.to_string());
    }
    // Record the credential backend first: if this build has no
    // persistent store, every later credential symptom follows from it.
    secret_store::log_compiled_backend();
    // The main window is built here, not from tauri.conf.json alone
    // ("create": false): only a code-built webview takes a new-window
    // handler, which stream pop-outs need (popout.rs).
    // Close to tray and Start minimised (window_prefs.rs): read before
    // the window exists, so a minimised login launch never flashes it.
    #[cfg(desktop)]
    let start_hidden = {
        app.manage(window_prefs::WindowPrefs::load(app.handle()));
        let prefs = app.state::<window_prefs::WindowPrefs>();
        // Always consumed, so the marker never outlives one launch.
        let show_next = window_prefs::take_show_next_launch(app.handle());
        window_prefs::should_start_hidden(
            show_next,
            window_prefs::launched_minimized(),
            prefs.start_minimized(),
            window_prefs::tray_available,
        )
    };
    if let Some(config) = app.config().app.windows.first().cloned() {
        let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
        #[cfg(desktop)]
        let builder = {
            let handle = app.handle().clone();
            builder
                .visible(!start_hidden)
                .on_new_window(move |url, features| popout::on_new_window(&handle, url, features))
        };
        let window = builder.build()?;
        // WebView2 hides device names until mic/camera are allowed.
        #[cfg(windows)]
        windows_media::allow_media_capture(&window, app.config(), config.use_https_scheme);
        // WebView2's own "is sharing your screen" bar; the stream card has Stop.
        #[cfg(windows)]
        windows_share_bar::hide_on_capture(
            &window,
            windows_media::app_origin(app.config(), config.use_https_scheme),
        );
        #[cfg(target_os = "linux")]
        exit_watch::watch_webview(&window);
        #[cfg(desktop)]
        let handle = app.handle().clone();
        #[cfg(desktop)]
        let main = window.clone();
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::Destroyed => {
                log::info!("[exit] main window destroyed");
                #[cfg(desktop)]
                popout::close_all(&handle);
            }
            // The window's close button, Alt+F4, or the desktop
            // closing it: a quit, unless close to tray hides it.
            #[cfg(desktop)]
            // Registered after the window-state plugin's own listener,
            // so the geometry it saves is the visible one.
            tauri::WindowEvent::CloseRequested { api, .. } => {
                log::info!(
                    "[exit] main window close requested (close button, keyboard or desktop)"
                );
                window_prefs::on_close_requested(&handle, &main, api);
            }
            _ => {}
        });
    }
    diagnostics::spawn_frontend_watchdog(app.handle());
    #[cfg(desktop)]
    tray::create_tray(app.handle())?;
    // WebKitGTK denies mic/camera access by default — grant it so
    // voice/video works on Linux (no-op elsewhere; see linux_media).
    #[cfg(target_os = "linux")]
    linux_media::enable_media_capture(app.handle());
    // WebKitGTK ships spell checking off — enable it in the system language.
    #[cfg(target_os = "linux")]
    linux_spellcheck::enable_spell_checking(app.handle());
    Ok(())
}

/// Logs a fatal startup error and shows it in a dialog.
fn show_startup_failure(error: &str) {
    eprintln!("Fatal startup error: {error}");
    log::error!("[exit] fatal startup error: {error}");
    #[cfg(target_os = "linux")]
    {
        exit_watch::note_exit("startup failed");
        show_linux_startup_dialog(error);
    }
    #[cfg(all(desktop, not(target_os = "linux")))]
    rfd::MessageDialog::new()
        .set_title(text::STARTUP_DIALOG_TITLE)
        .set_description(text::startup_dialog_body(error))
        .set_level(rfd::MessageLevel::Error)
        .show();
}

/// The startup error dialog on Linux, run on this (the GTK main) thread.
/// rfd's GTK dialog runs on a thread of its own and never appears once tao
/// has started GTK here, which it does before anything can fail, so the
/// process would wait on it forever. GTK is started here only if it is not
/// running yet; with no display that fails at once and stderr stands alone.
#[cfg(target_os = "linux")]
fn show_linux_startup_dialog(error: &str) {
    use gtk::prelude::*;
    if !gtk::is_initialized_main_thread() && gtk::init().is_err() {
        return;
    }
    let dialog = gtk::MessageDialog::new(
        None::<&gtk::Window>,
        gtk::DialogFlags::MODAL,
        gtk::MessageType::Error,
        gtk::ButtonsType::Ok,
        &text::startup_dialog_body(error),
    );
    dialog.set_title(text::STARTUP_DIALOG_TITLE);
    dialog.run();
    // SAFETY: the dialog is ours alone and not used after this.
    unsafe { dialog.destroy() };
}

#[cfg(all(test, target_os = "linux"))]
mod startup_dialog_tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    /// Needs a display of its own, `xvfb-run cargo test -- --ignored
    /// gtk_startup`: its dialog is a real window, which
    /// `x11_lists_sources_with_thumbnails_and_captures_one` would count. GTK is
    /// started first, as tao does before anything can fail, and the dialog
    /// must still appear; a check on GTK's own loop answers it once mapped.
    #[test]
    #[ignore = "needs an X display (xvfb-run)"]
    fn gtk_startup_dialog_appears_after_gtk_started() {
        use gtk::prelude::*;
        gtk::init().expect("xvfb-run provides a display");
        let seen = Arc::new(AtomicBool::new(false));
        let seen_by_watchdog = Arc::clone(&seen);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(10));
            if !seen_by_watchdog.load(Ordering::SeqCst) {
                eprintln!("the startup dialog never appeared");
                std::process::exit(1);
            }
        });
        let seen_by_check = Arc::clone(&seen);
        gtk::glib::timeout_add(Duration::from_millis(100), move || {
            let dialog = gtk::Window::list_toplevels()
                .into_iter()
                .filter_map(|w| w.downcast::<gtk::MessageDialog>().ok())
                .find(|d| {
                    d.is_mapped() && d.title().as_deref() == Some(super::text::STARTUP_DIALOG_TITLE)
                });
            match dialog {
                Some(dialog) => {
                    seen_by_check.store(true, Ordering::SeqCst);
                    dialog.response(gtk::ResponseType::Ok);
                    gtk::glib::ControlFlow::Break
                }
                None => gtk::glib::ControlFlow::Continue,
            }
        });
        super::show_linux_startup_dialog("test failure");
        assert!(seen.load(Ordering::SeqCst));
    }
}

#[cfg(all(test, desktop))]
mod tests {
    use super::{should_restore_on_second_launch, write_log_line};

    struct ClosedPipe;
    impl std::io::Write for ClosedPipe {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
    }

    #[test]
    fn a_log_line_to_a_closed_stdout_is_dropped_not_a_panic() {
        write_log_line(&mut ClosedPipe, &format_args!("lost"));
        let mut open = Vec::new();
        write_log_line(&mut open, &format_args!("kept {}", 1));
        assert_eq!(open, b"kept 1\n");
    }

    #[test]
    fn forwarded_launch_restores_window_unless_installer_is_launching() {
        // Normal forwarded launch: the running instance should come forward.
        assert!(should_restore_on_second_launch(false));
        // Installer launching: the window is hidden and the old version must
        // not come back for the launch to hand off to it.
        assert!(!should_restore_on_second_launch(true));
    }
}
