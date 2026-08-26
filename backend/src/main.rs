//! `t3code-agent` — the Rust agent backend t3code spawns as a provider.
//!
//! t3code drives its providers as child processes over stdio; this binary is
//! that child. It serves the durable agent-sdk `Shell` over stdio ACP, so
//! every t3code session is a durable, gated, resumable agent-sdk run — and
//! agent-sdk-rs stays a pure library (this product crate is the only thing
//! that wires a concrete tool set + default model).
//!
//! t3code's ProviderService maps onto the ACP methods this serves:
//!   startSession       → session/new
//!   sendTurn           → session/prompt
//!   interruptTurn      → session/cancel
//!   respondToRequest   → session/request_permission (answered inline)
//!   readThread/replay  → session/replay
//!   loadSession        → session/load  ("open this thread elsewhere")
//!
//! Config via env (t3code sets these when spawning):
//!   T3CODE_AGENT_DATA   session store root (default: <workspace>/.t3code-agent)
//!   T3CODE_AGENT_MODEL  the PREFERRED default, resolved through the provider
//!                       catalog (`providers::default_model`) — the same catalog
//!                       `server.getConfig` advertises, so this child and the
//!                       model picker can never disagree. Forms:
//!                       claude-resume:<m> | codex-resume:<m> | claude:<m>
//!                       | codex:<m> | ollama:<base_url>|<model>. An unresolvable
//!                       spec falls back to the catalog's first READY instance,
//!                       never to a hard-coded slug.
//!
//! Run: `t3code-agent`  (reads JSON-RPC on stdin, writes on stdout)

use std::sync::Arc;

use agent_sdk_acp::serve;
use agent_sdk_shell::{AgentDefinition, Shell, ShellAcp};

use t3code_agent::{paths, providers, tools};

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    // ONE Hearth PTY per workspace, opened before any session exists and shared
    // by every session and subagent — `cd`/env persist across tool calls and a
    // client can attach to the same screen.
    let (root, agent_data) = paths::workspace_paths();
    let data = agent_data.to_string_lossy().into_owned();
    let registry = tools::coding_registry(root, agent_data)
        .await
        .expect("open the workspace shell");
    let shell = Arc::new(Shell::new(&data, registry));

    // ONE model authority (#148). This child used to carry its own
    // `model_from_env()` with a hard-coded dated slug, so the model it ran and
    // the model `server.getConfig` advertised could disagree — and a user
    // switching models in the picker would still be talking to whatever this
    // default said. The catalog is the runtime truth for both.
    //
    // `None` is a REAL state (every provider disabled or misconfigured), and it
    // fails here loudly rather than substituting: a child that quietly runs a
    // model the picker does not list is the bug this deletion is about.
    let catalog = providers::catalog();
    let model = providers::default_model(&catalog).unwrap_or_else(|| {
        let configured: Vec<String> = catalog
            .snapshots()
            .iter()
            .map(|s| format!("{} ({:?})", s.instance_id, s.status))
            .collect();
        panic!(
            "no routable provider: nothing in the catalog can run a turn. Configured: [{}]",
            configured.join(", ")
        )
    });

    let default_definition = AgentDefinition {
        name: "t3code".into(),
        instructions: "You are a coding agent. Be concise and precise.".into(),
        model,
        tools: vec![],      // empty = offer the whole registry
        ask_tools: vec![],  // t3code's runtime-mode UI can flip these to Ask
        subagents: vec![],
        mcp_servers: vec![],
        labels: Default::default(), options: vec![], cwd: None,
    };

    let acp = ShellAcp { shell, default_definition };
    serve(tokio::io::stdin(), tokio::io::stdout(), Arc::new(acp)).await;
}
