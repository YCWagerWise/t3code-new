
//! PROOF (#328): `server.getUsageSummary` reports REAL transcript usage in the
//! wire shape, and reports honestly when it cannot.
//!
//! The stub this replaces returned `buckets: []` + `sources: []` for every
//! input. It decoded, it type-checked, and it made every turn the user ran
//! disappear — which is why "schema-valid" is not the bar here and every
//! assertion below is about the CONTENT of the payload.

use super::diagnostics;
use serde_json::{json, Value};

fn seed_claude(home: &std::path::Path, ts: &str, out: i64) {
    let file = home.join("projects/p/session.jsonl");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let line = json!({
        "type": "assistant",
        "timestamp": ts,
        "sessionId": "s-1",
        "requestId": "r-1",
        "message": { "id": "m-1", "model": "claude-opus-5", "usage": {
            "input_tokens": 100, "cache_read_input_tokens": 20,
            "cache_creation_input_tokens": 5, "output_tokens": out,
        }}
    });
    std::fs::write(&file, format!("{line}\n")).unwrap();
}

fn daily(since: &str, until: &str) -> Value {
    json!({ "sinceDay": since, "untilDay": until, "timeZone": "UTC" })
}

#[test]
fn the_usage_rpc_reports_tokens_it_actually_read() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("claude");
    seed_claude(&home, "2026-03-04T10:00:00.000Z", 40);

    let sources = vec![agent_sdk_usage::SourceSpec {
        provider: agent_sdk_usage::Provider::Claude,
        home,
    }];
    let out = diagnostics::usage_summary_from(
        &daily("2026-03-01", "2026-03-31"),
        Default::default(),
        &sources,
    )
    .expect("a readable source is not a UsageReadError");

    assert_eq!(out["contractVersion"], 4);
    let buckets = out["buckets"].as_array().expect("buckets is an array");
    assert_eq!(buckets.len(), 1, "a seeded transcript must produce a bucket: {out}");
    assert_eq!(buckets[0]["day"], "2026-03-04");
    assert_eq!(buckets[0]["provider"], "claude");
    assert_eq!(buckets[0]["model"], "claude-opus-5");
    assert_eq!(buckets[0]["totals"]["outputTokens"], 40);
    assert_eq!(buckets[0]["totals"]["cachedInputTokens"], 20);
    assert_eq!(buckets[0]["records"], 1);
    // Daily requests must OMIT hourStart — the contract types it as a
    // trimmed non-empty string, so a null would fail to decode.
    assert!(buckets[0].get("hourStart").is_none(), "no hourStart on a daily bucket");

    let sources_wire = out["sources"].as_array().expect("sources is an array");
    assert_eq!(sources_wire.len(), 1, "the source it read is reported: {out}");
    assert_eq!(sources_wire[0]["status"], "ok");
    assert_eq!(sources_wire[0]["scannedFiles"], 1);
    assert_eq!(sources_wire[0]["distinctSessions"], 1);
    assert_eq!(sources_wire[0]["fingerprint"]["provider"], "claude");
    assert!(
        sources_wire[0]["fingerprint"]["hostId"].as_str().is_some_and(|h| !h.is_empty()),
        "the fingerprint names this host, or two servers on one home double count"
    );

    // No rate table wired, and the payload SAYS so rather than showing $0.
    assert_eq!(out["pricing"]["status"], "unavailable");
    assert_eq!(out["pricing"]["knownModels"], 0);
    assert_eq!(buckets[0]["costSource"], "unpriced");
    assert_eq!(buckets[0]["unpricedRecords"], 1);
}

/// A provider the user never ran is reported as `missing`, WITH its row.
/// Dropping the row would make "no Codex usage" and "no Codex installed"
/// render identically, and the client could not tell the user which.
#[test]
fn an_unused_provider_is_reported_missing_rather_than_omitted() {
    let tmp = tempfile::tempdir().unwrap();
    let claude = tmp.path().join("claude");
    seed_claude(&claude, "2026-03-04T10:00:00.000Z", 40);

    let sources = vec![
        agent_sdk_usage::SourceSpec {
            provider: agent_sdk_usage::Provider::Claude,
            home: claude,
        },
        agent_sdk_usage::SourceSpec {
            provider: agent_sdk_usage::Provider::Codex,
            home: tmp.path().join("codex-never-run"),
        },
    ];
    let out = diagnostics::usage_summary_from(
        &daily("2026-03-01", "2026-03-31"),
        Default::default(),
        &sources,
    )
    .expect("a readable source is not a UsageReadError");

    let rows = out["sources"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "every source gets a row: {out}");
    let codex = rows.iter().find(|r| r["fingerprint"]["provider"] == "codex").unwrap();
    assert_eq!(codex["status"], "missing");
    assert_eq!(codex["scannedFiles"], 0);
    assert!(codex["message"].is_string(), "and says which path was absent");
    // The other provider's usage is unaffected.
    assert_eq!(out["buckets"].as_array().unwrap().len(), 1);
}

/// A window outside the data yields NO buckets but still reports the
/// source as read — "we looked and there was nothing" is a different
/// answer from "we did not look", and only the sources row distinguishes
/// them.
#[test]
fn an_empty_window_still_reports_the_source_it_scanned() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("claude");
    seed_claude(&home, "2026-03-04T10:00:00.000Z", 40);

    let sources = vec![agent_sdk_usage::SourceSpec {
        provider: agent_sdk_usage::Provider::Claude,
        home,
    }];
    let out = diagnostics::usage_summary_from(
        &daily("2026-01-01", "2026-01-31"),
        Default::default(),
        &sources,
    )
    .expect("an empty window is a summary, not an error");

    assert!(out["buckets"].as_array().unwrap().is_empty(), "nothing in that window");
    let rows = out["sources"].as_array().unwrap();
    assert_eq!(rows[0]["status"], "ok", "the file was still read");
    assert_eq!(rows[0]["scannedFiles"], 1);
}

/// An hourly request without exact bounds is an INVALID WINDOW, not a
/// silent downgrade to daily. Answering a different question under the
/// label the client asked for is undetectable downstream.
#[test]
fn an_hourly_request_without_bounds_is_an_error_not_a_daily_answer() {
    let err = diagnostics::usage_summary_from(
        &json!({
            "sinceDay": "2026-03-04", "untilDay": "2026-03-04",
            "timeZone": "UTC", "resolution": "hour",
        }),
        Default::default(),
        &[],
    )
    .expect_err("an unusable window is the ERROR arm, not a summary");
    assert_eq!(err["_tag"], "UsageReadError");
    assert_eq!(err["reason"], "invalidWindow");
    assert!(err["detail"].as_str().unwrap().contains("sinceTime"));
}

/// An hourly request WITH bounds buckets by hour and stamps `hourStart`.
#[test]
fn an_hourly_request_with_bounds_stamps_hour_start() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("claude");
    seed_claude(&home, "2026-03-04T10:30:00.000Z", 40);

    let sources = vec![agent_sdk_usage::SourceSpec {
        provider: agent_sdk_usage::Provider::Claude,
        home,
    }];
    let out = diagnostics::usage_summary_from(
        &json!({
            "sinceDay": "2026-03-04", "untilDay": "2026-03-04", "timeZone": "UTC",
            "resolution": "hour",
            "sinceTime": "2026-03-04T00:00:00.000Z",
            "untilTime": "2026-03-05T00:00:00.000Z",
        }),
        Default::default(),
        &sources,
    )
    .expect("bounded hourly is a summary");

    let buckets = out["buckets"].as_array().unwrap();
    assert_eq!(buckets.len(), 1, "{out}");
    assert_eq!(
        buckets[0]["hourStart"], "2026-03-04T10:00:00.000Z",
        "the 10:30 record lands in the 10:00 hour"
    );
}
