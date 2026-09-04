//! Test-only gates over the shipped desktop configuration.
//!
//! `Server/invariants` never walks outside `Server/`, and no lint reaches
//! `tauri.conf.json`, so `cargo test --lib` (a required CI context) is the only
//! place a rule about the desktop bundle can be enforced at all.
//!
//! Scope, stated honestly: these cover the **Rust backend and the updater
//! block**, not the whole client. The webview does contact third parties on
//! purpose — YouTube thumbnails and OG previews (`src/components/message-list/`,
//! and the `frame-src`/`connect-src` entries in `tauri.conf.json`'s CSP), which
//! `Cargo.toml`'s note on `tauri-plugin-http` describes. What these gates hold
//! is narrower and still worth holding: the Rust side, which owns the TOFU
//! certificate pins and the update channel, names no remote of its own.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

const TAURI_CONF: &str = include_str!("../tauri.conf.json");

/// The updater endpoint list must stay empty.
///
/// Update checks are configured at runtime from the signed-in server's URL
/// (`update_commands::build_update_endpoint`), so a static endpoint here would
/// be a second, unauthenticated update channel that every install polls --
/// exactly the shape a supply-chain compromise wants. Tauri treats a populated
/// list as authoritative, and nothing else in the tree would notice.
#[test]
fn updater_endpoints_are_empty() {
    let conf: Value = serde_json::from_str(TAURI_CONF).expect("tauri.conf.json is not valid JSON");

    // Resolve the path explicitly rather than defaulting to "absent means fine":
    // if the block is renamed or moved, this test must fail, not quietly find
    // nothing to check.
    let updater = conf
        .get("plugins")
        .and_then(|p| p.get("updater"))
        .expect("tauri.conf.json has no plugins.updater block; if the updater moved, move this test with it");
    let endpoints = updater
        .get("endpoints")
        .expect("plugins.updater has no `endpoints` key; the key must be present and empty")
        .as_array()
        .expect("plugins.updater.endpoints is not an array");

    assert!(
        endpoints.is_empty(),
        "plugins.updater.endpoints must stay empty: update checks go through the \
         signed-in server (see update_commands::build_update_endpoint). Found: {endpoints:?}"
    );
}

/// No third-party host may be hard-coded in the Rust backend.
///
/// Every remote the Rust side contacts is derived from the server URL the user
/// entered, and the TOFU proxies pin that host's certificate. A literal URL to
/// somebody else's host is either a hidden call home or a bypass of the pin,
/// and both are invisible in review once they are one line inside a 600-line
/// proxy. `build.rs` is scanned too: a build script runs on every developer and
/// CI machine and is the classic place to hide one.
///
/// Deliberately syntactic and deliberately narrow: it reads scheme-prefixed
/// host literals out of the source text and checks each against an allowlist.
/// Documentation and test hosts are allowed by suffix. A host that is not a
/// registrable name -- no dotted TLD, e.g. the single-label `http://x` in a
/// header-parsing fixture, or a host cut short by an interpolation such as
/// `format!("https://api.{domain}")` -- is ignored, because it names nobody.
/// IP literals are the exception: they resolve without a TLD, so a dotted quad
/// or a bracketed IPv6 address must be on the allowlist by name.
#[test]
fn no_third_party_host_literals_in_src() {
    let mut files = Vec::new();
    collect_rs(Path::new("src"), &mut files);
    let build_rs = PathBuf::from("build.rs");
    assert!(
        build_rs.is_file(),
        "build.rs is missing; it is part of this gate's subject (cwd is {:?})",
        std::env::current_dir()
    );
    files.push(build_rs);
    files.sort();
    assert!(
        files.len() > 1,
        "no .rs files found under src/; the gate would pass vacuously (cwd is {:?})",
        std::env::current_dir()
    );

    let mut offenders = BTreeSet::new();
    for path in &files {
        let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
        for (line_no, line) in text.lines().enumerate() {
            for host in hosts_in(line) {
                if !host_is_allowed(&host) {
                    offenders.insert(format!("{}:{}  {}", path.display(), line_no + 1, host));
                }
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "third-party host literal(s) in src-tauri; every remote must be derived \
         from the signed-in server URL:\n  {}",
        offenders.into_iter().collect::<Vec<_>>().join("\n  ")
    );
}

/// Hosts that name nobody: loopback, and the reserved documentation and test
/// names from RFC 2606 / RFC 6761.
const ALLOWED_EXACT: &[&str] = &[
    "127.0.0.1",
    "0.0.0.0",
    "[::1]",
    "localhost",
    "example.com",
    "example.org",
    "example.net",
];
const ALLOWED_SUFFIX: &[&str] = &[
    ".example.com",
    ".example.org",
    ".example.net",
    ".invalid",
    ".test",
    ".local",
    ".localhost",
];

fn host_is_allowed(host: &str) -> bool {
    if ALLOWED_EXACT.contains(&host)
        || ALLOWED_SUFFIX.iter().any(|s| host.ends_with(s))
        // 2001:db8::/32 is the IPv6 documentation range (RFC 3849) -- the
        // example.com of addresses.
        || host.starts_with("[2001:db8:")
    {
        return true;
    }
    // An IP literal resolves with no TLD, so it can never be waved through by
    // the registrability rule below -- it has to be named above or it is an
    // offender.
    if is_ip_literal(host) {
        return false;
    }
    !is_registrable(host)
}

/// A bracketed IPv6 address, or a dotted quad.
fn is_ip_literal(host: &str) -> bool {
    host.starts_with('[') || host.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// A name someone could own: at least one dot, and a last label that is a
/// plausible TLD. A single label (`wss://host` in a doc comment, `http://x` in
/// a header fixture) names nobody on the public internet.
fn is_registrable(host: &str) -> bool {
    let Some((_, tld)) = host.rsplit_once('.') else {
        return false;
    };
    tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic())
}

/// Collect `.rs` files under `dir`, recursively, unsorted. Panics rather than
/// skipping: a gate that cannot read its subject has failed, not passed.
fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = fs::read_dir(dir).unwrap_or_else(|e| panic!("read_dir {dir:?}: {e}"));
    for entry in entries {
        let path = entry.expect("read_dir entry").path();
        if path.is_dir() {
            collect_rs(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// Every lower-cased host that follows an `http`, `https`, `ws` or `wss` scheme
/// prefix in `line`, with userinfo and port removed.
///
/// `wss` is not optional here: the client's primary remote is a WebSocket
/// (`ws_proxy`, `tofu`, `livekit_proxy`), so a scanner that only knew about
/// `http(s)` would miss the one URL shape that matters most. Schemes are
/// matched case-insensitively -- `update_commands`'s own test table already
/// contains an `HTTPS://` literal.
fn hosts_in(line: &str) -> Vec<String> {
    const SCHEMES: [&str; 4] = ["https://", "http://", "wss://", "ws://"];
    let mut out = Vec::new();
    let mut i = 0;
    while i < line.len() {
        let rest = &line[i..];
        let matched = SCHEMES.iter().find(|s| {
            rest.len() >= s.len()
                && rest.is_char_boundary(s.len())
                && rest[..s.len()].eq_ignore_ascii_case(s)
        });
        let Some(scheme) = matched else {
            // Advance one char, not one byte: `line[i..]` must stay on a UTF-8
            // boundary or the slice panics on any non-ASCII source line.
            i += rest.chars().next().map_or(1, char::len_utf8);
            continue;
        };
        i += scheme.len();
        let authority: String = rest[scheme.len()..]
            .chars()
            .take_while(|c| {
                c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '@' | '[' | ']')
            })
            .collect();
        i += authority.len();
        if let Some(host) = host_of(&authority) {
            out.push(host);
        }
    }
    out
}

/// `user:pass@host:port` -> `host`. Splitting the port off at the LAST colon is
/// wrong for IPv6 (`[2001:db8::1]` has colons of its own), so a bracketed
/// address is taken whole.
fn host_of(authority: &str) -> Option<String> {
    let after_userinfo = authority.rsplit('@').next().unwrap_or(authority);
    let host = if after_userinfo.starts_with('[') {
        // Include the closing bracket; anything after it is a port.
        let end = after_userinfo.find(']')?;
        &after_userinfo[..=end]
    } else {
        after_userinfo.split(':').next().unwrap_or(after_userinfo)
    };
    if host.is_empty() {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

/// The extractor and the allowlist are the whole gate; if either stops seeing
/// hosts, the gate passes vacuously and says nothing.
#[test]
fn host_extraction_and_allowlist_hold() {
    // Extraction.
    assert_eq!(
        hosts_in("fetch(\"https://a.example.com:8443/x\")"),
        ["a.example.com"]
    );
    assert_eq!(
        hosts_in("a http://one.test b https://two.test c"),
        ["one.test", "two.test"]
    );
    assert_eq!(
        hosts_in("connect(\"WSS://Chat.Example.COM/ws\")"),
        ["chat.example.com"]
    );
    assert_eq!(
        hosts_in("\"https://user:pass@fake.example.com/x\""),
        ["fake.example.com"]
    );
    assert_eq!(
        hosts_in("\"https://[2001:db8::1]:8443/x\""),
        ["[2001:db8::1]"]
    );
    assert_eq!(hosts_in("\"wss://[::1]/socket\""), ["[::1]"]);
    // The shapes already in the tree that must NOT read as a host.
    assert!(hosts_in("if !trimmed.starts_with(\"https://\") {").is_empty());
    assert!(hosts_in("/// Extract the host from an https:// URL.").is_empty());
    // Non-ASCII on the line must not panic the byte walk.
    assert_eq!(
        hosts_in("// an em-dash \u{2014} then https://x.test"),
        ["x.test"]
    );

    // Allowlist. These are the calls the gate would have to get wrong to let a
    // real remote through, or to red the build over a fixture.
    for allowed in [
        "127.0.0.1",
        "[::1]",
        "localhost",
        "example.com",
        "chat.example.com",
        "anything.test",
        "x",    // single-label header fixture
        "api.", // cut short by an interpolation
    ] {
        assert!(host_is_allowed(allowed), "{allowed} should be allowed");
    }
    // Written bare, with no scheme: `hosts_in` only yields scheme-prefixed
    // hosts, so these fixtures cannot trip the gate that scans this very file.
    for blocked in [
        "evil-corp.io",
        "notexample.com",
        "telemetry.acme.co.uk",
        "my_host.evil.com",
        "[2606:4700::1111]",
        "203.0.113.7",
    ] {
        assert!(!host_is_allowed(blocked), "{blocked} should be blocked");
    }
}
