//! PROOF (#148): the ACP child has ONE model authority — the catalog.
//!
//! `t3code-agent` used to carry its own `model_from_env()` with a hard-coded
//! `claude-resume:claude-haiku-4-5-20251001` default. That is a second authority
//! next to `server.getConfig`, so the model the child ran and the model the
//! picker advertised could disagree — and the disagreement is invisible, which
//! is what makes it bite when a user switches models expecting context to carry.
//!
//! Everything here is ONE test on purpose: `T3CODE_AGENT_MODEL` is process-
//! global, so splitting these across `#[test]`s would race them against each
//! other inside the same binary.

use agent_sdk_shell::ModelRef;
use t3code_agent::providers;

/// Every `ModelRef` the catalog can produce, so a default can be checked for
/// membership rather than compared against a slug this test also hard-codes.
fn routable(catalog: &agent_sdk_shell::Catalog) -> Vec<ModelRef> {
    catalog
        .snapshots()
        .iter()
        .flat_map(|s| {
            let mut refs = Vec::new();
            if let Ok(m) = catalog.resolve(&s.instance_id, "") {
                refs.push(m);
            }
            for model in &s.models {
                if let Ok(m) = catalog.resolve(&s.instance_id, &model.slug) {
                    refs.push(m);
                }
            }
            refs
        })
        .collect()
}

#[test]
fn the_child_default_is_always_a_catalog_decision() {
    // 1. NO env preference at all — the old code's hard-coded branch.
    std::env::remove_var("T3CODE_AGENT_MODEL");
    let catalog = providers::catalog();
    let default = providers::default_model(&catalog).expect("claude/codex are always configured");
    assert!(
        routable(&catalog).contains(&default),
        "the default must be something the catalog itself can resolve, got {default:?}"
    );

    // 2. An env spec naming a model NO instance serves. The old code turned this
    //    into `ClaudeResume { model: "<whatever-was-typed>" }` — a slug the
    //    picker never listed, launched behind the user's back.
    std::env::set_var("T3CODE_AGENT_MODEL", "claude-resume:a-model-that-does-not-exist");
    let catalog = providers::catalog();
    let default = providers::default_model(&catalog).expect("still falls back to the catalog");
    assert!(
        routable(&catalog).contains(&default),
        "an unresolvable spec must fall back INSIDE the catalog, got {default:?}"
    );
    match &default {
        ModelRef::ClaudeResume { model } => assert_ne!(
            model, "a-model-that-does-not-exist",
            "the typed slug must not have been passed through unresolved"
        ),
        _ => {}
    }

    // 3. A spec that DOES resolve is honored — the env var still expresses a
    //    preference, it just cannot invent a model.
    std::env::set_var("T3CODE_AGENT_MODEL", "claude-resume:claude-opus-5");
    let catalog = providers::catalog();
    let default = providers::default_model(&catalog).expect("a real slug resolves");
    assert_eq!(
        default,
        ModelRef::ClaudeResume { model: "claude-opus-5".into() },
        "an env preference the catalog CAN serve is honored"
    );

    // 4. An older spelling still routes, through the catalog's alias table —
    //    a user's saved preference does not stop working when slugs canonicalize.
    std::env::set_var("T3CODE_AGENT_MODEL", "claude-resume:claude-haiku-4-5-20251001");
    let catalog = providers::catalog();
    let default = providers::default_model(&catalog).expect("a dated slug still resolves");
    assert_eq!(
        default,
        ModelRef::ClaudeResume { model: "claude-haiku-4-5".into() },
        "the dated slug canonicalizes instead of being passed through raw"
    );

    std::env::remove_var("T3CODE_AGENT_MODEL");
}
