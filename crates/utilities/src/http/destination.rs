//! Where a request goes: name resolution (pinned — resolved once, connected to exactly those
//! addresses, so a DNS answer can't change between the check and the connection) and the
//! classification of every resolved address.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use kalcode_core::{ErrorCategory, KalError, Result};

use crate::types::HttpDestination;

/// Cloud instance-metadata endpoints. They sit in link-local or private ranges and hand out
/// credentials to whatever asks, so they are classified [`HttpDestination::LinkLocal`] whatever
/// range they fall in.
const METADATA_V4: &[Ipv4Addr] = &[
    Ipv4Addr::new(169, 254, 169, 254),
    Ipv4Addr::new(169, 254, 170, 2),
    Ipv4Addr::new(100, 100, 100, 200),
];
const METADATA_V6: &[Ipv6Addr] = &[Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254)];

/// Longest a name lookup may take.
pub const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);
/// A bounded number of blocking system lookups may remain in flight after their caller times out.
pub const MAX_RESOLVER_WORKERS: usize = 4;

/// An address class KalCode never sends to.
fn refused_address(ip: IpAddr) -> KalError {
    KalError::new(
        ErrorCategory::Network,
        "destination_refused",
        format!(
            "{ip} is not an address a request can be sent to (unspecified, multicast, broadcast or reserved)."
        ),
    )
}

/// Classifies one address, or refuses it.
pub fn classify(ip: IpAddr) -> Result<HttpDestination> {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = embedded_v4(v6) {
                return classify_v4(v4);
            }
            classify_v6(v6)
        }
    }
}

/// The IPv4 address inside an IPv4-mapped (`::ffff:a.b.c.d`), IPv4-compatible (`::a.b.c.d`) or
/// NAT64 well-known-prefix (`64:ff9b::a.b.c.d`) IPv6 address.
fn embedded_v4(v6: Ipv6Addr) -> Option<Ipv4Addr> {
    if let Some(v4) = v6.to_ipv4_mapped() {
        return Some(v4);
    }
    let s = v6.segments();
    let tail = Ipv4Addr::new(
        (s[6] >> 8) as u8,
        (s[6] & 0xff) as u8,
        (s[7] >> 8) as u8,
        (s[7] & 0xff) as u8,
    );
    if s[..6] == [0, 0, 0, 0, 0, 0] && !v6.is_loopback() && !v6.is_unspecified() {
        return Some(tail);
    }
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return Some(tail);
    }
    None
}

fn classify_v4(ip: Ipv4Addr) -> Result<HttpDestination> {
    let o = ip.octets();
    if METADATA_V4.contains(&ip) || ip.is_link_local() {
        return Ok(HttpDestination::LinkLocal);
    }
    if ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() || o[0] >= 240 || o[0] == 0 {
        return Err(refused_address(IpAddr::V4(ip)));
    }
    if ip.is_loopback() {
        return Ok(HttpDestination::Loopback);
    }
    // RFC 1918 and shared address space (RFC 6598, carrier-grade NAT).
    if ip.is_private() || (o[0] == 100 && (64..128).contains(&o[1])) {
        return Ok(HttpDestination::Private);
    }
    Ok(HttpDestination::External)
}

fn classify_v6(ip: Ipv6Addr) -> Result<HttpDestination> {
    let first = ip.segments()[0];
    if METADATA_V6.contains(&ip) || (first & 0xffc0) == 0xfe80 {
        return Ok(HttpDestination::LinkLocal);
    }
    if ip.is_unspecified() || ip.is_multicast() {
        return Err(refused_address(IpAddr::V6(ip)));
    }
    if ip.is_loopback() {
        return Ok(HttpDestination::Loopback);
    }
    // Unique local addresses (fc00::/7) and the deprecated site-local range (fec0::/10).
    if (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfec0 {
        return Ok(HttpDestination::Private);
    }
    Ok(HttpDestination::External)
}

/// Gating strictness: link-local/metadata > external > private > loopback.
fn strictness(destination: HttpDestination) -> u8 {
    match destination {
        HttpDestination::Loopback => 0,
        HttpDestination::Private => 1,
        HttpDestination::External => 2,
        HttpDestination::LinkLocal => 3,
    }
}

/// The resolved, classified addresses of a host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolution {
    pub addrs: Vec<SocketAddr>,
    /// The strictest class among `addrs` (a name that resolves to both a public and a metadata
    /// address is treated as metadata).
    pub destination: HttpDestination,
    pub elapsed_ms: u32,
}

/// Classifies already-resolved addresses. Any refused address refuses the whole host.
pub fn classify_all(addrs: Vec<SocketAddr>, elapsed_ms: u32) -> Result<Resolution> {
    let mut destination = HttpDestination::Loopback;
    for addr in &addrs {
        let class = classify(addr.ip())?;
        if strictness(class) > strictness(destination) {
            destination = class;
        }
    }
    if addrs.is_empty() {
        return Err(not_found());
    }
    Ok(Resolution {
        addrs,
        destination,
        elapsed_ms,
    })
}

fn not_found() -> KalError {
    KalError::new(
        ErrorCategory::Network,
        "host_not_found",
        "That host name couldn't be found. Check the address, or your network connection.",
    )
    .retryable()
}

pub(crate) trait ResolveBackend: Send + Sync {
    fn resolve(&self, host: &str, port: u16) -> std::io::Result<Vec<SocketAddr>>;
}

struct SystemResolver;

impl ResolveBackend for SystemResolver {
    fn resolve(&self, host: &str, port: u16) -> std::io::Result<Vec<SocketAddr>> {
        (host, port)
            .to_socket_addrs()
            .map(|iter| iter.take(16).collect())
    }
}

#[derive(Default)]
struct ResolverState {
    accepting: bool,
    next_id: u64,
    workers: HashMap<u64, JoinHandle<()>>,
}

/// Owns every blocking system resolver worker. Timed-out workers remain accounted for, new work
/// is bounded, and shutdown reports unclean until the OS lookup actually returns.
pub struct TrackedResolver {
    backend: Arc<dyn ResolveBackend>,
    state: Mutex<ResolverState>,
    timeout: Duration,
    max_workers: usize,
}

impl std::fmt::Debug for TrackedResolver {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TrackedResolver")
            .field("timeout", &self.timeout)
            .field("max_workers", &self.max_workers)
            .finish_non_exhaustive()
    }
}

impl Default for TrackedResolver {
    fn default() -> Self {
        Self {
            backend: Arc::new(SystemResolver),
            state: Mutex::new(ResolverState {
                accepting: true,
                ..ResolverState::default()
            }),
            timeout: RESOLVE_TIMEOUT,
            max_workers: MAX_RESOLVER_WORKERS,
        }
    }
}

impl TrackedResolver {
    #[cfg(test)]
    pub(crate) fn with_backend(
        backend: Arc<dyn ResolveBackend>,
        timeout: Duration,
        max_workers: usize,
    ) -> Self {
        Self {
            backend,
            state: Mutex::new(ResolverState {
                accepting: true,
                ..ResolverState::default()
            }),
            timeout,
            max_workers,
        }
    }

    fn reap_finished(state: &mut ResolverState) {
        let finished: Vec<u64> = state
            .workers
            .iter()
            .filter_map(|(id, worker)| worker.is_finished().then_some(*id))
            .collect();
        for id in finished {
            if let Some(worker) = state.workers.remove(&id) {
                let _ = worker.join();
            }
        }
    }

    fn finish_worker(&self, id: u64) {
        let worker = self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .workers
            .remove(&id);
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }

    /// Resolves one host after the caller has consumed its exact DNS authority.
    pub fn resolve(&self, host: &str, port: u16) -> Result<Resolution> {
        let started = Instant::now();
        let bare = host.trim_start_matches('[').trim_end_matches(']');
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        Self::reap_finished(&mut state);
        if !state.accepting {
            return Err(KalError::internal(
                "resolver_shutting_down",
                "The API Inspector is shutting down.",
            ));
        }
        if let Ok(ip) = bare.parse::<IpAddr>() {
            return classify_all(vec![SocketAddr::new(ip, port)], 0);
        }
        if state.workers.len() >= self.max_workers {
            return Err(KalError::new(
                ErrorCategory::Network,
                "resolver_busy",
                "Too many host lookups are still in progress. Try again shortly.",
            )
            .retryable());
        }
        let id = state.next_id;
        state.next_id = state.next_id.wrapping_add(1);
        let backend = Arc::clone(&self.backend);
        let host = bare.to_owned();
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("kalcode-utility-resolve".into())
            .spawn(move || {
                let _ = tx.send(backend.resolve(&host, port));
            })
            .map_err(|e| {
                KalError::internal("resolve_unavailable", "KalCode couldn't look up that host.")
                    .with_source(e)
            })?;
        state.workers.insert(id, worker);
        drop(state);

        match rx.recv_timeout(self.timeout) {
            Ok(Ok(addrs)) => {
                self.finish_worker(id);
                classify_all(addrs, crate::elapsed_ms(started))
            }
            Ok(Err(_)) => {
                self.finish_worker(id);
                Err(not_found())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.finish_worker(id);
                Err(KalError::internal(
                    "resolve_interrupted",
                    "The host lookup was interrupted.",
                ))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => Err(KalError::new(
                ErrorCategory::Network,
                "resolve_timeout",
                "Looking up that host name took too long.",
            )
            .retryable()),
        }
    }

    /// Stops admission and proves every previously admitted lookup has completed.
    pub fn shutdown_checked(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.accepting = false;
        Self::reap_finished(&mut state);
        if state.workers.is_empty() {
            Ok(())
        } else {
            Err(KalError::internal(
                "resolver_workers_active",
                "Host lookups are still finishing; KalCode will retry shutdown.",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Condvar,
        atomic::{AtomicUsize, Ordering},
    };

    fn class(text: &str) -> std::result::Result<HttpDestination, &'static str> {
        classify(text.parse().expect("ip")).map_err(|e| e.code)
    }

    #[test]
    fn every_range_has_the_documented_class() {
        use HttpDestination::*;
        for (ip, expected) in [
            ("127.0.0.1", Ok(Loopback)),
            ("127.8.9.10", Ok(Loopback)),
            ("::1", Ok(Loopback)),
            ("::ffff:127.0.0.1", Ok(Loopback)),
            ("10.1.2.3", Ok(Private)),
            ("172.16.0.1", Ok(Private)),
            ("172.31.255.255", Ok(Private)),
            ("192.168.1.10", Ok(Private)),
            ("100.64.0.1", Ok(Private)),
            ("fd12:3456::1", Ok(Private)),
            ("169.254.1.1", Ok(LinkLocal)),
            ("169.254.169.254", Ok(LinkLocal)),
            ("::ffff:169.254.169.254", Ok(LinkLocal)),
            ("64:ff9b::a9fe:a9fe", Ok(LinkLocal)),
            ("100.100.100.200", Ok(LinkLocal)),
            ("fd00:ec2::254", Ok(LinkLocal)),
            ("fe80::1", Ok(LinkLocal)),
            ("8.8.8.8", Ok(External)),
            ("203.0.113.7", Ok(External)),
            ("172.32.0.1", Ok(External)),
            ("2606:4700::1111", Ok(External)),
            ("0.0.0.0", Err("destination_refused")),
            ("::", Err("destination_refused")),
            ("224.0.0.1", Err("destination_refused")),
            ("255.255.255.255", Err("destination_refused")),
            ("240.0.0.1", Err("destination_refused")),
            ("ff02::1", Err("destination_refused")),
            ("0.1.2.3", Err("destination_refused")),
        ] {
            assert_eq!(class(ip), expected, "{ip}");
        }
    }

    #[test]
    fn the_strictest_resolved_address_wins() {
        let mixed = classify_all(
            vec![
                "93.184.216.34:80".parse().expect("addr"),
                "169.254.169.254:80".parse().expect("addr"),
            ],
            0,
        )
        .expect("classified");
        assert_eq!(mixed.destination, HttpDestination::LinkLocal);
        let local = classify_all(vec!["127.0.0.1:80".parse().expect("addr")], 0).expect("ok");
        assert_eq!(local.destination, HttpDestination::Loopback);
        assert!(classify_all(vec![], 0).is_err());
        let refused = classify_all(
            vec![
                "127.0.0.1:80".parse().expect("addr"),
                "0.0.0.0:80".parse().expect("addr"),
            ],
            0,
        );
        assert_eq!(refused.map_err(|e| e.code), Err("destination_refused"));
    }

    #[test]
    fn ip_literals_resolve_without_dns() {
        let resolver = TrackedResolver::default();
        let r = resolver.resolve("[::1]", 8080).expect("v6");
        assert_eq!(r.addrs, vec!["[::1]:8080".parse().expect("addr")]);
        assert_eq!(r.destination, HttpDestination::Loopback);
        let r = resolver.resolve("127.0.0.1", 1).expect("v4");
        assert_eq!(r.elapsed_ms, 0);
    }

    struct BlockingBackend {
        calls: AtomicUsize,
        release: Arc<(Mutex<bool>, Condvar)>,
    }

    impl ResolveBackend for BlockingBackend {
        fn resolve(&self, _host: &str, port: u16) -> std::io::Result<Vec<SocketAddr>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let (lock, changed) = &*self.release;
            let mut released = lock.lock().unwrap_or_else(PoisonError::into_inner);
            while !*released {
                released = changed
                    .wait(released)
                    .unwrap_or_else(PoisonError::into_inner);
            }
            Ok(vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)])
        }
    }

    #[test]
    fn timed_out_workers_remain_bounded_and_block_clean_shutdown() {
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let backend = Arc::new(BlockingBackend {
            calls: AtomicUsize::new(0),
            release: Arc::clone(&release),
        });
        let resolver =
            TrackedResolver::with_backend(backend.clone(), Duration::from_millis(100), 1);

        assert_eq!(
            resolver.resolve("one.example", 443).unwrap_err().code,
            "resolve_timeout"
        );
        assert_eq!(
            resolver.resolve("two.example", 443).unwrap_err().code,
            "resolver_busy"
        );
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            resolver.shutdown_checked().unwrap_err().code,
            "resolver_workers_active"
        );

        let (lock, changed) = &*release;
        *lock.lock().unwrap_or_else(PoisonError::into_inner) = true;
        changed.notify_all();
        for _ in 0..100 {
            if resolver.shutdown_checked().is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        panic!("completed resolver worker was not drained");
    }
}
