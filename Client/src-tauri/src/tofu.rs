// Shared TLS Trust-On-First-Use (TOFU) machinery for the http / ws / livekit
// proxies. Self-hosted servers use self-signed certs, so we pin the leaf cert's
// SHA-256 fingerprint on first use — like SSH's known_hosts.
//
// F4/F8: pinning is now EXPLICIT. A first-use certificate is never silently
// trusted or forwarded to. The proxies capture the fingerprint during the
// handshake, then reject the connection and surface the fingerprint so the user
// can confirm it (via `accept_cert_fingerprint`) before any credential-bearing
// request is sent. `decide` is a pure function with no persistence side effects;
// the only writer of a pin is the explicit `accept_cert_fingerprint` command,
// with one exception (B11-5): a routine public-CA renewal. When the pinned leaf
// was itself publicly valid for the host and the new leaf is too, `evaluate`
// re-pins silently instead of prompting. Every other change still prompts.

use ring::digest::{digest, SHA256};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Runtime};

use crate::constants::{CERTS_STORE, CERT_WEB_PKI_STORE};

/// What the handshake showed: the leaf's fingerprint, and whether the chain
/// validated against the public web-PKI roots for the connection's DNS name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Observed {
    pub(crate) fingerprint: String,
    pub(crate) web_pki_valid: bool,
}

/// Shared observation captured during the TLS handshake.
pub(crate) type CapturedFingerprint = Arc<std::sync::Mutex<Option<Observed>>>;

/// Format a DER-encoded certificate's SHA-256 as lowercase colon-hex
/// ("aa:bb:cc:..."), the canonical pin format used across the cert store.
pub(crate) fn fingerprint_hex(cert_der: &[u8]) -> String {
    digest(&SHA256, cert_der)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(":")
}

// ── shared rustls signature-verification boilerplate ────────────────────────
// Identical across every verifier; single-homed here so the three proxies don't
// each re-implement it.

pub(crate) fn verify_tls12(
    message: &[u8],
    cert: &rustls::pki_types::CertificateDer<'_>,
    dss: &rustls::DigitallySignedStruct,
) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
    rustls::crypto::verify_tls12_signature(
        message,
        cert,
        dss,
        &rustls::crypto::ring::default_provider().signature_verification_algorithms,
    )
}

pub(crate) fn verify_tls13(
    message: &[u8],
    cert: &rustls::pki_types::CertificateDer<'_>,
    dss: &rustls::DigitallySignedStruct,
) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
    rustls::crypto::verify_tls13_signature(
        message,
        cert,
        dss,
        &rustls::crypto::ring::default_provider().signature_verification_algorithms,
    )
}

pub(crate) fn default_verify_schemes() -> Vec<rustls::SignatureScheme> {
    rustls::crypto::ring::default_provider()
        .signature_verification_algorithms
        .supported_schemes()
}

// ── verifiers ───────────────────────────────────────────────────────────────

/// The public web-PKI verifier (the webpki-roots bundle, as the updater uses),
/// built once. `None` only if rustls refuses to build it, which then marks no
/// certificate publicly valid, so every change prompts.
fn web_pki_verifier() -> Option<Arc<dyn rustls::client::danger::ServerCertVerifier>> {
    static VERIFIER: std::sync::OnceLock<
        Option<Arc<dyn rustls::client::danger::ServerCertVerifier>>,
    > = std::sync::OnceLock::new();
    VERIFIER
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            rustls::client::WebPkiServerVerifier::builder_with_provider(
                Arc::new(roots),
                Arc::new(rustls::crypto::ring::default_provider()),
            )
            .build()
            .ok()
            .map(|v| v as Arc<dyn rustls::client::danger::ServerCertVerifier>)
        })
        .clone()
}

/// A rustls verifier that ACCEPTS any leaf cert but records its fingerprint,
/// and whether it is publicly valid for the host, for the post-handshake TOFU
/// decision. Used by the http and ws proxies. Accepting here is safe only
/// because `evaluate` + the caller gate on the pin afterward.
#[derive(Debug)]
pub(crate) struct CaptureVerifier {
    captured: CapturedFingerprint,
    web_pki: Option<Arc<dyn rustls::client::danger::ServerCertVerifier>>,
}

impl CaptureVerifier {
    pub(crate) fn new() -> (Self, CapturedFingerprint) {
        Self::build(web_pki_verifier())
    }

    /// Seam for tests: inject the web-PKI verifier.
    #[cfg(test)]
    fn with_web_pki(
        web_pki: Arc<dyn rustls::client::danger::ServerCertVerifier>,
    ) -> (Self, CapturedFingerprint) {
        Self::build(Some(web_pki))
    }

    fn build(
        web_pki: Option<Arc<dyn rustls::client::danger::ServerCertVerifier>>,
    ) -> (Self, CapturedFingerprint) {
        let fp = Arc::new(std::sync::Mutex::new(None));
        (
            Self {
                captured: fp.clone(),
                web_pki,
            },
            fp,
        )
    }
}

impl rustls::client::danger::ServerCertVerifier for CaptureVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        ocsp_response: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        // Only a DNS name can be publicly valid here: an IP host always prompts
        // on a change, whatever its certificate.
        let web_pki_valid = matches!(server_name, rustls::pki_types::ServerName::DnsName(_))
            && self.web_pki.as_ref().is_some_and(|v| {
                v.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
                    .is_ok()
            });
        if let Ok(mut guard) = self.captured.lock() {
            *guard = Some(Observed {
                fingerprint: fingerprint_hex(end_entity.as_ref()),
                web_pki_valid,
            });
        }
        // Accept — the TOFU decision happens after the handshake, before any
        // request bytes are forwarded.
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        verify_tls12(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        verify_tls13(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        default_verify_schemes()
    }
}

/// A rustls verifier that requires the leaf cert to match a pinned fingerprint,
/// failing the handshake itself on mismatch. Used by the livekit proxy, which
/// refuses to start unless a pin already exists (no TOFU establishment).
#[derive(Debug)]
pub(crate) struct PinnedVerifier {
    expected_fingerprint: String,
}

impl PinnedVerifier {
    pub(crate) fn new(expected_fingerprint: String) -> Self {
        Self {
            expected_fingerprint,
        }
    }
}

impl rustls::client::danger::ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let hex = fingerprint_hex(end_entity.as_ref());
        if hex == self.expected_fingerprint {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(format!(
                "certificate fingerprint mismatch: expected {}, got {}",
                self.expected_fingerprint, hex
            )))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        verify_tls12(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        verify_tls13(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        default_verify_schemes()
    }
}

/// A rustls verifier that applies the pinned-fingerprint check ONLY to the
/// named host and normal web-PKI validation to every other host. Used by the
/// updater, whose single HTTP client talks both to the (possibly self-signed,
/// TOFU-pinned) OwnCord server for update metadata and to GitHub for the
/// installer download — a client-wide pin would reject GitHub's certificate.
#[derive(Debug)]
pub(crate) struct HostScopedVerifier {
    pinned_host: String,
    pinned: PinnedVerifier,
    default: Arc<dyn rustls::client::danger::ServerCertVerifier>,
}

impl HostScopedVerifier {
    pub(crate) fn new(pinned_host: String, expected_fingerprint: String) -> Result<Self, String> {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let default = rustls::client::WebPkiServerVerifier::builder_with_provider(
            Arc::new(roots),
            Arc::new(rustls::crypto::ring::default_provider()),
        )
        .build()
        .map_err(|e| format!("failed to build web-PKI verifier: {e}"))?;
        Ok(Self::with_default(
            pinned_host,
            expected_fingerprint,
            default,
        ))
    }

    /// Seam for tests: inject the verifier used for non-pinned hosts.
    fn with_default(
        pinned_host: String,
        expected_fingerprint: String,
        default: Arc<dyn rustls::client::danger::ServerCertVerifier>,
    ) -> Self {
        // url::Url wraps IPv6 hosts in brackets; ServerName renders them bare.
        let pinned_host = pinned_host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_ascii_lowercase();
        Self {
            pinned_host,
            pinned: PinnedVerifier::new(expected_fingerprint),
            default,
        }
    }

    fn is_pinned_host(&self, server_name: &rustls::pki_types::ServerName<'_>) -> bool {
        match server_name {
            rustls::pki_types::ServerName::DnsName(d) => {
                d.as_ref().eq_ignore_ascii_case(&self.pinned_host)
            }
            rustls::pki_types::ServerName::IpAddress(ip) => {
                std::net::IpAddr::from(*ip).to_string() == self.pinned_host
            }
            _ => false,
        }
    }
}

impl rustls::client::danger::ServerCertVerifier for HostScopedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        ocsp_response: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if self.is_pinned_host(server_name) {
            self.pinned.verify_server_cert(
                end_entity,
                intermediates,
                server_name,
                ocsp_response,
                now,
            )
        } else {
            self.default.verify_server_cert(
                end_entity,
                intermediates,
                server_name,
                ocsp_response,
                now,
            )
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        verify_tls12(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        verify_tls13(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        default_verify_schemes()
    }
}

// ── store keys ──────────────────────────────────────────────────────────────

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
/// for the URL to parse at all — see OC-0163), while the http/livekit proxies
/// may see the bare or default-port-bracketed form of the very same server —
/// without unwrapping here those resolve to different keys and the same
/// server's certificate gets pinned (and re-confirmed by the user) twice. A
/// *non-default* port keeps its brackets: "[::1]:8443" stays its own distinct
/// key, matching how a plain "host:8443" is never collapsed into "host".
pub(crate) fn cert_store_key(host: &str) -> String {
    // Only strip a trailing ":443" when what's left is unambiguously a host
    // (no remaining colon) or a bracketed IPv6 literal (ends in `]`, as in
    // "[::1]:443"). Without this guard, a BARE IPv6 literal whose final
    // hextet is "443" — e.g. "fd00::443" — would have that hextet eaten as
    // if it were a port, truncating the address to "fd00:" and pinning the
    // same server under a different key than the ws/livekit proxies use for
    // the bracketed form of the same address (OC-0215).
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
pub(crate) fn extract_host(url: &str) -> String {
    cert_store_key(
        url.strip_prefix("wss://")
            .unwrap_or(url)
            .split('/')
            .next()
            .unwrap_or(url),
    )
}

/// Load the stored pin for `host` from the Tauri cert store.
pub(crate) fn load_stored_fingerprint<R: Runtime>(
    app: &AppHandle<R>,
    host: &str,
) -> Result<Option<String>, String> {
    let store = crate::json_store::open(app, CERTS_STORE)
        .map_err(|e| format!("failed to open certs store: {e}"))?;
    Ok(store.get(host).and_then(|v| match v {
        Value::String(s) => Some(s),
        _ => None,
    }))
}

// ── the TOFU decision (pure) ────────────────────────────────────────────────

/// The trust decision for an observed fingerprint given the stored pin.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TofuOutcome {
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
pub(crate) fn decide(
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
pub(crate) fn web_pki_record(
    outcome: &TofuOutcome,
    current: &Observed,
    recorded: Option<&str>,
) -> Option<String> {
    let pinned = matches!(outcome, TofuOutcome::Trusted | TofuOutcome::Renewed { .. });
    (pinned && current.web_pki_valid && recorded != Some(current.fingerprint.as_str()))
        .then(|| current.fingerprint.clone())
}

/// Load the stored pin and decide. Persists only the automatic cases: the
/// web-PKI record of a publicly valid pinned leaf, and a renewal's new pin.
/// The record lives in its own store: losing it only means the next renewal
/// prompts.
pub(crate) fn evaluate<R: Runtime>(
    app: &AppHandle<R>,
    host: &str,
    current: &Observed,
) -> Result<TofuOutcome, String> {
    let stored = load_stored_fingerprint(app, host)?;
    let records = crate::json_store::open(app, CERT_WEB_PKI_STORE).ok();
    let recorded = records.as_ref().and_then(|r| match r.get(host) {
        Some(Value::String(s)) => Some(s),
        _ => None,
    });
    let outcome = decide(stored, recorded.as_deref(), current);
    if let TofuOutcome::Renewed { stored } = &outcome {
        let certs = crate::json_store::open(app, CERTS_STORE)
            .map_err(|e| format!("failed to open certs store: {e}"))?;
        certs.set(host, Value::String(current.fingerprint.clone()));
        if let Err(e) = certs.save() {
            certs.set(host, Value::String(stored.clone()));
            return Err(format!("failed to persist renewed cert fingerprint: {e}"));
        }
        // Fingerprints are public cert hashes — safe to log; the TOFU audit trail.
        log::info!(
            "[tofu] cert for {host} renewed by a publicly trusted CA: pin {stored} -> {}",
            current.fingerprint
        );
    }
    if let (Some(fp), Some(r)) = (
        web_pki_record(&outcome, current, recorded.as_deref()),
        &records,
    ) {
        r.set(host, Value::String(fp));
        if let Err(e) = r.save() {
            log::warn!("[tofu] failed to record web-PKI validity for {host}: {e}");
        }
    }
    Ok(outcome)
}

/// The human-readable mismatch message. The frontend parses `Stored:` out of it,
/// so keep this exact shape stable.
pub(crate) fn mismatch_message(host: &str, stored: &str, current: &str) -> String {
    crate::text::cert_mismatch(host, stored, current)
}

// ---------------------------------------------------------------------------
// Tests (pure logic only — no Tauri runtime required)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(fingerprint: &str, web_pki_valid: bool) -> Observed {
        Observed {
            fingerprint: fingerprint.into(),
            web_pki_valid,
        }
    }

    #[test]
    fn decide_first_use_when_no_pin() {
        assert_eq!(
            decide(None, None, &seen("aa:bb", false)),
            TofuOutcome::FirstUse
        );
    }

    #[test]
    fn decide_trusted_when_pin_matches() {
        assert_eq!(
            decide(Some("aa:bb".into()), None, &seen("aa:bb", false)),
            TofuOutcome::Trusted
        );
    }

    #[test]
    fn decide_mismatch_when_pin_differs() {
        assert_eq!(
            decide(Some("aa:bb".into()), None, &seen("cc:dd", false)),
            TofuOutcome::Mismatch {
                stored: "aa:bb".into()
            }
        );
    }

    // B11-5: a routine public-CA renewal re-pins silently, but only when the
    // pinned leaf was itself publicly valid for this host AND the new one is.
    #[test]
    fn decide_renews_when_old_and_new_leaf_are_web_pki_valid() {
        assert_eq!(
            decide(Some("aa:bb".into()), Some("aa:bb"), &seen("cc:dd", true)),
            TofuOutcome::Renewed {
                stored: "aa:bb".into()
            }
        );
    }

    #[test]
    fn decide_prompts_when_new_leaf_is_not_web_pki_valid() {
        assert_eq!(
            decide(Some("aa:bb".into()), Some("aa:bb"), &seen("cc:dd", false)),
            TofuOutcome::Mismatch {
                stored: "aa:bb".into()
            }
        );
    }

    #[test]
    fn decide_prompts_when_pinned_leaf_was_not_web_pki_valid() {
        // A self-signed pin has no web-PKI record, so any change prompts even
        // when the new certificate is publicly valid.
        assert_eq!(
            decide(Some("aa:bb".into()), None, &seen("cc:dd", true)),
            TofuOutcome::Mismatch {
                stored: "aa:bb".into()
            }
        );
    }

    #[test]
    fn decide_prompts_when_web_pki_record_is_for_another_leaf() {
        // The record vouches for one exact leaf; a stale one (the user later
        // accepted a different certificate by hand) vouches for nothing.
        assert_eq!(
            decide(Some("aa:bb".into()), Some("ee:ff"), &seen("cc:dd", true)),
            TofuOutcome::Mismatch {
                stored: "aa:bb".into()
            }
        );
    }

    #[test]
    fn decide_first_use_still_prompts_for_a_web_pki_valid_leaf() {
        assert_eq!(
            decide(None, None, &seen("aa:bb", true)),
            TofuOutcome::FirstUse
        );
    }

    #[test]
    fn web_pki_record_follows_the_trusted_leaf() {
        // A pinned leaf seen publicly valid gets recorded once...
        assert_eq!(
            web_pki_record(&TofuOutcome::Trusted, &seen("aa:bb", true), None),
            Some("aa:bb".to_string())
        );
        assert_eq!(
            web_pki_record(&TofuOutcome::Trusted, &seen("aa:bb", true), Some("aa:bb")),
            None
        );
        // ...a renewal records the new leaf...
        let renewed = TofuOutcome::Renewed {
            stored: "aa:bb".into(),
        };
        assert_eq!(
            web_pki_record(&renewed, &seen("cc:dd", true), Some("aa:bb")),
            Some("cc:dd".to_string())
        );
        // ...and nothing else is ever recorded.
        assert_eq!(
            web_pki_record(&TofuOutcome::Trusted, &seen("aa:bb", false), None),
            None
        );
        assert_eq!(
            web_pki_record(&TofuOutcome::FirstUse, &seen("aa:bb", true), None),
            None
        );
        let mismatch = TofuOutcome::Mismatch {
            stored: "aa:bb".into(),
        };
        assert_eq!(web_pki_record(&mismatch, &seen("cc:dd", true), None), None);
    }

    #[test]
    fn cert_store_key_strips_default_443_only() {
        assert_eq!(cert_store_key("example.com:443"), "example.com");
        assert_eq!(cert_store_key("example.com"), "example.com");
        assert_eq!(cert_store_key("example.com:8443"), "example.com:8443");
    }

    // OC-0163: ws_connect (via extract_host on a bracketed "wss://[::1]/..."
    // URL, once ws.ts brackets a bare IPv6 host to make it parse) and
    // start_http_proxy/start_livekit_proxy (which see the bare or
    // livekit-bracketed form of the SAME server) must resolve to the SAME
    // pin, or the user is prompted to accept the first-use certificate twice
    // for one server. A bracketed literal with a non-default port keeps its
    // own distinct key, matching the un-bracketed "host:port" behavior above.
    #[test]
    fn cert_store_key_treats_bracketed_and_bare_ipv6_as_the_same_host() {
        assert_eq!(
            cert_store_key("[2001:db8::1]"),
            cert_store_key("2001:db8::1")
        );
        assert_eq!(cert_store_key("2001:db8::1"), "2001:db8::1");
        assert_eq!(cert_store_key("[2001:db8::1]"), "2001:db8::1");
        // The default-port livekit form ("[host]:443") also collapses to the
        // same key as the portless forms above.
        assert_eq!(cert_store_key("[2001:db8::1]:443"), "2001:db8::1");
        // A non-default port keeps the brackets — it is a genuinely distinct
        // key from the default-port host, same as the plain "host:port" case.
        assert_eq!(cert_store_key("[2001:db8::1]:8443"), "[2001:db8::1]:8443");
    }

    // OC-0215: a BARE (unbracketed) IPv6 literal whose final hextet happens to
    // be "443" must NOT have that hextet eaten by the ":443" default-port
    // strip — "fd00::443" is a whole address, not "fd00::" on port 443. The
    // http proxy passes bare hosts verbatim (http_proxy::split_host_port has
    // an explicit `!host.contains(':')` guard for exactly this reason), while
    // the ws/livekit proxies see the bracketed form of the same address. All
    // three MUST resolve to the same key or the same server's certificate is
    // pinned (and re-confirmed by the user) under two different entries.
    #[test]
    fn cert_store_key_does_not_truncate_bare_ipv6_ending_in_443() {
        assert_eq!(cert_store_key("fd00::443"), "fd00::443");
        // Must agree with the bracketed forms the ws/livekit proxies derive
        // for the very same server.
        assert_eq!(cert_store_key("fd00::443"), cert_store_key("[fd00::443]"));
        assert_eq!(
            cert_store_key("fd00::443"),
            cert_store_key("[fd00::443]:443")
        );
    }

    // DNS names are case-insensitive, but a raw host string (a profile-entered
    // host, or one taken verbatim from a wss:// URL) is not normalized before
    // reaching here. Two call sites can derive the SAME host in different
    // case (e.g. login uses the host as typed, an attachment fetch resolves
    // it through URL parsing, which lowercases) — without folding case here,
    // they pin/read two different cert-store entries for the same server,
    // opening a second, unpinned proxy tunnel.
    #[test]
    fn cert_store_key_folds_case() {
        assert_eq!(cert_store_key("Example.COM"), "example.com");
        assert_eq!(cert_store_key("MyServer.LAN:8443"), "myserver.lan:8443");
        assert_eq!(cert_store_key("Example.COM:443"), "example.com");
    }

    #[test]
    fn extract_host_variants() {
        assert_eq!(extract_host("wss://example.com/chat"), "example.com");
        assert_eq!(
            extract_host("wss://example.com:8443/chat"),
            "example.com:8443"
        );
        assert_eq!(extract_host("wss://example.com:443/chat"), "example.com");
        assert_eq!(extract_host("wss://example.com"), "example.com");
        assert_eq!(extract_host("example.com/path"), "example.com");
        assert_eq!(extract_host(""), "");
    }

    #[test]
    fn fingerprint_hex_of_empty_is_known_sha256() {
        // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        assert_eq!(
            fingerprint_hex(b""),
            "e3:b0:c4:42:98:fc:1c:14:9a:fb:f4:c8:99:6f:b9:24:27:ae:41:e4:64:9b:93:4c:a4:95:99:1b:78:52:b8:55"
        );
    }

    // ── CaptureVerifier ──────────────────────────────────────────────────────

    // The whole post-handshake TOFU pin depends on CaptureVerifier recording
    // the LEAF cert, not an intermediate — that's what the safety comment at
    // the top of the impl asserts. Prove it: feed it a leaf plus a different
    // intermediate and check which fingerprint lands in the shared cell.
    #[test]
    fn capture_verifier_records_leaf_not_intermediate() {
        use rustls::client::danger::ServerCertVerifier;

        let (verifier, captured) = CaptureVerifier::new();
        let leaf = rustls::pki_types::CertificateDer::from(b"leaf-cert".to_vec());
        let intermediate = rustls::pki_types::CertificateDer::from(b"intermediate-cert".to_vec());
        let name = rustls::pki_types::ServerName::try_from("example.com".to_string()).unwrap();

        let result = verifier.verify_server_cert(
            &leaf,
            &[intermediate],
            &name,
            &[],
            rustls::pki_types::UnixTime::since_unix_epoch(std::time::Duration::from_secs(0)),
        );

        // Accepts unconditionally — the TOFU gate happens after the handshake.
        assert!(result.is_ok());
        assert_eq!(
            captured
                .lock()
                .unwrap()
                .as_ref()
                .map(|o| o.fingerprint.clone()),
            Some(fingerprint_hex(b"leaf-cert"))
        );
    }

    fn capture_with(stub_accepts: bool, host: &str) -> Option<Observed> {
        use rustls::client::danger::ServerCertVerifier;

        let (verifier, captured) = CaptureVerifier::with_web_pki(Arc::new(StubVerifier {
            accept: stub_accepts,
        }));
        let leaf = rustls::pki_types::CertificateDer::from(b"leaf-cert".to_vec());
        let name = rustls::pki_types::ServerName::try_from(host.to_string()).unwrap();
        let result = verifier.verify_server_cert(
            &leaf,
            &[],
            &name,
            &[],
            rustls::pki_types::UnixTime::since_unix_epoch(std::time::Duration::from_secs(0)),
        );
        // The web-PKI verdict is recorded, never enforced: the handshake is
        // accepted either way and the TOFU gate decides afterwards.
        assert!(result.is_ok());
        let observed = captured.lock().unwrap().clone();
        observed
    }

    #[test]
    fn capture_verifier_records_web_pki_validity_for_a_dns_name() {
        assert!(
            capture_with(true, "chat.example.com")
                .unwrap()
                .web_pki_valid
        );
        assert!(
            !capture_with(false, "chat.example.com")
                .unwrap()
                .web_pki_valid
        );
    }

    #[test]
    fn capture_verifier_never_marks_an_ip_host_web_pki_valid() {
        assert!(!capture_with(true, "192.168.1.10").unwrap().web_pki_valid);
        assert!(!capture_with(true, "2001:db8::1").unwrap().web_pki_valid);
    }

    #[test]
    fn capture_verifier_real_web_pki_rejects_an_untrusted_leaf() {
        use rustls::client::danger::ServerCertVerifier;

        let (verifier, captured) = CaptureVerifier::new();
        let leaf = rustls::pki_types::CertificateDer::from(b"not-a-public-cert".to_vec());
        let name = rustls::pki_types::ServerName::try_from("chat.example.com".to_string()).unwrap();
        let now = rustls::pki_types::UnixTime::now();
        assert!(verifier
            .verify_server_cert(&leaf, &[], &name, &[], now)
            .is_ok());
        assert!(!captured.lock().unwrap().as_ref().unwrap().web_pki_valid);
    }

    // ── HostScopedVerifier ──────────────────────────────────────────────────

    /// Stub for the non-pinned-host verifier: records nothing, just returns a
    /// fixed verdict so tests can prove which path a connection was routed to.
    #[derive(Debug)]
    struct StubVerifier {
        accept: bool,
    }

    impl rustls::client::danger::ServerCertVerifier for StubVerifier {
        fn verify_server_cert(
            &self,
            _end_entity: &rustls::pki_types::CertificateDer<'_>,
            _intermediates: &[rustls::pki_types::CertificateDer<'_>],
            _server_name: &rustls::pki_types::ServerName<'_>,
            _ocsp_response: &[u8],
            _now: rustls::pki_types::UnixTime,
        ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
            if self.accept {
                Ok(rustls::client::danger::ServerCertVerified::assertion())
            } else {
                Err(rustls::Error::General("stub rejected".into()))
            }
        }

        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &rustls::pki_types::CertificateDer<'_>,
            dss: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            verify_tls12(message, cert, dss)
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &rustls::pki_types::CertificateDer<'_>,
            dss: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            verify_tls13(message, cert, dss)
        }

        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            default_verify_schemes()
        }
    }

    fn host_scoped(pinned_host: &str, cert_bytes: &[u8], stub_accepts: bool) -> HostScopedVerifier {
        HostScopedVerifier::with_default(
            pinned_host.to_string(),
            fingerprint_hex(cert_bytes),
            Arc::new(StubVerifier {
                accept: stub_accepts,
            }),
        )
    }

    fn verify(
        v: &HostScopedVerifier,
        host: &str,
        cert_bytes: &[u8],
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        use rustls::client::danger::ServerCertVerifier;
        let cert = rustls::pki_types::CertificateDer::from(cert_bytes.to_vec());
        let name = rustls::pki_types::ServerName::try_from(host.to_string()).unwrap();
        v.verify_server_cert(
            &cert,
            &[],
            &name,
            &[],
            rustls::pki_types::UnixTime::since_unix_epoch(std::time::Duration::from_secs(0)),
        )
    }

    #[test]
    fn host_scoped_pins_matching_host() {
        // Stub rejects, so success proves the PINNED path handled it.
        let v = host_scoped("chat.example.com", b"server-cert", false);
        assert!(verify(&v, "chat.example.com", b"server-cert").is_ok());
    }

    #[test]
    fn host_scoped_rejects_wrong_cert_on_pinned_host() {
        let err = verify(
            &host_scoped("chat.example.com", b"server-cert", true),
            "chat.example.com",
            b"mitm-cert",
        )
        .unwrap_err();
        assert!(err.to_string().contains("fingerprint mismatch"), "{err}");
    }

    #[test]
    fn host_scoped_delegates_other_hosts_to_default() {
        // Cert does NOT match the pin; success proves the DEFAULT path handled it.
        let v = host_scoped("chat.example.com", b"server-cert", true);
        assert!(verify(&v, "github.com", b"github-cert").is_ok());
    }

    #[test]
    fn host_scoped_default_rejection_propagates() {
        let err = verify(
            &host_scoped("chat.example.com", b"server-cert", false),
            "github.com",
            b"github-cert",
        )
        .unwrap_err();
        assert!(err.to_string().contains("stub rejected"), "{err}");
    }

    #[test]
    fn host_scoped_host_match_is_case_insensitive() {
        let v = host_scoped("Chat.Example.COM", b"server-cert", false);
        assert!(verify(&v, "chat.example.com", b"server-cert").is_ok());
    }

    #[test]
    fn host_scoped_matches_ip_pinned_host() {
        let v = host_scoped("192.168.1.10", b"server-cert", false);
        assert!(verify(&v, "192.168.1.10", b"server-cert").is_ok());
    }
}
