use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::*;

/// A sink that records each delivery with the time it arrived.
fn recording(config: CoalesceConfig) -> (OutputCoalescer, Receiver<(Instant, Vec<u8>)>) {
    let (tx, rx) = channel();
    let coalescer = OutputCoalescer::new(config, move |bytes| {
        let _ = tx.send((Instant::now(), bytes));
        true
    });
    (coalescer, rx)
}

fn config(interval_ms: u64, max_bytes: usize) -> CoalesceConfig {
    CoalesceConfig {
        interval: Duration::from_millis(interval_ms),
        max_bytes,
    }
}

fn drain(rx: &Receiver<(Instant, Vec<u8>)>) -> Vec<Vec<u8>> {
    rx.try_iter().map(|(_, bytes)| bytes).collect()
}

#[test]
fn first_push_is_delivered_alone_and_at_once_even_when_empty() {
    let (coalescer, rx) = recording(config(10_000, 1 << 20));
    assert!(coalescer.push(b""));
    assert_eq!(
        drain(&rx),
        vec![Vec::<u8>::new()],
        "the empty replay is still a message"
    );
    // Live output right after the replay is never merged into it.
    assert!(coalescer.push(b"live"));
    assert!(drain(&rx).is_empty(), "inside the interval: buffered");
    drop(coalescer);
    assert_eq!(drain(&rx), vec![b"live".to_vec()]);
}

#[test]
fn an_isolated_chunk_after_a_quiet_interval_is_delivered_without_delay() {
    let (coalescer, rx) = recording(config(8, 1 << 20));
    assert!(coalescer.push(b"replay"));
    let _ = drain(&rx);
    for key in [b"a", b"b", b"c"] {
        // Typing: each echo arrives after the view has been quiet for longer than an interval.
        std::thread::sleep(Duration::from_millis(30));
        let pushed = Instant::now();
        assert!(coalescer.push(key));
        let (at, bytes) = rx
            .recv_timeout(Duration::from_millis(1))
            .expect("delivered synchronously by the push itself");
        assert_eq!(bytes, key.to_vec());
        assert!(at.duration_since(pushed) < Duration::from_millis(1));
    }
}

#[test]
fn output_inside_an_interval_is_delivered_by_the_timer_within_a_frame() {
    let (coalescer, rx) = recording(config(8, 1 << 20));
    assert!(coalescer.push(b"replay"));
    let _ = drain(&rx);
    let mut latencies = Vec::new();
    for _ in 0..20 {
        std::thread::sleep(Duration::from_millis(30));
        assert!(coalescer.push(b"lead")); // leading edge: immediate
        let pushed = Instant::now();
        assert!(coalescer.push(b"trail")); // inside the interval: the timer delivers it
        let (_, lead) = rx.recv().expect("lead");
        assert_eq!(lead, b"lead");
        let (at, trail) = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("the timer delivers buffered output");
        assert_eq!(trail, b"trail");
        latencies.push(at.duration_since(pushed));
    }
    latencies.sort();
    let worst = latencies[latencies.len() - 1];
    // 8 ms interval; Windows timer granularity can stretch a wait to one 15.6 ms tick. A loaded
    // CI machine gets generous headroom, the bound only catches a stuck or missing timer.
    assert!(
        worst < Duration::from_millis(100),
        "trailing latencies {latencies:?}"
    );
}

#[test]
fn reaching_the_size_cap_delivers_immediately_without_the_timer() {
    let (coalescer, rx) = recording(config(10_000, 1024));
    assert!(coalescer.push(b""));
    let _ = drain(&rx);
    assert!(coalescer.push(&[b'x'; 600]));
    assert!(drain(&rx).is_empty());
    assert!(coalescer.push(&[b'y'; 600]));
    let delivered = drain(&rx);
    assert_eq!(delivered.len(), 1, "the cap delivers at once");
    assert_eq!(delivered[0].len(), 1200);
}

#[test]
fn dropping_the_coalescer_delivers_what_it_still_buffers() {
    let (coalescer, rx) = recording(config(10_000, 1 << 20));
    assert!(coalescer.push(b"replay"));
    assert!(coalescer.push(b"tail-1"));
    assert!(coalescer.push(b"tail-2"));
    let before = drain(&rx);
    assert_eq!(before, vec![b"replay".to_vec()]);
    drop(coalescer);
    assert_eq!(drain(&rx), vec![b"tail-1tail-2".to_vec()]);
}

#[test]
fn a_refusing_sink_detaches_the_listener() {
    let open = Arc::new(AtomicBool::new(true));
    let gate = open.clone();
    let coalescer = OutputCoalescer::new(config(0, 1 << 20), move |_| gate.load(Ordering::SeqCst));
    assert!(coalescer.push(b"replay"));
    open.store(false, Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(2));
    assert!(
        !coalescer.push(b"refused"),
        "the refusing delivery reports false"
    );
    assert!(!coalescer.push(b"later"), "and every later push too");
}

#[test]
fn concurrent_producer_and_timer_keep_every_byte_in_order() {
    let delivered = Arc::new(Mutex::new(Vec::new()));
    let sink = delivered.clone();
    let deliveries = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = deliveries.clone();
    let coalescer = OutputCoalescer::new(config(1, 4096), move |bytes| {
        counter.fetch_add(1, Ordering::SeqCst);
        sink.lock().expect("lock").extend_from_slice(&bytes);
        true
    });
    let mut expected = Vec::new();
    assert!(coalescer.push(b""));
    for index in 0u32..200_000 {
        // Odd sizes and occasional pauses interleave cap, leading-edge and timer deliveries.
        let chunk = index.to_le_bytes();
        let chunk = &chunk[..1 + (index % 4) as usize];
        expected.extend_from_slice(chunk);
        assert!(coalescer.push(chunk));
        if index % 20_000 == 0 {
            std::thread::sleep(Duration::from_millis(3));
        }
    }
    drop(coalescer);
    assert_eq!(*delivered.lock().expect("lock"), expected);
    assert!(deliveries.load(Ordering::SeqCst) < 200_000 / 10);
}
