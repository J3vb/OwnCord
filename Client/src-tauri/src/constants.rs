/// Tauri store file for persisted certificate fingerprints (TOFU pinning).
pub const CERTS_STORE: &str = "certs.json";

/// Tauri store file for pinned peer voice-E2EE identity public keys (TOFU).
pub const IDENTITY_PINS_STORE: &str = "identity_pins.json";

/// Tauri store file for user settings and preferences.
pub const SETTINGS_STORE: &str = "settings.json";

/// Tauri store file for the degraded-mode credential fallback (see
/// `secret_store`). Values are ciphertext (DPAPI on Windows, ChaCha20-Poly1305
/// elsewhere), never plaintext, and the file only exists on a machine whose OS
/// credential store failed a round-trip.
pub const CREDENTIAL_FALLBACK_STORE: &str = "credential_fallback.json";

/// Per-install key that seals the non-Windows credential fallback entries
/// (see `fallback_crypto`). Written once, owner-only (0600).
///
/// Gated to match its only consumer: `fallback_crypto` is `cfg(not(windows))`
/// because Windows seals fallback entries with DPAPI instead, so on Windows
/// this constant would be dead code and `-D warnings` fails the build.
#[cfg(not(windows))]
pub const CREDENTIAL_FALLBACK_KEY_FILE: &str = "credential_fallback.key";
