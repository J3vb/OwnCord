//! Certificate and identity pins: store keys, the trust-on-first-use
//! decision, and the checks on pin text the webview hands in.

use serde_json::Value;

/// What the handshake showed: the leaf's fingerprint, and whether the chain
/// validated against the public web-PKI roots for the connection's DNS name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observed {
    pub fingerprint: String,
    pub web_pki_valid: bool,
}

/// Cert-store key for a host. Strips a default `:443` so the ws proxy (which
/// keys off `wss://host` with no explicit 443) and the http/livekit proxies
/// (which see `host:443`) resolve the SAME pin. Non-default ports are kept.
/// Case-folded (DNS names are case-insensitive): the host reaches this from
/// several places (a profile-entered host verbatim, a `wss://` URL, a URL
/// parsed on the TS side, which lowercases) — without folding case here, two
/// callers with the same server in different case would pin/read different
/// entries, opening a second, unpinned proxy tunnel.
///
/// Also strips brackets from a *portless* bracketed IPv6 literal ("[::1]" →
/// "::1"), after the `:443` strip above runs (so "[::1]:443" also unwraps).
/// The ws proxy computes this key from a bracketed `wss://[::1]/...`
/// authority (ws.ts's `bracketBareIPv6Host` has to bracket a bare IPv6 host
/// for the URL to parse at all), while the http/livekit proxies
/// may see the bare or default-port-bracketed form of the very same server —
/// without unwrapping here those resolve to different keys and the same
/// server's certificate gets pinned (and re-confirmed by the user) twice. A
/// *non-default* port keeps its brackets: "[::1]:8443" stays its own distinct
/// key, matching how a plain "host:8443" is never collapsed into "host".
pub fn cert_store_key(host: &str) -> String {
    // Only strip a trailing ":443" when what's left is unambiguously a host
    // (no remaining colon) or a bracketed IPv6 literal (ends in `]`, as in
    // "[::1]:443"). Without this guard, a BARE IPv6 literal whose final
    // hextet is "443" — e.g. "fd00::443" — would have that hextet eaten as
    // if it were a port, truncating the address to "fd00:" and pinning the
    // same server under a different key than the ws/livekit proxies use for
    // the bracketed form of the same address.
    let stripped = match host.strip_suffix(":443") {
        Some(rest) if !rest.contains(':') || rest.ends_with(']') => rest,
        _ => host,
    };
    let unbracketed = stripped
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(stripped);
    unbracketed.to_ascii_lowercase()
}

/// Extract the host (with any non-default port) from a `wss://` URL.
pub fn extract_host(url: &str) -> String {
    cert_store_key(
        url.strip_prefix("wss://")
            .unwrap_or(url)
            .split('/')
            .next()
            .unwrap_or(url),
    )
}

/// The trust decision for an observed fingerprint given the stored pin.
#[derive(Debug, PartialEq, Eq)]
pub enum TofuOutcome {
    /// A pin exists and matches — proceed.
    Trusted,
    /// No pin exists — do NOT trust or forward; ask the user to confirm.
    FirstUse,
    /// A pin exists but differs — reject; possible MITM or cert rotation.
    Mismatch { stored: String },
    /// A pin exists and differs, but the pinned leaf was publicly valid for
    /// this host and so is the new one: a routine public-CA renewal. Proceed;
    /// `evaluate` has already re-pinned.
    Renewed { stored: String },
}

/// Pure trust decision. No I/O, no persistence — this is the whole point of the
/// F4/F8 fix: deciding never writes a pin. `web_pki_pin` is the pinned leaf
/// recorded as publicly valid for this host, if any; it vouches only while it
/// equals the stored pin.
pub fn decide(
    stored: Option<String>,
    web_pki_pin: Option<&str>,
    current: &Observed,
) -> TofuOutcome {
    match stored {
        None => TofuOutcome::FirstUse,
        Some(s) if s == current.fingerprint => TofuOutcome::Trusted,
        Some(s) if current.web_pki_valid && web_pki_pin == Some(s.as_str()) => {
            TofuOutcome::Renewed { stored: s }
        }
        Some(s) => TofuOutcome::Mismatch { stored: s },
    }
}

/// The fingerprint to record as the publicly valid pinned leaf after
/// `outcome`, or `None` to leave the record alone. Only a leaf that is pinned
/// and seen publicly valid is ever recorded.
pub fn web_pki_record(
    outcome: &TofuOutcome,
    current: &Observed,
    recorded: Option<&str>,
) -> Option<String> {
    let pinned = matches!(outcome, TofuOutcome::Trusted | TofuOutcome::Renewed { .. });
    (pinned && current.web_pki_valid && recorded != Some(current.fingerprint.as_str()))
        .then(|| current.fingerprint.clone())
}

/// Whether `fingerprint` is a SHA-256 digest in colon-hex form:
/// `XX:XX:XX:...`, 32 hex pairs separated by colons (95 chars total).
///
/// Split out of `accept_cert_fingerprint` so the format check — the guard on
/// the only code path that writes a cert pin — is reachable from unit tests
/// without a Tauri runtime.
pub fn is_valid_cert_fingerprint(fingerprint: &str) -> bool {
    fingerprint.len() == 95
        && fingerprint.bytes().enumerate().all(|(i, b)| {
            if (i + 1) % 3 == 0 {
                b == b':'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

/// Whether writing `fingerprint` changes what `host` trusts: a first pin, or a
/// different one. Restating the stored pin asks nothing.
pub fn pin_needs_confirmation(stored: Option<&Value>, fingerprint: &str) -> bool {
    !matches!(stored, Some(Value::String(s)) if s == fingerprint)
}

/// Max length for a base64 identity public key (DoS guard). A raw P-256 key is
/// 65 bytes (~88 base64 chars); an SPKI-wrapped one ~124. 512 is generous.
pub const MAX_IDENTITY_PIN_LEN: usize = 512;

/// Store key for a peer's identity pin. A mismatch here (wrong separator, etc.)
/// would make pins silently fail to match and accept a MITM'd key, so it is a
/// pure, testable helper shared by both commands.
pub fn identity_pin_key(host: &str, user_id: &str) -> String {
    format!("{host}:{user_id}")
}

/// Check the arguments of a request to store a peer's identity pin: a
/// plausible host, a plain user id, and a bounded base64 key. The key itself
/// is parsed and verified on the JS side; this only keeps garbage and
/// oversized values out of the pin store.
pub fn validate_identity_pin_args(host: &str, user_id: &str, pin: &str) -> Result<(), String> {
    if host.is_empty() || host.len() > 253 {
        return Err("host must be 1-253 characters".into());
    }
    // Validate host format: alphanumeric, dots, hyphens, colons (port), brackets (IPv6)
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
    {
        return Err("host contains invalid characters".into());
    }
    if user_id.is_empty() || user_id.len() > 64 {
        return Err("user_id must be 1-64 characters".into());
    }
    if !user_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("user_id contains invalid characters".into());
    }
    if pin.is_empty() || pin.len() > MAX_IDENTITY_PIN_LEN {
        return Err("pin must be 1-512 characters".into());
    }
    // Base64 charset (standard + url-safe + padding). Guards against garbage/DoS;
    // the actual key parsing/verification happens on the JS side.
    if !pin
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '-' | '_'))
    {
        return Err("pin contains invalid characters".into());
    }
    Ok(())
}
