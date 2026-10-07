//! Pre-authentication admission control (§3).
//!
//! An unauthenticated peer costs a Noise DH and buffer space, so the desktop caps how many
//! handshakes run at once: [`crate::limits::Limits::max_handshakes`] in total and
//! [`crate::limits::Limits::max_handshakes_per_ip`] per source address. The listener asks
//! [`Admission::try_admit`] right after `accept()` and **before reading a byte**; over the limit
//! it drops the socket without any Noise work. The permit is held until
//! [`crate::server::accept`] returns.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// Counts handshakes in progress. Cheap to clone; clones share the counts.
#[derive(Clone)]
pub struct Admission {
    inner: Arc<Inner>,
}

struct Inner {
    max_total: usize,
    max_per_ip: usize,
    counts: Mutex<Counts>,
}

#[derive(Default)]
struct Counts {
    total: usize,
    per_ip: HashMap<IpAddr, usize>,
}

impl std::fmt::Debug for Admission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Admission")
            .field("max_total", &self.inner.max_total)
            .field("max_per_ip", &self.inner.max_per_ip)
            .field("in_progress", &self.in_progress())
            .finish()
    }
}

impl Admission {
    pub fn new(max_total: usize, max_per_ip: usize) -> Self {
        Self {
            inner: Arc::new(Inner {
                max_total,
                max_per_ip,
                counts: Mutex::new(Counts::default()),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Counts> {
        self.inner
            .counts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// A permit for one handshake from `peer`, or `None` when either limit is reached (drop
    /// the socket). IPv4-mapped IPv6 addresses count as their IPv4 address.
    pub fn try_admit(&self, peer: IpAddr) -> Option<AdmissionPermit> {
        let ip = peer.to_canonical();
        let mut counts = self.lock();
        if counts.total >= self.inner.max_total {
            return None;
        }
        let from_ip = counts.per_ip.entry(ip).or_insert(0);
        if *from_ip >= self.inner.max_per_ip {
            return None;
        }
        *from_ip += 1;
        counts.total += 1;
        Some(AdmissionPermit {
            admission: self.clone(),
            ip,
        })
    }

    /// Handshakes currently admitted.
    pub fn in_progress(&self) -> usize {
        self.lock().total
    }
}

/// One admitted handshake; dropping it frees the slot.
pub struct AdmissionPermit {
    admission: Admission,
    ip: IpAddr,
}

impl std::fmt::Debug for AdmissionPermit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AdmissionPermit")
            .field("ip", &self.ip)
            .finish()
    }
}

impl Drop for AdmissionPermit {
    fn drop(&mut self) {
        let mut counts = self.admission.lock();
        counts.total = counts.total.saturating_sub(1);
        if let Some(n) = counts.per_ip.get_mut(&self.ip) {
            *n -= 1;
            if *n == 0 {
                counts.per_ip.remove(&self.ip);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr};

    use super::*;

    fn ip(n: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, n))
    }

    #[test]
    fn caps_total_and_per_ip_and_frees_on_drop() {
        let admission = Admission::new(32, 4);
        let mut held = Vec::new();
        for n in 1..=8 {
            for _ in 0..4 {
                held.push(admission.try_admit(ip(n)).expect("under the limit"));
            }
        }
        assert_eq!(admission.in_progress(), 32);
        assert!(admission.try_admit(ip(9)).is_none(), "the 33rd is dropped");
        held.pop();
        assert!(admission.try_admit(ip(9)).is_some());
        assert_eq!(admission.in_progress(), 31, "the probe permit was dropped");
        drop(held);
        assert_eq!(admission.in_progress(), 0);
    }

    #[test]
    fn per_ip_limit_counts_mapped_addresses_once() {
        let admission = Admission::new(32, 4);
        let v4 = Ipv4Addr::new(192, 168, 1, 5);
        let mut held: Vec<_> = (0..2)
            .map(|_| admission.try_admit(IpAddr::V4(v4)).unwrap())
            .collect();
        let mapped = IpAddr::V6(v4.to_ipv6_mapped());
        held.extend((0..2).map(|_| admission.try_admit(mapped).unwrap()));
        assert!(admission.try_admit(IpAddr::V4(v4)).is_none());
        assert!(admission.try_admit(mapped).is_none());
        assert!(
            admission
                .try_admit(IpAddr::V6(Ipv6Addr::LOCALHOST))
                .is_some()
        );
    }
}
