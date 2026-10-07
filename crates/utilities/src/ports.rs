//! The Port Inspector: listening sockets → owning process → project.
//!
//! On Windows the listing comes straight from the IP Helper socket tables
//! (`GetExtendedTcpTable` / `GetExtendedUdpTable`: listeners and UDP endpoints with their owning
//! pids), so no process is spawned. Elsewhere, and on Windows if those tables can't be read, it
//! comes from the operating system's own tool, never a shell:
//! `%SystemRoot%\System32\netstat.exe -ano` (by absolute path, so a `netstat.exe` in a workspace
//! can't stand in for it), on macOS `lsof -nP -F`, on Linux `ss -H -ltunp` (falling back to
//! `lsof`). Parsing does not trust the tool's language: a TCP socket is listening when its remote
//! end is the wildcard (`0.0.0.0:0`, `[::]:0`, `*:*`), whatever word the localized state column
//! uses.
//!
//! [`ListenerCache`] keeps the Process Monitor's background "related" scan from listing sockets
//! on every poll.

use std::collections::BTreeMap;
use std::io::Read;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use kalcode_core::{ErrorCategory, KalError, Result};

use crate::types::{
    ListeningPort, PortExposure, PortList, PortLookup, ProcessInfo, ProcessOwner, TransportProtocol,
};

/// Longest the OS tool may run.
pub const TOOL_TIMEOUT: Duration = Duration::from_secs(8);
/// Most output read from it.
const MAX_OUTPUT: u64 = 8 * 1024 * 1024;

/// One listening socket as the tool reported it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct RawPort {
    pub protocol: TransportProtocol,
    pub local_address: String,
    pub port: u16,
    pub pid: Option<u32>,
    /// The command name, when the tool reports it (lsof, ss).
    pub command: Option<String>,
}

/// `%SystemRoot%\System32` (the Windows folder when the variable is missing or not absolute).
pub fn system32() -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32")
}

/// Runs `program` with `args` (no shell), returning its standard output within
/// [`TOOL_TIMEOUT`].
fn run(program: &std::path::Path, args: &[&str]) -> Result<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(|e| {
        KalError::new(
            ErrorCategory::Internal,
            "port_tool_unavailable",
            "KalCode couldn't run the system tool that lists ports.",
        )
        .with_source(e)
    })?;
    let mut stdout = child.stdout.take().ok_or_else(|| {
        KalError::internal(
            "port_tool_unavailable",
            "The port listing produced no output.",
        )
    })?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = (&mut stdout).take(MAX_OUTPUT).read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + TOOL_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(KalError::new(
                    ErrorCategory::Internal,
                    "port_tool_timeout",
                    "Listing ports took too long.",
                )
                .retryable());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => {
                return Err(KalError::internal(
                    "port_tool_unavailable",
                    "KalCode couldn't read the port listing.",
                )
                .with_source(e));
            }
        }
    }
    let bytes = reader.join().unwrap_or_default();
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// The Windows socket tables' name, as the Port Inspector shows it.
pub const WINDOWS_SOCKET_TABLES: &str = "Windows IP Helper";

/// Lists listening sockets with this platform's tool. Returns the tool's name too.
pub fn list_raw() -> Result<(Vec<RawPort>, &'static str)> {
    #[cfg(windows)]
    match ip_helper::listening() {
        Ok(ports) => return Ok((dedupe(ports), WINDOWS_SOCKET_TABLES)),
        Err(error) => tracing::warn!(
            event = "utility.socket_tables_unavailable",
            error,
            "falling back to netstat"
        ),
    }
    if cfg!(windows) {
        let out = run(&system32().join("netstat.exe"), &["-ano"])?;
        return Ok((parse_netstat(&out), "netstat"));
    }
    if cfg!(target_os = "linux") {
        for ss in ["/usr/bin/ss", "/usr/sbin/ss", "/bin/ss", "/sbin/ss"] {
            let path = std::path::Path::new(ss);
            if path.is_file() {
                let out = run(path, &["-H", "-ltunp"])?;
                return Ok((parse_ss(&out), "ss"));
            }
        }
    }
    for lsof in ["/usr/sbin/lsof", "/usr/bin/lsof", "/bin/lsof"] {
        let path = std::path::Path::new(lsof);
        if path.is_file() {
            let out = run(
                path,
                &["-nP", "-iTCP", "-sTCP:LISTEN", "-iUDP", "-F", "pcPn"],
            )?;
            return Ok((parse_lsof(&out), "lsof"));
        }
    }
    Err(KalError::new(
        ErrorCategory::Internal,
        "port_tool_unavailable",
        "No system tool for listing ports was found on this computer.",
    ))
}

/// The platform's tool name, when it exists (for the dock's status).
pub fn tool_name() -> Option<&'static str> {
    if cfg!(windows) {
        // The socket tables are part of every supported Windows.
        return Some(WINDOWS_SOCKET_TABLES);
    }
    if ["/usr/bin/ss", "/usr/sbin/ss", "/bin/ss", "/sbin/ss"]
        .iter()
        .any(|p| cfg!(target_os = "linux") && std::path::Path::new(p).is_file())
    {
        return Some("ss");
    }
    ["/usr/sbin/lsof", "/usr/bin/lsof", "/bin/lsof"]
        .iter()
        .any(|p| std::path::Path::new(p).is_file())
        .then_some("lsof")
}

/// Splits `addr:port` (`[v6]:port`, `v4:port`, `*:port`). IPv6 zone ids are kept in the address.
fn split_endpoint(text: &str) -> Option<(String, u16)> {
    let (addr, port) = text.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    // `ss` prints a scoped IPv6 address as `[fe80::1]%eth0`: drop the bracket before the zone.
    let addr = match addr.strip_prefix('[') {
        Some(rest) => rest.replacen(']', "", 1),
        None => addr.to_owned(),
    };
    Some((addr, port))
}

fn is_wildcard_remote(text: &str) -> bool {
    matches!(
        text,
        "0.0.0.0:0" | "[::]:0" | "*:*" | "*:0" | "0.0.0.0:*" | "[::]:*"
    )
}

fn dedupe(mut ports: Vec<RawPort>) -> Vec<RawPort> {
    ports.sort();
    ports.dedup();
    ports
}

/// `netstat -ano` (Windows). Language-independent: the protocol column is `TCP`/`UDP` in every
/// locale, and a TCP row is listening when its remote endpoint is the wildcard.
pub fn parse_netstat(output: &str) -> Vec<RawPort> {
    let mut ports = Vec::new();
    for line in output.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        let Some(proto) = cols.first() else {
            continue;
        };
        let protocol = match proto.to_ascii_uppercase().as_str() {
            "TCP" => TransportProtocol::Tcp,
            "UDP" => TransportProtocol::Udp,
            _ => continue,
        };
        let (local, remote, pid) = match (protocol, cols.len()) {
            (TransportProtocol::Tcp, 5) => (cols[1], cols[2], cols[4]),
            (TransportProtocol::Udp, 4) => (cols[1], cols[2], cols[3]),
            _ => continue,
        };
        if !is_wildcard_remote(remote) {
            continue;
        }
        let Some((address, port)) = split_endpoint(local) else {
            continue;
        };
        ports.push(RawPort {
            protocol,
            local_address: address,
            port,
            pid: pid.parse().ok().filter(|p| *p != 0),
            command: None,
        });
    }
    dedupe(ports)
}

/// Listening TCP sockets and UDP endpoints from the IP Helper tables, IPv4 and IPv6, formatted
/// exactly as [`parse_netstat`] reads them from `netstat -ano`.
#[cfg(windows)]
#[allow(unsafe_code)]
mod ip_helper {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::net::{Ipv4Addr, Ipv6Addr};

    use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID,
        MIB_UDP6ROW_OWNER_PID, MIB_UDPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
        UDP_TABLE_OWNER_PID,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};

    use super::RawPort;
    use crate::types::TransportProtocol;

    /// A table larger than this is refused (about a million IPv6 TCP rows).
    const MAX_TABLE_BYTES: u32 = 64 * 1024 * 1024;
    /// The table can grow between the size query and the read; retry a few times.
    const ATTEMPTS: usize = 4;

    type Fetch<'a> = &'a dyn Fn(*mut c_void, *mut u32) -> u32;

    pub fn listening() -> Result<Vec<RawPort>, &'static str> {
        let tcp = |family: u16| {
            move |buffer: *mut c_void, size: *mut u32| {
                // SAFETY: `buffer` is null (a size query) or writable for `*size` bytes, `size`
                // is a live local, and the API retains neither pointer.
                unsafe {
                    GetExtendedTcpTable(
                        buffer,
                        size,
                        0,
                        u32::from(family),
                        TCP_TABLE_OWNER_PID_LISTENER,
                        0,
                    )
                }
            }
        };
        let udp = |family: u16| {
            move |buffer: *mut c_void, size: *mut u32| {
                // SAFETY: as for the TCP table.
                unsafe {
                    GetExtendedUdpTable(buffer, size, 0, u32::from(family), UDP_TABLE_OWNER_PID, 0)
                }
            }
        };
        let mut ports = Vec::new();
        for row in rows::<MIB_TCPROW_OWNER_PID>(&tcp(AF_INET))? {
            ports.push(v4(
                TransportProtocol::Tcp,
                row.dwLocalAddr,
                row.dwLocalPort,
                row.dwOwningPid,
            ));
        }
        for row in rows::<MIB_TCP6ROW_OWNER_PID>(&tcp(AF_INET6))? {
            ports.push(v6(
                TransportProtocol::Tcp,
                row.ucLocalAddr,
                row.dwLocalScopeId,
                row.dwLocalPort,
                row.dwOwningPid,
            ));
        }
        for row in rows::<MIB_UDPROW_OWNER_PID>(&udp(AF_INET))? {
            ports.push(v4(
                TransportProtocol::Udp,
                row.dwLocalAddr,
                row.dwLocalPort,
                row.dwOwningPid,
            ));
        }
        for row in rows::<MIB_UDP6ROW_OWNER_PID>(&udp(AF_INET6))? {
            ports.push(v6(
                TransportProtocol::Udp,
                row.ucLocalAddr,
                row.dwLocalScopeId,
                row.dwLocalPort,
                row.dwOwningPid,
            ));
        }
        Ok(ports)
    }

    /// The port is the low 16 bits, in network byte order.
    fn port(raw: u32) -> u16 {
        u16::from_be(raw as u16)
    }

    fn pid(raw: u32) -> Option<u32> {
        (raw != 0).then_some(raw)
    }

    fn v4(protocol: TransportProtocol, addr: u32, raw_port: u32, owner: u32) -> RawPort {
        RawPort {
            protocol,
            // The address is in network byte order: its in-memory bytes are the octets.
            local_address: Ipv4Addr::from(addr.to_ne_bytes()).to_string(),
            port: port(raw_port),
            pid: pid(owner),
            command: None,
        }
    }

    fn v6(
        protocol: TransportProtocol,
        addr: [u8; 16],
        scope: u32,
        raw_port: u32,
        owner: u32,
    ) -> RawPort {
        let address = Ipv6Addr::from(addr);
        RawPort {
            protocol,
            // netstat shows a scope (zone) id only when there is one: `[fe80::1%12]`.
            local_address: if scope == 0 {
                address.to_string()
            } else {
                format!("{address}%{scope}")
            },
            port: port(raw_port),
            pid: pid(owner),
            command: None,
        }
    }

    /// Reads one table: a size query, then the read, retried while the table outgrows the
    /// buffer. Each table is a `u32` row count followed by the rows.
    fn rows<Row: Copy>(fetch: Fetch<'_>) -> Result<Vec<Row>, &'static str> {
        let mut size = 0_u32;
        let mut status = fetch(std::ptr::null_mut(), &mut size);
        for _ in 0..ATTEMPTS {
            if status != ERROR_INSUFFICIENT_BUFFER || size > MAX_TABLE_BYTES {
                return Err("the socket table size query failed");
            }
            // `u64` storage keeps the buffer aligned for every row type.
            let mut buffer = vec![0_u64; (size as usize).div_ceil(size_of::<u64>())];
            let capacity = u32::try_from(buffer.len() * size_of::<u64>())
                .map_err(|_| "the socket table is too large")?;
            let mut written = capacity;
            status = fetch(buffer.as_mut_ptr().cast(), &mut written);
            if status == NO_ERROR {
                return parse(&buffer, written.min(capacity) as usize);
            }
            // The table grew: ask again with the size the API reported.
            size = written.max(size.saturating_add(4096));
        }
        Err("the socket table kept growing while it was read")
    }

    fn parse<Row: Copy>(buffer: &[u64], len: usize) -> Result<Vec<Row>, &'static str> {
        let bytes = buffer.as_ptr().cast::<u8>();
        if len < size_of::<u32>() || len > std::mem::size_of_val(buffer) {
            return Err("the socket table is truncated");
        }
        // SAFETY: at least four of the buffer's initialized bytes exist.
        let count = unsafe { std::ptr::read_unaligned(bytes.cast::<u32>()) } as usize;
        // Rows follow the count at the row type's alignment (4 for every row type read here).
        let offset = size_of::<u32>().next_multiple_of(std::mem::align_of::<Row>());
        let needed = count
            .checked_mul(size_of::<Row>())
            .and_then(|rows| rows.checked_add(offset))
            .ok_or("the socket table is malformed")?;
        if needed > len {
            return Err("the socket table is truncated");
        }
        Ok((0..count)
            .map(|index| {
                // SAFETY: `needed <= len` proves every row lies inside the initialized buffer,
                // and the rows are plain `u32`/byte data, valid for any bit pattern.
                unsafe {
                    std::ptr::read_unaligned(
                        bytes.add(offset + index * size_of::<Row>()).cast::<Row>(),
                    )
                }
            })
            .collect())
    }
}

/// The socket list the Process Monitor's background "related" scan uses as a hint (port owners
/// count as related). Listing sockets on every poll is wasted work while nothing changed (on
/// macOS and Linux it spawns `lsof`/`ss`), so a listing is reused for [`LISTENER_TTL`] unless the
/// set of running terminal shells changed, the usual reason a new server appears. Concurrent
/// callers share one scan: a second caller waits for the first and reuses its result. The Port
/// Inspector always lists afresh and stores its result here.
#[derive(Default)]
pub struct ListenerCache {
    state: std::sync::Mutex<Option<CachedListeners>>,
}

/// How long a background socket listing is reused.
pub const LISTENER_TTL: Duration = Duration::from_secs(15);

struct CachedListeners {
    key: Vec<u32>,
    at: Instant,
    ports: Option<Vec<RawPort>>,
}

impl ListenerCache {
    /// The cached listing for `key` (the running terminal shells' pids), or a new one from
    /// `scan` when there is none, it is `ttl` old, or `key` changed. A failed scan is remembered
    /// as `None` for the same time, so a missing tool is not retried on every poll.
    pub fn get_or_scan(
        &self,
        key: &[u32],
        ttl: Duration,
        scan: impl FnOnce() -> Result<Vec<RawPort>>,
    ) -> Option<Vec<RawPort>> {
        let mut key = key.to_vec();
        key.sort_unstable();
        key.dedup();
        // Held across the scan, so concurrent callers wait for it instead of starting another.
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(cached) = state.as_ref()
            && cached.key == key
            && cached.at.elapsed() < ttl
        {
            return cached.ports.clone();
        }
        let ports = scan().ok();
        *state = Some(CachedListeners {
            key,
            at: Instant::now(),
            ports: ports.clone(),
        });
        ports
    }

    /// Refreshes the cached listing with one an explicit listing just took.
    pub fn store(&self, ports: &[RawPort]) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(cached) = state.as_mut() {
            cached.at = Instant::now();
            cached.ports = Some(ports.to_vec());
        }
    }
}

/// `ss -H -ltunp` (Linux): `tcp LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=7,fd=20))`.
pub fn parse_ss(output: &str) -> Vec<RawPort> {
    let mut ports = Vec::new();
    for line in output.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 {
            continue;
        }
        let protocol = match cols[0] {
            "tcp" => TransportProtocol::Tcp,
            "udp" => TransportProtocol::Udp,
            _ => continue,
        };
        let Some((address, port)) = split_endpoint(cols[4]) else {
            continue;
        };
        let users = cols.get(6..).map(|rest| rest.join(" ")).unwrap_or_default();
        let pid = users
            .split("pid=")
            .nth(1)
            .and_then(|s| s.split(|c: char| !c.is_ascii_digit()).next())
            .and_then(|s| s.parse().ok());
        let command = users
            .split("((\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .map(str::to_owned);
        ports.push(RawPort {
            protocol,
            local_address: address.split('%').next().unwrap_or("").to_owned(),
            port,
            pid,
            command,
        });
    }
    dedupe(ports)
}

/// `lsof -nP -F pcPn` (macOS, Linux fallback): `p<pid>`, `c<command>`, then per file `P<proto>`
/// and `n<local[->remote]>`.
pub fn parse_lsof(output: &str) -> Vec<RawPort> {
    let mut ports = Vec::new();
    let (mut pid, mut command, mut protocol) = (None, None, None);
    for line in output.lines() {
        let (tag, value) = line.split_at(line.len().min(1));
        match tag {
            "p" => {
                pid = value.parse().ok();
                command = None;
            }
            "c" => command = Some(value.to_owned()),
            "P" => {
                protocol = match value {
                    "TCP" => Some(TransportProtocol::Tcp),
                    "UDP" => Some(TransportProtocol::Udp),
                    _ => None,
                }
            }
            "n" => {
                // Connected UDP sockets and TCP connections name a remote end ("a->b").
                if value.contains("->") {
                    continue;
                }
                let (Some(proto), Some((address, port))) = (protocol, split_endpoint(value)) else {
                    continue;
                };
                ports.push(RawPort {
                    protocol: proto,
                    local_address: address,
                    port,
                    pid,
                    command: command.clone(),
                });
            }
            _ => {}
        }
    }
    dedupe(ports)
}

fn exposure(address: &str) -> PortExposure {
    let bare = address.split('%').next().unwrap_or(address);
    match bare {
        "0.0.0.0" | "::" | "*" | "" => PortExposure::AllInterfaces,
        a if a.starts_with("127.") || a == "::1" || a == "localhost" => PortExposure::Loopback,
        a if a
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.to_canonical().is_loopback()) =>
        {
            PortExposure::Loopback
        }
        _ => PortExposure::Interface,
    }
}

/// Joins raw sockets with the (classified, `all`-scope) process list: names, owners, KalCode
/// labels and workspaces. Sorted by port.
pub fn annotate(raw: &[RawPort], processes: &[ProcessInfo]) -> Vec<ListeningPort> {
    let by_pid: BTreeMap<u32, &ProcessInfo> = processes.iter().map(|p| (p.pid, p)).collect();
    let mut ports: Vec<ListeningPort> = raw
        .iter()
        .map(|r| {
            let process = r.pid.and_then(|pid| by_pid.get(&pid).copied());
            ListeningPort {
                protocol: r.protocol,
                local_address: r.local_address.clone(),
                port: r.port,
                exposure: exposure(&r.local_address),
                pid: r.pid,
                process_name: process
                    .map(|p| p.name.clone())
                    .or_else(|| r.command.clone()),
                owner: process.map(|p| p.owner),
                label: process.map(|p| p.label.clone()),
                workspace_id: process.and_then(|p| p.workspace_id.clone()),
                workspace_name: process.and_then(|p| p.workspace_name.clone()),
            }
        })
        .collect();
    ports.sort_by(|a, b| {
        a.port
            .cmp(&b.port)
            .then(a.protocol.cmp(&b.protocol))
            .then(a.local_address.cmp(&b.local_address))
    });
    ports
}

pub fn list(processes: &[ProcessInfo]) -> Result<PortList> {
    let (raw, source) = list_raw()?;
    Ok(PortList {
        ports: annotate(&raw, processes),
        source: source.to_owned(),
        sampled_at: kalcode_core::time::now_rfc3339(),
    })
}

/// Pids of listening sockets, for the Process Monitor's "related" scope.
pub fn owners(raw: &[RawPort]) -> BTreeMap<u32, Vec<u16>> {
    let mut map: BTreeMap<u32, Vec<u16>> = BTreeMap::new();
    for r in raw {
        if let Some(pid) = r.pid {
            let ports = map.entry(pid).or_default();
            if !ports.contains(&r.port) {
                ports.push(r.port);
            }
        }
    }
    for ports in map.values_mut() {
        ports.sort_unstable();
    }
    map
}

/// "What's using port 3000?" — the matching sockets and one sentence (names only).
pub fn lookup(port: u16, ports: &[ListeningPort]) -> PortLookup {
    let matches: Vec<ListeningPort> = ports.iter().filter(|p| p.port == port).cloned().collect();
    let summary = match matches.first() {
        None => format!("Nothing is listening on port {port}."),
        Some(first) => {
            let who = match (&first.process_name, first.pid) {
                (Some(name), Some(pid)) => format!("{name} (process {pid})"),
                (None, Some(pid)) => format!("process {pid}"),
                (Some(name), None) => name.clone(),
                (None, None) => "a process KalCode can't identify".to_owned(),
            };
            let origin = match (&first.workspace_name, first.owner) {
                (Some(ws), _) => format!(" from the {ws} workspace"),
                (None, Some(ProcessOwner::KalCodeChild)) => ", started by KalCode".to_owned(),
                (None, Some(ProcessOwner::KalCode)) => ", part of KalCode".to_owned(),
                (None, Some(ProcessOwner::System)) => ", a system service".to_owned(),
                _ => String::new(),
            };
            let reach = match first.exposure {
                PortExposure::Loopback => " It accepts connections from this computer only.",
                PortExposure::AllInterfaces => {
                    " It accepts connections from the network unless a firewall blocks them."
                }
                PortExposure::Interface => "",
            };
            let more = if matches.len() > 1 {
                format!(" ({} sockets in total.)", matches.len())
            } else {
                String::new()
            };
            format!("Port {port} is used by {who}{origin}.{reach}{more}")
        }
    };
    PortLookup {
        port,
        matches,
        summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Killability;

    const NETSTAT: &str = "
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1188
  TCP    127.0.0.1:3000         0.0.0.0:0              ABHÖREN         4120
  TCP    127.0.0.1:3000         127.0.0.1:52001        ESTABLISHED     4120
  TCP    192.168.1.20:52002     140.82.112.4:443       ESTABLISHED     900
  TCP    [::]:445               [::]:0                 LISTENING       4
  TCP    [fe80::1%12]:5357      [::]:0                 LISTENING       4
  UDP    0.0.0.0:5353           *:*                                    2500
  UDP    [::1]:1900             *:*                                    3100
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1188
";

    #[test]
    fn netstat_rows_are_read_in_any_language() {
        let ports = parse_netstat(NETSTAT);
        let summary: Vec<(TransportProtocol, &str, u16, Option<u32>)> = ports
            .iter()
            .map(|p| (p.protocol, p.local_address.as_str(), p.port, p.pid))
            .collect();
        assert_eq!(
            summary,
            vec![
                (TransportProtocol::Tcp, "0.0.0.0", 135, Some(1188)),
                (TransportProtocol::Tcp, "127.0.0.1", 3000, Some(4120)),
                (TransportProtocol::Tcp, "::", 445, Some(4)),
                (TransportProtocol::Tcp, "fe80::1%12", 5357, Some(4)),
                (TransportProtocol::Udp, "0.0.0.0", 5353, Some(2500)),
                (TransportProtocol::Udp, "::1", 1900, Some(3100)),
            ]
        );
    }

    #[test]
    fn ss_and_lsof_are_read() {
        let ss = "tcp   LISTEN 0      511        127.0.0.1:3000      0.0.0.0:*    users:((\"node\",pid=7123,fd=20))\n\
                  tcp   LISTEN 0      4096            [::]:22           [::]:*    \n\
                  udp   UNCONN 0      0          0.0.0.0:5353      0.0.0.0:*    users:((\"avahi\",pid=611,fd=12))\n";
        let ports = parse_ss(ss);
        assert_eq!(ports.len(), 3);
        let node = ports.iter().find(|p| p.port == 3000).expect("3000");
        assert_eq!(node.pid, Some(7123));
        assert_eq!(node.command.as_deref(), Some("node"));
        let lsof = "p7123\ncnode\nf20\nPTCP\nn127.0.0.1:3000\np611\ncavahi\nf12\nPUDP\nn*:5353\nf13\nPUDP\nn10.0.0.2:5000->10.0.0.9:5001\n";
        let ports = parse_lsof(lsof);
        assert_eq!(ports.len(), 2);
        assert_eq!(ports[0].command.as_deref(), Some("node"));
        assert_eq!(ports[1].local_address, "*");
    }

    #[test]
    fn ss_scoped_ipv6_addresses_lose_their_bracket_and_zone() {
        let ss = "udp   UNCONN 0      0      [fe80::1c2:3ff:fe4d:5e6f]%eth0:546        [::]:*    users:((\"dhclient\",pid=900,fd=6))
";
        let ports = parse_ss(ss);
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].local_address, "fe80::1c2:3ff:fe4d:5e6f");
        assert_eq!(ports[0].port, 546);
        assert_eq!(ports[0].pid, Some(900));
    }

    fn process(pid: u32, name: &str, owner: ProcessOwner, workspace: Option<&str>) -> ProcessInfo {
        ProcessInfo {
            pid,
            parent_pid: None,
            name: name.into(),
            start_time: "1".into(),
            cpu_percent: None,
            memory_bytes: 0,
            owner,
            role: None,
            label: "x".into(),
            workspace_id: workspace.map(|_| "ws1".to_owned()),
            workspace_name: workspace.map(str::to_owned),
            terminal_id: None,
            terminal_generation: None,
            ports: vec![],
            killable: Killability::Confirm,
            can_restart: false,
        }
    }

    #[test]
    fn ports_are_joined_with_their_processes_and_answered_in_a_sentence() {
        let raw = parse_netstat(NETSTAT);
        let processes = vec![
            process(4120, "node.exe", ProcessOwner::KalCodeChild, Some("shop")),
            process(1188, "svchost.exe", ProcessOwner::System, None),
        ];
        let ports = annotate(&raw, &processes);
        let node = ports.iter().find(|p| p.port == 3000).expect("3000");
        assert_eq!(node.process_name.as_deref(), Some("node.exe"));
        assert_eq!(node.workspace_name.as_deref(), Some("shop"));
        assert_eq!(node.exposure, PortExposure::Loopback);
        let answer = lookup(3000, &ports);
        assert_eq!(
            answer.summary,
            "Port 3000 is used by node.exe (process 4120) from the shop workspace. It accepts connections from this computer only."
        );
        let rpc = lookup(135, &ports);
        assert!(rpc.summary.contains("a system service"), "{}", rpc.summary);
        assert!(rpc.summary.contains("from the network"), "{}", rpc.summary);
        assert_eq!(
            lookup(4000, &ports).summary,
            "Nothing is listening on port 4000."
        );
        let owners = owners(&raw);
        assert_eq!(owners.get(&4120), Some(&vec![3000]));
        assert_eq!(owners.get(&4), Some(&vec![445, 5357]));
    }

    #[test]
    fn the_real_tool_finds_a_port_this_test_opened() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let Ok((raw, _)) = list_raw() else {
            // No port tool on this machine (a minimal CI container): nothing to check.
            return;
        };
        let mine = raw
            .iter()
            .find(|p| p.port == port && p.protocol == TransportProtocol::Tcp)
            .unwrap_or_else(|| panic!("port {port} not listed"));
        if cfg!(windows) {
            assert_eq!(mine.pid, Some(std::process::id()));
        }
        drop(listener);
    }

    #[cfg(windows)]
    #[test]
    fn the_socket_tables_match_netstat_for_this_process() {
        let tcp4 = std::net::TcpListener::bind("127.0.0.1:0").expect("bind tcp4");
        let tcp6 = std::net::TcpListener::bind("[::1]:0").ok();
        let udp4 = std::net::UdpSocket::bind("127.0.0.1:0").expect("bind udp4");
        let me = Some(std::process::id());
        let (native, source) = list_raw().expect("socket tables");
        assert_eq!(source, WINDOWS_SOCKET_TABLES);
        let netstat =
            parse_netstat(&run(&system32().join("netstat.exe"), &["-ano"]).expect("netstat"));
        // Other tests in this process open sockets concurrently, so compare this test's own.
        let port = |addr: std::io::Result<std::net::SocketAddr>| addr.expect("addr").port();
        let mut expected = vec![
            (TransportProtocol::Tcp, "127.0.0.1", port(tcp4.local_addr())),
            (TransportProtocol::Udp, "127.0.0.1", port(udp4.local_addr())),
        ];
        if let Some(tcp6) = &tcp6 {
            expected.push((TransportProtocol::Tcp, "::1", port(tcp6.local_addr())));
        }
        for (protocol, address, port) in expected {
            let row = RawPort {
                protocol,
                local_address: address.to_owned(),
                port,
                pid: me,
                command: None,
            };
            assert!(native.contains(&row), "socket tables miss {row:?}");
            assert!(
                netstat.contains(&row),
                "netstat formats {row:?} differently"
            );
        }
    }

    fn raw(port: u16) -> RawPort {
        RawPort {
            protocol: TransportProtocol::Tcp,
            local_address: "127.0.0.1".into(),
            port,
            pid: Some(42),
            command: None,
        }
    }

    #[test]
    fn the_listener_cache_reuses_a_listing_until_it_expires_or_the_shells_change() {
        let cache = ListenerCache::default();
        let scans = std::sync::atomic::AtomicUsize::new(0);
        let scan = |port| {
            scans.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(vec![raw(port)])
        };
        let ttl = Duration::from_secs(60);
        assert_eq!(
            cache.get_or_scan(&[7, 3], ttl, || scan(1)),
            Some(vec![raw(1)])
        );
        // Same shells in another order: reused.
        assert_eq!(
            cache.get_or_scan(&[3, 7, 7], ttl, || scan(2)),
            Some(vec![raw(1)])
        );
        assert_eq!(scans.load(std::sync::atomic::Ordering::SeqCst), 1);
        // A shell started: listed again.
        assert_eq!(
            cache.get_or_scan(&[3, 7, 9], ttl, || scan(3)),
            Some(vec![raw(3)])
        );
        // Expired: listed again.
        assert_eq!(
            cache.get_or_scan(&[3, 7, 9], Duration::ZERO, || scan(4)),
            Some(vec![raw(4)])
        );
        // An explicit listing refreshes what the background scan reuses.
        cache.store(&[raw(5)]);
        assert_eq!(
            cache.get_or_scan(&[3, 7, 9], ttl, || scan(6)),
            Some(vec![raw(5)])
        );
        assert_eq!(scans.load(std::sync::atomic::Ordering::SeqCst), 3);
        // A failed listing is remembered too, so a missing tool isn't retried on every poll.
        assert_eq!(
            cache.get_or_scan(&[1], ttl, || Err(KalError::internal("x", "y"))),
            None
        );
        assert_eq!(cache.get_or_scan(&[1], ttl, || scan(7)), None);
    }

    #[test]
    fn concurrent_background_scans_share_one_listing() {
        let cache = std::sync::Arc::new(ListenerCache::default());
        let scans = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let (cache, scans, barrier) = (cache.clone(), scans.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    cache.get_or_scan(&[1], Duration::from_secs(60), || {
                        scans.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(50));
                        Ok(vec![raw(1)])
                    })
                })
            })
            .collect();
        for worker in workers {
            assert_eq!(worker.join().expect("worker"), Some(vec![raw(1)]));
        }
        assert_eq!(scans.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
