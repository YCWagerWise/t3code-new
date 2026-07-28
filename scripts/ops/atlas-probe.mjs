#!/usr/bin/env node
// Drive an Atlas run from the command line, over the same `/_feed` socket the T3
// adapter uses.
//
// This exists because unit tests around the adapter proved nothing about whether a
// turn actually runs — three separate bugs this session were only ever visible from a
// real drive. Reach for it before believing a green suite.
//
//   turn      send a command and print every frame until the turn ends
//   heartbeat watch an idle run's liveness frames
//   dump      replay a run's durable feed from the beginning
//
// Env: ATLAS_URL (default http://127.0.0.1:3010), ATLAS_WS_TOKEN (required),
//      MODEL, PLUGIN, TEXT, CWD, RUN_ID.

const mode = process.argv[2] ?? "turn";
const base = (process.env.ATLAS_URL ?? "http://127.0.0.1:3010").replace(/\/$/, "");
const token = process.env.ATLAS_WS_TOKEN;
const plugin = process.env.PLUGIN ?? "triage";
const runId = process.env.RUN_ID ?? `thr-probe-${Date.now()}`;

if (!token) {
  console.error("ATLAS_WS_TOKEN is required (see ~/atlas-host.env). Never log its value.");
  process.exit(2);
}

const params = new URLSearchParams({ run_id: runId, plugin, access_token: token });
if (mode === "dump") params.set("after", "0");
const url = `${base.replace(/^http/, "ws")}/_feed?${params}`;

const t0 = Date.now();
const at = () => String(Date.now() - t0).padStart(6);
const seen = [];
const ws = new WebSocket(url);

// The token rides the query string because browsers cannot set WS headers; keep it out
// of anything durable. Only the run id is printed.
console.log(`run=${runId} plugin=${plugin} mode=${mode}`);

ws.onopen = () => {
  if (mode !== "turn") return;
  const payload = {
    text: process.env.TEXT ?? "Reply with exactly: OK",
    ...(process.env.MODEL ? { model: process.env.MODEL } : {}),
    ...(process.env.CWD ? { cwd: process.env.CWD } : {}),
  };
  ws.send(JSON.stringify({ kind: "cmd", payload }));
  console.log(`${at()} SENT ${JSON.stringify(payload)}`);
};

ws.onmessage = (event) => {
  let frame;
  try {
    frame = JSON.parse(String(event.data));
  } catch {
    return;
  }
  if (mode === "turn" && frame.kind === "hb") return; // liveness is noise during a turn
  if (mode === "heartbeat" && frame.kind !== "hb") return;

  if (mode === "dump") {
    seen.push(
      `seq=${String(frame.seq).padStart(3)} ${String(frame.kind).padEnd(10)} ${JSON.stringify(frame.payload ?? frame.error ?? "").slice(0, 200)}`,
    );
    return;
  }
  console.log(`${at()} ${String(frame.kind).padEnd(10)} ${JSON.stringify(frame).slice(0, 260)}`);

  // Only a terminal turn frame, or a transport error, ends the probe.
  const terminal =
    (frame.kind === "turn" && frame.payload?.state !== "start") || frame.kind === "error";
  if (mode === "turn" && terminal) setTimeout(() => process.exit(0), 300);
};

ws.onerror = (e) => console.log(`${at()} ERROR ${e.message ?? e.type ?? String(e)}`);
ws.onclose = (e) => console.log(`${at()} CLOSE code=${e.code} reason=${JSON.stringify(e.reason)}`);

const budgetMs = mode === "turn" ? 240_000 : mode === "heartbeat" ? 46_000 : 5_000;
setTimeout(() => {
  if (mode === "dump") for (const line of seen) console.log(line);
  else console.log(`${at()} no terminal frame within ${budgetMs}ms`);
  process.exit(mode === "turn" ? 1 : 0);
}, budgetMs);
