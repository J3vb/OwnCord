fn main() {
    // The plugins whose Kotlin side sends events: the webview subscribes
    // through these two commands.
    let listener =
        || tauri_build::InlinedPlugin::new().commands(&["register_listener", "remove_listener"]);
    let attributes = tauri_build::Attributes::new()
        .plugin("owncord-metered-network", listener())
        .plugin("owncord-mobile-audio", listener())
        .plugin("owncord-idle", listener());
    if let Err(error) = tauri_build::try_build(attributes) {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
