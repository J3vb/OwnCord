fn main() {
    let attributes = tauri_build::Attributes::new().plugin(
        "owncord-metered-network",
        tauri_build::InlinedPlugin::new().commands(&["register_listener", "remove_listener"]),
    );
    if let Err(error) = tauri_build::try_build(attributes) {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
