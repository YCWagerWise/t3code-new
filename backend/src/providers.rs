//! The backend's provider catalog: ONE [`Catalog`] that both the model picker
//! and the turn router read.
//!
//! This file is deliberately thin. Everything structural — the open driver
//! vocabulary, per-instance availability, secret redaction, option descriptors,
//! reconcile semantics, and selection→`ModelRef` resolution — lives in
//! `agent-sdk-shell`/`agent-sdk-provider`. What belongs here is only the
//! product's own question: which instances does THIS install have configured?

use agent_sdk_provider::instance::ProviderInstanceConfig;
use agent_sdk_shell::{Catalog, ModelRef, DRIVER_CLAUDE, DRIVER_CODEX, DRIVER_OPENAI_COMPAT};
use serde_json::{json, Value};

/// Configured instances for this install.
///
/// Claude and Codex are always offered (they are CLI-auth backends — present or
/// not, the user must be able to see and pick them). An OpenAI-compatible
/// endpoint is offered whenever one is configured, which is what makes Ollama a
/// first-class choice instead of an env-only backdoor (#36):
///
///   T3CODE_OLLAMA_URL=http://localhost:11434
///   T3CODE_OLLAMA_MODELS=qwen2.5-coder,llama3.1
///
/// `T3CODE_AGENT_MODEL=ollama:<base>|<model>` also implies an instance, so the
/// env var that used to be the ONLY way to reach Ollama now puts it in the
/// picker rather than bypassing it.
pub fn configured_instances() -> Vec<ProviderInstanceConfig> {
    let mut out = vec![
        instance("claudeAgent", DRIVER_CLAUDE, "Claude", json!({})),
        instance("codex", DRIVER_CODEX, "Codex", json!({})),
    ];
    if let Some((base, models)) = ollama_from_env() {
        out.push(instance(
            "ollama_local",
            DRIVER_OPENAI_COMPAT,
            "Ollama",
            json!({ "baseUrl": base, "models": models }),
        ));
    }
    out
}

/// The OpenAI-compatible endpoint this install is pointed at, if any.
fn ollama_from_env() -> Option<(String, Vec<String>)> {
    let explicit = std::env::var("T3CODE_OLLAMA_URL").ok().filter(|s| !s.trim().is_empty());
    // the legacy single-model spec still counts as a configured instance
    let from_agent_model = std::env::var("T3CODE_AGENT_MODEL").ok().and_then(|spec| {
        let rest = spec.strip_prefix("ollama:")?;
        let (base, model) = rest.split_once('|').unwrap_or(("http://localhost:11434", rest));
        Some((base.to_string(), model.to_string()))
    });

    let base = explicit
        .clone()
        .or_else(|| from_agent_model.as_ref().map(|(b, _)| b.clone()))?;
    let mut models: Vec<String> = std::env::var("T3CODE_OLLAMA_MODELS")
        .ok()
        .map(|s| s.split(',').map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).collect())
        .unwrap_or_default();
    if let Some((_, m)) = &from_agent_model {
        if !models.contains(m) {
            models.insert(0, m.clone());
        }
    }
    // No models = nothing to pick. The driver reports this as unavailable WITH
    // the reason, which is more useful than hiding the provider entirely.
    Some((base, models))
}

pub fn instance(id: &str, driver: &str, name: &str, config: Value) -> ProviderInstanceConfig {
    ProviderInstanceConfig {
        instance_id: id.into(),
        driver: driver.into(),
        display_name: Some(name.into()),
        enabled: true,
        config: config.as_object().cloned().unwrap_or_default(),
        secrets: Default::default(),
        options: vec![],
    }
}

/// Ask each OpenAI-compatible endpoint what models it actually serves, and fold
/// the answer into its instance config.
///
/// Without this, an install that points at a running Ollama has NO selectable
/// models unless the user hand-types slugs into `T3CODE_OLLAMA_MODELS` — the
/// endpoint is right there answering `/v1/models` and the picker stays empty,
/// which reads as "Ollama is broken" (#180). Discovery is additive: a model the
/// user configured by hand stays, and an endpoint that cannot be reached leaves
/// the instance exactly as it was so the failure shows up as the driver's own
/// unavailable reason rather than as models silently disappearing.
pub async fn with_discovered_models(
    mut instances: Vec<ProviderInstanceConfig>,
) -> Vec<ProviderInstanceConfig> {
    for inst in instances.iter_mut() {
        if inst.driver.as_str() != DRIVER_OPENAI_COMPAT || !inst.enabled {
            continue;
        }
        let Some(base) = inst.config.get("baseUrl").and_then(Value::as_str) else { continue };
        // Doubly bounded: the probe has its own connect/request timeouts, and
        // the CALLER caps the whole thing too. Boot and provider refresh both
        // await this, and neither may be held up by an endpoint that accepts a
        // connection and then goes quiet (#189).
        let probe = agent_sdk_provider::instance::probe_openai_compat_models(base);
        let Ok(Ok(found)) = tokio::time::timeout(std::time::Duration::from_secs(6), probe).await
        else {
            tracing::warn!(%base, "model discovery timed out or failed — keeping configured models");
            continue;
        };
        let mut slugs: Vec<String> = inst
            .config
            .get("models")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        for m in found {
            if !slugs.contains(&m.slug) {
                slugs.push(m.slug);
            }
        }
        inst.config.insert("models".into(), json!(slugs));
    }
    instances
}

/// The catalog for this install, reconciled once at boot.
pub fn catalog() -> Catalog {
    let mut c = Catalog::new();
    c.reconcile(&configured_instances());
    c
}

/// The default model, resolved ENTIRELY through the catalog.
///
/// There is deliberately no hard-coded escape-hatch slug here. A dated
/// `claude-haiku-…` fallback outside the catalog is exactly the hidden
/// substitution `Catalog::resolve` exists to prevent: a disabled or
/// unavailable Claude instance would still launch a model the picker does not
/// list, so the UI shows one state and the turn runs another.
///
/// `None` means nothing is routable. That is a real state — every provider
/// disabled or misconfigured — and the caller surfaces it instead of running
/// something the user never chose.
pub fn default_model(catalog: &Catalog) -> Option<ModelRef> {
    let spec = std::env::var("T3CODE_AGENT_MODEL").unwrap_or_default();
    let (kind, rest) = spec.split_once(':').unwrap_or(("", ""));
    let named = match kind {
        "ollama" => {
            let (_, model) = rest.split_once('|').unwrap_or(("", rest));
            catalog.resolve("ollama_local", model).ok()
        }
        "codex" | "codex-resume" => catalog.resolve("codex", rest).ok(),
        "claude" | "claude-resume" => catalog.resolve("claudeAgent", rest).ok(),
        _ => None,
    };
    if let Some(m) = named {
        return Some(m);
    }
    // No env preference (or it did not resolve): the first READY instance in
    // the catalog, at its own default model. Still a catalog decision, so the
    // picker can always show what a default turn will run.
    catalog
        .snapshots()
        .iter()
        .find(|s| s.status == agent_sdk_provider::ProviderStatus::Ready)
        .and_then(|s| catalog.resolve(&s.instance_id, "").ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #36: an Ollama selection routes to OpenAiCompat rather than defaulting.
    /// This is the backend-side contract the finding asked for.
    #[test]
    fn an_ollama_selection_routes_to_openai_compat() {
        let mut c = Catalog::new();
        let mut configs = configured_instances();
        configs.push(instance(
            "ollama_local",
            DRIVER_OPENAI_COMPAT,
            "Ollama",
            json!({"baseUrl": "http://localhost:11434", "models": ["qwen2.5-coder"]}),
        ));
        c.reconcile(&configs);

        match c.resolve("ollama_local", "qwen2.5-coder").expect("ollama routes") {
            ModelRef::OpenAiCompat { base_url, model } => {
                assert_eq!(base_url, "http://localhost:11434");
                assert_eq!(model, "qwen2.5-coder");
            }
            other => panic!("ollama must not run {other:?}"),
        }
    }

    /// Claude and Codex are always in the catalog, so the picker is never empty.
    #[test]
    fn claude_and_codex_are_always_configured() {
        let ids: Vec<String> =
            configured_instances().into_iter().map(|c| c.instance_id).collect();
        assert!(ids.contains(&"claudeAgent".to_string()));
        assert!(ids.contains(&"codex".to_string()));
    }
}


#[cfg(test)]
mod discovery_tests {
    use super::*;

    /// #180: discovery is ADDITIVE and never destructive.
    ///
    /// An endpoint that cannot be reached must leave the instance exactly as the
    /// user configured it — models silently disappearing reads as "my provider
    /// broke", when the truth is "the probe failed", and the driver already
    /// reports that as its own unavailable reason.
    #[tokio::test]
    async fn an_unreachable_endpoint_leaves_configured_models_alone() {
        let configured = vec![instance(
            "ollama_local",
            DRIVER_OPENAI_COMPAT,
            "Ollama",
            json!({ "baseUrl": "http://127.0.0.1:1", "models": ["qwen2.5-coder"] }),
        )];
        let after = with_discovered_models(configured).await;
        assert_eq!(
            after[0].config.get("models").unwrap(),
            &json!(["qwen2.5-coder"]),
            "the user's own model list survived a failed probe"
        );
    }


    /// #189: discovery is BOUNDED. Boot and refresh both await it, so an
    /// endpoint that accepts the connection and then never answers must not
    /// wedge the runtime before the settings screen that would fix it exists.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_silent_endpoint_cannot_wedge_discovery() {
        // a listener that accepts and then says nothing, forever
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((sock, _)) = listener.accept().await {
                held.push(sock); // never read, never write, never close
            }
        });

        let configured = vec![instance(
            "ollama_local",
            DRIVER_OPENAI_COMPAT,
            "Ollama",
            json!({ "baseUrl": format!("http://{addr}"), "models": ["qwen2.5-coder"] }),
        )];

        let started = std::time::Instant::now();
        let after = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            with_discovered_models(configured),
        )
        .await
        .expect("discovery must return on its own, not hang the caller");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(15),
            "it returned within its bound ({:?})",
            started.elapsed()
        );
        assert_eq!(
            after[0].config.get("models").unwrap(),
            &json!(["qwen2.5-coder"]),
            "a timeout preserves what the user configured"
        );
    }
    /// A driver that is not OpenAI-compatible is never probed, and a disabled
    /// instance is left alone entirely.
    #[tokio::test]
    async fn only_enabled_openai_compatible_instances_are_probed() {
        let mut disabled = instance(
            "ollama_local",
            DRIVER_OPENAI_COMPAT,
            "Ollama",
            json!({ "baseUrl": "http://127.0.0.1:1" }),
        );
        disabled.enabled = false;
        let claude = instance("claudeAgent", DRIVER_CLAUDE, "Claude", json!({}));
        let after = with_discovered_models(vec![disabled, claude]).await;
        assert!(after[0].config.get("models").is_none(), "a disabled instance is untouched");
        assert!(after[1].config.get("models").is_none(), "a non-compatible driver is not probed");
    }
}
