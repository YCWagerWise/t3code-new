# backend — the Rust T3Code server

This is the Rust implementation of the T3Code server: the thing `apps/web` talks
to over Effect-RPC on `/ws`, and the flagship integration test for the stack
underneath it (agent-sdk-rs, hearth, cairn, do-rs, turso).

It is not a port of `apps/server` endpoint by endpoint. The point is to leverage
the lower layers so this stays composition glue: durable threads and cursors come
from the SDK's runtime store, process lifecycle from hearth, workspace truth from
cairn, durability and coordination from do-rs over turso. When this file grows a
subsystem, the question is whether a reusable primitive is missing one layer down.

## Run it as the product

    T3CODE_BACKEND=rust pnpm dev

That is the whole thing. `pnpm dev` allocates a web port and a server port,
exports both `T3CODE_PORT` (what the web client proxies at) and
`T3CODE_SERVER_PORT` (what this server binds), and `apps/server`'s dev script
starts this backend instead of the Node one. Read the URL off the runner output;
`scripts/dev-runner.ts` hashes a per-worktree offset onto the base ports so
several cells can run at once, and the port your worktree gets is not the port
another one got.

`pnpm dev` with no `T3CODE_BACKEND` still starts the Node server, which is the
historical default and stays the default until this backend is the better one.

### Why that flag has to exist

Before it did, nothing in the repo's dev path built or ran this crate. `pnpm dev`
resolved to `--filter=t3`, which was `node --watch src/bin.ts`, and
`grep -i rust scripts/dev-runner.ts t3.json` returned nothing. So anyone driving
the app in a browser was driving the Node server, and a defect in this backend was
invisible to that loop by construction. That is the mechanical reason this repo
accumulated Rust-backend defects found by reading code rather than by using the
product.

## Run it by hand

Sometimes you want the server without Vite (attaching a debugger, pointing a
second client at it, running it under `perf`):

    cargo run --release --bin t3code-server

Environment it reads:

| variable | meaning | default |
|---|---|---|
| `T3CODE_SERVER_PORT` | the port to bind on 127.0.0.1 | `13774` |
| `T3CODE_WORKSPACE` | the workspace root the agent works in | current directory |
| `T3CODE_AGENT_DATA` | durable state root (do-rs isolates, hearth jobs) | `./.t3code-agent` |
| `T3CODE_AGENT_MODEL` | preferred default model, resolved through the provider catalog | first READY instance |

Two of those will bite you:

* **`T3CODE_AGENT_DATA` is a bare relative path.** The store root is therefore
  "whatever directory you launched from", and this repo already contains two
  complete copies of it (`./.t3code-agent` and `./backend/.t3code-agent`) with
  disjoint session ids. Set it explicitly, or you get a clean-looking first run
  that is actually a second universe.
* **Do not point `T3CODE_AGENT_DATA` at `~/.t3/userdata`.** That is the
  developer's live T3Code database, in use while you work. Read it, copy from it,
  never start a server against it.

To drive it from a browser without `pnpm dev`, start the web dev server with
`T3CODE_PORT` set to the same port so Vite proxies `/api`, `/ws`, `/oauth` and
`/.well-known` at it. Never set `VITE_HTTP_URL` or `VITE_WS_URL` for browser dev:
they bake an origin into the bundle and break every non-localhost client.

## Tests

    cargo test --release

Run it on the build box rather than a laptop; a full workspace release run with
several agents on one machine is what makes the machine unusable. Restart and
reconnect behaviour lives in `tests/restart_reconnect.rs` and shell/PTY behaviour
in `tests/shell_session.rs` — those are the ones that prove the durability claim,
as opposed to happy-path in-memory behaviour.

## Layout

| file | owns |
|---|---|
| `server_main.rs` | the served router, the WS frame dispatcher, and the RPC surface |
| `main.rs` | `t3code-agent`, the ACP child t3code spawns as a provider |
| `providers.rs` | the provider catalog: one authority for what the model picker shows and what a turn runs |
| `assets.rs` | `assets.createUrl` and the HTTP route that redeems what it mints |
| `terminal.rs`, `sourcecontrol.rs`, `vcs.rs`, `projects.rs`, `settings.rs`, `keybindings.rs`, `review.rs`, `diagnostics.rs` | thin adapters over the layer that actually owns each concern |
| `contract_tests.rs`, `usage_contract_tests.rs` | the contract surface, kept out of `server_main.rs` on purpose |
