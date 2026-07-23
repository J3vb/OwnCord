/// Tauri store file for persisted certificate fingerprints (TOFU pinning).
pub const CERTS_STORE: &str = "certs.json";

/// Tauri store file for pinned peer voice-E2EE identity public keys (TOFU).
pub const IDENTITY_PINS_STORE: &str = "identity_pins.json";

/// Tauri store file for user settings and preferences.
pub const SETTINGS_STORE: &str = "settings.json";
