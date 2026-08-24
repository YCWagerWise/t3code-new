import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { findAgentBinary } from "./AgentSdkDriver.ts";

/**
 * #240: the driver used to hardcode `installed: true, status: "ready"`, so a
 * missing `t3code-agent` binary was reported to the client as a fully ready
 * provider. The user only discovered it after sending a turn.
 *
 * `findAgentBinary` is the seam that decides `installed`/`status`, so these
 * cover it directly rather than standing up the whole driver graph.
 */
describe("findAgentBinary", () => {
  const tmp = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-agentbin-"));

  it.effect("finds a bare name on PATH", () =>
    Effect.gen(function* () {
      const dir = NodeFs.mkdtempSync(NodePath.join(tmp, "path-"));
      const bin = NodePath.join(dir, "t3code-agent");
      NodeFs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });

      expect(yield* findAgentBinary({ PATH: dir })).toBe(bin);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports null when the bare name is on no PATH entry", () =>
    Effect.gen(function* () {
      const empty = NodeFs.mkdtempSync(NodePath.join(tmp, "empty-"));

      // This is the case that used to be reported as `installed: true`.
      expect(yield* findAgentBinary({ PATH: empty })).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses an explicit T3CODE_AGENT_BIN path as given", () =>
    Effect.gen(function* () {
      const dir = NodeFs.mkdtempSync(NodePath.join(tmp, "explicit-"));
      const bin = NodePath.join(dir, "custom-agent");
      NodeFs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });

      expect(yield* findAgentBinary({ T3CODE_AGENT_BIN: bin, PATH: "" })).toBe(bin);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not fall back to PATH when an explicit override is missing", () =>
    Effect.gen(function* () {
      // A bad override must surface as unavailable rather than silently
      // resolving some other binary that happens to share the name.
      const dir = NodeFs.mkdtempSync(NodePath.join(tmp, "shadow-"));
      NodeFs.writeFileSync(NodePath.join(dir, "t3code-agent"), "#!/bin/sh\n", { mode: 0o755 });

      expect(
        yield* findAgentBinary({
          T3CODE_AGENT_BIN: NodePath.join(dir, "does-not-exist"),
          PATH: dir,
        }),
      ).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports null when PATH is absent entirely", () =>
    Effect.gen(function* () {
      expect(yield* findAgentBinary({})).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // #240 follow-up (reviewer): the fs.exists check on its own was not
  // enough — a file that exists but is not executable would still report
  // ready and the user hits EACCES only after sending a turn. The probe
  // now requires the same runnable predicate the spawn path implies.
  it.effect("reports null when the bare name on PATH is not executable", () =>
    Effect.gen(function* () {
      const dir = NodeFs.mkdtempSync(NodePath.join(tmp, "no-exec-"));
      const bin = NodePath.join(dir, "t3code-agent");
      // Present but not executable (mode 0o644 = rw-r--r--).
      NodeFs.writeFileSync(bin, "not a real binary\n", { mode: 0o644 });

      expect(yield* findAgentBinary({ PATH: dir })).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports null when an explicit T3CODE_AGENT_BIN path is not executable", () =>
    Effect.gen(function* () {
      const dir = NodeFs.mkdtempSync(NodePath.join(tmp, "explicit-no-exec-"));
      const bin = NodePath.join(dir, "unrunnable");
      NodeFs.writeFileSync(bin, "just text\n", { mode: 0o644 });

      expect(yield* findAgentBinary({ T3CODE_AGENT_BIN: bin, PATH: "" })).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports null for a file this user OWNS with only the OTHER execute bit", () =>
    Effect.gen(function* () {
      // THE CASE `mode & 0o111` GETS WRONG. 0o001 grants execute to `other`
      // only. POSIX picks ONE permission class by who is asking — owner, else
      // group, else other — so for a file this process owns, the OWNER class
      // applies and it has no `x`. The bit is set and we still cannot run it.
      // `access(X_OK)` asks the kernel; a bitmask re-derives the rule and gets
      // it backwards.
      const dir = NodeFs.mkdtempSync(NodePath.join(tmp, "other-exec-only-"));
      const bin = NodePath.join(dir, "t3code-agent");
      NodeFs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o001 });

      expect(yield* findAgentBinary({ PATH: dir })).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("skips a non-executable PATH entry and finds the executable one after it", () =>
    Effect.gen(function* () {
      // Before #240 the lookup returned the FIRST existing hit, so it reported
      // a path that the spawn would never have used — the spawn walks PATH and
      // takes the first RUNNABLE match. Worse than reporting nothing, because
      // it looks resolved.
      const broken = NodeFs.mkdtempSync(NodePath.join(tmp, "shadow-broken-"));
      const good = NodeFs.mkdtempSync(NodePath.join(tmp, "shadow-good-"));
      NodeFs.writeFileSync(NodePath.join(broken, "t3code-agent"), "text\n", {
        mode: 0o644,
      });
      const real = NodePath.join(good, "t3code-agent");
      NodeFs.writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });

      expect(yield* findAgentBinary({ PATH: [broken, good].join(NodePath.delimiter) })).toBe(real);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports null when the PATH candidate is a DIRECTORY, not a file", () =>
    Effect.gen(function* () {
      // Yes, this happens: someone `mkdir t3code-agent` in a PATH dir
      // to hold logs. The `type !== "File"` check catches it before the
      // spawn does.
      const dir = NodeFs.mkdtempSync(NodePath.join(tmp, "dir-shadow-"));
      NodeFs.mkdirSync(NodePath.join(dir, "t3code-agent"));

      expect(yield* findAgentBinary({ PATH: dir })).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
