//! Durable server settings + the provider-management surface (#47, #60).
//!
//! The frontend edits `providerInstances` (add Ollama, custom Codex/Claude
//! models, display names, enable/disable) and expects those choices to be
//! DURABLE and to change what the runtime actually routes — not a localStorage
//! decoration. So the chosen instances live in the do-rs `OrchStore`, and every
//! write reconciles them into the SAME [`Catalog`] that `server.getConfig`
//! advertises and that turn admission resolves against. Reconnect or restart
//! rebuilds the catalog from this store, not from the skinny boot env catalog.
//!
//! Wire mapping is manual on purpose: the SDK `ProviderInstanceConfig` is
//! snake_case, the contract is camelCase, and the runtime never sends a partial
//! `ServerSettings` — it sends only `providerInstances` and lets the contract's
//! `withDecodingDefault` fill every other field on the client.

use agent_sdk_provider::instance::{ProviderDriverKind, ProviderInstanceConfig};
use agent_sdk_shell::{Catalog, OrchStore};
use serde_json::{json, Map, Value};

/// Durable key for the user's saved provider instances.
const INSTANCES_KEY: &str = "server_settings:provider_instances";
/// Durable key for every OTHER `ServerSettings` field the UI edits (writing
/// style, text-generation model selection, observability, background activity…)
/// — kept verbatim as the client's own encoded values so they round-trip
/// unchanged instead of resetting to defaults on the next getSettings (#87).
const OTHER_KEY: &str = "server_settings:other";

/// The stored non-provider settings fields (empty until the user saves one).
pub async fn load_other(store: &OrchStore) -> Map<String, Value> {
    // `kv` is fallible now. An unreadable store is not "no settings saved", but
    // this loader has no error channel, so keep the existing empty-map fallback
    // and say WHY in the log rather than silently conflating the two.
    match store.kv(OTHER_KEY).await {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_default(),
        Ok(None) => Map::new(),
        Err(e) => {
            tracing::error!(%e, "settings store unreadable; serving empty settings");
            Map::new()
        }
    }
}

pub async fn save_other(store: &OrchStore, other: &Map<String, Value>) -> Result<(), String> {
    let raw = serde_json::to_string(other).map_err(|e| e.to_string())?;
    store.put_kv(OTHER_KEY, &raw).await
}

/// The expected JSON kind of each KNOWN non-provider settings field. Storing a
/// value of the wrong kind would make a later `getSettings` fail to decode as
/// `ServerSettings` and break the UI, so a patch carrying a mistyped known field
/// is REJECTED before anything is persisted (#121). Unknown fields are allowed
/// through — the contract's Struct ignores excess properties, so they can't
/// break decode, and passing them keeps forward-compat.
fn field_kind_ok(field: &str, v: &Value) -> bool {
    match field {
        // booleans
        "enableLegacyTokenStreaming"
        | "enableProviderUpdateChecks"
        | "enableAgentBrowserAccess"
        | "newWorktreesStartFromOrigin" => v.is_boolean(),
        // durations / numbers
        "automaticGitFetchInterval" | "providerHealthRefreshInterval" => v.is_number(),
        // plain strings
        "backgroundActivityProfile" | "defaultThreadEnvMode" | "addProjectBaseDirectory" => {
            v.is_string()
        }
        // typed objects
        "textGenerationModelSelection"
        | "sourceControlWritingStyle"
        | "backgroundActivity"
        | "observability"
        // per-instance model customizations: `{instanceId: {hidden, order,…}}`
        // (#109). A durable record keyed by instance, so it is an object.
        | "providerModelPreferences"
        | "providers" => v.is_object(),
        // null | ModelSelection
        "sourceControlWriterModelSelection" => v.is_null() || v.is_object(),
        // the favorited-model list (#109) — an array of model refs.
        "favorites" => v.is_array(),
        // unknown field → allowed (ignored on decode; keeps forward-compat).
        _ => true,
    }
}

/// Validate a patch's non-provider fields against the contract kinds BEFORE
/// persisting. Returns the offending field name on the first mismatch, so the
/// caller can reject the write and leave the durable blob untouched (#121).
pub fn validate_other(patch: &Value) -> std::result::Result<(), String> {
    let fields = patch.pointer("/patch").and_then(Value::as_object).or_else(|| patch.as_object());
    if let Some(fields) = fields {
        for (k, v) in fields {
            if k == "providerInstances" {
                continue;
            }
            if !field_kind_ok(k, v) {
                return Err(format!("settings field `{k}` has an invalid type for its contract"));
            }
        }
    }
    Ok(())
}

/// Merge a patch's NON-`providerInstances` top-level fields into the stored
/// other-settings. Each field the patch carries replaces its stored value
/// verbatim (the client sends the whole encoded field), so a saved writing
/// style / model selection survives the next getSettings instead of being
/// silently dropped. Call [`validate_other`] first — this trusts the shapes.
pub fn merge_other(current: &Map<String, Value>, patch: &Value) -> Map<String, Value> {
    let mut out = current.clone();
    let fields = patch.pointer("/patch").and_then(Value::as_object).or_else(|| patch.as_object());
    if let Some(fields) = fields {
        for (k, v) in fields {
            if k == "providerInstances" {
                continue;
            }
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

/// One provider instance as the contract's camelCase `ProviderInstanceConfig`.
/// The redaction placeholder the contract round-trips. A client that saves
/// this back is saying "unchanged" — which is what lets settings survive a
/// round trip through a UI that never held the secret.
const REDACTED: &str = "__redacted__";

fn wire_instance(c: &ProviderInstanceConfig) -> Value {
    // `environment` is the API-key-shaped surface the settings UI writes
    // (ProviderInstanceCard.updateEnvironment). Dropping it meant a user
    // configured an Ollama/OpenAI-compatible provider's env, got a Success,
    // and found the fields erased on reload (#88).
    //
    // Literal values leave here REDACTED: the client can render and re-save the
    // instance without ever holding the secret, and a redacted value coming
    // back means "keep what you had", not "clear it".
    let environment: Map<String, Value> = c
        .secrets
        .iter()
        .map(|(k, v)| {
            let shown = match v {
                agent_sdk_provider::SecretValue::Literal { .. } => json!(REDACTED),
                agent_sdk_provider::SecretValue::Redacted => json!(REDACTED),
                agent_sdk_provider::SecretValue::EnvVar { name } => json!({ "envVar": name }),
            };
            (k.clone(), shown)
        })
        .collect();

    let mut out = json!({
        "instanceId": c.instance_id,
        "driver": c.driver.0,
        "displayName": c.display_name,
        "enabled": c.enabled,
        "config": Value::Object(c.config.clone()),
    });
    if let Some(o) = out.as_object_mut() {
        if !environment.is_empty() {
            o.insert("environment".into(), Value::Object(environment));
        }
        // accentColor is display metadata, not a secret; it rides the opaque
        // config blob durably and is surfaced back as its own field so the UI
        // sees what it saved.
        if let Some(accent) = c.config.get("accentColor").and_then(Value::as_str) {
            o.insert("accentColor".into(), json!(accent));
        }
    }
    out
}

/// Decode the wire `environment` map into SDK secrets.
fn parse_environment(v: &Value) -> std::collections::HashMap<String, agent_sdk_provider::SecretValue> {
    use agent_sdk_provider::SecretValue;
    v.get("environment")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, val)| {
                    let secret = match val {
                        // `{"envVar": "NAME"}` — read from the host at
                        // construction, which fails closed rather than falling
                        // through to ambient credentials at call time.
                        Value::Object(o) => {
                            let name = o.get("envVar").and_then(Value::as_str)?;
                            SecretValue::EnvVar { name: name.to_string() }
                        }
                        Value::String(s) if s == REDACTED => SecretValue::Redacted,
                        Value::String(s) => SecretValue::Literal { value: s.clone() },
                        _ => return None,
                    };
                    Some((k.clone(), secret))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A minimal `ServerSettings` wire object: `providerInstances` only. Every other
/// field fills from the contract's `withDecodingDefault` on the client, so the
/// runtime never has to mirror the full settings surface to answer honestly.
pub fn settings_wire(instances: &[ProviderInstanceConfig], other: &Map<String, Value>) -> Value {
    // Start from the saved non-provider fields (they round-trip verbatim), then
    // overlay the reconciled providerInstances. Anything neither carries fills
    // from the contract's withDecodingDefault on the client.
    let mut root = other.clone();
    let mut m = Map::new();
    for c in instances {
        m.insert(c.instance_id.clone(), wire_instance(c));
    }
    root.insert("providerInstances".into(), Value::Object(m));
    Value::Object(root)
}

/// Parse one camelCase wire instance back into the SDK config (the SDK's own
/// Deserialize is snake_case, so this bridges the case boundary explicitly).
/// Parse one provider instance. `key` is the map key it was stored under —
/// the settings UI keys `providerInstances` BY instance id and does not always
/// repeat it inside the value, so requiring the inner field silently DROPS a
/// provider the user just added and answers Success anyway.
fn parse_instance_keyed(key: &str, v: &Value) -> Option<ProviderInstanceConfig> {
    let instance_id = v
        .get("instanceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(key)
        .to_string();
    if instance_id.is_empty() {
        return None;
    }
    let driver = v.get("driver").and_then(Value::as_str)?.to_string();
    let mut config = v.get("config").and_then(Value::as_object).cloned().unwrap_or_default();
    // keep accentColor durable alongside the driver's own config
    if let Some(accent) = v.get("accentColor").and_then(Value::as_str) {
        config.insert("accentColor".into(), json!(accent));
    }
    Some(ProviderInstanceConfig {
        instance_id,
        driver: ProviderDriverKind(driver),
        display_name: v.get("displayName").and_then(Value::as_str).map(String::from),
        enabled: v.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        config,
        secrets: parse_environment(v),
        options: Default::default(),
    })
}

/// The provider instances to reconcile: the user's saved set if any, else the
/// boot defaults. Merges defaults UNDER saved rows so a stock provider the user
/// never touched (claude/codex) is always present even after they add Ollama.
pub async fn load_instances(
    store: &OrchStore,
    defaults: Vec<ProviderInstanceConfig>,
) -> Vec<ProviderInstanceConfig> {
    let saved: Vec<ProviderInstanceConfig> = match store.kv(INSTANCES_KEY).await {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_default(),
        Ok(None) => Vec::new(),
        Err(e) => {
            tracing::error!(%e, "provider instance store unreadable; using defaults");
            Vec::new()
        }
    };
    if saved.is_empty() {
        return defaults;
    }
    let mut out = defaults;
    for s in saved {
        if let Some(slot) = out.iter_mut().find(|d| d.instance_id == s.instance_id) {
            *slot = s;
        } else {
            out.push(s);
        }
    }
    out
}

/// Persist the current instance set durably (write-through, reported on failure).
pub async fn save_instances(
    store: &OrchStore,
    instances: &[ProviderInstanceConfig],
) -> Result<(), String> {
    let raw = serde_json::to_string(instances).map_err(|e| e.to_string())?;
    store.put_kv(INSTANCES_KEY, &raw).await
}

/// Apply an `updateSettings` patch's `providerInstances` over the current set.
/// The frontend sends the full instance map it wants; each entry replaces (or
/// adds) by id, and an entry absent from the patch is left untouched.
pub fn apply_patch(current: &[ProviderInstanceConfig], patch: &Value) -> Vec<ProviderInstanceConfig> {
    let Some(obj) = patch
        .pointer("/patch/providerInstances")
        .or_else(|| patch.get("providerInstances"))
        .and_then(Value::as_object)
    else {
        // `providerInstances` absent from the patch → the set is unchanged.
        return current.to_vec();
    };
    // PRESENT `providerInstances` is a WHOLE-MAP REPLACEMENT, not a merge: the
    // UI deletes/resets a provider by sending the map WITHOUT that key
    // (`withoutProviderInstanceKey`), so an instance absent from the patch must
    // be REMOVED, not silently preserved — otherwise a deleted Ollama/custom
    // provider stays saved, stays in the reconciled catalog, and reappears in
    // the picker (#94). Boot defaults are re-established under this set at
    // load/reconcile, so stock providers can't be lost, only customs.
    obj.iter()
        .filter_map(|(key, entry)| parse_instance_keyed(key, entry))
        .map(|incoming| {
            // A REDACTED secret coming back means "unchanged", so merge it
            // against what we already hold. Without this a settings round trip
            // through a client that never saw the secret would CLEAR it — the
            // exact data loss the redaction placeholder exists to prevent.
            match current.iter().find(|c| c.instance_id == incoming.instance_id) {
                Some(stored) => incoming.rehydrate_from(stored),
                None => incoming,
            }
        })
        .collect()
}

/// Update a single instance's config from an `updateProvider` input, keyed by
/// its driver's default instance id (`server.updateProvider` targets a driver).
pub fn apply_provider_update(
    current: &[ProviderInstanceConfig],
    input: &Value,
) -> Vec<ProviderInstanceConfig> {
    // `server.updateProvider` carries `{ provider, instanceId? }`; the config the
    // user edited rides the same message shape the settings UI produces.
    let target = input
        .get("instanceId")
        .and_then(Value::as_str)
        .or_else(|| input.get("provider").and_then(Value::as_str));
    let Some(target) = target else { return current.to_vec() };
    let mut out = current.to_vec();
    if let Some(cfg) = input.get("config").and_then(Value::as_object) {
        if let Some(slot) = out.iter_mut().find(|c| c.instance_id == target) {
            slot.config = cfg.clone();
        }
    }
    if let Some(enabled) = input.get("enabled").and_then(Value::as_bool) {
        if let Some(slot) = out.iter_mut().find(|c| c.instance_id == target) {
            slot.enabled = enabled;
        }
    }
    out
}

/// Reconcile a fresh instance set into the live catalog IN PLACE, so the picker
/// (`server.getConfig`) and the router (turn admission) both see the change.
pub fn reconcile(catalog: &mut Catalog, instances: &[ProviderInstanceConfig]) {
    catalog.reconcile(instances);
}

#[cfg(test)]
mod env_tests {
    use super::*;

    fn wire(env: Value) -> Value {
        json!({"driver": "openaiCompat", "enabled": true, "environment": env,
               "accentColor": "#ff8800", "config": {"baseUrl": "http://x", "models": ["m"]}})
    }

    /// #88: a provider's environment survives a save, and a REDACTED value on
    /// the way back in means "unchanged" rather than "clear it".
    #[test]
    fn provider_environment_round_trips_without_leaking_or_clearing() {
        let saved = apply_patch(&[], &json!({"patch": {"providerInstances": {
            "ollama_local": wire(json!({"OPENAI_API_KEY": "sk-secret"})),
        }}}));
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].secrets.len(), 1, "the env var was stored: {:?}", saved[0].secrets);
        assert_eq!(saved[0].config.get("accentColor").and_then(Value::as_str), Some("#ff8800"));

        // what the client is shown NEVER carries the literal
        let shown = settings_wire(&saved, &Map::new());
        let inst = shown["providerInstances"]["ollama_local"].clone();
        assert_eq!(inst["environment"]["OPENAI_API_KEY"], "__redacted__", "{inst}");
        assert!(!shown.to_string().contains("sk-secret"), "the secret never left the server");
        assert_eq!(inst["accentColor"], "#ff8800", "display metadata comes back");

        // the client re-saves what it was shown (redacted) — the key SURVIVES
        let round = apply_patch(&saved, &json!({"patch": {"providerInstances": {
            "ollama_local": inst,
        }}}));
        match round[0].secrets.get("OPENAI_API_KEY") {
            Some(agent_sdk_provider::SecretValue::Literal { value }) => {
                assert_eq!(value, "sk-secret", "a redacted round trip must not clear the key")
            }
            other => panic!("expected the stored literal, got {other:?}"),
        }

        // an explicit deletion IS honoured — removal is not redaction
        let cleared = apply_patch(&round, &json!({"patch": {"providerInstances": {
            "ollama_local": wire(json!({})),
        }}}));
        assert!(cleared[0].secrets.is_empty(), "an explicit deletion is honoured");
    }

    /// #97/#109: the non-provider settings the git UX and model registry depend
    /// on survive an updateSettings -> getSettings round trip instead of being
    /// dropped to defaults, and a mistyped value is refused before it can poison
    /// a later getSettings decode.
    #[test]
    fn source_control_and_model_customization_fields_round_trip() {
        let writer_sel = json!({"instanceId": "codex", "model": "codex-default"});
        let patch = json!({"patch": {
            "sourceControlWritingStyle": {"tone": "concise", "conventionalCommits": true},
            "sourceControlWriterModelSelection": writer_sel,
            "favorites": ["claudeAgent:claude-haiku-4-5", "ollama_local:llama3"],
            "providerModelPreferences": {"ollama_local": {"hidden": ["noisy-model"], "order": ["llama3"]}},
        }});

        // every field validates (right kinds), and each is persisted verbatim.
        validate_other(&patch).expect("well-typed patch is accepted");
        let stored = merge_other(&Map::new(), &patch);
        let wire = settings_wire(&[], &stored);

        assert_eq!(wire["sourceControlWritingStyle"]["tone"], "concise");
        assert_eq!(wire["sourceControlWriterModelSelection"], writer_sel);
        assert_eq!(wire["favorites"][1], "ollama_local:llama3");
        assert_eq!(wire["providerModelPreferences"]["ollama_local"]["hidden"][0], "noisy-model");

        // a null writer selection is valid (no dedicated writer model).
        validate_other(&json!({"patch": {"sourceControlWriterModelSelection": Value::Null}}))
            .expect("null writer selection is allowed");

        // mistyped fields are refused so a later getSettings can't fail to decode.
        assert!(validate_other(&json!({"patch": {"favorites": "not-an-array"}})).is_err());
        assert!(validate_other(&json!({"patch": {"providerModelPreferences": ["nope"]}})).is_err());
        assert!(validate_other(&json!({"patch": {"sourceControlWritingStyle": "string"}})).is_err());
    }

    /// An `envVar` reference stays a reference: the value is read from the host
    /// at construction (fail-closed), never inlined onto the wire.
    #[test]
    fn an_env_var_reference_stays_a_reference() {
        let saved = apply_patch(&[], &json!({"patch": {"providerInstances": {
            "x": wire(json!({"KEY": {"envVar": "MY_HOST_VAR"}})),
        }}}));
        match saved[0].secrets.get("KEY") {
            Some(agent_sdk_provider::SecretValue::EnvVar { name }) => assert_eq!(name, "MY_HOST_VAR"),
            other => panic!("{other:?}"),
        }
        let shown = settings_wire(&saved, &Map::new());
        assert_eq!(shown["providerInstances"]["x"]["environment"]["KEY"]["envVar"], "MY_HOST_VAR");
    }
}
