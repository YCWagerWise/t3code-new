//! Product-level crash recovery proof: spawn the real `t3code-server`, write a
//! thread through its WebSocket RPC path, kill the process with SIGKILL, then
//! restart the binary and read the thread back.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("ephemeral port");
    listener.local_addr().expect("local_addr").port()
}

fn connect(port: u16) -> std::io::Result<TcpStream> {
    let addr = format!("127.0.0.1:{port}")
        .to_socket_addrs()?
        .next()
        .unwrap();
    let s = TcpStream::connect_timeout(&addr, Duration::from_secs(3))?;
    s.set_read_timeout(Some(Duration::from_secs(3)))?;
    s.set_write_timeout(Some(Duration::from_secs(3)))?;
    Ok(s)
}

fn probe(port: u16, timeout: Duration) -> Result<(), String> {
    let mut s = connect(port).map_err(|e| format!("connect: {e}"))?;
    s.set_read_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    s.write_all(
        b"GET /.well-known/t3/environment HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    )
    .map_err(|e| format!("write: {e}"))?;
    let mut buf = [0u8; 64];
    match s.read(&mut buf) {
        Ok(0) => Err("server closed without answering".into()),
        Ok(n) if String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1") => Ok(()),
        Ok(n) => Err(format!(
            "not an HTTP response: {:?}",
            String::from_utf8_lossy(&buf[..n])
        )),
        Err(e) => Err(format!("read: {e}")),
    }
}

fn wait_ready(port: u16, child: &mut Child) {
    let start = Instant::now();
    loop {
        if probe(port, Duration::from_secs(2)).is_ok() {
            return;
        }
        if let Some(status) = child.try_wait().expect("child status") {
            panic!("t3code-server exited before readiness: {status}");
        }
        if start.elapsed() > Duration::from_secs(60) {
            panic!("t3code-server never answered on {port}");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn spawn_server(port: u16, workspace: &std::path::Path, data: &std::path::Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_t3code-server"))
        .env("T3CODE_SERVER_PORT", port.to_string())
        .env("T3CODE_WORKSPACE", workspace)
        .env("T3CODE_AGENT_DATA", data)
        .env("T3CODE_AGENT_MODEL", "ollama:http://127.0.0.1:9|crash-test")
        .env("T3CODE_OLLAMA_URL", "http://127.0.0.1:9")
        .env("T3CODE_OLLAMA_MODELS", "crash-test")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn t3code-server")
}

fn ws_text_frame(payload: &str) -> Vec<u8> {
    let b = payload.as_bytes();
    let mut f = vec![0x81u8];
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

fn ws_connect(port: u16) -> TcpStream {
    let mut s = connect(port).expect("tcp connect");
    let key = "dGhlIHNhbXBsZSBub25jZQ==";
    let req = format!(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n\
         Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    s.write_all(req.as_bytes()).expect("write ws handshake");
    let mut buf = [0u8; 512];
    let n = s.read(&mut buf).expect("read ws handshake");
    assert!(
        String::from_utf8_lossy(&buf[..n]).contains("101"),
        "websocket upgrade failed: {:?}",
        String::from_utf8_lossy(&buf[..n])
    );
    s
}

fn ws_send(s: &mut TcpStream, id: &str, tag: &str, payload: Value) {
    let frame = json!({ "_tag": "Request", "id": id, "tag": tag, "payload": payload });
    s.write_all(&ws_text_frame(&frame.to_string()))
        .expect("write ws frame");
}

fn ws_read_text(s: &mut TcpStream) -> Value {
    let mut head = [0u8; 2];
    s.read_exact(&mut head).expect("read ws header");
    let opcode = head[0] & 0x0f;
    assert_eq!(opcode, 1, "expected text frame, got opcode {opcode}");
    let masked = head[1] & 0x80 != 0;
    let mut len = (head[1] & 0x7f) as u64;
    if len == 126 {
        let mut b = [0u8; 2];
        s.read_exact(&mut b).expect("read ws len16");
        len = u16::from_be_bytes(b) as u64;
    } else if len == 127 {
        let mut b = [0u8; 8];
        s.read_exact(&mut b).expect("read ws len64");
        len = u64::from_be_bytes(b);
    }
    let mut mask = [0u8; 4];
    if masked {
        s.read_exact(&mut mask).expect("read ws mask");
    }
    let mut payload = vec![0u8; len as usize];
    s.read_exact(&mut payload).expect("read ws payload");
    if masked {
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= mask[i % 4];
        }
    }
    serde_json::from_slice(&payload).expect("json ws frame")
}

fn read_until<F>(s: &mut TcpStream, timeout: Duration, mut pred: F) -> Value
where
    F: FnMut(&Value) -> bool,
{
    let deadline = Instant::now() + timeout;
    loop {
        let now = Instant::now();
        assert!(
            now < deadline,
            "timed out waiting for matching websocket frame"
        );
        s.set_read_timeout(Some(deadline - now)).unwrap();
        let frame = ws_read_text(s);
        if pred(&frame) {
            return frame;
        }
    }
}

fn chunk_contains_thread(frame: &Value, thread_id: &str) -> bool {
    frame["_tag"] == "Chunk"
        && frame["values"].as_array().is_some_and(|values| {
            values.iter().any(|v| {
                (v["kind"] == "thread-upserted" && v["thread"]["id"] == thread_id)
                    || (v["kind"] == "snapshot" && v["snapshot"]["thread"]["id"] == thread_id)
            })
        })
}

#[test]
fn a_sigkilled_server_recovers_a_thread_written_before_the_crash() {
    let env = tempfile::tempdir().expect("tempdir");
    let workspace = env.path().join("workspace");
    let data = env.path().join("data");
    std::fs::create_dir_all(&workspace).unwrap();
    let port = free_port();
    let thread_id = "t-crash-recover";

    let mut first = spawn_server(port, &workspace, &data);
    wait_ready(port, &mut first);
    let mut ws = ws_connect(port);
    ws_send(
        &mut ws,
        "sub-shell",
        "orchestration.subscribeShell",
        json!({}),
    );
    ws_send(
        &mut ws,
        "start",
        "orchestration.dispatchCommand",
        json!({ "input": {
            "type": "thread.turn.start",
            "commandId": "cmd-crash",
            "threadId": thread_id,
            "message": {
                "messageId": "m-crash",
                "role": "user",
                "text": "persist this before crash",
                "attachments": []
            },
            "runtimeMode": "full-access",
            "interactionMode": "default",
            "modelSelection": { "instanceId": "ollama_local", "model": "crash-test" },
            "bootstrap": { "createThread": {
                "projectId": "p-workspace",
                "title": "Crash recovery",
                "runtimeMode": "full-access",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": workspace,
            }}
        }}),
    );
    read_until(&mut ws, Duration::from_secs(10), |f| {
        chunk_contains_thread(f, thread_id)
    });

    first.kill().expect("SIGKILL first server");
    let status = first.wait().expect("wait killed server");
    assert!(
        !status.success(),
        "the first server must not exit gracefully"
    );

    let mut second = spawn_server(port, &workspace, &data);
    wait_ready(port, &mut second);
    let mut ws2 = ws_connect(port);
    ws_send(
        &mut ws2,
        "sub-thread",
        "orchestration.subscribeThread",
        json!({ "threadId": thread_id }),
    );
    let frame = read_until(&mut ws2, Duration::from_secs(10), |f| {
        chunk_contains_thread(f, thread_id)
    });
    assert_eq!(
        frame["values"][0]["snapshot"]["thread"]["id"], thread_id,
        "the restarted server did not recover the pre-crash thread: {frame}"
    );

    let _ = second.kill();
    let _ = second.wait();
}
