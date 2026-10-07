//! The listening socket, the addresses a phone can reach it on, and the machine name.

use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, TcpListener};

use kalcode_remote::{DEFAULT_PORT, MAX_PORT};

/// Why the listener could not start, in words the Settings page shows with its fix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindError {
    pub code: &'static str,
    pub message: String,
}

/// Binds `0.0.0.0` on the first free port from 47820 to 47829.
pub fn bind() -> Result<TcpListener, BindError> {
    let mut in_use = false;
    for port in DEFAULT_PORT..=MAX_PORT {
        match TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)) {
            Ok(listener) => {
                listener.set_nonblocking(true).map_err(|_| BindError {
                    code: "listen_failed",
                    message: "KalCode couldn't start listening for your devices. Turn Remote off and on again.".into(),
                })?;
                return Ok(listener);
            }
            Err(error) if error.kind() == ErrorKind::AddrInUse => in_use = true,
            Err(error) if error.kind() == ErrorKind::PermissionDenied => {
                return Err(BindError {
                    code: "listen_blocked",
                    message: format!(
                        "This computer blocked KalCode from listening on port {port}. Allow KalCode in your firewall or security software, then turn Remote on again."
                    ),
                });
            }
            Err(_) => {}
        }
    }
    Err(if in_use {
        BindError {
            code: "ports_in_use",
            message: format!(
                "Ports {DEFAULT_PORT}–{MAX_PORT} are all in use by other apps. Close one of them (or another KalCode with Remote on), then turn Remote on again."
            ),
        }
    } else {
        BindError {
            code: "listen_failed",
            message:
                "KalCode couldn't start listening for your devices. Turn Remote off and on again."
                    .into(),
        }
    })
}

/// `ipv4:port` for every interface a phone can plausibly reach: private LAN addresses first,
/// then Tailscale (`100.64.0.0/10`), then any other routable address. Loopback, link-local and
/// well-known virtual adapters (Hyper-V, WSL, Docker, VirtualBox, VMware) are left out.
pub fn advertised_addresses(port: u16) -> Vec<String> {
    let networks = sysinfo::Networks::new_with_refreshed_list();
    let interfaces = networks.list().iter().flat_map(|(name, data)| {
        data.ip_networks()
            .iter()
            .map(move |network| (name.as_str(), network.addr))
    });
    rank_addresses(interfaces)
        .into_iter()
        .map(|ip| format!("{ip}:{port}"))
        .collect()
}

/// Orders and filters `(interface name, address)` pairs; see [`advertised_addresses`].
pub fn rank_addresses<'a>(
    interfaces: impl IntoIterator<Item = (&'a str, IpAddr)>,
) -> Vec<Ipv4Addr> {
    let mut ranked: Vec<(u8, Ipv4Addr)> = Vec::new();
    for (name, addr) in interfaces {
        let IpAddr::V4(ip) = addr else {
            continue;
        };
        if ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || ip.is_multicast() {
            continue;
        }
        let rank = if is_tailscale(ip) {
            1
        } else if is_virtual_adapter(name) {
            continue;
        } else if ip.is_private() {
            0
        } else {
            2
        };
        if !ranked.iter().any(|(_, seen)| *seen == ip) {
            ranked.push((rank, ip));
        }
    }
    ranked.sort();
    ranked.into_iter().map(|(_, ip)| ip).collect()
}

fn is_tailscale(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 100 && (64..128).contains(&b)
}

fn is_virtual_adapter(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "vethernet",
        "hyper-v",
        "wsl",
        "docker",
        "virtualbox",
        "vboxnet",
        "vmware",
        "vmnet",
        "loopback",
        "bridge",
        "br-",
        "veth",
    ]
    .iter()
    .any(|marker| name.contains(marker))
}

/// The name the phone shows for this workstation.
pub fn machine_name() -> String {
    sysinfo::System::host_name()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "KalCode workstation".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().expect("ip")
    }

    #[test]
    fn lan_first_then_tailscale_and_never_loopback_or_virtual() {
        let ranked = rank_addresses([
            ("Tailscale", ip("100.101.102.103")),
            ("Loopback Pseudo-Interface 1", ip("127.0.0.1")),
            ("vEthernet (WSL)", ip("172.29.64.1")),
            ("Wi-Fi", ip("192.168.1.20")),
            ("Wi-Fi", ip("fe80::1")),
            ("Ethernet", ip("169.254.10.2")),
            ("Ethernet 2", ip("10.0.0.7")),
            ("Wi-Fi", ip("192.168.1.20")),
        ]);
        let expected: Vec<Ipv4Addr> = ["10.0.0.7", "192.168.1.20", "100.101.102.103"]
            .iter()
            .map(|a| a.parse().expect("ip"))
            .collect();
        assert_eq!(ranked, expected);
        // 100.128.0.0 is outside 100.64.0.0/10 (and not private): ranked after Tailscale.
        assert_eq!(
            rank_addresses([("utun4", ip("100.128.0.1")), ("utun3", ip("100.64.0.1"))]),
            vec![
                "100.64.0.1".parse::<Ipv4Addr>().expect("ip"),
                "100.128.0.1".parse().expect("ip")
            ]
        );
    }
}
