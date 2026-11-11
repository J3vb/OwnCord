//! Saved-session resume.
//!
//! Auto-login and a server switch resume from the stored session token. The
//! page gets that token as stored only where `ActiveSession::saved_sign_in`
//! answers `Direct`. For any other saved host this process asks the host's own
//! server first, through the same pinned loopback tunnel the saved-password
//! login uses, and hands the token over only once that server accepts it. A
//! refused token never reaches the page.
use serde::Serialize;
use std::time::Duration;
use tauri::AppHandle;
use tokio::time::timeout;

use super::{
    login_account, parse_credential_blob, require_non_empty, run_store_op, tunnel_exchange,
    CredentialData, CLIENT_USER_AGENT,
};
use crate::active_session::{ActiveSession, SavedSignIn};
use crate::secret_store;

/// How long the server may take to answer the saved-session check.
const SESSION_CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// The answer of `resume_saved_session` for a host with a stored credential.
#[derive(Serialize, Clone, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SavedSessionResume {
    /// Sign in with this token.
    Resumed { username: String, token: String },
    /// The server no longer accepts the stored token: show the sign-in form.
    SignInNeeded,
    /// The server's certificate is not confirmed, so it was not asked. The
    /// tunnel has raised the certificate prompt.
    CertificateUnverified,
    /// Another server's session is active: no token is handed over.
    Refused,
}

impl std::fmt::Debug for SavedSessionResume {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Resumed { username, .. } => f
                .debug_struct("Resumed")
                .field("username", username)
                .field("token", &"[REDACTED]")
                .finish(),
            Self::SignInNeeded => f.write_str("SignInNeeded"),
            Self::CertificateUnverified => f.write_str("CertificateUnverified"),
            Self::Refused => f.write_str("Refused"),
        }
    }
}

/// Resume the saved session for `host`: the stored username and token, once
/// they may be used.
///
/// Returns `None` when no credential exists for the host. Errors when the
/// store cannot be read, or when the host's server could not be asked (every
/// such reason starts with "saved sign-in check").
#[tauri::command(async)]
pub async fn resume_saved_session(
    app: AppHandle,
    state: tauri::State<'_, crate::http_proxy::HttpProxyState>,
    session: tauri::State<'_, ActiveSession>,
    host: String,
) -> Result<Option<SavedSessionResume>, String> {
    require_non_empty(&host, "host")?;
    let Ok(admission) = session.saved_sign_in(&host) else {
        return Ok(Some(SavedSessionResume::Refused));
    };

    let account = login_account(&host);
    let lookup_app = app.clone();
    let stored = run_store_op(move || {
        secret_store::get(&lookup_app, &account)
            .map_err(|e| format!("resume_saved_session failed: {e}"))
    })
    .await?;
    let Some(blob) = stored else {
        return Ok(None);
    };
    let cred = parse_credential_blob(&blob)?;

    let dial_host = host.clone();
    let resumed = decide_resume(&session, &host, admission, cred, |token| async move {
        let tunnel = crate::http_proxy::start_http_proxy(app, state, dial_host).await?;
        timeout(
            SESSION_CHECK_TIMEOUT,
            check_saved_session(tunnel.port, &tunnel.token, &token),
        )
        .await
        .map_err(|_| "saved sign-in check timed out".to_string())?
    })
    .await?;
    Ok(Some(resumed))
}

/// What `resume_saved_session` answers for a stored credential. `ask_server`
/// asks the host's own server about the token; it runs only for
/// `SavedSignIn::AskServer`, and only its acceptance lets the token through.
async fn decide_resume<A, Fut>(
    session: &ActiveSession,
    host: &str,
    admission: SavedSignIn,
    cred: CredentialData,
    ask_server: A,
) -> Result<SavedSessionResume, String>
where
    A: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<SessionCheck, String>>,
{
    if admission == SavedSignIn::AskServer {
        if !is_header_safe_token(&cred.token) {
            return Ok(SavedSessionResume::SignInNeeded);
        }
        match ask_server(cred.token.clone()).await? {
            SessionCheck::Accepted => {}
            SessionCheck::Refused => return Ok(SavedSessionResume::SignInNeeded),
            SessionCheck::CertificateUnverified => {
                return Ok(SavedSessionResume::CertificateUnverified)
            }
        }
        // The check ran unlocked. A session that started for another server
        // meanwhile owns the page now, and this answer is not for it.
        if session.saved_sign_in(host).is_err() {
            return Ok(SavedSessionResume::Refused);
        }
    }

    Ok(SavedSessionResume::Resumed {
        username: cred.username,
        token: cred.token,
    })
}

/// What the host's server said about a stored token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionCheck {
    Accepted,
    Refused,
    /// The tunnel did not reach the server: its certificate is not confirmed.
    CertificateUnverified,
}

/// Whether a stored token can be written into a request header as it is. The
/// server issues hex tokens; anything with a space or a control character is
/// not one of them and is never put on the wire.
fn is_header_safe_token(token: &str) -> bool {
    !token.is_empty() && token.bytes().all(|b| b.is_ascii_graphic())
}

/// Build the raw HTTP/1.1 request that asks the server who `session_token`
/// belongs to. Pure, so the framing is testable without a socket. The headers
/// follow `build_login_request`, for the reasons given there.
fn build_session_check_request(tunnel_token: &str, session_token: &str) -> String {
    format!(
        "GET /{tunnel_token}/api/v1/auth/me HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: {CLIENT_USER_AGENT}\r\nAccept: application/json\r\nAuthorization: Bearer {session_token}\r\nConnection: close\r\n\r\n"
    )
}

/// What the answer to the saved-session check means. The tunnel's own
/// certificate refusal is named; any other answer (a busy or failing server,
/// an upstream that could not be dialled) says nothing about the token.
fn session_check_outcome(status: u16, body: &[u8]) -> Result<SessionCheck, String> {
    match status {
        200 => Ok(SessionCheck::Accepted),
        401 | 403 => Ok(SessionCheck::Refused),
        502 if is_certificate_refusal(body) => Ok(SessionCheck::CertificateUnverified),
        other => Err(format!("saved sign-in check: the server answered {other}")),
    }
}

/// Whether a response body is the tunnel's certificate refusal
/// (`http_pool::cert_error_response`).
fn is_certificate_refusal(body: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned))
        .is_some_and(|code| code == crate::tofu::TLS_CERT_ERROR_CODE)
}

/// Ask the server, through the loopback proxy, whether it accepts
/// `session_token`.
async fn check_saved_session(
    port: u16,
    tunnel_token: &str,
    session_token: &str,
) -> Result<SessionCheck, String> {
    let request = build_session_check_request(tunnel_token, session_token);
    let raw = tunnel_exchange(port, &request, "saved sign-in check").await?;
    let status = response_status(&raw)
        .ok_or_else(|| "saved sign-in check: malformed response (no status code)".to_string())?;
    session_check_outcome(status, response_body(&raw))
}

/// Everything after a raw HTTP/1.1 response's header block (empty when the
/// block never ends).
fn response_body(raw: &[u8]) -> &[u8] {
    raw.windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map_or(&[], |end| &raw[end + 4..])
}

/// The status code on a raw HTTP/1.1 response's first line, if there is one.
fn response_status(raw: &[u8]) -> Option<u16> {
    let line_end = raw.windows(2).position(|w| w == b"\r\n")?;
    String::from_utf8_lossy(&raw[..line_end])
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn saved_session_resume_serializes_a_tagged_outcome() {
        let resumed = SavedSessionResume::Resumed {
            username: "alice".into(),
            token: "tok".into(),
        };
        assert_eq!(
            serde_json::to_string(&resumed).unwrap(),
            r#"{"outcome":"resumed","username":"alice","token":"tok"}"#
        );
        assert_eq!(
            serde_json::to_string(&SavedSessionResume::SignInNeeded).unwrap(),
            r#"{"outcome":"sign_in_needed"}"#
        );
        assert_eq!(
            serde_json::to_string(&SavedSessionResume::CertificateUnverified).unwrap(),
            r#"{"outcome":"certificate_unverified"}"#
        );
        assert_eq!(
            serde_json::to_string(&SavedSessionResume::Refused).unwrap(),
            r#"{"outcome":"refused"}"#
        );
    }

    #[test]
    fn saved_session_resume_debug_redacts_the_token() {
        let resumed = SavedSessionResume::Resumed {
            username: "alice".into(),
            token: "session-token-value".into(),
        };
        let text = format!("{resumed:?}");
        assert!(text.contains("alice"), "{text}");
        assert!(!text.contains("session-token-value"), "{text}");
    }

    #[test]
    fn session_check_request_carries_the_token_to_the_me_route() {
        let request = build_session_check_request("tunnel", "abc123");
        assert!(
            request.starts_with("GET /tunnel/api/v1/auth/me HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(request.contains("\r\nAuthorization: Bearer abc123\r\n"));
        assert!(request.contains("\r\nConnection: close\r\n"));
        assert!(request.contains("\r\nAccept: application/json\r\n"));
        assert!(request.contains(&format!("\r\nUser-Agent: {CLIENT_USER_AGENT}\r\n")));
        assert!(request.ends_with("\r\n\r\n"));
        // A bodyless GET: nothing follows the header block.
        assert_eq!(request.matches("\r\n\r\n").count(), 1);
    }

    #[test]
    fn a_token_that_is_not_plain_text_is_never_put_in_a_header() {
        assert!(is_header_safe_token("0123abcdef"));
        assert!(is_header_safe_token("a.b-c_d~e+f/g="));
        assert!(!is_header_safe_token(""));
        assert!(!is_header_safe_token("tok en"));
        assert!(!is_header_safe_token("tok\r\nHost: other.example"));
        assert!(!is_header_safe_token("tok\n"));
        assert!(!is_header_safe_token("tok\0"));
        assert!(!is_header_safe_token("t\u{f6}k"));
    }

    #[test]
    fn session_check_reads_only_an_accept_or_a_refusal_as_an_answer() {
        assert_eq!(
            session_check_outcome(200, b"{}"),
            Ok(SessionCheck::Accepted)
        );
        assert_eq!(session_check_outcome(401, b""), Ok(SessionCheck::Refused));
        assert_eq!(session_check_outcome(403, b""), Ok(SessionCheck::Refused));
        for status in [204, 301, 404, 429, 500, 502, 503] {
            let err = session_check_outcome(status, b"").unwrap_err();
            assert!(err.starts_with("saved sign-in check"), "{err}");
        }
    }

    #[test]
    fn session_check_names_the_tunnels_certificate_refusal() {
        let refusal = crate::http_pool::cert_error_response();
        assert_eq!(
            session_check_outcome(502, response_body(&refusal)),
            Ok(SessionCheck::CertificateUnverified)
        );
        // Only the tunnel's own 502 carries the code: another status with the
        // same body, or a 502 without it, is not a certificate answer.
        assert!(session_check_outcome(500, response_body(&refusal)).is_err());
        assert!(session_check_outcome(502, br#"{"error":"BAD_GATEWAY"}"#).is_err());
        assert!(session_check_outcome(502, b"not json").is_err());
        assert_eq!(response_body(b"HTTP/1.1 502 Bad Gateway\r\n"), b"");
    }

    fn stored(token: &str) -> CredentialData {
        CredentialData {
            username: "alice".into(),
            token: token.into(),
            password: Some("hunter2".into()),
            has_password: true,
        }
    }

    async fn never_asked(_token: String) -> Result<SessionCheck, String> {
        panic!("the server must not be asked");
    }

    #[tokio::test]
    async fn a_direct_resume_hands_the_token_over_without_asking_the_server() {
        let session = ActiveSession::new();
        let resumed = decide_resume(
            &session,
            "a.example:8443",
            SavedSignIn::Direct,
            stored("abc123"),
            never_asked,
        )
        .await;
        assert_eq!(
            resumed,
            Ok(SavedSessionResume::Resumed {
                username: "alice".into(),
                token: "abc123".into(),
            })
        );
    }

    #[tokio::test]
    async fn a_token_reaches_the_page_only_once_its_server_accepts_it() {
        let session = ActiveSession::new();
        let ask = |answer: Result<SessionCheck, String>| {
            let session = &session;
            async move {
                decide_resume(
                    session,
                    "b.example:8443",
                    SavedSignIn::AskServer,
                    stored("abc123"),
                    |token| async move {
                        assert_eq!(token, "abc123");
                        answer
                    },
                )
                .await
            }
        };

        assert_eq!(
            ask(Ok(SessionCheck::Accepted)).await,
            Ok(SavedSessionResume::Resumed {
                username: "alice".into(),
                token: "abc123".into(),
            })
        );
        for (answer, expected) in [
            (SessionCheck::Refused, SavedSessionResume::SignInNeeded),
            (
                SessionCheck::CertificateUnverified,
                SavedSessionResume::CertificateUnverified,
            ),
        ] {
            let resumed = ask(Ok(answer)).await.unwrap();
            assert_eq!(resumed, expected);
            let json = serde_json::to_string(&resumed).unwrap();
            assert!(!json.contains("abc123"), "{json}");
            assert!(!json.contains("hunter2"), "{json}");
        }
        assert_eq!(
            ask(Err("saved sign-in check: connect failed".into())).await,
            Err("saved sign-in check: connect failed".into())
        );
    }

    #[tokio::test]
    async fn a_token_that_cannot_go_in_a_header_asks_for_a_sign_in_without_a_request() {
        let session = ActiveSession::new();
        let resumed = decide_resume(
            &session,
            "b.example:8443",
            SavedSignIn::AskServer,
            stored("tok\r\nHost: other.example"),
            never_asked,
        )
        .await;
        assert_eq!(resumed, Ok(SavedSessionResume::SignInNeeded));
    }

    #[tokio::test]
    async fn a_session_that_starts_for_another_server_during_the_check_gets_no_token() {
        let session = ActiveSession::new();
        let resumed = decide_resume(
            &session,
            "b.example:8443",
            SavedSignIn::AskServer,
            stored("abc123"),
            |_token| async {
                session.set("a.example:8443");
                Ok(SessionCheck::Accepted)
            },
        )
        .await;
        assert_eq!(resumed, Ok(SavedSessionResume::Refused));

        // The same server signing in meanwhile is this very resume's session.
        let session = ActiveSession::new();
        let resumed = decide_resume(
            &session,
            "b.example:8443",
            SavedSignIn::AskServer,
            stored("abc123"),
            |_token| async {
                session.set("b.example:8443");
                Ok(SessionCheck::Accepted)
            },
        )
        .await;
        assert!(matches!(resumed, Ok(SavedSessionResume::Resumed { .. })));
    }

    #[test]
    fn response_status_reads_the_first_line_only() {
        assert_eq!(
            response_status(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"),
            Some(200)
        );
        assert_eq!(
            response_status(b"HTTP/1.1 401 Unauthorized\r\n\r\n"),
            Some(401)
        );
        assert_eq!(response_status(b""), None);
        assert_eq!(response_status(b"HTTP/1.1 200 OK"), None);
        assert_eq!(response_status(b"garbage\r\n\r\n"), None);
        assert_eq!(response_status(b"HTTP/1.1 abc\r\n\r\n"), None);
    }

    /// The store read runs on the blocking pool under the credential lock, as
    /// every credential command's does.
    #[test]
    fn the_resume_command_is_async_and_reads_the_store_on_the_blocking_pool() {
        let src = include_str!("session_resume.rs");
        let body = src.split("#[cfg(test)]\nmod tests").next().unwrap_or(src);
        assert_eq!(body.matches("#[tauri::command(async)]").count(), 1);
        assert!(body.contains("#[tauri::command(async)]\npub async fn resume_saved_session("));
        assert_eq!(body.matches("secret_store::").count(), 1);
        assert!(body.contains("run_store_op(move || {\n        secret_store::get("));
    }

    /// A loopback server that answers one request with `reply` and closes.
    async fn one_shot_server(reply: &'static [u8]) -> (u16, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 1024];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = stream.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
            }
            stream.write_all(reply).await.unwrap();
            request
        });
        (port, seen)
    }

    #[tokio::test]
    async fn saved_session_check_accepts_only_what_the_server_accepts() {
        let (port, seen) = one_shot_server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").await;
        assert_eq!(
            check_saved_session(port, "tunnel", "abc123").await,
            Ok(SessionCheck::Accepted)
        );
        let request = String::from_utf8(seen.await.unwrap()).unwrap();
        assert!(
            request.starts_with("GET /tunnel/api/v1/auth/me "),
            "{request}"
        );
        assert!(
            request.contains("Authorization: Bearer abc123\r\n"),
            "{request}"
        );

        let (port, _seen) =
            one_shot_server(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n").await;
        assert_eq!(
            check_saved_session(port, "tunnel", "abc123").await,
            Ok(SessionCheck::Refused)
        );
    }

    #[tokio::test]
    async fn saved_session_check_fails_when_the_server_drops_or_cannot_be_reached() {
        // The tunnel closes without an answer when its upstream dial fails.
        let (port, _seen) = one_shot_server(b"").await;
        let err = check_saved_session(port, "tunnel", "abc123")
            .await
            .unwrap_err();
        assert!(err.starts_with("saved sign-in check"), "{err}");

        // The tunnel could not dial its upstream.
        let (port, _seen) =
            one_shot_server(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n").await;
        let err = check_saved_session(port, "tunnel", "abc123")
            .await
            .unwrap_err();
        assert!(err.starts_with("saved sign-in check"), "{err}");

        // The tunnel refused the server's certificate: named, not a failure.
        let refusal: &'static [u8] = Box::leak(crate::http_pool::cert_error_response().into());
        let (port, _seen) = one_shot_server(refusal).await;
        assert_eq!(
            check_saved_session(port, "tunnel", "abc123").await,
            Ok(SessionCheck::CertificateUnverified)
        );

        // Nothing listens: the connect itself fails.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let err = check_saved_session(port, "tunnel", "abc123")
            .await
            .unwrap_err();
        assert!(err.starts_with("saved sign-in check"), "{err}");
    }
}
