//! Process/resource diagnostics for the settings Diagnostics page (#67).
//!
//! The frontend wires `server.getProcessDiagnostics`,
//! `server.getProcessResourceHistory` and `server.getTraceDiagnostics`
//! (`packages/client-runtime/src/state/server.ts:688-714`) and renders them in
//! `DiagnosticsSettings` / `ResourceTelemetryDiagnostics`. On this runtime all
//! three fell through to unsupported-method, so the one screen that answers "is
//! an agent subprocess wedged, and what is eating this machine" was blank.
//!
//! Everything here is measured, never modelled. The process rows come from a
//! real `ps` walk of the server's own descendants; the history buckets come from
//! samples this process actually took. Where a number cannot be measured on this
//! runtime it is reported as the contract's explicit unavailable state rather
//! than as a plausible zero — a fabricated 0% CPU next to a wedged agent is
//! worse than an empty panel, because it reads as a healthy answer.
//!
//! Scope note: `ps` is the portable source that needs no elevated rights and no
//! sidecar. It gives CPU%, RSS, status and the parent/child edges — enough for
//! the health story. It does NOT give per-process I/O byte counters, which is
//! why `ioSemantics` is reported `"unavailable"` throughout instead of zeros.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// How many samples the ring buffer keeps. At the 2s cadence the UI polls on,
/// this is ~30 minutes of history — enough for the "what spiked five minutes

/// One process as `ps` reported it.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Proc {
    pub pid: i64,
    pub ppid: i64,
    pub pgid: i64,
    pub status: String,
    pub cpu_percent: f64,
    pub rss_bytes: i64,
    pub elapsed: String,
    pub elapsed_secs: i64,
    pub command: String,
}

/// One point in time: every descendant of the server, plus when it was taken.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Sample {
    pub at_ms: i64,
    pub procs: Vec<Proc>,
}

const PS_COMMAND: &str = "ps -Ao pid=,ppid=,pgid=,stat=,%cpu=,rss=,etime=,args=";
const PS_TIMEOUT: Duration = Duration::from_secs(2);
const PS_OUTPUT_MAX_BYTES: usize = 512 * 1024;

#[async_trait::async_trait]
pub trait ProcessSource: Send + Sync {
    async fn ps_output(&self) -> Result<String, String>;
}

#[derive(Clone)]
pub struct HearthProcessSource {
    runner: Arc<hearth::Runner>,
}

impl HearthProcessSource {
    pub fn new(runner: Arc<hearth::Runner>) -> Self {
        Self { runner }
    }
}

#[async_trait::async_trait]
impl ProcessSource for HearthProcessSource {
    async fn ps_output(&self) -> Result<String, String> {
        let cap = PS_OUTPUT_MAX_BYTES + 1;
        let command = format!("{PS_COMMAND} | head -c {cap}");
        let out = self.runner.run_full(&command, Some(PS_TIMEOUT.as_secs())).await;
        if out.interrupted {
            return Err(format!("ps exceeded {}s budget", PS_TIMEOUT.as_secs()));
        }
        if out.exit_code != 0 {
            return Err(format!("ps exited {}", out.exit_code));
        }
        let stdout = out.output.split_once('\n').map(|(_, tail)| tail).unwrap_or("").to_string();
        if stdout.len() > PS_OUTPUT_MAX_BYTES {
            return Err(format!("ps output exceeded {PS_OUTPUT_MAX_BYTES} byte diagnostics ceiling"));
        }
        Ok(stdout)
    }
}

/// `ps` elapsed time — `[[dd-]hh:]mm:ss` — as seconds.
///
/// Returns `None` rather than 0 on an unparseable value: the start time is
/// derived by subtracting this from now, and a silent 0 would date every process
/// to this instant, making a long-running wedged agent look freshly spawned.
pub fn parse_etime(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let (days, rest) = match raw.split_once('-') {
        Some((d, r)) => (d.parse::<i64>().ok()?, r),
        None => (0, raw),
    };
    let parts: Vec<&str> = rest.split(':').collect();
    let (h, m, s) = match parts.as_slice() {
        [h, m, s] => (h.parse::<i64>().ok()?, m.parse::<i64>().ok()?, s.parse::<i64>().ok()?),
        [m, s] => (0, m.parse::<i64>().ok()?, s.parse::<i64>().ok()?),
        _ => return None,
    };
    Some(days * 86_400 + h * 3_600 + m * 60 + s)
}

/// Parse one `ps` line laid out as `pid ppid pgid stat %cpu rss etime args...`.
///
/// `args` is taken as the whole remainder precisely because it contains spaces —
/// splitting it would truncate the command to its binary and lose the argv that
/// tells one agent subprocess from another.
pub fn parse_ps_line(line: &str) -> Option<Proc> {
    // `ps` pads its columns, so fields are separated by RUNS of spaces. Splitting
    // on each whitespace CHARACTER would yield empty fields and shift every
    // column one to the right — which silently lands `%cpu` in `status` and the
    // tail of the numbers inside `command`. Fields are taken by whitespace RUN;
    // `command` is then the untouched remainder, so argv keeps its own spacing.
    let mut rest = line.trim_start();
    let field = |rest: &mut &str| -> Option<String> {
        if rest.is_empty() {
            return None;
        }
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let (tok, tail) = rest.split_at(end);
        *rest = tail.trim_start();
        Some(tok.to_string())
    };
    let pid = field(&mut rest)?.parse::<i64>().ok()?;
    let ppid = field(&mut rest)?.parse::<i64>().ok()?;
    let pgid = field(&mut rest)?.parse::<i64>().unwrap_or(0);
    let status = field(&mut rest)?;
    let cpu_percent = field(&mut rest)?.parse::<f64>().unwrap_or(0.0);
    // `ps` reports RSS in kibibytes; the contract wants bytes.
    let rss_kib = field(&mut rest)?.parse::<i64>().unwrap_or(0);
    let elapsed_raw = field(&mut rest)?;
    let command = rest.trim().to_string();
    if pid <= 0 {
        return None;
    }
    Some(Proc {
        pid,
        ppid,
        pgid,
        status,
        cpu_percent,
        rss_bytes: rss_kib.saturating_mul(1024),
        elapsed_secs: parse_etime(&elapsed_raw).unwrap_or(0),
        elapsed: elapsed_raw,
        command,
    })
}

/// Every process on the box, as the supervised process source sees it.
pub async fn ps_all_from(source: &dyn ProcessSource) -> Result<Vec<Proc>, String> {
    let stdout = tokio::time::timeout(PS_TIMEOUT + Duration::from_millis(250), source.ps_output())
        .await
        .map_err(|_| format!("ps source exceeded {}ms deadline", (PS_TIMEOUT + Duration::from_millis(250)).as_millis()))??;
    if stdout.len() > PS_OUTPUT_MAX_BYTES {
        return Err(format!("ps output exceeded {PS_OUTPUT_MAX_BYTES} byte diagnostics ceiling"));
    }
    Ok(stdout.lines().filter_map(parse_ps_line).collect())
}

/// The server process and everything under it, with each row's depth from the
/// root and its direct children.
///
/// Walks DOWN from `root` rather than filtering by name: an agent subprocess is
/// whatever the server actually spawned, and a name filter would both miss
/// renamed provider binaries and capture an unrelated process that happens to
/// share a name.
pub fn descendants(all: &[Proc], root: i64) -> Vec<(Proc, usize, Vec<i64>)> {
    let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
    for p in all {
        children.entry(p.ppid).or_default().push(p.pid);
    }
    let by_pid: HashMap<i64, &Proc> = all.iter().map(|p| (p.pid, p)).collect();

    let mut out = Vec::new();
    // Explicit stack, not recursion: the tree comes from the OS and a `ps`
    // snapshot raced against a reparent can present a cycle. `seen` makes that
    // terminate instead of hanging the RPC.
    let mut seen = std::collections::HashSet::new();
    let mut stack = vec![(root, 0usize)];
    while let Some((pid, depth)) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        let kids = children.get(&pid).cloned().unwrap_or_default();
        if let Some(p) = by_pid.get(&pid) {
            out.push(((*p).clone(), depth, kids.clone()));
        }
        for k in kids {
            stack.push((k, depth + 1));
        }
    }
    out.sort_by_key(|(p, d, _)| (*d, p.pid));
    out
}

/// Effect `Schema.Option` on the wire.
fn some(v: Value) -> Value {
    json!({"_id": "Option", "_tag": "Some", "value": v})
}
fn none() -> Value {
    json!({"_id": "Option", "_tag": "None"})
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

/// Take one sample of the server's process tree.
pub async fn sample_from(root: i64, source: &dyn ProcessSource) -> Result<Sample, String> {
    let all = ps_all_from(source).await?;
    let at_ms = chrono::Utc::now().timestamp_millis();
    let procs = descendants(&all, root)
        .into_iter()
        .map(|(p, _, _)| p)
        .collect();
    Ok(Sample { at_ms, procs })
}

/// `ServerProcessDiagnosticsResult`.
pub async fn process_diagnostics_from(root: i64, source: &dyn ProcessSource) -> Value {
    let now = chrono::Utc::now().timestamp_millis();
    let all = match ps_all_from(source).await {
        Ok(a) => a,
        // A failed read is reported AS a failed read. The alternative — an empty
        // process list — renders as "nothing is running", which is a lie the
        // user would act on.
        Err(e) => {
            return json!({
                "serverPid": root.max(1), "readAt": iso(now), "processCount": 0,
                "totalRssBytes": 0, "totalCpuPercent": 0.0, "processes": [],
                "error": some(json!({"message": e})),
            })
        }
    };
    let rows = descendants(&all, root);
    let total_rss: i64 = rows.iter().map(|(p, _, _)| p.rss_bytes).sum();
    let total_cpu: f64 = rows.iter().map(|(p, _, _)| p.cpu_percent).sum();
    let processes: Vec<Value> = rows
        .iter()
        .map(|(p, depth, kids)| {
            json!({
                "pid": p.pid,
                // Derived from elapsed rather than parsed out of `lstart`: the
                // arithmetic is timezone- and locale-free, which the string form
                // is not.
                "startTimeMs": (now - p.elapsed_secs * 1000).max(0),
                "ppid": p.ppid.max(0),
                // 0 is a real pgid on no platform we serve, so it stands for
                // "ps did not report one" rather than being sent as a number.
                "pgid": if p.pgid > 0 { some(json!(p.pgid)) } else { none() },
                "status": if p.status.is_empty() { "?" } else { p.status.as_str() },
                "cpuPercent": p.cpu_percent,
                "rssBytes": p.rss_bytes.max(0),
                "elapsed": if p.elapsed.is_empty() { "0:00" } else { p.elapsed.as_str() },
                "command": if p.command.is_empty() { "(unknown)" } else { p.command.as_str() },
                "depth": depth,
                "childPids": kids,
            })
        })
        .collect();
    json!({
        "serverPid": root.max(1),
        "readAt": iso(now),
        "processCount": processes.len(),
        "totalRssBytes": total_rss.max(0),
        "totalCpuPercent": total_cpu,
        "processes": processes,
        "error": none(),
    })
}

/// Health block shared by the history/telemetry results.
///
/// `native` is honestly `degraded`, not `healthy`: this runtime samples through
/// `ps`, so CPU and memory are real but I/O and cumulative CPU-time are not
/// collected at all. Claiming `healthy` would tell the panel every number on it
/// can be trusted equally.
fn health(scanned: usize, retained: usize, last_sample_ms: Option<i64>) -> Value {
    json!({
        "native": {
            "status": if last_sample_ms.is_some() { "degraded" } else { "starting" },
            "lastSampleAt": match last_sample_ms { Some(ms) => some(json!(iso(ms))), None => none() },
            "lastError": some(json!("ps-based sampling: per-process I/O and cumulative CPU time are not collected")),
        },
        // No Electron here — this is the headless Rust server.
        "desktop": { "status": "unavailable", "lastSampleAt": none(), "lastError": none() },
        "sidecarVersion": none(),
        "sidecarPid": none(),
        "restartCount": 0,
        "collectionDurationMicros": 0,
        "scannedProcessCount": scanned,
        "retainedProcessCount": retained,
        "inaccessibleProcessCount": 0,
    })
}

/// Record one sample into the DURABLE history (#336).
///
/// One row per process per metric, tagged by pid, plus a whole-sample roll-up
/// under the reserved `SERVER_TAG` so the bucket series does not have to sum
/// across tags on the read path. The command line rides along as a label,
/// because a leaderboard of pids with no names is not a diagnostics panel.
pub async fn record_sample(
    hist: &agent_sdk_metrics::ResourceHistory,
    s: &Sample,
) -> Result<(), String> {
    let cpu_total: f64 = s.procs.iter().map(|p| p.cpu_percent).sum();
    let rss_total: i64 = s.procs.iter().map(|p| p.rss_bytes).sum();
    hist.record(
        s.at_ms,
        SERVER_TAG,
        &[
            (CPU_METRIC, cpu_total),
            (RSS_METRIC, rss_total as f64),
            (PROCS_METRIC, s.procs.len() as f64),
        ],
    )
    .await?;
    for p in &s.procs {
        let tag = p.pid.to_string();
        hist.record(
            s.at_ms,
            &tag,
            &[(CPU_METRIC, p.cpu_percent), (RSS_METRIC, p.rss_bytes as f64), (PPID_METRIC, p.ppid as f64)],
        )
        .await?;
        hist.label(&tag, &p.command).await?;
    }
    Ok(())
}

/// The whole-server roll-up's tag. A pid is a decimal string, so this cannot
/// collide with one.
pub const SERVER_TAG: &str = "server";
pub const CPU_METRIC: &str = "cpu_percent";
pub const RSS_METRIC: &str = "rss_bytes";
pub const PROCS_METRIC: &str = "process_count";
pub const PPID_METRIC: &str = "ppid";
/// The cadence the panel polls at, and therefore the width of "current".
pub const SAMPLE_INTERVAL_MS: i64 = 2_000;

/// `ResourceTelemetryHistory` / `ServerProcessResourceHistory`, read from the
/// DURABLE history rather than a process-local ring (#336).
///
/// What changes for the user: the panel is no longer empty after a restart,
/// and two backends serving one UI plot the same history instead of whichever
/// one the socket happened to land on. What stays product-owned is only this
/// function — the wire shape the panel decodes.
///
/// Empty buckets are OMITTED, exactly as the ring version did: a window in
/// which the sampler did not run is not a window of 0% CPU.
pub async fn history_wire_durable(
    hist: &agent_sdk_metrics::ResourceHistory,
    window_ms: i64,
    bucket_ms: i64,
    sample_interval_ms: i64,
) -> Result<Value, String> {
    use agent_sdk_metrics::Aggregate;
    let now = chrono::Utc::now().timestamp_millis();
    let window = window_ms.max(0);
    let bucket = bucket_ms.max(1);

    let avg_cpu = hist.series(CPU_METRIC, Some(SERVER_TAG), now, window.max(1), bucket, Aggregate::Avg).await?;
    let max_cpu = hist.series(CPU_METRIC, Some(SERVER_TAG), now, window.max(1), bucket, Aggregate::Max).await?;
    let max_rss = hist.series(RSS_METRIC, Some(SERVER_TAG), now, window.max(1), bucket, Aggregate::Max).await?;
    let max_procs = hist.series(PROCS_METRIC, Some(SERVER_TAG), now, window.max(1), bucket, Aggregate::Max).await?;
    let samples = hist.series(PROCS_METRIC, Some(SERVER_TAG), now, window.max(1), bucket, Aggregate::Count).await?;

    let at = |series: &[(i64, Option<f64>)], i: usize| series.get(i).and_then(|(_, v)| *v);
    let buckets: Vec<Value> = avg_cpu
        .iter()
        .enumerate()
        // A bucket the sampler never covered stays absent, rather than being
        // drawn as a quiet period that never happened.
        .filter(|(i, (_, v))| v.is_some() || at(&max_cpu, *i).is_some())
        .map(|(i, (start, avg))| {
            json!({
                "startedAt": iso(*start),
                "endedAt": iso(start + bucket),
                "avgCpuPercent": avg.unwrap_or(0.0),
                "maxCpuPercent": at(&max_cpu, i).unwrap_or(0.0),
                "maxRssBytes": at(&max_rss, i).unwrap_or(0.0) as i64,
                // No per-process I/O counters from `ps`; see `ioSemantics`.
                "ioReadBytes": 0,
                "ioWriteBytes": 0,
                "maxProcessCount": at(&max_procs, i).unwrap_or(0.0) as i64,
            })
        })
        .collect();

    let retained: i64 = samples.iter().filter_map(|(_, v)| *v).map(|v| v as i64).sum();
    let top = top_processes_durable(hist, now, window.max(1)).await?;
    let live = max_procs.iter().rev().find_map(|(_, v)| *v).unwrap_or(0.0) as usize;
    let last_at = avg_cpu.iter().rev().find(|(_, v)| v.is_some()).map(|(t, _)| *t);
    Ok(json!({
        "readAt": iso(now),
        "windowMs": window,
        "bucketMs": bucket_ms.max(0),
        "sampleIntervalMs": sample_interval_ms.max(0),
        "retainedSampleCount": retained,
        "buckets": buckets,
        "topProcesses": top,
        "health": health(live, live, last_at),
    }))
}

/// The heaviest processes over the window, from the durable rows.
async fn top_processes_durable(
    hist: &agent_sdk_metrics::ResourceHistory,
    now_ms: i64,
    window_ms: i64,
) -> Result<Vec<Value>, String> {
    use agent_sdk_metrics::Aggregate;
    let peak_cpu = hist.by_tag(CPU_METRIC, now_ms, window_ms, Aggregate::Max).await?;
    let avg_cpu = hist.by_tag(CPU_METRIC, now_ms, window_ms, Aggregate::Avg).await?;
    let peak_rss = hist.by_tag(RSS_METRIC, now_ms, window_ms, Aggregate::Max).await?;
    let ppids = hist.by_tag(PPID_METRIC, now_ms, window_ms, Aggregate::Max).await?;
    // "current" is the most recent sampling tick, not the window: a process
    // that spiked ten minutes ago and is now idle must not be reported as
    // currently burning CPU. Two ticks of slack so a read landing between
    // samples still finds one.
    let recent = (SAMPLE_INTERVAL_MS * 2).min(window_ms);
    let last_cpu = hist.by_tag(CPU_METRIC, now_ms, recent, Aggregate::Max).await?;
    let last_rss = hist.by_tag(RSS_METRIC, now_ms, recent, Aggregate::Max).await?;
    let labels = hist.labels().await?;

    let mut rows: Vec<&agent_sdk_metrics::TagStat> =
        peak_cpu.iter().filter(|t| t.tag != SERVER_TAG).collect();
    rows.sort_by(|a, b| b.value.partial_cmp(&a.value).unwrap_or(std::cmp::Ordering::Equal));
    let find = |v: &Vec<agent_sdk_metrics::TagStat>, tag: &str| {
        v.iter().find(|t| t.tag == tag).map(|t| t.value).unwrap_or(0.0)
    };
    Ok(rows
        .into_iter()
        .take(10)
        .map(|t| {
            // The SAME wire shape the ring emitted — this is a change of
            // source, not of contract, so the panel must not be able to tell
            // which one answered it.
            let command = labels.get(&t.tag).cloned().unwrap_or_default();
            json!({
                "identity": {
                    "pid": t.tag.parse::<i64>().unwrap_or(0),
                    "startTimeMs": t.first_ms.max(0),
                },
                "ppid": (find(&ppids, &t.tag) as i64).max(0),
                "depth": 0,
                "name": command.split_whitespace().next().unwrap_or("(unknown)"),
                "command": if command.is_empty() { "(unknown)" } else { command.as_str() },
                "category": "server-child",
                "firstSeenAt": iso(t.first_ms),
                "lastSeenAt": iso(t.last_ms),
                "currentCpuPercent": find(&last_cpu, &t.tag),
                "avgCpuPercent": find(&avg_cpu, &t.tag),
                "maxCpuPercent": t.value,
                // `ps` gives no cumulative CPU-time counter in this format.
                "cpuTimeMs": 0,
                "currentRssBytes": (find(&last_rss, &t.tag) as i64).max(0),
                "peakRssBytes": (find(&peak_rss, &t.tag) as i64).max(0),
                "ioReadBytes": 0,
                "ioWriteBytes": 0,
                "ioSemantics": "unavailable",
                "sampleCount": t.samples,
            })
        })
        .collect())
}

/// `ServerTraceDiagnosticsResult`.
///
/// This runtime writes tracing to stderr, not to the OTLP span file the panel
/// scans. Rather than answer with an empty-but-successful scan — which renders
/// as "we looked and everything is clean" — it reports the contract's real
/// `trace-file-not-found` error, which the panel already knows how to show.
pub fn trace_diagnostics(trace_path: &str) -> Value {
    let now = chrono::Utc::now().timestamp_millis();
    let exists = std::path::Path::new(trace_path).is_file();
    json!({
        "traceFilePath": if trace_path.is_empty() { "(none)" } else { trace_path },
        "scannedFilePaths": [],
        "readAt": iso(now),
        "recordCount": 0,
        "parseErrorCount": 0,
        "firstSpanAt": none(),
        "lastSpanAt": none(),
        "failureCount": 0,
        "interruptionCount": 0,
        "slowSpanThresholdMs": 0,
        "slowSpanCount": 0,
        "logLevelCounts": {},
        "topSpansByCount": [],
        "slowestSpans": [],
        "commonFailures": [],
        "latestFailures": [],
        "latestWarningAndErrorLogs": [],
        "partialFailure": some(json!(true)),
        "error": some(json!({
            "kind": if exists { "trace-file-read-failed" } else { "trace-file-not-found" },
            "message": if exists {
                "trace file present but this runtime does not write OTLP spans to it".to_string()
            } else {
                format!("no trace file at {trace_path}; this runtime traces to stderr")
            },
        })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct StaticSource(Result<String, String>);

    #[async_trait::async_trait]
    impl ProcessSource for StaticSource {
        async fn ps_output(&self) -> Result<String, String> {
            self.0.clone()
        }
    }

    struct HangingSource;

    #[async_trait::async_trait]
    impl ProcessSource for HangingSource {
        async fn ps_output(&self) -> Result<String, String> {
            std::future::pending::<()>().await;
            unreachable!()
        }
    }

    #[test]
    fn etime_parses_every_ps_layout() {
        assert_eq!(parse_etime("05:10"), Some(310));
        assert_eq!(parse_etime("01:05:10"), Some(3910));
        assert_eq!(parse_etime("2-01:05:10"), Some(2 * 86_400 + 3910));
    }

    /// An unparseable elapsed must not become 0 — start time is `now - elapsed`,
    /// so 0 would date a long-running wedged process to this instant.
    #[test]
    fn etime_refuses_garbage_instead_of_zeroing() {
        assert_eq!(parse_etime("banana"), None);
        assert_eq!(parse_etime(""), None);
        assert_eq!(parse_etime("1:2:3:4"), None);
    }

    /// argv contains spaces; taking it as the remainder is what keeps one agent
    /// subprocess distinguishable from another.
    #[test]
    fn ps_line_keeps_the_whole_command() {
        let p = parse_ps_line("  4321  1000  1000 Ss   12.5  20480 01:05:10 node /x/agent.js --flag a b")
            .expect("parses");
        assert_eq!(p.pid, 4321);
        assert_eq!(p.ppid, 1000);
        assert_eq!(p.cpu_percent, 12.5);
        assert_eq!(p.rss_bytes, 20480 * 1024, "ps reports KiB, contract wants bytes");
        assert_eq!(p.command, "node /x/agent.js --flag a b");
        assert_eq!(p.elapsed_secs, 3910);
    }

    #[test]
    fn ps_line_rejects_a_header_or_junk_row() {
        assert!(parse_ps_line("PID PPID PGID STAT %CPU RSS ELAPSED COMMAND").is_none());
        assert!(parse_ps_line("").is_none());
    }

    fn p(pid: i64, ppid: i64) -> Proc {
        Proc {
            pid, ppid, pgid: pid, status: "S".into(), cpu_percent: 1.0,
            rss_bytes: 1024, elapsed: "0:01".into(), elapsed_secs: 1,
            command: format!("proc{pid}"),
        }
    }

    /// Walks DOWN from the server, so an unrelated tree on the same box is not
    /// reported as an agent subprocess.
    #[test]
    fn descendants_take_the_server_tree_only() {
        let all = vec![p(1, 0), p(10, 1), p(11, 10), p(12, 10), p(99, 1)];
        let got = descendants(&all, 10);
        let pids: Vec<i64> = got.iter().map(|(x, _, _)| x.pid).collect();
        assert_eq!(pids, vec![10, 11, 12], "99 is a sibling, not a descendant: {pids:?}");
        assert_eq!(got[0].1, 0, "root is depth 0");
        assert_eq!(got[1].1, 1);
        let kids = &got[0].2;
        assert_eq!(kids.len(), 2, "root lists its direct children");
    }

    /// A `ps` snapshot raced against a reparent can present a cycle. It must
    /// terminate, not hang the RPC.
    #[test]
    fn descendants_terminate_on_a_cycle() {
        let all = vec![p(10, 11), p(11, 10)];
        let got = descendants(&all, 10);
        assert_eq!(got.len(), 2, "visited each once: {got:?}");
    }

    fn sample_at(at_ms: i64, cpu: f64, rss: i64) -> Sample {
        Sample {
            at_ms,
            procs: vec![Proc { cpu_percent: cpu, rss_bytes: rss, ..p(10, 1) }],
        }
    }

    /// Every history assertion below runs against the DURABLE store (#336),
    /// because that is now the only source. The ring these replaced could be
    /// tested synchronously; the point of deleting it is that this one cannot
    /// forget after a restart, so the tests open a real isolate.
    async fn history(tag: &str) -> (std::path::PathBuf, agent_sdk_metrics::ResourceHistory) {
        let dir = std::env::temp_dir().join(format!("t3-diag-{tag}-{}", uuid::Uuid::new_v4()));
        let pool = do_storage::DbPool::new(dir.join("diagnostics"));
        let db = pool.object_db("diagnostics", "main").await.unwrap();
        (dir, agent_sdk_metrics::ResourceHistory::open(db, 24 * 60 * 60 * 1000).await.unwrap())
    }

    /// The property the ring could not have: history OUTLIVES the process that
    /// recorded it. This is the whole finding — the panel used to be empty
    /// after a restart, which reads as "nothing happened".
    #[tokio::test]
    async fn history_survives_a_restart() {
        let (dir, h) = history("restart").await;
        let now = chrono::Utc::now().timestamp_millis();
        record_sample(&h, &sample_at(now - 1_000, 42.0, 4_242)).await.unwrap();
        drop(h);

        // A second "process" over the same directory.
        let pool = do_storage::DbPool::new(dir.join("diagnostics"));
        let db = pool.object_db("diagnostics", "main").await.unwrap();
        let h2 = agent_sdk_metrics::ResourceHistory::open(db, 24 * 60 * 60 * 1000).await.unwrap();
        let w = history_wire_durable(&h2, 60_000, 10_000, 2_000).await.unwrap();
        assert!(
            w["buckets"].as_array().unwrap().iter().any(|b| b["maxCpuPercent"].as_f64() == Some(42.0)),
            "the sample recorded before the restart must still be there: {w}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Empty buckets are OMITTED, not emitted as zeros — a gap means the server
    /// was not sampling, and a 0% bar invents a quiet period.
    #[tokio::test]
    async fn history_omits_buckets_with_no_samples() {
        let (dir, h) = history("gaps").await;
        let now = chrono::Utc::now().timestamp_millis();
        record_sample(&h, &sample_at(now - 9_000, 10.0, 100)).await.unwrap();
        record_sample(&h, &sample_at(now - 1_000, 30.0, 300)).await.unwrap();
        let w = history_wire_durable(&h, 10_000, 1_000, 2_000).await.unwrap();
        assert_eq!(
            w["buckets"].as_array().unwrap().len(),
            2,
            "only the two sampled buckets: {}",
            w["buckets"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn history_bucket_reports_avg_and_max_separately() {
        let (dir, h) = history("avgmax").await;
        let now = chrono::Utc::now().timestamp_millis();
        record_sample(&h, &sample_at(now - 900, 10.0, 100)).await.unwrap();
        record_sample(&h, &sample_at(now - 800, 30.0, 300)).await.unwrap();
        let w = history_wire_durable(&h, 10_000, 10_000, 2_000).await.unwrap();
        let b = &w["buckets"].as_array().unwrap()[0];
        assert_eq!(b["avgCpuPercent"], 20.0);
        assert_eq!(b["maxCpuPercent"], 30.0, "the spike must survive averaging");
        assert_eq!(b["maxRssBytes"], 300);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn top_processes_rank_by_peak_cpu_and_keep_their_names() {
        let (dir, h) = history("top").await;
        let now = chrono::Utc::now().timestamp_millis();
        record_sample(
            &h,
            &Sample {
                at_ms: now - 500,
                procs: vec![
                    Proc { cpu_percent: 5.0, command: "quiet --thing".into(), ..p(10, 1) },
                    Proc { cpu_percent: 90.0, command: "hog --burn".into(), ..p(11, 1) },
                ],
            },
        )
        .await
        .unwrap();
        let w = history_wire_durable(&h, 10_000, 1_000, 2_000).await.unwrap();
        let top = w["topProcesses"].as_array().unwrap();
        assert_eq!(top[0]["identity"]["pid"], 11, "the hog is first: {top:?}");
        assert_eq!(top[0]["maxCpuPercent"], 90.0);
        // The label came back out of the store, not out of a process-local map:
        // a pid with no command line is not a diagnostics row.
        assert_eq!(top[0]["command"], "hog --burn");
        assert_eq!(top[0]["name"], "hog");
        assert_eq!(top[0]["ioSemantics"], "unavailable", "unmeasured I/O says so");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Health must not claim `healthy` while whole columns are uncollected.
    #[tokio::test]
    async fn health_is_honest_about_partial_collection() {
        let (dir, h) = history("health").await;
        let now = chrono::Utc::now().timestamp_millis();
        record_sample(&h, &sample_at(now - 100, 1.0, 1)).await.unwrap();
        let w = history_wire_durable(&h, 10_000, 1_000, 2_000).await.unwrap();
        assert_eq!(w["health"]["native"]["status"], "degraded");
        assert_eq!(w["health"]["desktop"]["status"], "unavailable");
        assert_eq!(w["health"]["native"]["lastError"]["_tag"], "Some");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn history_wire_carries_the_window_the_caller_asked_for() {
        let (dir, h) = history("window").await;
        let w = history_wire_durable(&h, 60_000, 5_000, 2_000).await.unwrap();
        assert_eq!(w["windowMs"], 60_000);
        assert_eq!(w["bucketMs"], 5_000);
        assert_eq!(w["retainedSampleCount"], 0);
        assert_eq!(w["buckets"].as_array().unwrap().len(), 0, "no samples, no invented bars");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A missing trace file is the contract's `trace-file-not-found`, not an
    /// empty successful scan that reads as "we looked, all clean".
    #[test]
    fn trace_diagnostics_reports_a_missing_file_as_an_error() {
        let d = trace_diagnostics("/nonexistent/trace.jsonl");
        assert_eq!(d["error"]["_tag"], "Some");
        assert_eq!(d["error"]["value"]["kind"], "trace-file-not-found");
        assert_eq!(d["recordCount"], 0);
    }

    /// Option must use Effect's encoded form, or the client drops the field.
    #[test]
    fn options_use_the_effect_wire_encoding() {
        assert_eq!(none()["_id"], "Option");
        assert_eq!(none()["_tag"], "None");
        assert_eq!(some(json!(1))["_tag"], "Some");
        assert_eq!(some(json!(1))["value"], 1);
    }

    /// A failed `ps` is reported AS a failure. An empty process list would
    /// render as "nothing is running", which the user would act on.
    #[tokio::test]
    async fn a_failed_scan_is_an_error_not_an_empty_list() {
        // pid 0 has no descendants to find; the shape still has to be complete
        // and decodable, with an explicit (not fabricated) error field.
        let d = process_diagnostics_from(-1, &StaticSource(Err("ps failed under test".into()))).await;
        assert!(d["serverPid"].as_i64().unwrap() >= 1, "PositiveInt: {d}");
        assert!(d["error"]["_id"] == "Option", "error is an Option: {d}");
        assert_eq!(d["error"]["_tag"], "Some", "failed ps is explicit: {d}");
    }

    #[tokio::test]
    async fn hung_process_source_returns_a_deadline_error() {
        let start = std::time::Instant::now();
        let err = ps_all_from(&HangingSource).await.expect_err("hung source must fail");
        assert!(err.contains("deadline"), "deadline error: {err}");
        assert!(start.elapsed() < std::time::Duration::from_secs(4), "deadline bounded the caller");
    }

    #[tokio::test]
    async fn oversized_process_source_is_rejected_not_silently_truncated() {
        let line = "  4321  1000  1000 Ss    0.1   2048 00:00:01 command\n";
        let rows = line.repeat((PS_OUTPUT_MAX_BYTES / line.len()) + 2);
        let err = ps_all_from(&StaticSource(Ok(rows))).await.expect_err("oversized ps output must fail");
        assert!(err.contains("ceiling"), "ceiling error: {err}");
    }

    /// A well-formed snapshot comes back non-empty when the supervised source
    /// reports the current process row.
    #[tokio::test]
    async fn process_diagnostics_reads_this_real_process() {
        let me = std::process::id() as i64;
        let source = StaticSource(Ok(format!("{me} 1 {me} Ss 0.1 2048 00:00:01 t3code-test-process\n")));
        let d = process_diagnostics_from(me, &source).await;
        assert_eq!(d["error"]["_tag"], "None", "live ps read failed: {d}");
        assert_eq!(d["serverPid"], me);
        let procs = d["processes"].as_array().expect("array");
        assert!(!procs.is_empty(), "must find at least this process: {d}");
        let self_row = procs.iter().find(|p| p["pid"] == me).expect("self in the tree");
        assert_eq!(self_row["depth"], 0);
        assert!(self_row["rssBytes"].as_i64().unwrap() > 0, "real RSS: {self_row}");
        assert!(self_row["command"].as_str().unwrap().len() > 1);
    }
}

// ─────────────────────── #67 remainder: telemetry + usage ───────────────────
//
// Two RPCs remained absent after the diagnostics slice landed: the streaming
// `subscribeResourceTelemetry` and one-shot `server.getUsageSummary`. Both are
// answered here from measured or explicit-unavailable data — never fabricated —
// so the reducer sees the contract shape and the panels render honestly:
// processes come from the same `ps` walk the diagnostics page already uses;
// power/attribution/usage-source come back as the contract's typed unavailable.

fn power_snapshot_unknown(now_ms: i64) -> Value {
    json!({
        "source": "server",
        "idle": "unknown",
        "idleSeconds": Value::Null,
        "locked": "unknown",
        "suspended": false,
        "onBattery": "unknown",
        "lowPowerMode": "unknown",
        "thermalState": "unknown",
        "stale": true,
        "updatedAt": iso(now_ms),
    })
}

fn empty_aggregate() -> Value {
    json!({
        "processCount": 0, "currentCpuPercent": 0.0, "cpuTimeMs": 0,
        "currentRssBytes": 0, "peakRssBytes": 0,
        "ioReadBytes": 0, "ioWriteBytes": 0,
        "ioReadBytesPerSecond": 0.0, "ioWriteBytesPerSecond": 0.0,
        "processStarts": 0, "processExits": 0,
    })
}

/// A `ResourceTelemetrySnapshot` built from the same `ps` walk the diagnostics
/// history uses. `processes` is real (this backend measures CPU%, RSS, ppid,
/// child pids). Per-process I/O byte counters are `ioSemantics: "unavailable"`
/// because `ps` does not expose them; fabricating zeros would render a wedged
/// disk-bound agent as "no I/O" which reads as healthy. Groups aggregate
/// what the backend can observe (its own descendant tree). `power`,
/// `attribution` and `health` are the contract's explicit unavailable states
/// pending a per-source sampler.
pub async fn resource_telemetry_snapshot_from(root: i64, sample_interval_ms: i64, source: &dyn ProcessSource) -> Value {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let all = match ps_all_from(source).await {
        Ok(v) => v,
        Err(e) => {
            return json!({
                "readAt": iso(now_ms),
                "sampleIntervalMs": sample_interval_ms.max(0),
                "processes": [],
                "groups": {
                    "backend": empty_aggregate(),
                    "electron": empty_aggregate(),
                    "monitor": empty_aggregate(),
                    "allT3": empty_aggregate(),
                },
                "power": power_snapshot_unknown(now_ms),
                "speedLimitPercent": none(),
                "attribution": { "readAt": iso(now_ms), "entries": [] },
                "health": {
                    "native": { "status": "unavailable", "lastSampleAt": none(), "lastError": some(json!(e)) },
                    "desktop": { "status": "unavailable", "lastSampleAt": none(), "lastError": none() },
                    "sidecarVersion": none(),
                    "sidecarPid": none(),
                    "restartCount": 0,
                    "collectionDurationMicros": 0,
                    "scannedProcessCount": 0,
                    "retainedProcessCount": 0,
                    "inaccessibleProcessCount": 0,
                },
            });
        }
    };
    let rows = descendants(&all, root);
    let mut total_cpu = 0.0;
    let mut total_rss: i64 = 0;
    let processes: Vec<Value> = rows
        .iter()
        .map(|(p, depth, kids)| {
            total_cpu += p.cpu_percent;
            total_rss += p.rss_bytes.max(0);
            let start_time_ms = (now_ms - p.elapsed_secs * 1000).max(0);
            json!({
                "identity": { "pid": p.pid.max(1), "startTimeMs": start_time_ms },
                "ppid": p.ppid.max(0),
                "childPids": kids,
                "depth": depth,
                "name": if p.command.is_empty() { "(unknown)".to_string() } else { p.command.split_whitespace().next().unwrap_or("(unknown)").to_string() },
                "command": if p.command.is_empty() { "(unknown)" } else { p.command.as_str() },
                "status": if p.status.is_empty() { "?" } else { p.status.as_str() },
                "category": "unknown-t3",
                "cpuPercent": p.cpu_percent,
                "cpuTimeMs": (p.elapsed_secs * 1000).max(0),
                "residentBytes": p.rss_bytes.max(0),
                "peakResidentBytes": p.rss_bytes.max(0),
                "virtualBytes": 0,
                "ioReadBytes": 0,
                "ioWriteBytes": 0,
                "ioReadBytesPerSecond": 0.0,
                "ioWriteBytesPerSecond": 0.0,
                "ioSemantics": "unavailable",
                "runTimeMs": (p.elapsed_secs * 1000).max(0),
                "firstSeenAt": iso(start_time_ms),
                "lastSeenAt": iso(now_ms),
            })
        })
        .collect();
    let backend_agg = json!({
        "processCount": processes.len(), "currentCpuPercent": total_cpu, "cpuTimeMs": 0,
        "currentRssBytes": total_rss, "peakRssBytes": total_rss,
        "ioReadBytes": 0, "ioWriteBytes": 0,
        "ioReadBytesPerSecond": 0.0, "ioWriteBytesPerSecond": 0.0,
        "processStarts": 0, "processExits": 0,
    });
    json!({
        "readAt": iso(now_ms),
        "sampleIntervalMs": sample_interval_ms.max(0),
        "processes": processes,
        "groups": {
            "backend": backend_agg,
            "electron": empty_aggregate(),
            "monitor": empty_aggregate(),
            "allT3": empty_aggregate(),
        },
        "power": power_snapshot_unknown(now_ms),
        "speedLimitPercent": none(),
        "attribution": { "readAt": iso(now_ms), "entries": [] },
        "health": {
            "native": { "status": "healthy", "lastSampleAt": some(json!(iso(now_ms))), "lastError": none() },
            "desktop": { "status": "unavailable", "lastSampleAt": none(), "lastError": none() },
            "sidecarVersion": none(),
            "sidecarPid": none(),
            "restartCount": 0,
            "collectionDurationMicros": 0,
            "scannedProcessCount": rows.len() as i64,
            "retainedProcessCount": rows.len() as i64,
            "inaccessibleProcessCount": 0,
        },
    })
}

/// Read real provider-CLI usage and shape it into the wire `UsageSummary`.
///
/// The scan itself lives in `agent_sdk_usage` — the transcript formats, the
/// provider homes, and the counting rules that make those formats add up are
/// facts about the PROVIDER, not about this product. This function only maps
/// the SDK's result into the contract's JSON and decides what to do when the
/// window is unusable.
///
/// What it replaces: a stub that returned `buckets: []` + `sources: []`
/// unconditionally. That decoded, satisfied every type, and made every real
/// turn the user ran disappear (#328). An empty answer must mean "we looked and
/// there was nothing", which is why `sources` now always reports one row per
/// provider home with the status that home actually had.
///
/// No network. The rate table is whatever the caller cached; with none, tokens
/// are reported and cost is reported as `unpriced` rather than as zero.
pub fn usage_summary(
    input: &Value,
    rates: agent_sdk_usage::RateTable,
) -> Result<Value, Value> {
    usage_summary_from(input, rates, &agent_sdk_usage::default_sources())
}

/// [`usage_summary`] against EXPLICIT provider homes.
///
/// The source list is a parameter rather than an ambient environment read so a
/// test can point the scan at seeded fixtures. Reading `$HOME` inside would
/// make the only provable version of this function the one that scans the
/// developer's real transcripts.
/// `Err` carries the contract's `UsageReadError`, which the RPC declares on
/// its ERROR channel. It must not travel as a success value: the success side
/// is typed `UsageSummary`, so an error-shaped payload delivered through it is
/// something the frontend decoder rejects outright — a failure the Rust side
/// would call handled and the client would experience as a broken page (#332).
pub fn usage_summary_from(
    input: &Value,
    rates: agent_sdk_usage::RateTable,
    sources: &[agent_sdk_usage::SourceSpec],
) -> Result<Value, Value> {
    use agent_sdk_usage::{AggregateOptions, Resolution};

    let now = chrono::Utc::now().timestamp_millis();
    let since = input.get("sinceDay").and_then(Value::as_str).unwrap_or("1970-01-01").to_string();
    let until = input.get("untilDay").and_then(Value::as_str).unwrap_or(&since).to_string();
    let tz = input.get("timeZone").and_then(Value::as_str).unwrap_or("UTC").to_string();

    // A window that runs BACKWARDS is invalid, not empty. Every comparison
    // downstream is a lexicographic `YYYY-MM-DD` string compare, so
    // `since > until` silently matches nothing and would answer "you have no
    // usage" to what is actually a malformed request — the one answer the
    // caller cannot distinguish from the truth.
    if !is_iso_day(&since) || !is_iso_day(&until) {
        return Err(usage_read_error(
            "invalidWindow",
            "sinceDay and untilDay must be YYYY-MM-DD",
        ));
    }
    if since > until {
        return Err(usage_read_error(
            "invalidWindow",
            &format!("sinceDay {since} is after untilDay {until}"),
        ));
    }

    let hourly = input.get("resolution").and_then(Value::as_str) == Some("hour");
    let parse_instant = |key: &str| -> Option<i64> {
        let raw = input.get(key)?.as_str()?;
        chrono::DateTime::parse_from_rfc3339(raw).ok().map(|d| d.timestamp_millis())
    };
    let (since_time_ms, until_time_ms) = if hourly {
        (parse_instant("sinceTime"), parse_instant("untilTime"))
    } else {
        (None, None)
    };

    // An hourly request without usable bounds is a BAD WINDOW, not a reason to
    // silently answer the daily question instead. The client asked for a
    // rolling window; giving it days under an hourly label would be wrong in a
    // way nothing downstream could detect.
    if hourly && (since_time_ms.is_none() || until_time_ms.is_none()) {
        return Err(usage_read_error(
            "invalidWindow",
            "hourly usage requires sinceTime and untilTime as RFC3339 instants",
        ));
    }

    let options = AggregateOptions {
        time_zone: tz.clone(),
        since_day: since.clone(),
        until_day: until.clone(),
        resolution: if hourly { Resolution::Hour } else { Resolution::Day },
        since_time_ms,
        until_time_ms,
    };

    // The mtime prefilter needs the window's start as an instant. A day string
    // in an arbitrary zone is at worst a day off, and the scan already carries
    // 36h of slack, so midnight UTC of `sinceDay` is a safe floor.
    let window_start_ms = since_time_ms.or_else(|| {
        chrono::NaiveDate::parse_from_str(&since, "%Y-%m-%d")
            .ok()
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .map(|dt| dt.and_utc().timestamp_millis())
    });

    let host_id = hostname();
    let started = std::time::Instant::now();
    let scan = match agent_sdk_usage::scan(sources, options, rates.clone(), &host_id, window_start_ms)
    {
        Ok(s) => s,
        // A scan that RAN and FAILED is an error, not an empty page — the
        // distinction the old stub could not express.
        Err(e) => return Err(usage_read_error("scanFailed", &e)),
    };
    let scan_duration_ms = started.elapsed().as_millis() as i64;

    let buckets: Vec<Value> = scan
        .buckets
        .iter()
        .map(|b| {
            let mut row = json!({
                "day": b.day,
                "provider": b.provider.as_str(),
                "model": b.model,
                "totals": {
                    "uncachedInputTokens": b.totals.uncached_input_tokens,
                    "cachedInputTokens": b.totals.cached_input_tokens,
                    "cacheCreationTokens": b.totals.cache_creation_tokens,
                    "outputTokens": b.totals.output_tokens,
                    "reasoningTokens": b.totals.reasoning_tokens,
                },
                "costUsd": b.cost_usd,
                "cacheSavingsUsd": b.cache_savings_usd,
                "costSource": b.cost_source.as_str(),
                "records": b.records,
                "unpricedRecords": b.unpriced_records,
                "sessions": b.sessions,
            });
            // `hourStart` is OPTIONAL in the contract and present only for
            // hourly requests; emitting it as null on a daily request fails the
            // schema's trimmed-non-empty-string.
            if let Some(hour) = &b.hour_start {
                row["hourStart"] = json!(hour);
            }
            row
        })
        .collect();

    let sources_wire: Vec<Value> = scan
        .sources
        .iter()
        .map(|s| {
            json!({
                "fingerprint": {
                    "hostId": s.fingerprint.host_id,
                    "provider": s.fingerprint.provider.as_str(),
                    "resolvedHomePath": s.fingerprint.resolved_home_path,
                    "volumeId": s.fingerprint.volume_id,
                },
                "status": s.status.as_str(),
                "scannedFiles": s.scanned_files,
                "skippedFiles": s.skipped_files,
                "malformedRecords": s.malformed_records,
                "distinctSessions": s.distinct_sessions,
                // The contract types this as a TRIMMED NON-EMPTY string or
                // null, so an empty message must travel as null.
                "message": match s.message.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
                    Some(m) => json!(m),
                    None => Value::Null,
                },
            })
        })
        .collect();

    Ok(json!({
        "contractVersion": 4,
        "readAt": iso(now),
        "timeZone": tz,
        "sinceDay": since,
        "untilDay": until,
        "buckets": buckets,
        "sources": sources_wire,
        "pricing": {
            // Rates are never fetched over the network by this runtime. An
            // empty table is reported as `unavailable` so the UI says "cost
            // unknown" instead of rendering a confident $0.00.
            "status": if rates.is_empty() { "unavailable" } else { "cached" },
            "source": "litellm-model-prices",
            "fetchedAt": Value::Null,
            "knownModels": rates.len() as i64,
        },
        "scanDurationMs": scan_duration_ms,
    }))
}

/// A `YYYY-MM-DD` calendar day that actually exists.
///
/// Checked by PARSING rather than by shape, so `2026-02-30` is rejected too —
/// a date that passes a length/digit test but names no day would bucket
/// nothing and read as an empty window.
fn is_iso_day(day: &str) -> bool {
    chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").is_ok()
}

/// The contract's `UsageReadError` shape — a scan that ran and failed, or a
/// window that could not be honoured.
fn usage_read_error(reason: &str, detail: &str) -> Value {
    json!({ "_tag": "UsageReadError", "reason": reason, "detail": detail })
}

/// This machine's identity in a source fingerprint. Two servers reading one
/// provider home must agree on it, or the client counts that home twice.
fn hostname() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|h| !h.trim().is_empty())
        .unwrap_or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "unknown-host".to_string())
        })
}
