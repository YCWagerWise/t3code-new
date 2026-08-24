//! PROOF (#28): `run_bash` is ONE durable Hearth PTY per workspace, not a
//! disposable subprocess per call.
//!
//! The defect this pins down: a fresh `hearth::session::Session` per action
//! call throws away the only thing a PTY is for. The agent runs `cd build`,
//! the next call is back in the workspace root, and the model reasons about a
//! shell that does not exist. These tests drive the REAL registry the product
//! wires (`tools::coding_tools`) through the `Action` trait, so they fail if
//! anyone reintroduces a per-call shell.

use agent_sdk_core::{Ctx, Registry};
use serde_json::{json, Value};
use t3code_agent::tools;

/// The minimal Ctx an Action needs; these tools ignore it entirely.
struct NoCtx;
impl Ctx for NoCtx {}

async fn call(reg: &Registry, name: &str, args: Value) -> Value {
    let desc = reg
        .descriptors()
        .find(|d| d.name == name)
        .unwrap_or_else(|| panic!("tool `{name}` is registered"))
        .clone();
    let action = reg.get(&desc.key).expect("action for descriptor");
    action.call_json(&NoCtx, args).await.unwrap_or_else(|e| panic!("{name}: {e}"))
}

async fn workspace() -> (std::path::PathBuf, Registry) {
    let dir = std::env::temp_dir().join(format!("t3-shell-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    let data = dir.join(".t3code-agent");
    let runner = tools::open_workspace_shell(&dir, data.clone()).await.expect("open shell");
    let reg = tools::coding_tools(dir.clone(), data.join("checkpoints"), runner);
    (dir, reg)
}

/// `cd` and `export` in one tool call are still in effect in the next one —
/// the shell is a session, not a subprocess.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cd_and_export_persist_across_two_tool_calls() {
    let (dir, reg) = workspace().await;

    call(&reg, "run_bash", json!({"command": "cd sub && export T3_MARKER=kept"})).await;

    let pwd = call(&reg, "run_bash", json!({"command": "pwd"})).await;
    let pwd = pwd["output"].as_str().unwrap();
    assert!(pwd.contains("sub"), "the second call is still in the directory the first cd'd to: {pwd}");

    let marker = call(&reg, "run_bash", json!({"command": "echo \"[$T3_MARKER]\""})).await;
    let marker = marker["output"].as_str().unwrap();
    assert!(marker.contains("[kept]"), "exported env survived the call boundary: {marker}");

    // the exit code is honest, not swallowed. NOTE the subshell: `exit 3`
    // unqualified would end the session's own shell — which is itself proof
    // that this is one long-lived PTY and not a throwaway subprocess.
    let bad = call(&reg, "run_bash", json!({"command": "bash -c 'exit 3'"})).await;
    assert_eq!(bad["exit_code"], json!(3), "the real exit code comes back: {bad}");

    // the session is still alive and still where we left it after that failure
    let pwd = call(&reg, "run_bash", json!({"command": "pwd"})).await;
    assert!(pwd["output"].as_str().unwrap().contains("sub"), "a failed command did not reset the shell");

    let _ = std::fs::remove_dir_all(&dir);
}

/// The PTY the agent typed into is the PTY a human can look at: `read_screen`
/// returns the live screen of the SAME session, identified by a stable id.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_same_pty_is_inspectable_and_identified() {
    let (dir, reg) = workspace().await;

    let ran = call(&reg, "run_bash", json!({"command": "echo T3-SCREEN-PROBE"})).await;
    let sid = ran["session_id"].as_str().unwrap().to_string();
    assert!(!sid.is_empty(), "run_bash names the PTY it ran in");

    let screen = call(&reg, "read_screen", json!({})).await;
    assert_eq!(screen["session_id"].as_str().unwrap(), sid, "one session, one id");
    assert!(
        screen["screen"].as_str().unwrap().contains("T3-SCREEN-PROBE"),
        "the human-visible screen shows what the agent ran: {}",
        screen["screen"]
    );

    // the snapshot reports the PTY's launch directory and liveness — and says
    // so; the live cwd is the shell's business, visible on the screen.
    assert_eq!(screen["workdir"].as_str().unwrap(), dir.to_string_lossy(), "workdir is the launch dir");
    assert_eq!(screen["status"], json!("running"), "the PTY is alive between calls: {screen}");

    // the screen accumulates across calls — it is one continuous terminal
    call(&reg, "run_bash", json!({"command": "echo T3-SECOND-PROBE"})).await;
    let screen = call(&reg, "read_screen", json!({})).await;
    let text = screen["screen"].as_str().unwrap();
    assert!(text.contains("T3-SECOND-PROBE"), "the later command is on the same screen: {text}");

    // the id is derived from the workspace, so a restart reattaches to it
    assert_eq!(tools::workspace_id(&dir), sid, "the id is stable across process lifetimes");

    let _ = std::fs::remove_dir_all(&dir);
}

/// PROOF (#44): a PTY that died explains itself THROUGH the tool boundary.
///
/// Hearth knows the exit code; if `read_screen` drops it, the agent sees a
/// blank pane and cannot tell a clean `exit` from a crash — or read the code a
/// script died on. This drives the real registry, not the session directly.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_screen_reports_why_the_shell_died() {
    let (dir, reg) = workspace().await;

    // a live shell first, so the screen has real content to retain
    call(&reg, "run_bash", json!({"command": "echo alive-in-pty"})).await;
    let live = call(&reg, "read_screen", json!({})).await;
    assert_eq!(live["status"], "running", "{live}");
    assert!(live.get("exit_code").is_none(), "a running shell has no exit code: {live}");

    // kill it from inside with a code a human would want to see
    call(&reg, "run_bash", json!({"command": "exit 7"})).await;

    let dead = call(&reg, "read_screen", json!({})).await;
    assert_eq!(dead["status"], "exited", "the death is visible at the tool boundary: {dead}");
    assert_eq!(dead["exit_code"], 7, "the exit code survives to the agent: {dead}");
    assert!(
        dead["screen"].as_str().unwrap_or_default().contains("alive-in-pty"),
        "the final screen is retained, not blanked: {dead}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// PROOF (#207): a thread running in a WORKTREE edits that worktree, not the
/// workspace root the server booted in.
///
/// The registry factory takes the `AgentDefinition` precisely so the host can
/// vary tools per agent. It used to ignore it (`|_def|`) and close over the
/// boot-time root, so every worktree thread's `write_file`/`read_file` landed
/// in the MAIN checkout while the UI showed the worktree — silent, and only
/// visible once the wrong branch had the edits.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worktree_thread_writes_into_its_own_checkout() {
    let root = std::env::temp_dir().join(format!("t3-wt-{}", uuid::Uuid::new_v4()));
    let worktree = root.join("wt");
    std::fs::create_dir_all(&worktree).unwrap();
    let data = root.join(".t3code-agent");
    let runner = tools::open_workspace_shell(&root, data.clone()).await.expect("open shell");

    let factory = tools::coding_registry_with_runner(root.clone(), data.clone(), runner).await;

    let mut def = agent_sdk_shell::AgentDefinition {
        name: "t3code".into(),
        instructions: String::new(),
        model: agent_sdk_shell::ModelRef::ClaudeCli { model: "x".into() },
        tools: vec![],
        ask_tools: vec![],
        subagents: vec![],
        mcp_servers: vec![],
        labels: Default::default(), options: vec![],
        cwd: None,
    };

    // no cwd: the host root, as before.
    call(&factory(&def), "write_file", json!({"path": "root.txt", "content": "at root\n"})).await;
    assert!(root.join("root.txt").exists(), "a cwd-less agent still writes at the host root");

    // with cwd: the SAME factory builds tools rooted in the worktree.
    def.cwd = Some(worktree.to_string_lossy().into_owned());
    let reg = factory(&def);
    call(&reg, "write_file", json!({"path": "wt.txt", "content": "in the worktree\n"})).await;

    assert!(
        worktree.join("wt.txt").exists(),
        "the write landed in the worktree the thread runs in"
    );
    assert!(
        !root.join("wt.txt").exists(),
        "and NOT in the workspace root — that is the bug this pins"
    );

    // reads are re-rooted too, or the agent writes one file and reads another.
    let back = call(&reg, "read_file", json!({"path": "wt.txt"})).await;
    let text = serde_json::to_string(&back).unwrap();
    assert!(text.contains("in the worktree"), "read_file resolves against the worktree: {text}");

    // the worktree agent cannot reach the root file by its bare name. This one
    // is expected to FAIL, so it goes through the raw action rather than the
    // unwrapping helper.
    let desc = reg.descriptors().find(|d| d.name == "read_file").unwrap().clone();
    let action = reg.get(&desc.key).unwrap();
    let root_file = action.call_json(&NoCtx, json!({"path": "root.txt"})).await;
    let root_text = format!("{root_file:?}");
    assert!(
        !root_text.contains("at root"),
        "a worktree agent does not silently read the main checkout: {root_text}"
    );

    let _ = std::fs::remove_dir_all(&root);
}
