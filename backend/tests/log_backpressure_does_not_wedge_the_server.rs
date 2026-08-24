//! PROOF (#404): the server keeps answering when NOBODY DRAINS ITS STDOUT.
//!
//! #404 was reported as "the server hangs under the real UI": the app sat on
//! "Reconnecting to Local (Rust)" forever, every HTTP path timed out, no WS
//! upgrade completed, and yet the process was alive and the port still
//! accepted TCP. It was filed against a lock or a lost wakeup on the four
//! startup subscriptions. It was neither.
//!
//! `tracing_subscriber::fmt()` writes each line SYNCHRONOUSLY on the thread
//! that emits it, and those are tokio WORKER threads. When stdout is a pipe
//! whose reader never drains it — how a parent process (a dev launcher, an
//! Electron shell, `subprocess.PIPE`) spawns this binary — `write(2)` blocks
//! once the 64KB pipe buffer fills. Every worker thread that logs parks in the
//! kernel; when they are all parked the runtime runs NOTHING. The listening
//! socket still accepts because that is the kernel backlog, not this process,
//! so from outside it looks alive and simply never answers.
//!
//! Why no existing test caught it: 108 in-process backend tests and the whole
//! frontend suite pass against this exact binary, because a test harness never
//! leaves a full pipe attached to a running server. The bug lives entirely in
//! how the process is SPAWNED, so only a test that spawns it can see it.
//!
//! This test fails (times out on the probe) against a synchronous writer and
//! passes against the non-blocking one. The subscriptions are not special —
//! they are only a convenient way to generate log volume; any logging endpoint
//! reproduces it.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Well past the 64KB pipe buffer. The unfixed server wedged at roughly 400
/// requests over 100 sockets; this drives 4x that.
const ROUNDS: usize = 400;
const SUBS: &[&str] = &[
    "subscribeServerConfig",
    "subscribeVcsStatus",
    "subscribeServerLifecycle",
    "server.getConfig",
];

fn ws_text_frame(payload: &str) -> Vec<u8> {
    let b = payload.as_bytes();
    let mut f = vec![0x81u8];
    // client->server frames must be masked; a zero mask keeps the payload
    // readable and is still a legal mask.
    if b.len() < 126 {
        f.push(0x80 | b.len() as u8);
    } else {
        f.push(0x80 | 126);
        f.extend_from_slice(&(b.len() as u16).to_be_bytes());
    }
    f.extend_from_slice(&[0, 0, 0, 0]);
    f.extend_from_slice(b);
    f
}

fn connect(port: u16) -> std::io::Result<TcpStream> {
    let addr = format!("127.0.0.1:{port}").to_socket_addrs()?.next().unwrap();
    let s = TcpStream::connect_timeout(&addr, Duration::from_secs(3))?;
    s.set_read_timeout(Some(Duration::from_secs(3)))?;
    s.set_write_timeout(Some(Duration::from_secs(3)))?;
    Ok(s)
}

/// A plain HTTP GET with a hard deadline. This is the probe that hangs when the
/// runtime is wedged — note it does not even need a route that exists.
fn probe(port: u16, timeout: Duration) -> Result<(), String> {
    let mut s = connect(port).map_err(|e| format!("connect: {e}"))?;
    s.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    s.write_all(
        format!("GET /api/orchestration/shell HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    )
    .map_err(|e| format!("write: {e}"))?;
    let mut buf = [0u8; 64];
    match s.read(&mut buf) {
        Ok(0) => Err("server closed without answering".into()),
        Ok(n) => {
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            if head.starts_with("HTTP/1.1") {
                Ok(())
            } else {
                Err(format!("not an HTTP response: {head:?}"))
            }
        }
        Err(e) => Err(format!("read: {e}")),
    }
}

#[test]
fn a_server_whose_stdout_pipe_is_never_drained_keeps_serving() {
    let dir = tempfile::tempdir().expect("tempdir");
    // AN OS-ASSIGNED PORT, NOT A FIXED ONE.
    //
    // This was hardcoded to 13931, which broke the test in two different ways,
    // both of which manufacture a FALSE #404 signal:
    //
    //  1. Several agents run this suite against this repo at once. Two runs, or
    //     one run plus a leaked child from a killed run, collide on the port —
    //     the second child cannot bind and the test reports `server never bound`
    //     as though the server were wedged.
    //  2. Worse, a FOREIGN listener on that port SATISFIES the readiness check
    //     below, because a bare TCP connect succeeds against anything holding
    //     the socket. The test then sails past bind-wait and fails in the probe
    //     with a read timeout — which is exactly the shape of the real #404
    //     wedge (accepts, never answers) while having nothing to do with it.
    //     Verified: with an unrelated listener parked on 13931 this test fails
    //     `server must answer before any load: read: Resource temporarily
    //     unavailable`, indistinguishable from the bug it exists to detect.
    //
    // Asking the kernel for a free port removes both. The listener is dropped
    // before the child spawns; the window is a few microseconds and, unlike a
    // fixed port, it is not GUARANTEED to collide under parallel agents.
    let port: u16 = {
        let probe_listener =
            std::net::TcpListener::bind("127.0.0.1:0").expect("reserve an ephemeral port");
        probe_listener.local_addr().expect("local_addr").port()
    };

    // THE WHOLE POINT: `Stdio::piped()` and then never reading it. Swap this
    // for `Stdio::null()` and the test passes even against the broken build,
    // which is precisely why the bug survived every existing test.
    let mut child = Command::new(env!("CARGO_BIN_EXE_t3code-server"))
        .env("T3CODE_SERVER_PORT", port.to_string())
        .env("T3CODE_WORKSPACE", dir.path())
        .env("T3CODE_AGENT_DATA", dir.path().join("data"))
        .env("RUST_LOG", "t3code_server=info")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn t3code-server");

    // Kill the child on every exit path, including a panicking assert.
    struct Reap(std::process::Child);
    impl Drop for Reap {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    // Take the pipes but NEVER read them WHILE THE SERVER IS RUNNING. That is
    // the invariant under test — a full pipe is the whole reproduction — so
    // these stay untouched for the duration. They are read only on the failure
    // path below, once the run is already over and draining can no longer
    // affect the outcome.
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let mut reap = Reap(child);

    /// Why the child is not answering — killed, reaped, and drained.
    ///
    /// Without this the bind timeout reported `server never bound` and nothing
    /// else, which is mute at exactly the moment it matters: it cannot tell a
    /// REAL #404 wedge (process alive, port accepting, no answer) from a
    /// fixture failure (port already in use, missing env, an early panic).
    /// A regression test that cannot say which of those happened is not
    /// evidence in either direction.
    fn postmortem(
        reap: &mut Reap,
        stdout: &mut Option<std::process::ChildStdout>,
        stderr: &mut Option<std::process::ChildStderr>,
    ) -> String {
        // Distinguish "still running and wedged" from "already dead" BEFORE
        // killing it — that difference is the entire diagnosis.
        let alive = match reap.0.try_wait() {
            Ok(None) => "still running (so this is a WEDGE, not a crash)".to_string(),
            Ok(Some(st)) => format!("already exited with {st} (so this is a STARTUP FAILURE, not a wedge)"),
            Err(e) => format!("could not determine child status: {e}"),
        };
        let _ = reap.0.kill();
        let _ = reap.0.wait();
        // Safe to drain now: the process is dead, so nothing about the
        // never-drained invariant can be disturbed by reading its leftovers.
        let mut out = String::new();
        let mut err = String::new();
        if let Some(p) = stdout.as_mut() {
            let _ = p.read_to_string(&mut out);
        }
        if let Some(p) = stderr.as_mut() {
            let _ = p.read_to_string(&mut err);
        }
        let tail = |s: &str| -> String {
            let lines: Vec<&str> = s.lines().collect();
            let start = lines.len().saturating_sub(40);
            lines[start..].join("\n")
        };
        format!(
            "child status: {alive}\n\
             ── child stderr (last 40 lines, {} bytes total) ──\n{}\n\
             ── child stdout (last 40 lines, {} bytes total) ──\n{}",
            err.len(),
            tail(&err),
            out.len(),
            tail(&out),
        )
    }

    // Wait for the server to be READY, which means ANSWERING — not merely
    // holding the socket. A bare `connect().is_ok()` is satisfied by any
    // process on the port, so readiness has to be an actual HTTP reply or the
    // test cannot tell our server from a stranger's. It is also the honest
    // check: this test's whole subject is a server that accepts and does not
    // answer, so "accepts" was never an adequate definition of up.
    let boot = Instant::now();
    loop {
        if probe(port, Duration::from_secs(2)).is_ok() {
            break;
        }
        if boot.elapsed() >= Duration::from_secs(60) {
            panic!(
                "server never answered on {port} in 60s.\n{}",
                postmortem(&mut reap, &mut stdout_pipe, &mut stderr_pipe)
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    probe(port, Duration::from_secs(10)).expect("server must answer before any load");

    // Drive real WS upgrades + subscriptions to generate log volume. Sockets
    // are held open (the reported wedge had two live sockets), so this also
    // keeps the connection tasks alive.
    let mut held = Vec::new();
    let mut id = 0usize;
    for _ in 0..ROUNDS {
        let mut c = match connect(port) {
            Ok(c) => c,
            // A refused/timed-out connect once the server is wedged is itself
            // the failure; report it as one rather than silently stopping.
            Err(e) => panic!("server stopped accepting after {id} requests: {e}"),
        };
        let key = "dGhlIHNhbXBsZSBub25jZQ==";
        let req = format!(
            "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n\
             Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        if c.write_all(req.as_bytes()).is_err() {
            panic!("server stopped reading the WS handshake after {id} requests");
        }
        let mut buf = [0u8; 256];
        match c.read(&mut buf) {
            Ok(n) if String::from_utf8_lossy(&buf[..n]).contains("101") => {}
            Ok(n) => panic!(
                "no WS upgrade after {id} requests: {:?}",
                String::from_utf8_lossy(&buf[..n.min(80)])
            ),
            Err(e) => panic!("WS upgrade never completed after {id} requests: {e}"),
        }
        for tag in SUBS {
            id += 1;
            let frame = ws_text_frame(&format!(
                r#"{{"_tag":"Request","id":"{id}","tag":"{tag}","payload":{{}}}}"#
            ));
            let _ = c.write_all(&frame);
        }
        held.push(c);
    }

    // THE ASSERTION. A wedged server fails this by timing out, not by
    // answering wrongly — so the timeout has to be short enough to be a
    // verdict and long enough not to be flaky under a loaded machine.
    probe(port, Duration::from_secs(10)).unwrap_or_else(|e| {
        panic!(
            "the server stopped answering after {id} requests over {} sockets \
             with an undrained stdout pipe: {e}. A log write must never be able \
             to park a runtime worker thread (#404).",
            held.len()
        )
    });
}
