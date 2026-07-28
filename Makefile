# Repeatable operations for T3 Code + Atlas.
#
# Every recipe here encodes something that was got wrong at least once by hand. Where a
# command has a non-obvious flag, the comment says what breaks without it.

SHELL := /bin/bash
ATLAS_RS ?= $(HOME)/atlas/atlas-rs
ATLAS_ENV ?= $(HOME)/atlas-host.env
ATLAS_URL ?= http://127.0.0.1:3010
APP := $(HOME)/Applications/T3 Code (Alpha).app
DMG := release/T3-Code-0.0.28-arm64.dmg
VOL := /Volumes/T3 Code (Alpha) 0.0.28-arm64
# Never echoed — only ever passed into a child process.
TOKEN = $(shell grep '^ATLAS_WS_TOKEN=' $(ATLAS_ENV) 2>/dev/null | cut -d= -f2-)

.DEFAULT_GOAL := help
.PHONY: help status bounce test typecheck check desktop desktop-build desktop-install \
        atlas-build atlas-deploy atlas-test probe heartbeat dump stranded clean-orphans

help: ## Show this help
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[1m%-16s\033[0m %s\n",$$1,$$2}'

# ---------------------------------------------------------------- state

status: ## What is running, and on which ports/profiles
	@echo "== listeners =="
	@lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E 'node|Electron|atlas-hos|T3 Code' | awk '{print "  " $$1, $$2, $$9}' || echo "  none"
	@echo "== atlas node =="
	@curl -s -o /dev/null -w "  /_members: %{http_code}\n" $(ATLAS_URL)/_members || true
	@echo "== desktop app =="
	@pgrep -f "Contents/MacOS/T3 Code" >/dev/null && echo "  running" || echo "  not running"

stranded: ## Threads whose projection claims a turn no runtime owns
	# The contradiction is the JOIN, not the active turn on its own: a live binding
	# with a turn in flight is a healthy run. Reporting those as stranded would be the
	# same false signal this whole exercise was about removing.
	@echo "== stranded (runtime stopped, projection still running) =="
	@sqlite3 "$(HOME)/.t3/userdata/state.sqlite" \
	  "SELECT s.thread_id, s.status, s.updated_at FROM projection_thread_sessions s \
	   JOIN provider_session_runtime r ON r.thread_id = s.thread_id \
	   WHERE s.active_turn_id IS NOT NULL AND s.active_turn_id != '' \
	     AND r.status = 'stopped';" 2>/dev/null | sed 's/^/  /' || true
	@echo "  (empty = none; the reaper settles these at boot)"
	@echo "== in flight (runtime alive — these are healthy) =="
	@sqlite3 "$(HOME)/.t3/userdata/state.sqlite" \
	  "SELECT s.thread_id, s.status, s.updated_at FROM projection_thread_sessions s \
	   LEFT JOIN provider_session_runtime r ON r.thread_id = s.thread_id \
	   WHERE s.active_turn_id IS NOT NULL AND s.active_turn_id != '' \
	     AND (r.status IS NULL OR r.status != 'stopped');" 2>/dev/null | sed 's/^/  /' || true

# ---------------------------------------------------------------- dev loop

bounce: ## Restart the dev server WITHOUT killing it
	# `node --watch` restarts on file CHANGE, not on child exit — `kill` takes the
	# server down and leaves it down. Touching a watched file is the safe restart,
	# and it preserves T3CODE_PORT so the web client's baked VITE_WS_URL still matches.
	@touch apps/server/src/bin.ts && echo "touched apps/server/src/bin.ts — watcher will respawn"

test: ## Server test suite
	@cd apps/server && pnpm vitest run

typecheck: ## Whole-repo typecheck
	# Do NOT wrap this in `timeout` — that binary does not exist on macOS, and the
	# shell returns 127 while an empty grep reads as success.
	@pnpm typecheck

check: typecheck test ## Typecheck then test

# ---------------------------------------------------------------- desktop app

desktop-build: ## Build the mac dmg
	# node_modules/.bin on PATH or the script dies on `spawn vp ENOENT`.
	@PATH="$(PWD)/node_modules/.bin:$$PATH" node scripts/build-desktop-artifact.ts \
	  --platform mac --target dmg --arch arm64

desktop-install: ## Quit, swap the installed bundle, relaunch
	@pkill -f "Contents/MacOS/T3 Code" 2>/dev/null || true
	@sleep 5
	@if [ -d "$(APP)" ]; then rm -rf "$(APP).prev" && mv "$(APP)" "$(APP).prev"; fi
	@hdiutil attach -nobrowse -quiet "$(DMG)"
	@cp -R "$(VOL)/T3 Code (Alpha).app" "$(HOME)/Applications/"
	@hdiutil detach "$(VOL)" -quiet || true
	@echo "installed; verifying the bundle actually contains current server code:"
	@S="$(APP)/Contents/Resources/app.asar.unpacked/apps/server/dist/bin.mjs"; \
	  echo "  boot reconciliation: $$(grep -c 'boot-reconciled' "$$S" 2>/dev/null)"; \
	  echo "  cwd on cmd frame:    $$(grep -c 'state.cwd' "$$S" 2>/dev/null)"
	@open "$(APP)" && echo "launched"

desktop: desktop-build desktop-install ## Rebuild and reinstall the desktop app
	# The packaged app runs a BUILT server, which is exactly why agents survive their
	# own edits under it — and exactly why source changes need this loop to appear.

# ---------------------------------------------------------------- atlas

atlas-build: ## Release-build atlas-host
	@cd $(ATLAS_RS) && cargo build --release -p atlas-host

atlas-test: ## atlas-host tests (lib + integration)
	@cd $(ATLAS_RS) && cargo test -p atlas-host

atlas-deploy: atlas-build ## Build, restart the node, wait for health
	@launchctl kickstart -k gui/$$(id -u)/pro.vulcanos.atlas-host
	@for i in 1 2 3 4 5 6; do \
	  c=$$(curl -s -o /dev/null -w "%{http_code}" $(ATLAS_URL)/_members); \
	  [ "$$c" = "200" ] && echo "node healthy" && exit 0; sleep 2; done; \
	  echo "node did not come back" && exit 1

# ---------------------------------------------------------------- probes

probe: ## Drive one real Atlas turn end to end (MODEL=, TEXT=, CWD=)
	# The only check that cannot be faked. A green suite proved nothing about whether
	# a turn runs — every serious bug this session was found here.
	@ATLAS_WS_TOKEN="$(TOKEN)" ATLAS_URL=$(ATLAS_URL) node scripts/ops/atlas-probe.mjs turn

heartbeat: ## Watch liveness frames on an idle run
	@ATLAS_WS_TOKEN="$(TOKEN)" ATLAS_URL=$(ATLAS_URL) node scripts/ops/atlas-probe.mjs heartbeat

dump: ## Replay a run's durable feed (RUN_ID=thr-...)
	@ATLAS_WS_TOKEN="$(TOKEN)" ATLAS_URL=$(ATLAS_URL) node scripts/ops/atlas-probe.mjs dump

# ---------------------------------------------------------------- hygiene

clean-orphans: ## List stale dev servers/web servers to kill by hand
	# Deliberately does not kill anything: an orphan and the live pair look identical
	# from the outside, and killing the wrong one strands whatever it was running.
	@lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep node | awk '{print "  " $$2, $$9}' || echo "  none"
	@echo "  the live pair is the web server whose VITE_WS_URL matches a listening API port:"
	@for p in $$(pgrep -f 'vite-plus'); do \
	  ps eww -o command= -p $$p 2>/dev/null | tr ' ' '\n' | grep -E '^VITE_WS_URL=' | sed "s/^/  pid $$p /"; done
