import { assert, it } from "@effect/vitest";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessSpawnError, VcsProcessTimeoutError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { makeCliPresenceCache } from "./SourceControlProviderDiscovery.ts";

/**
 * A `VcsProcess` double that answers however the test scripts it, and counts how many times it
 * was actually asked to spawn something. `makeCliPresenceCache`'s whole point is to make that
 * count stop growing once the answer is known — every test here asserts on it directly, per the
 * "assert on the classified result plus the spawn-count" fallback for a repo with no existing
 * span-assertion seam.
 */
function scriptedProcess(run: VcsProcess.VcsProcess["Service"]["run"]): {
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    process: VcsProcess.VcsProcess.of({
      run: (input) => {
        calls += 1;
        return run(input);
      },
    }),
    calls: () => calls,
  };
}

/** What `VcsProcess.run` now returns for an absent command — a success, never a failure. */
const commandNotFoundOutput = {
  exitCode: ChildProcessSpawner.ExitCode(-1),
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  commandNotFound: true,
} satisfies VcsProcess.VcsProcessOutput;

it.effect(
  "a) classifies an absent command as a non-failing result, not a Failure — the ENOENT case",
  () =>
    Effect.gen(function* () {
      const { process, calls } = scriptedProcess(() => Effect.succeed(commandNotFoundOutput));
      const cache = yield* makeCliPresenceCache(
        [{ executable: "az", versionArgs: ["--version"] }],
        {
          process,
          cwd: "/repo",
        },
      );

      // `Effect.result` turns a failure into an ordinary value instead of throwing, so a
      // `Result.Failure` here would mean the probe itself failed — exactly what must not happen
      // for an absent CLI. Succeeding is the direct proof: an `Effect.fn` span only closes as
      // Failure when the effect it wraps fails, and this one does not.
      const result = yield* Effect.result(Cache.get(cache, "az"));

      assert.deepStrictEqual(result, Result.succeed({ status: "absent" }));
      assert.strictEqual(calls(), 1);
    }),
);

it.effect("b1) a timeout is a genuine failure and is not cached as absence", () =>
  Effect.gen(function* () {
    const { process, calls } = scriptedProcess((input) =>
      Effect.fail(
        new VcsProcessTimeoutError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          timeoutMs: 5_000,
        }),
      ),
    );
    const cache = yield* makeCliPresenceCache([{ executable: "az", versionArgs: ["--version"] }], {
      process,
      cwd: "/repo",
    });

    const first = yield* Effect.result(Cache.get(cache, "az"));
    const second = yield* Effect.result(Cache.get(cache, "az"));

    assert.ok(Result.isFailure(first), "a timeout must still fail the probe");
    assert.ok(Result.isFailure(second), "a timeout must still fail the probe");
    // Not cached: a second call re-probes rather than replaying an hours-old "absent" answer for
    // a CLI that is actually just slow or temporarily broken.
    assert.strictEqual(calls(), 2);
  }),
);

it.effect("b2) an EACCES spawn fault is a genuine failure and is not cached as absence", () =>
  Effect.gen(function* () {
    const { process, calls } = scriptedProcess((input) =>
      Effect.fail(
        new VcsProcessSpawnError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          cause: PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "ChildProcess",
            method: "spawn",
          }),
        }),
      ),
    );
    const cache = yield* makeCliPresenceCache([{ executable: "az", versionArgs: ["--version"] }], {
      process,
      cwd: "/repo",
    });

    const first = yield* Effect.result(Cache.get(cache, "az"));
    const second = yield* Effect.result(Cache.get(cache, "az"));

    assert.ok(Result.isFailure(first), "EACCES must still fail the probe, not report absence");
    assert.ok(Result.isFailure(second), "EACCES must still fail the probe, not report absence");
    assert.strictEqual(calls(), 2);
  }),
);

it.effect(
  "c) an absent result is served from cache on a second call, inside the sticky window",
  () =>
    Effect.gen(function* () {
      const { process, calls } = scriptedProcess(() => Effect.succeed(commandNotFoundOutput));
      const cache = yield* makeCliPresenceCache(
        [{ executable: "az", versionArgs: ["--version"] }],
        {
          process,
          cwd: "/repo",
        },
      );

      const first = yield* Cache.get(cache, "az");
      // Comfortably inside the 24-hour sticky-negative TTL, but far past the 5-minute TTL an
      // "available" result would have gotten — this is what proves the two are on genuinely
      // different clocks, not just "cached briefly".
      yield* TestClock.adjust("23 hours");
      const second = yield* Cache.get(cache, "az");

      assert.deepStrictEqual(first, { status: "absent" });
      assert.deepStrictEqual(second, { status: "absent" });
      assert.strictEqual(calls(), 1);
    }),
);

it.effect("an available result is cached too, but on its own shorter window", () =>
  Effect.gen(function* () {
    const { process, calls } = scriptedProcess(() =>
      Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: "az version 2.60.0\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        commandNotFound: false,
      } satisfies VcsProcess.VcsProcessOutput),
    );
    const cache = yield* makeCliPresenceCache([{ executable: "az", versionArgs: ["--version"] }], {
      process,
      cwd: "/repo",
    });

    yield* Cache.get(cache, "az");
    yield* TestClock.adjust("23 hours");
    yield* Cache.get(cache, "az");

    // The 24h absence TTL would still have masked a fresh probe; an available result's own much
    // shorter TTL does not, so this genuinely re-probed.
    assert.strictEqual(calls(), 2);
  }),
);
