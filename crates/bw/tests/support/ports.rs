use std::net::TcpListener;
use std::sync::atomic::{AtomicU32, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);

/// A free 127.0.0.1 port in 20000..32000, below the ephemeral ranges of macOS (49152+) and Linux (32768+).
/// A port from `bind(0)` that a test frees and binds later can meanwhile become an outgoing connection's
/// source port, so a later bind fails with AddrInUse; ports in this range are never handed out that way.
pub fn free_port() -> u16 {
    let seed = std::process::id().wrapping_mul(7919);
    for _ in 0..12_000 {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let port = 20_000 + (seed.wrapping_add(n) % 12_000) as u16;
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    panic!("no free 127.0.0.1 port in 20000..32000");
}
