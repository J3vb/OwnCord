use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::secret_store::{self, Backend};

/// Data returned from `load_credential`.
///
/// The plaintext password is deliberately NOT part of the IPC payload. It stays
/// inside this process and is used only by `login_with_saved_password`; the
/// frontend learns that one exists through `has_password` and prefills a
/// placeholder. See `docs/security.md` and `docs/architecture/client.md`, both
/// of which state that plaintext passwords never cross IPC back to JS.
#[derive(Serialize, Clone)]
pub struct CredentialData {
    pub username: String,
    pub token: String,
    #[serde(skip)]
    pub password: Option<String>,
    /// Whether a password is stored for this host. Always mirrors
    /// `password.is_some()` — set by `parse_credential_blob`, the only
    /// constructor outside tests.
    pub has_password: bool,
}

impl std::fmt::Debug for CredentialData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialData")
            .field("username", &self.username)
            .field("token", &"[REDACTED]")
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .field("has_password", &self.has_password)
            .finish()
    }
}

// ---------------------------------------------------------------------------
// Account naming
// ---------------------------------------------------------------------------
//
// Both secrets live in the same credential-store service
// (`secret_store::SERVICE`) and are told apart by their account name. Changing
// either function orphans every credential already stored under the old name,
// so they are pure and covered by tests.

/// Account holding the login credential for `host`.
fn login_account(host: &str) -> String {
    host.to_string()
}

/// Account holding the voice-E2EE identity private key for `host`.
///
/// The `identity:` prefix keeps it distinct from the login credential for the
/// same host; a collision would make one secret overwrite the other.
fn identity_account(host: &str) -> String {
    format!("identity:{host}")
}

fn require_non_empty(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Cross-command serialization
// ---------------------------------------------------------------------------
//
// B4-3 moved every command below to `#[tauri::command(async)]` so the
// blocking keyring/DPAPI I/O runs off Tauri's IPC main thread instead of
// freezing the UI on it. Before that, Tauri ran all (sync) commands one at a
// time on that thread, so two overlapping invocations were always fully
// serialized in arrival order. `async` dispatches each invocation onto the
// async runtime's thread pool instead, so two overlapping calls can now
// genuinely run concurrently and interleave their OS credential-store
// operations.
//
// That is reachable, not hypothetical: `identity.ts`'s legacy-key migration
// does a save-then-delete pair for two different accounts, and logging out
// fires a fire-and-forget `delete_credential` for a host whose connect-page
// auto-login can immediately issue `load_credential` for the very same host.
// Nothing upstream awaits the delete before the read can start.
//
// This mutex restores the "only one credential-store operation in flight at
// a time" property that made ordering safe pre-`async`, without giving back
// the perf win: it guards the whole command body (not just the raw OS call),
// so the fallback file's read-modify-write in `secret_store::set_with` is
// still atomic with respect to a concurrent read or delete for the same or a
// different account.
static CREDENTIAL_LOCK: Mutex<()> = Mutex::new(());

/// Run `f` with every other credential-store command excluded. Poisoning is
/// recovered from (the guarded value is `()`, so there is nothing to
/// distrust) rather than propagated, so a panic inside one command cannot
/// permanently wedge every credential operation for the rest of the process.
fn with_credential_lock<T>(f: impl FnOnce() -> T) -> T {
    let _guard = CREDENTIAL_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Decide what password a re-written credential blob should carry.
///
/// Three states, because "no password supplied" and "erase the password" are
/// different intents. Conflating them was a live defect: because an omitted
/// password wiped the stored one, the frontend had to round-trip the plaintext
/// back through IPC on every re-save — which is the only reason it was ever
/// returned to JavaScript at all.
fn resolve_password(
    supplied: Option<&str>,
    clear: bool,
    read_existing: impl FnOnce() -> Result<Option<String>, String>,
) -> Result<Option<String>, String> {
    match (supplied, clear) {
        // An explicit new password wins, even over a clear request.
        (Some(pw), _) => Ok(Some(pw.to_string())),
        // Explicitly erase.
        (None, true) => Ok(None),
        // Default: carry forward whatever is already stored.
        //
        // The read is lazy and its failure is FATAL. `secret_store::get`
        // deliberately separates "nothing stored" from "the store could not be
        // read", so a caller can tell a broken keychain from a first login;
        // treating an error as "no password" here would rewrite the blob
        // without the password the user asked us to keep - silently destroying
        // it, which is the same class of loss this command exists to prevent.
        (None, false) => read_existing(),
    }
}

/// Save a credential (username + token + optional password) to the system
/// credential store.
///
/// Credential key: service=`com.owncord.client`, account=`host`
/// Secret: JSON `{"username":"...","token":"...","password":"..."}`
///
/// On Windows the secret is protected by DPAPI via Windows Credential Manager.
/// On Linux it is stored in the Secret Service (GNOME Keyring / KWallet).
/// On macOS it is stored in the system Keychain. The write is read back before
/// this returns — see [`crate::secret_store`] for what happens when it does not
/// come back.
#[tauri::command(async)]
pub fn save_credential(
    app: AppHandle,
    host: String,
    username: String,
    token: String,
    password: Option<String>,
    clear_password: Option<bool>,
) -> Result<(), String> {
    with_credential_lock(|| {
        require_non_empty(&host, "host")?;
        require_non_empty(&token, "token")?;
        require_non_empty(&username, "username")?;

        let account = login_account(&host);
        let mut payload = serde_json::json!({
            "username": username,
            "token": token,
        });

        // The existing blob is read only on the preserve path, and neither a
        // read failure nor a parse failure may be treated as "no password
        // stored": both mean the password cannot be preserved, and answering
        // `None` would rewrite the blob without it. A malformed blob can still
        // carry a readable password (`parse_credential_blob` also rejects a
        // missing username or token), so discarding it is a real loss, not
        // just a theoretical one.
        let read_existing = || {
            let Some(blob) = secret_store::get(&app, &account).map_err(|e| {
                format!("save_credential refused to overwrite an unreadable credential: {e}")
            })?
            else {
                return Ok(None);
            };
            let cred = parse_credential_blob(&blob).map_err(|e| {
                format!("save_credential refused to overwrite an unparseable credential: {e}")
            })?;
            Ok(cred.password)
        };

        if let Some(pw) = resolve_password(
            password.as_deref(),
            clear_password.unwrap_or(false),
            read_existing,
        )? {
            payload["password"] = serde_json::Value::String(pw);
        }

        secret_store::set(&app, &account, &payload.to_string())
            .map_err(|e| format!("save_credential failed: {e}"))?;
        Ok(())
    })
}

/// Load a credential from the system credential store.
///
/// Returns `None` when no credential exists for the given host.
#[tauri::command(async)]
pub fn load_credential(app: AppHandle, host: String) -> Result<Option<CredentialData>, String> {
    with_credential_lock(|| {
        require_non_empty(&host, "host")?;

        let Some(json_str) = secret_store::get(&app, &login_account(&host))
            .map_err(|e| format!("load_credential failed: {e}"))?
        else {
            return Ok(None);
        };

        parse_credential_blob(&json_str).map(Some)
    })
}

/// Parse the stored credential JSON blob.
///
/// Split out from the command so the blob contract is testable without a
/// credential store.
fn parse_credential_blob(json_str: &str) -> Result<CredentialData, String> {
    let parsed: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| format!("credential blob is not valid JSON: {e}"))?;

    let username = parsed
        .get("username")
        .and_then(|v| v.as_str())
        .ok_or("credential blob missing 'username' field")?
        .to_string();
    let token = parsed
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or("credential blob missing 'token' field")?
        .to_string();
    let password = parsed
        .get("password")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(CredentialData {
        username,
        token,
        has_password: password.is_some(),
        password,
    })
}

/// Delete a credential from the system credential store.
///
/// Deleting a non-existent credential is not treated as an error.
#[tauri::command(async)]
pub fn delete_credential(app: AppHandle, host: String) -> Result<(), String> {
    with_credential_lock(|| {
        require_non_empty(&host, "host")?;
        secret_store::delete(&app, &login_account(&host))
            .map_err(|e| format!("delete_credential failed: {e}"))
    })
}

// ---------------------------------------------------------------------------
// Identity-key commands (F3: voice E2EE TOFU long-term identity keypair)
// ---------------------------------------------------------------------------
//
// Mirrors save/load/delete_credential, but the secret is a single opaque
// key blob (base64 JWK private key) rather than a JSON credential struct,
// and it is stored under account `identity:{host}` to keep it distinct from
// the login credential entry (account `{host}`) in the same service.
//
// `host` here is an opaque scope string, not necessarily a bare host: the
// only caller (`identity.ts`) passes `{userId}@{host}`, so the account
// actually written is `identity:{userId}@{host}`.

/// Save the long-term identity private key for `host`.
///
/// The write is read back before this returns. A machine whose credential store
/// accepts writes without keeping them falls through to the encrypted fallback
/// file (DPAPI on Windows, sealed per-install key elsewhere); if that is also
/// unavailable this returns an error rather than reporting a success that would
/// leave peers rejecting the user's voice announce after a restart.
#[tauri::command(async)]
pub fn save_identity_key(app: AppHandle, host: String, key: String) -> Result<(), String> {
    with_credential_lock(|| {
        require_non_empty(&host, "host")?;
        require_non_empty(&key, "key")?;

        secret_store::set(&app, &identity_account(&host), &key)
            .map_err(|e| format!("save_identity_key failed: {e}"))?;
        Ok(())
    })
}

/// Load the identity private key for `host`.
///
/// Returns `None` when no identity key exists for the given host.
#[tauri::command(async)]
pub fn load_identity_key(app: AppHandle, host: String) -> Result<Option<String>, String> {
    with_credential_lock(|| {
        require_non_empty(&host, "host")?;
        secret_store::get(&app, &identity_account(&host))
            .map_err(|e| format!("load_identity_key failed: {e}"))
    })
}

/// Delete the identity private key for `host`.
///
/// Deleting a non-existent key is not treated as an error.
#[tauri::command(async)]
pub fn delete_identity_key(app: AppHandle, host: String) -> Result<(), String> {
    with_credential_lock(|| {
        require_non_empty(&host, "host")?;
        secret_store::delete(&app, &identity_account(&host))
            .map_err(|e| format!("delete_identity_key failed: {e}"))
    })
}

// Pending text is private data. Reuse the credential store's verified,
// encrypted fallback and its cross-command lock; never put it in settings.json.
const PENDING_MESSAGE_MAX_BYTES: usize = 128 * 1024;

fn pending_messages_account(host: &str, user_id: u64) -> Result<String, String> {
    if host.is_empty() || host.len() > 2048 || user_id == 0 {
        return Err("invalid pending message owner".to_string());
    }
    let owner = serde_json::to_vec(&(host, user_id)).map_err(|e| e.to_string())?;
    let digest = ring::digest::digest(&ring::digest::SHA256, &owner);
    let digest = digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("pending-messages:{digest}"))
}

fn validate_pending_messages(value: &str) -> Result<(), String> {
    if value.len() > PENDING_MESSAGE_MAX_BYTES {
        return Err("pending message storage limit exceeded".to_string());
    }
    let parsed: serde_json::Value =
        serde_json::from_str(value).map_err(|_| "invalid pending message data".to_string())?;
    match parsed.as_array() {
        Some(entries) if entries.len() <= 64 => Ok(()),
        _ => Err("invalid pending message count".to_string()),
    }
}

#[tauri::command(async)]
pub fn save_pending_messages(
    app: AppHandle,
    host: String,
    user_id: u64,
    value: String,
) -> Result<(), String> {
    with_credential_lock(|| {
        let account = pending_messages_account(&host, user_id)?;
        validate_pending_messages(&value)?;
        secret_store::set(&app, &account, &value).map(|_| ())
    })
}

#[tauri::command(async)]
pub fn load_pending_messages(
    app: AppHandle,
    host: String,
    user_id: u64,
) -> Result<Option<String>, String> {
    with_credential_lock(|| {
        let account = pending_messages_account(&host, user_id)?;
        let value = secret_store::get(&app, &account)?;
        if let Some(ref value) = value {
            validate_pending_messages(value)?;
        }
        Ok(value)
    })
}

#[tauri::command(async)]
pub fn delete_pending_messages(app: AppHandle, host: String, user_id: u64) -> Result<(), String> {
    with_credential_lock(|| {
        let account = pending_messages_account(&host, user_id)?;
        secret_store::delete(&app, &account)
    })
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/// Result of [`probe_credential_store`].
#[derive(Serialize, Debug)]
pub struct CredentialStoreProbe {
    /// Whether a write/read/delete cycle completed with the value intact.
    pub ok: bool,
    /// Which store served the probe, when it succeeded.
    pub backend: Option<Backend>,
    /// Failure detail, for the log and the support bundle.
    pub error: Option<String>,
}

/// Write, read back and delete a throwaway secret to prove the credential store
/// works on this machine.
///
/// This is the check to run when a user reports peers rejecting their voice
/// announce: it distinguishes "the credential store is fine" from "writes are
/// accepted and dropped" without touching any real credential. The probe
/// account is removed again whatever the outcome.
#[tauri::command(async)]
pub fn probe_credential_store(app: AppHandle) -> CredentialStoreProbe {
    with_credential_lock(|| {
        // Underscores are not legal in DNS hostnames, so this cannot collide
        // with a real `{host}` or `identity:{host}` account.
        const PROBE_ACCOUNT: &str = "__diagnostic_probe__";
        const PROBE_SECRET: &str = "owncord-credential-store-probe";

        let result = secret_store::set(&app, PROBE_ACCOUNT, PROBE_SECRET).and_then(|backend| {
            match secret_store::get(&app, PROBE_ACCOUNT)? {
                Some(ref got) if got == PROBE_SECRET => Ok(backend),
                Some(_) => Err("read back a different value than was written".into()),
                None => Err("the store reported a successful write but returned no entry".into()),
            }
        });

        // Always clean up, including when the probe failed part-way through.
        if let Err(e) = secret_store::delete(&app, PROBE_ACCOUNT) {
            log::warn!("failed to remove credential store probe entry: {e}");
        }

        match result {
            Ok(backend) => {
                log::info!("credential store probe succeeded (backend: {backend:?})");
                CredentialStoreProbe {
                    ok: true,
                    backend: Some(backend),
                    error: None,
                }
            }
            Err(e) => {
                log::error!("credential store probe failed: {e}");
                CredentialStoreProbe {
                    ok: false,
                    backend: None,
                    error: Some(e),
                }
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Saved-password login
// ---------------------------------------------------------------------------
//
// The plaintext password never crosses the IPC boundary. When the user ticked
// "Remember password", the login form shows a placeholder and calls
// `login_with_saved_password` instead of sending a password of its own; the
// password is read from the credential store and used here, inside this
// process.
//
// The request goes to the loopback `http_proxy` tunnel this process already
// owns, exactly like a webview `fetch`: the proxy terminates TLS, pins the
// certificate (TOFU) and rewrites the `Host` header, so nothing about
// certificate handling is duplicated or bypassed here.
//
// The plaintext does live briefly in this process's memory, in the request
// buffer, and is not zeroized (no `zeroize` dependency). That is strictly
// better than the arrangement it replaces, where the same plaintext sat in
// the JS heap for the lifetime of the connect page.

/// How long the whole saved-password login may take before it is abandoned.
const SAVED_LOGIN_TIMEOUT: Duration = Duration::from_secs(20);

/// Largest `/auth/login` response this will buffer.
///
/// The timeout alone is not a bound: a server that streams steadily can push
/// an unbounded amount of memory into the read buffer inside 20 seconds.
/// `http_proxy.rs` caps its own header read for the same reason.
const SAVED_LOGIN_MAX_RESPONSE: u64 = 64 * 1024;

/// Raw relay of the server's `/auth/login` response.
///
/// Rust deliberately does not interpret the body. Login answers a union — a
/// token, or a `partial_token` plus `requires_2fa` — on top of every error
/// shape, and re-encoding that contract in a second language is precisely how
/// two implementations drift apart. The frontend parses this with exactly the
/// same code that handles its own `api.login` response.
#[derive(Serialize, Clone, Debug)]
pub struct SavedLoginResponse {
    pub status: u16,
    pub body: String,
}

/// Log in to `host` as `username` using the password saved in the credential
/// store, returning the server's raw response.
///
/// Errors when no credential, or no saved password, exists for the host.
#[tauri::command(async)]
pub async fn login_with_saved_password(
    app: AppHandle,
    state: tauri::State<'_, crate::http_proxy::HttpProxyState>,
    host: String,
    username: String,
) -> Result<SavedLoginResponse, String> {
    require_non_empty(&host, "host")?;
    require_non_empty(&username, "username")?;

    let account = login_account(&host);
    let stored = with_credential_lock(|| {
        secret_store::get(&app, &account)
            .map_err(|e| format!("login_with_saved_password failed: {e}"))
    })?;
    let password = stored
        .ok_or_else(|| "no stored credential for this host".to_string())
        .and_then(|blob| parse_credential_blob(&blob))?
        .password
        .ok_or_else(|| "no saved password for this host".to_string())?;

    let port = crate::http_proxy::start_http_proxy(app, state, host).await?;

    timeout(SAVED_LOGIN_TIMEOUT, post_login(port, &username, &password))
        .await
        .map_err(|_| "saved-password login timed out".to_string())?
}

/// POST the login body to the loopback proxy and return the raw response.
async fn post_login(
    port: u16,
    username: &str,
    password: &str,
) -> Result<SavedLoginResponse, String> {
    let body = serde_json::json!({ "username": username, "password": password }).to_string();
    // `Host` is rewritten to the real remote by the proxy, and `Connection:
    // close` is forced there too — it is sent explicitly so the read below can
    // simply run to EOF instead of framing a keep-alive response.
    let request = format!(
        "POST /api/v1/auth/login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );

    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .map_err(|e| format!("saved-password login: connect failed: {e}"))?;
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("saved-password login: write failed: {e}"))?;

    // Bounded read: one byte over the cap is treated as a failure rather than
    // silently truncated, so a partial body can never be parsed as a complete
    // response.
    let mut raw = Vec::new();
    let mut bounded = stream.take(SAVED_LOGIN_MAX_RESPONSE + 1);
    bounded
        .read_to_end(&mut raw)
        .await
        .map_err(|e| format!("saved-password login: read failed: {e}"))?;
    if raw.len() as u64 > SAVED_LOGIN_MAX_RESPONSE {
        return Err("saved-password login: response exceeded the size limit".to_string());
    }

    parse_http_response(&raw)
}

/// Whether a response header block declares chunked transfer framing.
///
/// Unfolds obs-fold continuation lines - a header value continued on a
/// following line beginning with a space or tab - before scanning. Without
/// that, a folded `Transfer-Encoding` splits into a line whose value is empty
/// and a line carrying no colon at all, and slips past a per-line scan.
/// obs-fold is deprecated by RFC 9112 and nothing in this path emits it, so
/// this is belt-and-braces against a misbehaving intermediary - but a framing
/// check that is trivially bypassable is not a check.
fn header_says_chunked(head: &str) -> bool {
    let mut unfolded = String::with_capacity(head.len());
    for line in head.lines().skip(1) {
        if line.starts_with(' ') || line.starts_with('\t') {
            // Continuation of the previous header's value.
            unfolded.push(' ');
            unfolded.push_str(line.trim());
        } else {
            unfolded.push('\n');
            unfolded.push_str(line);
        }
    }

    unfolded
        .lines()
        .filter_map(|line| line.split_once(':'))
        .any(|(name, value)| {
            name.trim().eq_ignore_ascii_case("transfer-encoding")
                && value.to_ascii_lowercase().contains("chunked")
        })
}

/// Split a raw HTTP/1.1 response into its status code and body.
///
/// Pure, so the framing is testable without a socket.
fn parse_http_response(raw: &[u8]) -> Result<SavedLoginResponse, String> {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or("saved-password login: malformed response (no header terminator)")?;
    let status_line = head
        .lines()
        .next()
        .ok_or("saved-password login: malformed response (no status line)")?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or("saved-password login: malformed response (no status code)")?;

    // This splits headers from the remaining wire bytes; it does not decode
    // transfer framing. A chunked body would therefore be relayed with its
    // chunk sizes and trailers still embedded, and the frontend would fail to
    // parse it as JSON and stall with no usable error. The request forces
    // `Connection: close` and HTTP/1.1 forbids chunked alongside it in
    // practice here, so this is a guard against a misbehaving intermediary
    // rather than an expected path — fail loudly instead of relaying garbage.
    if header_says_chunked(head) {
        return Err("saved-password login: chunked response framing is not supported".to_string());
    }

    Ok(SavedLoginResponse {
        status,
        body: body.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_messages_are_partitioned_by_host_port_and_account() {
        let first = pending_messages_account("chat.example:55000", 1).unwrap();
        assert_ne!(
            first,
            pending_messages_account("chat.example:55000", 2).unwrap()
        );
        assert_ne!(
            first,
            pending_messages_account("chat.example:55001", 1).unwrap()
        );
        assert_ne!(
            first,
            pending_messages_account("other.example:55000", 1).unwrap()
        );
        assert_eq!(
            first,
            pending_messages_account("chat.example:55000", 1).unwrap()
        );
        assert!(!first.contains("chat.example"));
        assert!(pending_messages_account("", 1).is_err());
        assert!(pending_messages_account("chat.example", 0).is_err());
    }

    #[test]
    fn pending_messages_enforce_native_size_and_count_limits() {
        assert!(validate_pending_messages("[]").is_ok());
        assert!(validate_pending_messages("[{}").is_err());
        assert!(validate_pending_messages("{}").is_err());
        let count = serde_json::to_string(&vec![0; 65]).unwrap();
        assert!(validate_pending_messages(&count).is_err());
        let large = serde_json::to_string(&vec!["x".repeat(PENDING_MESSAGE_MAX_BYTES)]).unwrap();
        assert!(validate_pending_messages(&large).is_err());
    }

    #[test]
    fn require_non_empty_rejects_empty_and_names_the_field() {
        let err = require_non_empty("", "host").unwrap_err();
        assert_eq!(err, "host must not be empty");
        assert_eq!(
            require_non_empty("", "token").unwrap_err(),
            "token must not be empty"
        );
        assert_eq!(
            require_non_empty("", "username").unwrap_err(),
            "username must not be empty"
        );
        assert_eq!(
            require_non_empty("", "key").unwrap_err(),
            "key must not be empty"
        );
    }

    #[test]
    fn require_non_empty_accepts_a_value() {
        assert!(require_non_empty("chat.example.com", "host").is_ok());
    }

    #[test]
    fn login_and_identity_accounts_never_collide() {
        // Both secrets share one credential-store service, so a collision would
        // silently overwrite one with the other.
        let host = "chat.example.com";
        assert_eq!(login_account(host), "chat.example.com");
        assert_eq!(identity_account(host), "identity:chat.example.com");
        assert_ne!(login_account(host), identity_account(host));
    }

    #[test]
    fn account_names_keep_the_port_that_distinguishes_hosts() {
        // Two servers on one machine differ only by port; dropping it would
        // make them share an identity key.
        assert_ne!(
            login_account("localhost:8443"),
            login_account("localhost:9443")
        );
        assert_eq!(
            identity_account("localhost:8443"),
            "identity:localhost:8443"
        );
    }

    #[test]
    fn parse_credential_blob_reads_all_fields() {
        let data =
            parse_credential_blob(r#"{"username":"alice","token":"tok","password":"pw"}"#).unwrap();
        assert_eq!(data.username, "alice");
        assert_eq!(data.token, "tok");
        assert_eq!(data.password.as_deref(), Some("pw"));
    }

    #[test]
    fn parse_credential_blob_allows_missing_password() {
        let data = parse_credential_blob(r#"{"username":"alice","token":"tok"}"#).unwrap();
        assert_eq!(data.password, None);
    }

    #[test]
    fn parse_credential_blob_rejects_malformed_input() {
        assert!(parse_credential_blob("not json")
            .unwrap_err()
            .contains("not valid JSON"));
        assert!(parse_credential_blob(r#"{"token":"tok"}"#)
            .unwrap_err()
            .contains("missing 'username'"));
        assert!(parse_credential_blob(r#"{"username":"alice"}"#)
            .unwrap_err()
            .contains("missing 'token'"));
    }

    #[test]
    fn credential_data_debug_redacts_sensitive_fields() {
        let data = CredentialData {
            username: "alice".into(),
            token: "secret-token".into(),
            password: Some("hunter2".into()),
            has_password: true,
        };
        let debug = format!("{data:?}");
        assert!(debug.contains("alice"));
        assert!(!debug.contains("secret-token"));
        assert!(!debug.contains("hunter2"));
        assert!(debug.contains("[REDACTED]"));
    }

    /// The IPC payload must never carry the plaintext password. This is the
    /// test-locked half of the claim made in `docs/security.md` and
    /// `docs/architecture/client.md`; the `#[serde(skip)]` on the field is the
    /// other half. Replaces an earlier test that asserted the opposite.
    #[test]
    fn credential_data_never_serializes_the_password() {
        let data = CredentialData {
            username: "alice".into(),
            token: "tok".into(),
            password: Some("hunter2".into()),
            has_password: true,
        };
        let json = serde_json::to_string(&data).unwrap();
        assert!(
            !json.contains("hunter2"),
            "plaintext password crossed IPC: {json}"
        );
        assert!(
            !json.contains("\"password\""),
            "password key present: {json}"
        );
        // The frontend still learns that one exists, so it can prefill a
        // placeholder and offer the saved-password login path.
        assert!(json.contains("\"has_password\":true"), "{json}");
    }

    #[test]
    fn credential_data_reports_absent_password() {
        let data = CredentialData {
            username: "alice".into(),
            token: "tok".into(),
            password: None,
            has_password: false,
        };
        let json = serde_json::to_string(&data).unwrap();
        assert!(json.contains("\"has_password\":false"), "{json}");
    }

    #[test]
    fn parse_credential_blob_sets_has_password_from_the_blob() {
        let with_pw =
            parse_credential_blob(r#"{"username":"a","token":"t","password":"p"}"#).unwrap();
        assert!(with_pw.has_password);
        assert_eq!(with_pw.password.as_deref(), Some("p"));

        let without = parse_credential_blob(r#"{"username":"a","token":"t"}"#).unwrap();
        assert!(!without.has_password);
        assert!(without.password.is_none());
    }

    // `save_credential` used to conflate "no password supplied" with "erase
    // the stored password", which is the only reason the frontend ever had to
    // round-trip the plaintext back through IPC. These pin the replacement.

    #[test]
    fn resolve_password_preserves_the_stored_one_by_default() {
        assert_eq!(
            resolve_password(None, false, || Ok(Some("stored".into())))
                .unwrap()
                .as_deref(),
            Some("stored")
        );
        assert_eq!(resolve_password(None, false, || Ok(None)).unwrap(), None);
    }

    /// The bug this guards: an unreadable credential store must NOT look like
    /// "no password stored". If it did, an ordinary re-save (a token refresh,
    /// say) would rewrite the blob without the password the user asked to
    /// keep, destroying it with no error anywhere.
    #[test]
    fn resolve_password_refuses_to_preserve_from_an_unreadable_store() {
        let err = resolve_password(None, false, || Err("keychain locked".to_string()))
            .expect_err("a read failure must abort the save, not erase the password");
        assert!(err.contains("keychain locked"), "{err}");
    }

    /// A blob that reads fine but does not parse is still a case where the
    /// password cannot be preserved. It can even carry a readable password —
    /// `parse_credential_blob` also rejects a missing username or token — so
    /// answering "no password" would discard a recoverable one.
    #[test]
    fn resolve_password_refuses_to_preserve_from_an_unparseable_blob() {
        let err = resolve_password(None, false, || {
            Err("credential blob is not valid JSON".to_string())
        })
        .expect_err("a parse failure must abort the save, not erase the password");
        assert!(err.contains("not valid JSON"), "{err}");
    }
    #[test]
    fn resolve_password_erases_only_when_asked() {
        assert_eq!(
            resolve_password(None, true, || Ok(Some("stored".into()))).unwrap(),
            None
        );
    }

    #[test]
    fn resolve_password_does_not_read_when_it_does_not_need_to() {
        // The read is the only fallible part, so the paths that cannot need it
        // must not be able to fail because of it.
        let exploding = || -> Result<Option<String>, String> {
            panic!("the existing credential must not be read on this path")
        };
        assert_eq!(
            resolve_password(Some("new"), false, exploding)
                .unwrap()
                .as_deref(),
            Some("new")
        );
        assert_eq!(resolve_password(None, true, exploding).unwrap(), None);
    }

    #[test]
    fn resolve_password_lets_a_supplied_password_win() {
        assert_eq!(
            resolve_password(Some("new"), false, || Ok(Some("stored".into())))
                .unwrap()
                .as_deref(),
            Some("new")
        );
        // A supplied password beats a clear request rather than silently
        // discarding what the caller just asked to store.
        assert_eq!(
            resolve_password(Some("new"), true, || Ok(Some("stored".into())))
                .unwrap()
                .as_deref(),
            Some("new")
        );
    }

    /// Builds a raw HTTP/1.1 response from parts, so the framing tests do not
    /// bury CRLFs inside string literals.
    fn http_response(status_line: &str, headers: &[&str], body: &str) -> Vec<u8> {
        let mut out = String::from(status_line);
        out.push_str("\r\n");
        for h in headers {
            out.push_str(h);
            out.push_str("\r\n");
        }
        out.push_str("\r\n");
        out.push_str(body);
        out.into_bytes()
    }

    #[test]
    fn parse_http_response_splits_status_and_body() {
        let raw = http_response(
            "HTTP/1.1 200 OK",
            &["Content-Type: application/json"],
            r#"{"token":"t"}"#,
        );
        let res = parse_http_response(&raw).unwrap();
        assert_eq!(res.status, 200);
        assert_eq!(res.body, r#"{"token":"t"}"#);
    }

    #[test]
    fn parse_http_response_relays_a_2fa_challenge_verbatim() {
        // Rust must not interpret the union: a 2FA challenge is just a body.
        let raw = http_response(
            "HTTP/1.1 200 OK",
            &[],
            r#"{"requires_2fa":true,"partial_token":"pt"}"#,
        );
        let res = parse_http_response(&raw).unwrap();
        assert_eq!(res.status, 200);
        assert!(res.body.contains("requires_2fa"));
        assert!(res.body.contains("partial_token"));
    }

    #[test]
    fn parse_http_response_relays_an_error_status() {
        let raw = http_response(
            "HTTP/1.1 401 Unauthorized",
            &[],
            r#"{"error":"INVALID_CREDENTIALS"}"#,
        );
        let res = parse_http_response(&raw).unwrap();
        assert_eq!(res.status, 401);
        assert!(res.body.contains("INVALID_CREDENTIALS"));
    }

    #[test]
    fn parse_http_response_rejects_chunked_framing() {
        // Splitting headers from the rest does not decode transfer framing, so
        // a chunked body would reach the frontend with its chunk sizes still
        // embedded and stall the form on an unparseable response. Fail loudly.
        let raw = http_response(
            "HTTP/1.1 200 OK",
            &["Transfer-Encoding: chunked"],
            "1a
{\"token\":\"t\"}
0

",
        );
        let err = parse_http_response(&raw).expect_err("chunked framing must be rejected");
        assert!(err.contains("chunked"), "{err}");
    }

    #[test]
    fn parse_http_response_rejects_chunked_hidden_by_an_obs_fold() {
        // A folded value splits into a line with an empty value and a line
        // carrying no colon at all, which a per-line scan drops. A framing
        // check that is trivially bypassable is not a check.
        let raw = http_response(
            "HTTP/1.1 200 OK",
            &["Transfer-Encoding:", " chunked"],
            "body",
        );
        let err = parse_http_response(&raw).expect_err("folded chunked must still be rejected");
        assert!(err.contains("chunked"), "{err}");
    }

    #[test]
    fn parse_http_response_rejects_chunked_among_other_codings() {
        for value in [
            "Transfer-Encoding: identity, chunked",
            "Transfer-Encoding: CHUNKED",
            "Transfer-Encoding:   chunked  ",
        ] {
            let raw = http_response("HTTP/1.1 200 OK", &[value], "body");
            assert!(
                parse_http_response(&raw).is_err(),
                "should have rejected: {value}"
            );
        }
    }

    #[test]
    fn parse_http_response_does_not_mistake_a_body_for_a_header() {
        // The scan must run on the header block only.
        let raw = http_response(
            "HTTP/1.1 200 OK",
            &["Content-Type: application/json"],
            r#"{"note":"Transfer-Encoding: chunked"}"#,
        );
        let res = parse_http_response(&raw).expect("a body naming the header is not framing");
        assert_eq!(res.status, 200);
    }
    #[test]
    fn parse_http_response_ignores_a_non_chunked_transfer_encoding() {
        let raw = http_response(
            "HTTP/1.1 200 OK",
            &["Transfer-Encoding: identity"],
            r#"{"token":"t"}"#,
        );
        assert_eq!(parse_http_response(&raw).unwrap().status, 200);
    }

    #[test]
    fn parse_http_response_rejects_malformed_input() {
        // No header terminator at all.
        assert!(parse_http_response(b"not http at all").is_err());
        // Terminator present, but the status line carries no code.
        let raw = http_response("HTTP/1.1", &[], "body");
        assert!(parse_http_response(&raw).is_err());
    }

    /// B4-3 follow-up: all 7 commands moved to `#[tauri::command(async)]`,
    /// which runs each invocation on the async runtime's thread pool instead
    /// of Tauri's single IPC main thread. Two overlapping invocations (e.g.
    /// `identity.ts`'s save-then-delete legacy-key migration, or a logout's
    /// `delete_credential` racing a connect-page auto-login's
    /// `load_credential` for the same host) can now genuinely run
    /// concurrently. `with_credential_lock` must serialize them: this proves
    /// no two holders of the lock ever run their critical section at the
    /// same time, regardless of which OS thread the runtime schedules them
    /// on.
    #[test]
    fn credential_lock_serializes_overlapping_commands() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use std::thread;
        use std::time::Duration;

        let concurrent = Arc::new(AtomicUsize::new(0));
        let max_concurrent = Arc::new(AtomicUsize::new(0));

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let concurrent = Arc::clone(&concurrent);
                let max_concurrent = Arc::clone(&max_concurrent);
                thread::spawn(move || {
                    with_credential_lock(|| {
                        let now = concurrent.fetch_add(1, Ordering::SeqCst) + 1;
                        max_concurrent.fetch_max(now, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(5));
                        concurrent.fetch_sub(1, Ordering::SeqCst);
                    });
                })
            })
            .collect();

        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(
            max_concurrent.load(Ordering::SeqCst),
            1,
            "two credential-store commands ran their critical section concurrently"
        );
    }

    /// `with_credential_lock`'s doc comment promises that poisoning is
    /// recovered from rather than propagated, so a panic inside one
    /// credential command cannot permanently wedge every later credential
    /// operation for the rest of the process. Prove it: panic while holding
    /// the lock on a spawned thread (which poisons `CREDENTIAL_LOCK`), then
    /// confirm a later `with_credential_lock` call still runs its closure
    /// instead of panicking on the poisoned mutex.
    #[test]
    fn with_credential_lock_recovers_from_a_poisoned_guard() {
        use std::thread;

        let poisoning = thread::spawn(|| {
            with_credential_lock(|| {
                panic!("boom");
            });
        });
        assert!(
            poisoning.join().is_err(),
            "expected the spawned thread to panic while holding the lock"
        );

        assert_eq!(
            with_credential_lock(|| 42),
            42,
            "with_credential_lock must recover from a poisoned mutex, not propagate it"
        );
    }
}
