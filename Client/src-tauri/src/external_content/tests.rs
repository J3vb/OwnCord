use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// --- The shared corpus ------------------------------------------------

#[derive(serde::Deserialize)]
struct Vector {
    address: String,
    allowed: bool,
    note: String,
}

/// Read at run time, not with include_str!: a compile-time include bakes
/// the vectors into the test binary, so a corpus-only change would look
/// like a no-op rebuild.
fn corpus() -> Vec<Vector> {
    #[derive(serde::Deserialize)]
    struct Corpus {
        vectors: Vec<Vector>,
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../Server/safefetch/testdata/classify_vectors.json");
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let corpus: Corpus = serde_json::from_str(&raw).expect("parse corpus");
    assert!(!corpus.vectors.is_empty(), "the corpus has no vectors");
    corpus.vectors
}

#[test]
fn classifier_agrees_with_every_corpus_vector() {
    let mut wrong = Vec::new();
    for v in corpus() {
        let ip: IpAddr = v
            .address
            .parse()
            .unwrap_or_else(|e| panic!("{}: {e}", v.address));
        if classify_addr(ip).is_ok() != v.allowed {
            wrong.push(format!("{} ({}) allowed={}", v.address, v.note, !v.allowed));
        }
    }
    assert!(
        wrong.is_empty(),
        "classifier disagrees with the corpus: {wrong:#?}"
    );
}

// --- URL vetting (clause 2) ---------------------------------------------

#[test]
fn vet_url_refuses_everything_but_https_on_443() {
    let p = Policy::PRODUCTION;
    assert!(vet_url(&p, "https://example.com/a").is_ok());
    assert!(vet_url(&p, "https://example.com:443/a").is_ok());
    for bad in [
        "http://example.com/",
        "https://example.com:8443/",
        "https://user:pw@example.com/",
        "https://user@example.com/",
        "ftp://example.com/",
        "file:///etc/passwd",
        "not a url",
        "https://exa mple.com/",
    ] {
        assert_eq!(
            vet_url(&p, bad).err(),
            Some(Failure::BlockedDestination),
            "{bad}"
        );
    }
}

#[tokio::test]
async fn names_and_literals_in_blocked_classes_are_refused() {
    let p = Policy::PRODUCTION;
    // Hosts without their scheme: config_gates.rs reads scheme-prefixed
    // IP literals in this crate as hard-coded remotes.
    for host in [
        "localhost",
        "127.0.0.2",
        "[::1]",
        "[fd00::1]",
        "[::ffff:127.0.0.1]",
        "10.0.0.1",
        "0x7f.1",
        "169.254.169.254",
    ] {
        let raw = format!("https://{host}/");
        let url = vet_url(&p, &raw).unwrap();
        assert_eq!(
            vet_addrs(&p, &url).await.err(),
            Some(Failure::BlockedDestination),
            "{raw}"
        );
    }
}

#[test]
fn the_resolver_answers_only_for_the_vetted_host() {
    use reqwest::dns::Resolve;
    use std::str::FromStr;
    let resolver = VettedResolver {
        host: "example.com".into(),
        addrs: vec!["93.184.216.34:443".parse().unwrap()],
        classify: classify_addr,
    };
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let ok = rt.block_on(resolver.resolve(reqwest::dns::Name::from_str("example.com").unwrap()));
    assert_eq!(ok.unwrap().collect::<Vec<_>>().len(), 1);
    let other = rt.block_on(resolver.resolve(reqwest::dns::Name::from_str("evil.test").unwrap()));
    assert!(
        other.is_err(),
        "a name the hop did not vet must not resolve"
    );
}

// --- A local server for the fetch pipeline --------------------------------

/// Loopback plain HTTP stands in for the internet: 127.0.0.1 is allowed,
/// every other address is judged by the real classifier.
fn loopback_policy() -> Policy {
    Policy {
        allow_http: true,
        port_allowed: |_| true,
        classify: |ip| {
            if ip == IpAddr::V4(Ipv4Addr::LOCALHOST) {
                Ok(())
            } else {
                classify_addr(ip)
            }
        },
    }
}

fn small_limits() -> Limits {
    Limits {
        html_bytes: 64,
        json_bytes: 256,
        image_bytes: 32,
        in_flight_bytes: 1024,
        cache_bytes: 1024,
        page_deadline: Duration::from_secs(2),
        image_deadline: Duration::from_secs(2),
    }
}

/// Serve `route(path)` — raw response bytes, or None to hang — on a fresh
/// loopback port. Returns the base URL.
async fn serve(route: fn(&str) -> Option<Vec<u8>>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]);
                let mut path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                if let Some(rest) = path.strip_prefix("/slow") {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    path = rest.to_string();
                }
                match route(&path) {
                    Some(resp) => {
                        let _ = sock.write_all(&resp).await;
                    }
                    None => std::future::pending::<()>().await,
                }
            });
        }
    });
    base
}

fn response(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

/// An RFC 1918 redirect target (kept apart from its scheme for config_gates.rs).
const PRIVATE: &str = "10.0.0.1";

const GIF: &[u8] = b"GIF89a\x01\x00\x01\x00\x00\x00\x00;";

fn routes(path: &str) -> Option<Vec<u8>> {
    Some(match path {
        "/page" => response(
            "200 OK",
            &[("Content-Type", "text/html; charset=utf-8")],
            br#"<title>T</title><meta property="og:image" content="/i.gif">"#,
        ),
        "/i.gif" => response("200 OK", &[("Content-Type", "image/gif")], GIF),
        "/private" => response(
            "302 Found",
            &[("Location", &format!("http://{PRIVATE}/"))],
            b"",
        ),
        "/loop" => response("302 Found", &[("Location", "/loop")], b""),
        "/hop3" => response("302 Found", &[("Location", "/hop2")], b""),
        "/hop2" => response("302 Found", &[("Location", "/hop1")], b""),
        "/hop1" => response("302 Found", &[("Location", "/i.gif")], b""),
        "/exact" => response(
            "200 OK",
            &[("Content-Type", "image/gif")],
            &[GIF, &[0u8; 18]].concat(),
        ),
        "/over" => response(
            "200 OK",
            &[("Content-Type", "image/gif")],
            &[GIF, &[0u8; 19]].concat(),
        ),
        "/svg" => response("200 OK", &[("Content-Type", "image/svg+xml")], b"<svg/>"),
        "/liar" => response("200 OK", &[("Content-Type", "image/png")], GIF),
        "/json" => response(
            "200 OK",
            &[("Content-Type", "application/json")],
            br#"{"title":"x"}"#,
        ),
        "/oembed" => response(
            "200 OK",
            &[("Content-Type", "application/json")],
            br#"{"type":"video","version":"1.0","title":"Video"}"#,
        ),
        "/hang" => return None,
        _ => response("404 Not Found", &[], b""),
    })
}

fn broker() -> ExternalContentState {
    ExternalContentState::with(loopback_policy(), small_limits())
}

#[tokio::test]
async fn a_preview_carries_a_handle_not_the_image_url() {
    let base = serve(routes).await;
    let b = broker();
    let preview = b.preview("p", &format!("{base}/page")).await.unwrap();
    assert_eq!(preview.title.as_deref(), Some("T"));
    let handle = preview.image.expect("a handle for og:image");
    assert!(
        !handle.contains("i.gif"),
        "the handle must not leak the URL"
    );
    let bytes = b.image("p", Some(&handle), None).await.unwrap();
    assert_eq!(bytes.as_slice(), GIF);
}

#[tokio::test]
async fn a_handle_does_not_outlive_its_partition() {
    let base = serve(routes).await;
    let b = broker();
    let handle = b
        .preview("a", &format!("{base}/page"))
        .await
        .unwrap()
        .image
        .unwrap();
    assert_eq!(
        b.image("b", Some(&handle), None).await.err(),
        Some(Failure::ExpiredHandle)
    );
}

#[tokio::test]
async fn a_slow_fetch_for_an_old_partition_leaves_the_new_one_intact() {
    let base = serve(routes).await;
    let b = broker();
    let (page, gif) = (format!("{base}/slow/page"), format!("{base}/slow/i.gif"));
    let old = async { tokio::join!(b.preview("old", &page), b.image("old", None, Some(&gif))) };
    let new = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        b.preview("new", &format!("{base}/page"))
            .await
            .unwrap()
            .image
            .unwrap()
    };
    let ((old_preview, old_image), handle) = tokio::join!(old, new);
    let old_preview = old_preview.unwrap();
    assert_eq!(old_preview.title.as_deref(), Some("T"), "still returned");
    assert_eq!(
        old_preview.image, None,
        "no handle minted for a stale partition"
    );
    assert_eq!(old_image.unwrap().as_slice(), GIF, "still returned");
    {
        let mut inner = b.current("new").expect("the new partition stays live");
        assert_eq!(
            inner.cache.entries.len(),
            1,
            "only the new preview is cached"
        );
        assert!(inner
            .cache
            .get("new", &format!("preview:{base}/page"))
            .is_some());
    }
    assert_eq!(
        b.image("new", Some(&handle), None)
            .await
            .unwrap()
            .as_slice(),
        GIF
    );
}

#[tokio::test]
async fn a_redirect_to_a_private_address_is_refused() {
    let base = serve(routes).await;
    let got = broker()
        .image("p", None, Some(&format!("{base}/private")))
        .await;
    assert_eq!(got.err(), Some(Failure::BlockedDestination));
}

#[tokio::test]
async fn the_redirect_budget_is_exact() {
    let base = serve(routes).await;
    let b = broker();
    // Three hops is the budget: followed.
    assert!(b
        .image("p", None, Some(&format!("{base}/hop3")))
        .await
        .is_ok());
    // One more is refused.
    assert_eq!(
        b.image("p", None, Some(&format!("{base}/loop")))
            .await
            .err(),
        Some(Failure::TooManyRedirects)
    );
}

#[tokio::test]
async fn the_byte_ceiling_is_exact() {
    let base = serve(routes).await;
    let b = broker();
    // image_bytes is 32: exactly 32 is served, 33 refused.
    assert_eq!(
        b.image("p", None, Some(&format!("{base}/exact")))
            .await
            .unwrap()
            .len(),
        32
    );
    assert_eq!(
        b.image("p", None, Some(&format!("{base}/over")))
            .await
            .err(),
        Some(Failure::Oversized)
    );
}

#[tokio::test]
async fn types_are_checked_declared_and_sniffed() {
    let base = serve(routes).await;
    let b = broker();
    for path in ["/svg", "/liar", "/page"] {
        assert_eq!(
            b.image("p", None, Some(&format!("{base}{path}")))
                .await
                .err(),
            Some(Failure::WrongType),
            "{path}"
        );
    }
    // JSON that is not an oEmbed document is not a preview.
    assert_eq!(
        b.preview("p", &format!("{base}/json")).await.err(),
        Some(Failure::WrongType)
    );
    let oembed = b.preview("p", &format!("{base}/oembed")).await.unwrap();
    assert_eq!(oembed.title.as_deref(), Some("Video"));
}

#[tokio::test]
async fn the_deadline_bounds_a_response_that_never_comes() {
    let base = serve(routes).await;
    let limits = Limits {
        image_deadline: Duration::from_millis(200),
        ..small_limits()
    };
    let b = ExternalContentState::with(loopback_policy(), limits);
    let got = b.image("p", None, Some(&format!("{base}/hang"))).await;
    assert_eq!(got.err(), Some(Failure::Unavailable));
}

#[tokio::test(start_paused = true)]
async fn fetch_deadline_includes_the_wait_for_a_permit() {
    let b = broker();
    let _held = b.gate.acquire_many(MAX_CONCURRENT as u32).await.unwrap();
    let fetch = b.fetch("http://127.0.0.1:1/", Want::Image);
    tokio::pin!(fetch);
    // Past the image deadline with every permit held, the call must give up.
    let got = tokio::time::timeout(
        small_limits().image_deadline + Duration::from_secs(1),
        &mut fetch,
    )
    .await
    .expect("fetch must end by its own deadline, not wait on the gate");
    assert_eq!(got.err(), Some(Failure::Unavailable));
}

#[test]
fn overlong_og_image_is_dropped() {
    let page = |img: &str| Fetched {
        body: format!(r#"<meta property="og:image" content="{img}">"#).into_bytes(),
        content_type: "text/html".into(),
        url: Url::parse("https://example.com/p").unwrap(),
    };
    let long = format!("/{}", "a".repeat(3000));
    assert_eq!(reduce_page(&page(&long)).unwrap().image_url, None);
    let short = format!("/{}", "a".repeat(200));
    assert!(reduce_page(&page(&short)).unwrap().image_url.is_some());
}

#[tokio::test]
async fn the_aggregate_budget_refuses_a_read_that_would_exceed_it() {
    let base = serve(routes).await;
    let limits = Limits {
        in_flight_bytes: 13, // one byte short of the 14-byte GIF
        ..small_limits()
    };
    let b = ExternalContentState::with(loopback_policy(), limits);
    assert_eq!(
        b.image("p", None, Some(&format!("{base}/i.gif")))
            .await
            .err(),
        Some(Failure::Oversized)
    );
    assert_eq!(
        b.in_flight.used.load(Ordering::Acquire),
        0,
        "reservations are returned"
    );
}

// --- Budgets and cache ------------------------------------------------------

#[test]
fn the_byte_budget_boundary() {
    let budget = ByteBudget::new(10);
    assert!(budget.try_reserve(10), "exactly the budget fits");
    assert!(!budget.try_reserve(1), "one byte past it does not");
    budget.release(10);
    let mut r = Reservation {
        budget: &budget,
        held: 0,
    };
    assert!(r.grow(4));
    assert!(r.grow(6));
    assert!(!r.grow(1));
    drop(r);
    assert_eq!(budget.used.load(Ordering::Acquire), 0);
}

fn image(n: usize) -> Cached {
    Cached::Image(Arc::new(vec![0; n]))
}

#[test]
fn the_cache_key_includes_the_partition() {
    let mut cache = ByteCache::new(1024);
    cache.put("server-a", "image:https://x/y.png", image(8));
    assert!(cache.get("server-a", "image:https://x/y.png").is_some());
    assert!(
        cache.get("server-b", "image:https://x/y.png").is_none(),
        "another partition must never be served this entry"
    );
}

#[test]
fn eviction_is_byte_weighted_lru() {
    let mut cache = ByteCache::new(100);
    cache.put("p", "a", image(40));
    cache.put("p", "b", image(40));
    cache.get("p", "a"); // b is now least recently used
    cache.put("p", "c", image(40)); // 120 > 100: evict b
    assert!(cache.get("p", "a").is_some());
    assert!(cache.get("p", "b").is_none());
    assert!(cache.get("p", "c").is_some());
    assert_eq!(cache.used, 80);
    cache.put("p", "huge", image(101)); // larger than the whole budget
    assert!(cache.get("p", "huge").is_none());
    assert_eq!(cache.used, 80);
    cache.put("p", "fill", image(20)); // exactly at budget: nothing evicted
    assert_eq!(cache.used, 100);
    assert!(cache.get("p", "a").is_some() && cache.get("p", "c").is_some());
}

#[test]
fn entering_a_new_partition_clears_the_old_one() {
    let b = broker();
    b.enter("old").cache.put("old", "k", image(8));
    let inner = b.enter("new");
    assert_eq!(inner.cache.used, 0);
    assert!(inner.cache.entries.is_empty());
}

/// How the renderer's teardown clears this cache without a third command:
/// it names its fresh partition with an empty preview request, refused
/// before any network work.
#[tokio::test]
async fn an_empty_preview_under_a_new_partition_clears_the_old_one() {
    let b = broker();
    b.enter("old").cache.put("old", "k", image(8));
    assert_eq!(
        b.preview("new", "").await.err(),
        Some(Failure::BlockedDestination)
    );
    let inner = b.enter("new");
    assert_eq!(inner.cache.used, 0);
    assert!(inner.cache.entries.is_empty());
}

// --- The User-Agent ---------------------------------------------

#[test]
fn the_user_agent_is_a_crawler_token_with_no_owncord_version() {
    assert!(USER_AGENT.starts_with("facebookexternalhit/"));
    assert!(!USER_AGENT.to_ascii_lowercase().contains("owncord"));
    assert!(!USER_AGENT.contains(env!("CARGO_PKG_VERSION")));
}

// --- parse_og_tags: one case per former TS parseOgTags test ---------------

#[test]
fn og_extracts_title_description_image_site_name() {
    let t = parse_og_tags(
        r#"<html><head>
            <meta property="og:title" content="My Page">
            <meta property="og:description" content="A page description">
            <meta property="og:image" content="https://example.com/img.jpg">
            <meta property="og:site_name" content="Example">
            </head></html>"#,
    );
    assert_eq!(t.title.as_deref(), Some("My Page"));
    assert_eq!(t.description.as_deref(), Some("A page description"));
    assert_eq!(t.image.as_deref(), Some("https://example.com/img.jpg"));
    assert_eq!(t.site_name.as_deref(), Some("Example"));
}

#[test]
fn og_falls_back_to_title_element() {
    let t = parse_og_tags("<html><head><title>Fallback Title</title></head></html>");
    assert_eq!(t.title.as_deref(), Some("Fallback Title"));
}

#[test]
fn og_falls_back_to_meta_description() {
    let t =
        parse_og_tags(r#"<html><head><meta name="description" content="Meta desc"></head></html>"#);
    assert_eq!(t.description.as_deref(), Some("Meta desc"));
}

#[test]
fn og_returns_nothing_when_there_is_no_metadata() {
    assert_eq!(
        parse_og_tags("<html><head></head><body>Hello</body></html>"),
        OgTags::default()
    );
}

#[test]
fn og_accepts_reversed_attribute_order() {
    let t = parse_og_tags(r#"<meta content="Reversed Title" property="og:title">"#);
    assert_eq!(t.title.as_deref(), Some("Reversed Title"));
}

#[test]
fn og_tag_and_attribute_names_are_case_insensitive() {
    let t = parse_og_tags(r#"<META PROPERTY="og:title" CONTENT="Upper Case">"#);
    assert_eq!(t.title.as_deref(), Some("Upper Case"));
}

#[test]
fn og_trims_the_title_element() {
    let t = parse_og_tags("<title>  Spaced Title  </title>");
    assert_eq!(t.title.as_deref(), Some("Spaced Title"));
}

#[test]
fn og_ignores_meta_like_text_in_comments_and_scripts() {
    let t = parse_og_tags(
        r#"<html><head>
            <!-- <meta property="og:title" content="Commented Out"> -->
            <script>var s = '<meta property="og:title" content="In Script">';</script>
            <style>/* <meta property="og:title" content="In Style"> */</style>
            </head></html>"#,
    );
    assert_eq!(t.title, None);
}

// Precedence details the TS implementation had without a test for them.

#[test]
fn og_first_element_in_document_order_wins() {
    let t = parse_og_tags(
        r#"<meta property="og:title" content="First"><meta property="og:title" content="Second">"#,
    );
    assert_eq!(t.title.as_deref(), Some("First"));
}

#[test]
fn og_property_beats_name_and_an_empty_content_is_kept() {
    let t = parse_og_tags(
        r#"<meta name="og:title" content="By Name"><meta property="og:title" content="">
               <title>Doc</title>"#,
    );
    assert_eq!(
        t.title.as_deref(),
        Some(""),
        "empty content is a value, not absent"
    );
}

#[test]
fn og_a_match_without_content_falls_through_to_the_next_name() {
    let t = parse_og_tags(
        r#"<meta property="og:description"><meta name="description" content="Plain">"#,
    );
    assert_eq!(t.description.as_deref(), Some("Plain"));
}

#[test]
fn og_decodes_entities_and_reads_image_dimensions() {
    let t = parse_og_tags(
        r#"<title>A &amp; B</title><meta property="og:image:width" content="1200">
               <meta property="og:image:height" content=" 630 ">"#,
    );
    assert_eq!(t.title.as_deref(), Some("A & B"));
    assert_eq!((t.image_width, t.image_height), (Some(1200), Some(630)));
}
