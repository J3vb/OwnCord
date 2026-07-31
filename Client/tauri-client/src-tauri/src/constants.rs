/// Tauri store file for persisted certificate fingerprints (TOFU pinning).
pub const CERTS_STORE: &str = "certs.json";

/// Tauri store file for pinned peer voice-E2EE identity public keys (TOFU).
pub const IDENTITY_PINS_STORE: &str = "identity_pins.json";

/// Tauri store file for user settings and preferences.
pub const SETTINGS_STORE: &str = "settings.json";

/// Tauri store file for the degraded-mode credential fallback (see
/// `secret_store`). Values are DPAPI ciphertext, never plaintext, and the file
/// only exists on a machine whose OS credential store failed a round-trip.
pub const CREDENTIAL_FALLBACK_STORE: &str = "credential_fallback.json";
