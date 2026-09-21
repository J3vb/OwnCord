// The desktop external-content broker (B7-16) — docs/trust-model.md, C-09.
//
// Every automatic fetch of content a message author (or a fetched page) named
// comes through here: link previews, oEmbed titles, OG images, inline images,
// GIFs, external avatars. The renderer gets no HTTP client for any of it
// (clause 1); it asks for a typed minimum and gets one:
//
//   parse     — https on 443 only, no embedded credentials (clause 2);
//   resolve   — every A/AAAA answer, each classified with the full
//               Server/safefetch list; one bad answer refuses the hop (3);
//   dial      — only the vetted addresses, hostname kept for SNI and the
//               certificate check; the resolver fails closed for any other
//               name, so nothing is looked up twice (4);
//   redirects — never automatic; at most MAX_REDIRECTS followed by hand, each
//               hop re-running parse/resolve/classify (5);
//   bounds    — a total deadline, a streaming byte ceiling, a content-type
//               allowlist checked against the sniffed type for images, a
//               concurrency cap, and a process-wide in-flight byte budget (6);
//   output    — title/description/site name/dimensions and an opaque image
//               handle; never a status, header, body or remote image URL (7).
//
// The Go classifier (Server/safefetch/classify.go) is the specification. The
// two lists share no code, so they share a test corpus instead:
// Server/safefetch/testdata/classify_vectors.json, read by both suites.
//
// The server's own files (attachments, avatars, emoji) are NOT fetched here —
// they keep the cert-pinned TOFU proxy (http_proxy.rs). The two paths have
// opposite trust models, and there is deliberately no "is this the server?"
// branch in this file.

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::Semaphore;
use url::{Host, Url};

// --- Policy constants --------------------------------------------------------

/// A known-crawler User-Agent: some sites serve Open Graph tags only to
/// crawlers they recognise, and preview coverage is the priority (B7-16
/// Decision 2, the owner's ruling). It must never carry an OwnCord version —
/// every preview goes from the viewer's machine to a host the message author
/// chose, and a version string would pair each viewer's IP with their build.
/// The bare product token is what sites match on; the crawler's "+URL"
/// comment is left off because config_gates.rs forbids third-party host
/// literals in this crate, and a site keying on the token does not need it.
const USER_AGENT: &str = "facebookexternalhit/1.1";

/// Redirects followed by hand before the fetch is refused.
const MAX_REDIRECTS: usize = 3;
/// Concurrent broker fetches across the whole process.
const MAX_CONCURRENT: usize = 6;

/// Every limit a fetch is bounded by. Production uses `Limits::PRODUCTION`;
/// tests shrink them to hit the boundaries without megabytes of fixtures.
#[derive(Clone, Copy)]
struct Limits {
    /// How much of an HTML page is read and parsed. Past this the read stops
    /// and the prefix is parsed — the old renderer's 50 000-char slice.
    html_bytes: usize,
    /// An oEmbed document larger than this is refused.
    json_bytes: usize,
    /// An image larger than this is refused.
    image_bytes: usize,
    /// Bytes all in-flight fetches may hold at once (B5 decision 2's
    /// aggregate cross-caller budget).
    in_flight_bytes: usize,
    /// Bytes the result cache may hold; eviction is byte-weighted LRU.
    cache_bytes: usize,
    page_deadline: Duration,
    image_deadline: Duration,
}

impl Limits {
    const PRODUCTION: Limits = Limits {
        html_bytes: 50_000,
        json_bytes: 64 * 1024,
        image_bytes: 16 * 1024 * 1024,
        in_flight_bytes: 64 * 1024 * 1024,
        cache_bytes: 64 * 1024 * 1024,
        page_deadline: Duration::from_secs(5),
        image_deadline: Duration::from_secs(15),
    };
}

/// Raster types an image fetch may return, by sniffed signature. SVG is
/// absent on purpose: it is the one image type that can carry script.
const IMAGE_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/bmp",
];

// --- Failures ------------------------------------------------------------------

/// The refusal classes the renderer can tell apart. Anything more specific
/// stays in the log: the reason a destination was refused is not something
/// message-controlled code gets to read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    BlockedDestination,
    TooManyRedirects,
    Oversized,
    WrongType,
    Unavailable,
}

impl Failure {
    /// The wire spelling — `ExternalContentFailure` in
    /// Client/src/platform/contracts/externalContent.ts.
    pub fn as_str(self) -> &'static str {
        match self {
            Failure::BlockedDestination => "blocked-destination",
            Failure::TooManyRedirects => "too-many-redirects",
            Failure::Oversized => "oversized",
            Failure::WrongType => "wrong-type",
            Failure::Unavailable => "unavailable",
        }
    }
}

// --- Classifier (clause 3) ----------------------------------------------------

/// Server/safefetch/classify.go's `blockedPrefixes`, IPv4 half, row for row.
const BLOCKED_V4: &[([u8; 4], u8, &str)] = &[
    ([0, 0, 0, 0], 8, "this-network (RFC1122)"),
    ([10, 0, 0, 0], 8, "private (RFC1918)"),
    ([100, 64, 0, 0], 10, "carrier-grade NAT (RFC6598)"),
    ([127, 0, 0, 0], 8, "loopback"),
    ([169, 254, 0, 0], 16, "link-local (RFC3927)"),
    ([172, 16, 0, 0], 12, "private (RFC1918)"),
    ([192, 0, 0, 0], 24, "IETF protocol assignments (RFC6890)"),
    ([192, 0, 2, 0], 24, "documentation TEST-NET-1 (RFC5737)"),
    (
        [192, 88, 99, 0],
        24,
        "deprecated 6to4 relay anycast (RFC7526)",
    ),
    ([192, 168, 0, 0], 16, "private (RFC1918)"),
    ([198, 18, 0, 0], 15, "benchmarking (RFC2544)"),
    ([198, 51, 100, 0], 24, "documentation TEST-NET-2 (RFC5737)"),
    ([203, 0, 113, 0], 24, "documentation TEST-NET-3 (RFC5737)"),
    ([224, 0, 0, 0], 4, "multicast (RFC5771)"),
    (
        [240, 0, 0, 0],
        4,
        "reserved (RFC1112), including the limited broadcast address",
    ),
];

/// The IPv6 half. IPv4-mapped addresses never reach it: `classify_addr`
/// unmaps first, so ::ffff:10.0.0.1 is judged as 10.0.0.1.
const BLOCKED_V6: &[([u16; 8], u8, &str)] = &[
    ([0, 0, 0, 0, 0, 0, 0, 0], 128, "unspecified"),
    ([0, 0, 0, 0, 0, 0, 0, 1], 128, "loopback"),
    (
        [0x64, 0xff9b, 1, 0, 0, 0, 0, 0],
        48,
        "local-use IPv4/IPv6 translation (RFC8215)",
    ),
    ([0x100, 0, 0, 0, 0, 0, 0, 0], 64, "discard-only (RFC6666)"),
    (
        [0x2001, 0, 0, 0, 0, 0, 0, 0],
        23,
        "IETF protocol assignments, including Teredo and IPv6 benchmarking (RFC2928)",
    ),
    ([0x2001, 0x20, 0, 0, 0, 0, 0, 0], 28, "ORCHIDv2 (RFC7343)"),
    (
        [0xfec0, 0, 0, 0, 0, 0, 0, 0],
        10,
        "deprecated site-local (RFC3879)",
    ),
    (
        [0, 0, 0, 0, 0, 0, 0, 0],
        96,
        "deprecated IPv4-compatible (RFC4291)",
    ),
    (
        [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0],
        32,
        "documentation (RFC3849)",
    ),
    ([0x2002, 0, 0, 0, 0, 0, 0, 0], 16, "6to4 (RFC3056)"),
    ([0x3fff, 0, 0, 0, 0, 0, 0, 0], 20, "documentation (RFC9637)"),
    (
        [0x5f00, 0, 0, 0, 0, 0, 0, 0],
        16,
        "SRv6 segment routing (RFC9602)",
    ),
    ([0xfc00, 0, 0, 0, 0, 0, 0, 0], 7, "unique local (RFC4193)"),
    ([0xfe80, 0, 0, 0, 0, 0, 0, 0], 10, "link-local (RFC4291)"),
    ([0xff00, 0, 0, 0, 0, 0, 0, 0], 8, "multicast (RFC4291)"),
];

/// RFC 6052's well-known NAT64 prefix, 64:ff9b::/96 — unwrapped, not blocked:
/// the embedded IPv4 address is what a translator delivers to, so that is
/// what gets classified (see classify.go's `nat64WellKnown`).
const NAT64_WELL_KNOWN: ([u16; 8], u8) = ([0x64, 0xff9b, 0, 0, 0, 0, 0, 0], 96);

fn v4_in(addr: Ipv4Addr, net: [u8; 4], len: u8) -> bool {
    let mask = if len == 0 { 0 } else { u32::MAX << (32 - len) };
    u32::from(addr) & mask == u32::from(Ipv4Addr::from(net)) & mask
}

fn v6_in(addr: Ipv6Addr, net: [u16; 8], len: u8) -> bool {
    let mask = if len == 0 {
        0
    } else {
        u128::MAX << (128 - len)
    };
    u128::from(addr) & mask == u128::from(Ipv6Addr::from(net)) & mask
}

/// `Ok` when `ip` is a globally routable unicast address the broker may dial,
/// otherwise the reason it is refused. The Rust twin of `safefetch.ClassifyAddr`.
pub fn classify_addr(ip: IpAddr) -> Result<(), &'static str> {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => {
            // Unmap before anything else, or every IPv4 rule is bypassed by
            // respelling the address as ::ffff:a.b.c.d.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return classify_v4(v4);
            }
            if v6_in(v6, NAT64_WELL_KNOWN.0, NAT64_WELL_KNOWN.1) {
                let embedded = Ipv4Addr::from((u128::from(v6) & 0xffff_ffff) as u32);
                return classify_v4(embedded);
            }
            for (net, len, why) in BLOCKED_V6 {
                if v6_in(v6, *net, *len) {
                    return Err(why);
                }
            }
            // Belt and braces, as in classify.go: the std predicates catch the
            // same classes from another angle.
            if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
                return Err("not global unicast");
            }
            Ok(())
        }
    }
}

fn classify_v4(v4: Ipv4Addr) -> Result<(), &'static str> {
    for (net, len, why) in BLOCKED_V4 {
        if v4_in(v4, *net, *len) {
            return Err(why);
        }
    }
    if v4.is_loopback()
        || v4.is_unspecified()
        || v4.is_multicast()
        || v4.is_link_local()
        || v4.is_private()
        || v4.is_broadcast()
    {
        return Err("not global unicast");
    }
    Ok(())
}

// --- Destination policy (clauses 2–4) -----------------------------------------

/// What a hop may be. Production is `Policy::PRODUCTION`; the only other
/// policies are in this file's tests, which need plain HTTP on loopback to
/// run a local server.
#[derive(Clone, Copy)]
struct Policy {
    allow_http: bool,
    port_allowed: fn(u16) -> bool,
    classify: fn(IpAddr) -> Result<(), &'static str>,
}

impl Policy {
    const PRODUCTION: Policy = Policy {
        allow_http: false,
        port_allowed: |port| port == 443,
        classify: classify_addr,
    };
}

/// Parse `raw` and refuse it unless it is a permitted scheme and port with a
/// host and no embedded credentials.
fn vet_url(policy: &Policy, raw: &str) -> Result<Url, Failure> {
    let url = Url::parse(raw).map_err(|_| Failure::BlockedDestination)?;
    let scheme_ok = url.scheme() == "https" || (policy.allow_http && url.scheme() == "http");
    if !scheme_ok || !url.username().is_empty() || url.password().is_some() {
        return Err(Failure::BlockedDestination);
    }
    let port = url
        .port_or_known_default()
        .ok_or(Failure::BlockedDestination)?;
    if url.host().is_none() || !(policy.port_allowed)(port) {
        return Err(Failure::BlockedDestination);
    }
    Ok(url)
}

/// Resolve the hop's host and classify every answer. An IP literal is
/// classified directly and never resolved.
async fn vet_addrs(policy: &Policy, url: &Url) -> Result<Vec<SocketAddr>, Failure> {
    let port = url
        .port_or_known_default()
        .ok_or(Failure::BlockedDestination)?;
    let addrs: Vec<SocketAddr> = match url.host() {
        Some(Host::Ipv4(ip)) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
        Some(Host::Ipv6(ip)) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
        Some(Host::Domain(name)) => tokio::net::lookup_host((name, port))
            .await
            .map_err(|_| Failure::Unavailable)?
            .collect(),
        None => return Err(Failure::BlockedDestination),
    };
    if addrs.is_empty() {
        return Err(Failure::Unavailable);
    }
    // Every answer, not the first that works: one poisoned record among ten
    // refuses the request, or an attacker retries until ordering favours them.
    for addr in &addrs {
        if let Err(why) = (policy.classify)(addr.ip()) {
            log::debug!(
                "[external_content] refused {}: {} is {}",
                url.host_str().unwrap_or(""),
                addr.ip(),
                why
            );
            return Err(Failure::BlockedDestination);
        }
    }
    Ok(addrs)
}

/// The client's only resolver: it answers for the one host this hop vetted,
/// with exactly the addresses that were vetted, and fails closed for any
/// other name. There is no second, unconstrained lookup to rebind.
struct VettedResolver {
    host: String,
    addrs: Vec<SocketAddr>,
    classify: fn(IpAddr) -> Result<(), &'static str>,
}

impl reqwest::dns::Resolve for VettedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let answer = if name.as_str() == self.host
            && self.addrs.iter().all(|a| (self.classify)(a.ip()).is_ok())
        {
            let addrs: reqwest::dns::Addrs = Box::new(self.addrs.clone().into_iter());
            Ok(addrs)
        } else {
            Err(format!("{} was not vetted for this hop", name.as_str()).into())
        };
        Box::pin(std::future::ready(answer))
    }
}

// --- Budgets and cache (clause 6, B5 decision 2) ------------------------------

/// A process-wide byte budget shared by every in-flight fetch: a reader
/// reserves each chunk before keeping it, and a read that would take the
/// total past the limit is refused rather than queued.
struct ByteBudget {
    limit: usize,
    used: AtomicUsize,
}

impl ByteBudget {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            used: AtomicUsize::new(0),
        }
    }

    fn try_reserve(&self, n: usize) -> bool {
        self.used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(n).filter(|total| *total <= self.limit)
            })
            .is_ok()
    }

    fn release(&self, n: usize) {
        self.used.fetch_sub(n, Ordering::AcqRel);
    }
}

/// What one fetch holds against the budget; returned to it on drop.
struct Reservation<'a> {
    budget: &'a ByteBudget,
    held: usize,
}

impl Reservation<'_> {
    fn grow(&mut self, n: usize) -> bool {
        if !self.budget.try_reserve(n) {
            return false;
        }
        self.held += n;
        true
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        self.budget.release(self.held);
    }
}

/// A fetched page reduced to the fields a preview may carry. Cached with the
/// image URL; the handle the renderer sees is minted per answer.
#[derive(Clone, Debug, Default, PartialEq)]
struct PreviewData {
    title: Option<String>,
    description: Option<String>,
    site_name: Option<String>,
    image_url: Option<String>,
    image_width: Option<u32>,
    image_height: Option<u32>,
}

impl PreviewData {
    fn weight(&self) -> usize {
        64 + [
            &self.title,
            &self.description,
            &self.site_name,
            &self.image_url,
        ]
        .iter()
        .map(|s| s.as_ref().map_or(0, String::len))
        .sum::<usize>()
    }
}

#[derive(Clone)]
enum Cached {
    Preview(PreviewData),
    Image(Arc<Vec<u8>>),
}

impl Cached {
    fn weight(&self) -> usize {
        match self {
            Cached::Preview(p) => p.weight(),
            Cached::Image(bytes) => bytes.len(),
        }
    }
}

/// Byte-weighted LRU keyed by (partition, kind + URL). The partition is part
/// of the key, not a filter on the way out, so one server's previews can
/// never answer for another's.
struct ByteCache {
    budget: usize,
    used: usize,
    tick: u64,
    entries: HashMap<(String, String), (Cached, u64)>,
}

impl ByteCache {
    fn new(budget: usize) -> Self {
        Self {
            budget,
            used: 0,
            tick: 0,
            entries: HashMap::new(),
        }
    }

    fn get(&mut self, partition: &str, key: &str) -> Option<Cached> {
        self.tick += 1;
        let tick = self.tick;
        let entry = self
            .entries
            .get_mut(&(partition.to_string(), key.to_string()))?;
        entry.1 = tick;
        Some(entry.0.clone())
    }

    fn put(&mut self, partition: &str, key: &str, value: Cached) {
        let weight = value.weight();
        if weight > self.budget {
            return;
        }
        self.tick += 1;
        if let Some((old, _)) = self
            .entries
            .insert((partition.to_string(), key.to_string()), (value, self.tick))
        {
            self.used -= old.weight();
        }
        self.used += weight;
        // ponytail: O(n) scan for the least-recently-used entry per eviction;
        // the budget holds at most a few thousand entries. Use an ordered
        // index if the entry count ever grows by orders of magnitude.
        while self.used > self.budget {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, (_, tick))| *tick)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some((evicted, _)) = self.entries.remove(&oldest) {
                self.used -= evicted.weight();
            }
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.used = 0;
    }
}

/// Opaque image handles minted for preview answers. A handle names a vetted
/// URL without handing the URL to the renderer (clause 7).
struct Handles {
    next: u64,
    by_id: HashMap<String, String>,
    order: VecDeque<String>,
}

/// Handles kept before the oldest is forgotten; a forgotten handle's image
/// is simply unavailable, and the renderer re-asks for the preview.
const MAX_HANDLES: usize = 4096;

impl Handles {
    fn new() -> Self {
        Self {
            next: 0,
            by_id: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn mint(&mut self, url: String) -> String {
        self.next += 1;
        let id = format!("h{:x}", self.next);
        self.by_id.insert(id.clone(), url);
        self.order.push_back(id.clone());
        if self.order.len() > MAX_HANDLES {
            if let Some(old) = self.order.pop_front() {
                self.by_id.remove(&old);
            }
        }
        id
    }

    fn clear(&mut self) {
        self.by_id.clear();
        self.order.clear();
    }
}

struct Partitioned {
    partition: String,
    cache: ByteCache,
    handles: Handles,
}

// --- The broker -------------------------------------------------------------------

/// The answer to `external_preview`: the typed minimum, nothing else.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPreview {
    title: Option<String>,
    description: Option<String>,
    site_name: Option<String>,
    image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_height: Option<u32>,
}

#[derive(Clone, Copy, PartialEq)]
enum Want {
    Page,
    Image,
}

struct Fetched {
    body: Vec<u8>,
    content_type: String,
    url: Url,
}

pub struct ExternalContentState {
    policy: Policy,
    limits: Limits,
    gate: Semaphore,
    in_flight: ByteBudget,
    inner: Mutex<Partitioned>,
}

impl ExternalContentState {
    pub fn new() -> Self {
        Self::with(Policy::PRODUCTION, Limits::PRODUCTION)
    }

    fn with(policy: Policy, limits: Limits) -> Self {
        Self {
            policy,
            limits,
            gate: Semaphore::new(MAX_CONCURRENT),
            in_flight: ByteBudget::new(limits.in_flight_bytes),
            inner: Mutex::new(Partitioned {
                partition: String::new(),
                cache: ByteCache::new(limits.cache_bytes),
                handles: Handles::new(),
            }),
        }
    }

    /// Lock the partitioned state, switching to `partition` first. Only one
    /// partition is live at a time (the renderer shows one server): naming a
    /// new one drops everything the previous partition cached, which is how a
    /// renderer teardown — it moves to a fresh partition — clears this cache.
    fn enter(&self, partition: &str) -> std::sync::MutexGuard<'_, Partitioned> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.partition != partition {
            inner.cache.clear();
            inner.handles.clear();
            inner.partition = partition.to_string();
        }
        inner
    }

    /// Lock the partitioned state only if `partition` is still the live one.
    /// A request that awaited the network may find a newer partition named in
    /// the meantime; it must drop its result, never switch back and evict it.
    fn current(&self, partition: &str) -> Option<std::sync::MutexGuard<'_, Partitioned>> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        (inner.partition == partition).then_some(inner)
    }

    pub async fn preview(&self, partition: &str, url: &str) -> Result<ExternalPreview, Failure> {
        let key = format!("preview:{url}");
        let cached = self.enter(partition).cache.get(partition, &key);
        let data = match cached {
            Some(Cached::Preview(data)) => data,
            _ => {
                let fetched = self.fetch(url, Want::Page).await?;
                let data = reduce_page(&fetched)?;
                if let Some(mut inner) = self.current(partition) {
                    inner
                        .cache
                        .put(partition, &key, Cached::Preview(data.clone()));
                }
                data
            }
        };
        let image = match (data.image_url, self.current(partition)) {
            (Some(u), Some(mut inner)) => Some(inner.handles.mint(u)),
            _ => None,
        };
        Ok(ExternalPreview {
            title: data.title,
            description: data.description,
            site_name: data.site_name,
            image,
            image_width: data.image_width,
            image_height: data.image_height,
        })
    }

    pub async fn image(
        &self,
        partition: &str,
        handle: Option<&str>,
        url: Option<&str>,
    ) -> Result<Arc<Vec<u8>>, Failure> {
        let target = match (handle, url) {
            (Some(h), None) => self
                .enter(partition)
                .handles
                .by_id
                .get(h)
                .cloned()
                .ok_or(Failure::Unavailable)?,
            (None, Some(u)) => u.to_string(),
            _ => return Err(Failure::BlockedDestination),
        };
        let key = format!("image:{target}");
        if let Some(Cached::Image(bytes)) = self.enter(partition).cache.get(partition, &key) {
            return Ok(bytes);
        }
        let fetched = self.fetch(&target, Want::Image).await?;
        let bytes = Arc::new(fetched.body);
        if let Some(mut inner) = self.current(partition) {
            inner
                .cache
                .put(partition, &key, Cached::Image(bytes.clone()));
        }
        Ok(bytes)
    }

    async fn fetch(&self, raw: &str, want: Want) -> Result<Fetched, Failure> {
        let _permit = self
            .gate
            .acquire()
            .await
            .map_err(|_| Failure::Unavailable)?;
        let deadline = match want {
            Want::Page => self.limits.page_deadline,
            Want::Image => self.limits.image_deadline,
        };
        let mut reservation = Reservation {
            budget: &self.in_flight,
            held: 0,
        };
        tokio::time::timeout(deadline, self.follow(raw, want, deadline, &mut reservation))
            .await
            .map_err(|_| Failure::Unavailable)?
    }

    async fn follow(
        &self,
        raw: &str,
        want: Want,
        deadline: Duration,
        reservation: &mut Reservation<'_>,
    ) -> Result<Fetched, Failure> {
        let started = Instant::now();
        let mut url = vet_url(&self.policy, raw)?;
        let mut hops = 0;
        loop {
            let addrs = vet_addrs(&self.policy, &url).await?;
            let mut builder = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .user_agent(USER_AGENT)
                .timeout(deadline.saturating_sub(started.elapsed()))
                .https_only(!self.policy.allow_http);
            if let Some(Host::Domain(name)) = url.host() {
                builder = builder.dns_resolver(Arc::new(VettedResolver {
                    host: name.to_string(),
                    addrs,
                    classify: self.policy.classify,
                }));
            }
            // ponytail: a client per hop re-reads the root store each time;
            // cache one per policy if preview latency ever shows it.
            let client = builder.build().map_err(|_| Failure::Unavailable)?;
            let accept = match want {
                Want::Page => "text/html, application/json;q=0.9",
                Want::Image => "image/*",
            };
            let mut resp = client
                .get(url.clone())
                .header(reqwest::header::ACCEPT, accept)
                .send()
                .await
                .map_err(|_| Failure::Unavailable)?;

            let status = resp.status().as_u16();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                if hops >= MAX_REDIRECTS {
                    return Err(Failure::TooManyRedirects);
                }
                hops += 1;
                let location = resp
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or(Failure::Unavailable)?;
                let next = url
                    .join(location)
                    .map_err(|_| Failure::BlockedDestination)?;
                // The whole check again: a downgrade to http fails the scheme
                // rule, a private target fails the classifier.
                url = vet_url(&self.policy, next.as_str())?;
                continue;
            }
            if !resp.status().is_success() {
                return Err(Failure::Unavailable);
            }

            let content_type = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|v| {
                    v.split(';')
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_ascii_lowercase()
                })
                .unwrap_or_default();
            let (cap, truncate) = match want {
                Want::Page if content_type == "text/html" => (self.limits.html_bytes, true),
                Want::Page if is_json(&content_type) => (self.limits.json_bytes, false),
                Want::Image if IMAGE_TYPES.contains(&content_type.as_str()) => {
                    (self.limits.image_bytes, false)
                }
                _ => return Err(Failure::WrongType),
            };
            // A declared length is a hint, not a limit — the read below is —
            // but a body that announces itself too large is refused unread.
            if !truncate && resp.content_length().is_some_and(|n| n > cap as u64) {
                return Err(Failure::Oversized);
            }

            let mut body = Vec::new();
            while let Some(chunk) = resp.chunk().await.map_err(|_| Failure::Unavailable)? {
                let room = cap - body.len();
                let take = if chunk.len() > room {
                    if !truncate {
                        return Err(Failure::Oversized);
                    }
                    room
                } else {
                    chunk.len()
                };
                if !reservation.grow(take) {
                    return Err(Failure::Oversized);
                }
                body.extend_from_slice(&chunk[..take]);
                if truncate && body.len() >= cap {
                    break;
                }
            }

            if want == Want::Image && sniff_image(&body) != Some(content_type.as_str()) {
                // The declared type is only a claim: the bytes have to agree.
                return Err(Failure::WrongType);
            }
            return Ok(Fetched {
                body,
                content_type,
                url,
            });
        }
    }
}

fn is_json(content_type: &str) -> bool {
    content_type == "application/json" || content_type.ends_with("+json")
}

/// The raster type `bytes` actually is, by signature.
fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && matches!(&bytes[8..12], b"avif" | b"avis")
    {
        Some("image/avif")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    }
}

// --- Parsing (clause 7: the renderer never sees a body) ----------------------

/// Reduce a fetched page to its preview: Open Graph for HTML, the title for an
/// oEmbed document. Any other JSON is not a preview.
fn reduce_page(fetched: &Fetched) -> Result<PreviewData, Failure> {
    if is_json(&fetched.content_type) {
        return parse_oembed(&fetched.body).ok_or(Failure::WrongType);
    }
    let html = String::from_utf8_lossy(&fetched.body);
    let tags = parse_og_tags(&html);
    // Resolved against the page, then vetted like any other destination —
    // the image is fetched later, by handle, under the same policy.
    let image_url = tags
        .image
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(|s| fetched.url.join(s).ok())
        .map(|u| u.to_string());
    Ok(PreviewData {
        title: tags.title,
        description: tags.description,
        site_name: tags.site_name,
        image_url,
        image_width: tags.image_width,
        image_height: tags.image_height,
    })
}

/// The title of an oEmbed document (a JSON object with `type` and `version`).
fn parse_oembed(body: &[u8]) -> Option<PreviewData> {
    let doc: serde_json::Value = serde_json::from_slice(body).ok()?;
    let obj = doc.as_object()?;
    if !obj.contains_key("type") || !obj.contains_key("version") {
        return None;
    }
    Some(PreviewData {
        title: obj.get("title").and_then(|t| t.as_str()).map(cap_text),
        ..PreviewData::default()
    })
}

/// Longest string any preview field carries across the boundary.
const MAX_FIELD_CHARS: usize = 1024;

fn cap_text(s: &str) -> String {
    s.chars().take(MAX_FIELD_CHARS).collect()
}

/// Open Graph fields, as the renderer's old `parseOgTags` read them.
#[derive(Debug, Default, PartialEq)]
struct OgTags {
    title: Option<String>,
    description: Option<String>,
    image: Option<String>,
    site_name: Option<String>,
    image_width: Option<u32>,
    image_height: Option<u32>,
}

/// A port of `parseOgTags` (formerly Client/src/components/message-list/embeds.ts),
/// on html5ever's spec tokenizer rather than a regex — the F7 property: linear
/// time on hostile input, and meta-like text inside comments, scripts and
/// styles is not a tag.
///
/// Precedence, case by case with the TypeScript it replaces:
/// - For each name in order, the FIRST `meta[property=name]` in document order
///   wins, else the first `meta[name=name]`. An element that matches but has
///   no `content` attribute yields nothing and the next name is tried; an
///   empty `content` is an empty string, not absent.
/// - title = og:title, else the first `<title>`'s text, trimmed.
/// - description = og:description, else description.
fn parse_og_tags(html: &str) -> OgTags {
    use html5ever::tendril::StrTendril;
    use html5ever::tokenizer::states::RawKind;
    use html5ever::tokenizer::{
        BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts,
    };
    use std::cell::RefCell;

    #[derive(Default)]
    struct State {
        by_property: HashMap<String, Option<String>>,
        by_name: HashMap<String, Option<String>>,
        title: Option<String>,
        in_first_title: bool,
    }
    struct Sink(RefCell<State>);

    impl TokenSink for Sink {
        type Handle = ();
        fn process_token(&self, token: Token, _line: u64) -> TokenSinkResult<()> {
            let mut s = self.0.borrow_mut();
            match token {
                Token::TagToken(tag) if tag.kind == TagKind::StartTag => match &*tag.name {
                    "meta" => {
                        let attr = |n: &str| {
                            tag.attrs
                                .iter()
                                .find(|a| &*a.name.local == n)
                                .map(|a| a.value.to_string())
                        };
                        let content = attr("content");
                        if let Some(p) = attr("property") {
                            s.by_property.entry(p).or_insert_with(|| content.clone());
                        }
                        if let Some(n) = attr("name") {
                            s.by_name.entry(n).or_insert(content);
                        }
                    }
                    "title" => {
                        if s.title.is_none() {
                            s.title = Some(String::new());
                            s.in_first_title = true;
                        }
                        return TokenSinkResult::RawData(RawKind::Rcdata);
                    }
                    "textarea" => return TokenSinkResult::RawData(RawKind::Rcdata),
                    "script" => return TokenSinkResult::RawData(RawKind::ScriptData),
                    "style" | "xmp" | "iframe" | "noembed" | "noframes" => {
                        return TokenSinkResult::RawData(RawKind::Rawtext)
                    }
                    "plaintext" => return TokenSinkResult::Plaintext,
                    _ => {}
                },
                Token::TagToken(tag) if &*tag.name == "title" => s.in_first_title = false,
                Token::CharacterTokens(text) if s.in_first_title => {
                    if let Some(t) = s.title.as_mut() {
                        t.push_str(&text);
                    }
                }
                _ => {}
            }
            TokenSinkResult::Continue
        }
    }

    let tokenizer = Tokenizer::new(
        Sink(RefCell::new(State::default())),
        TokenizerOpts::default(),
    );
    let input = BufferQueue::default();
    input.push_back(StrTendril::from_slice(html));
    let _ = tokenizer.feed(&input);
    tokenizer.end();
    let state = tokenizer.sink.0.into_inner();

    let meta = |names: &[&str]| -> Option<String> {
        names.iter().find_map(|n| {
            state
                .by_property
                .get(*n)
                .or_else(|| state.by_name.get(*n))
                .cloned()
                .flatten()
        })
    };
    let dimension = |n: &str| meta(&[n]).and_then(|v| v.trim().parse::<u32>().ok());
    OgTags {
        title: meta(&["og:title"])
            .or_else(|| state.title.as_deref().map(|t| t.trim().to_string()))
            .map(|t| cap_text(&t)),
        description: meta(&["og:description", "description"]).map(|t| cap_text(&t)),
        image: meta(&["og:image"]),
        site_name: meta(&["og:site_name"]).map(|t| cap_text(&t)),
        image_width: dimension("og:image:width"),
        image_height: dimension("og:image:height"),
    }
}

// --- Commands ---------------------------------------------------------------------

/// The typed minimum for `url` — Open Graph for a page, the title for an
/// oEmbed document — with the preview image as an opaque handle. Errors are
/// the `ExternalContentFailure` spelling and nothing more.
#[tauri::command]
pub async fn external_preview(
    state: tauri::State<'_, ExternalContentState>,
    partition: String,
    url: String,
) -> Result<ExternalPreview, String> {
    state
        .preview(&partition, &url)
        .await
        .map_err(|f| f.as_str().to_string())
}

/// The raw bytes of one vetted image, named by a handle from
/// `external_preview` or by a URL the renderer already holds. Raw IPC bytes,
/// not base64: the renderer turns them into a same-origin `blob:` URL.
#[tauri::command]
pub async fn external_image(
    state: tauri::State<'_, ExternalContentState>,
    partition: String,
    handle: Option<String>,
    url: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let bytes = state
        .image(&partition, handle.as_deref(), url.as_deref())
        .await
        .map_err(|f| f.as_str().to_string())?;
    Ok(tauri::ipc::Response::new(bytes.as_ref().clone()))
}

#[cfg(test)]
mod tests {
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
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
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
        let ok =
            rt.block_on(resolver.resolve(reqwest::dns::Name::from_str("example.com").unwrap()));
        assert_eq!(ok.unwrap().collect::<Vec<_>>().len(), 1);
        let other =
            rt.block_on(resolver.resolve(reqwest::dns::Name::from_str("evil.test").unwrap()));
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
            Some(Failure::Unavailable)
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

    // --- The User-Agent (Decision 2) ---------------------------------------------

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
        let t = parse_og_tags(
            r#"<html><head><meta name="description" content="Meta desc"></head></html>"#,
        );
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
}
