/**
 * AtlasTextGeneration tests.
 *
 * Run against a stubbed HttpClient, not a live node — CI has no Atlas ring, and a
 * test that silently skips when the fleet is down is a test that lies.
 *
 * What is pinned here is the part that can silently rot: that a run is addressed
 * off the user's warm thread, that the model's JSON survives being wrapped in
 * prose, that each result is sanitized before it reaches the UI, and that a node
 * failure or a malformed answer becomes a typed error rather than garbage in a
 * commit message.
 */
import { AtlasSettings, TextGenerationError } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { makeAtlasTextGeneration } from "./AtlasTextGeneration.ts";

const decodeAtlasSettings = Schema.decodeSync(AtlasSettings);
const isTextGenerationError = Schema.is(TextGenerationError);
const CONFIG = decodeAtlasSettings({ baseUrl: "http://127.0.0.1:3010", plugin: "coder" });

const MODEL_SELECTION = { provider: "atlas", model: "claude" } as never;

interface Captured {
  url: string;
  body: string;
}

/** Records the outgoing request and replays a canned answer. */
const stubHttpClient = (respondWith: { status: number; body: string }) => {
  const captured: Array<Captured> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const bodyText =
          request.body._tag === "Uint8Array"
            ? new TextDecoder().decode(request.body.body)
            : request.body._tag === "Raw"
              ? String(request.body.body)
              : "";
        captured.push({ url: request.url, body: bodyText });
        return HttpClientResponse.fromWeb(
          request,
          new Response(respondWith.body, { status: respondWith.status }),
        );
      }),
    ),
  );
  return { captured, layer };
};

/** Build the service against a canned node response and hand it to the test. */
const withStub = (
  respondWith: { status: number; body: string },
  use: (
    service: Effect.Success<ReturnType<typeof makeAtlasTextGeneration>>,
    captured: Array<Captured>,
  ) => Effect.Effect<void, TextGenerationError, never>,
) => {
  const stub = stubHttpClient(respondWith);
  return makeAtlasTextGeneration(CONFIG).pipe(
    Effect.flatMap((service) => use(service, stub.captured)),
    Effect.provide(stub.layer),
  );
};

describe("AtlasTextGeneration", () => {
  it.effect("addresses a run that is NOT the user's warm thread", () =>
    withStub({ status: 200, body: `{"title":"Add feed socket"}` }, (service, captured) =>
      service
        .generateThreadTitle({
          cwd: "/repo",
          message: "add a websocket",
          modelSelection: MODEL_SELECTION,
        })
        .pipe(
          Effect.map(() => {
            const [sent] = captured;
            // A `thr-` prefix would make Atlas treat this as a warm thread and a
            // generated commit message would land in the user's conversation.
            assert.ok(sent?.url.includes("/Agent/textgen-generateThreadTitle-"));
            assert.ok(!sent?.url.includes("/Agent/thr-"));
            assert.ok(sent?.url.endsWith("/run"));
            assert.deepStrictEqual(JSON.parse(sent?.body ?? "{}").plugin, "coder");
          }),
        ),
    ),
  );

  it.effect("gives each call a distinct run id so concurrent generations cannot collide", () =>
    withStub({ status: 200, body: `{"title":"T"}` }, (service, captured) =>
      Effect.all(
        [
          service.generateThreadTitle({
            cwd: "/repo",
            message: "one",
            modelSelection: MODEL_SELECTION,
          }),
          service.generateThreadTitle({
            cwd: "/repo",
            message: "two",
            modelSelection: MODEL_SELECTION,
          }),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(() => {
          assert.strictEqual(captured.length, 2);
          assert.notStrictEqual(captured[0]?.url, captured[1]?.url);
        }),
      ),
    ),
  );

  it.effect("lifts the model's JSON out of surrounding prose", () =>
    withStub(
      {
        status: 200,
        // Atlas answers in prose; the agent wraps its JSON in explanation.
        body: 'Sure! Here is the title:\n\n{"title":"Add the feed socket"}\n\nHope that helps.',
      },
      (service) =>
        service
          .generateThreadTitle({
            cwd: "/repo",
            message: "m",
            modelSelection: MODEL_SELECTION,
          })
          .pipe(Effect.map((r) => assert.strictEqual(r.title, "Add the feed socket"))),
    ),
  );

  it.effect("sanitizes a thread title rather than trusting the model", () =>
    withStub({ status: 200, body: `{"title":"  \\"Add   the   socket\\"  "}` }, (service) =>
      service
        .generateThreadTitle({ cwd: "/repo", message: "m", modelSelection: MODEL_SELECTION })
        .pipe(
          // Quotes stripped, whitespace collapsed — a raw title would look wrong
          // in the sidebar.
          Effect.map((r) => assert.strictEqual(r.title, "Add the socket")),
        ),
    ),
  );

  it.effect("strips a trailing period from a commit subject", () =>
    withStub({ status: 200, body: `{"subject":"Add the feed socket.","body":"Details."}` }, (s) =>
      s
        .generateCommitMessage({
          cwd: "/repo",
          branch: "main",
          stagedSummary: "1 file",
          stagedPatch: "diff",
          modelSelection: MODEL_SELECTION,
        })
        .pipe(
          Effect.map((r) => {
            assert.strictEqual(r.subject, "Add the feed socket");
            assert.strictEqual(r.body, "Details.");
          }),
        ),
    ),
  );

  it.effect("returns a branch name under its contract key", () =>
    withStub({ status: 200, body: `{"branch":"feat/feed-socket"}` }, (service) =>
      service
        .generateBranchName({ cwd: "/repo", message: "m", modelSelection: MODEL_SELECTION })
        .pipe(Effect.map((r) => assert.strictEqual(r.branch, "feat/feed-socket"))),
    ),
  );

  it.effect("returns PR title and body", () =>
    withStub({ status: 200, body: `{"title":"Add feed","body":"## What\\n\\nA socket."}` }, (s) =>
      s
        .generatePrContent({
          cwd: "/repo",
          baseBranch: "main",
          headBranch: "feat/x",
          commitSummary: "c",
          diffSummary: "d",
          diffPatch: "p",
          modelSelection: MODEL_SELECTION,
        })
        .pipe(
          Effect.map((r) => {
            assert.strictEqual(r.title, "Add feed");
            assert.ok(r.body.includes("A socket."));
          }),
        ),
    ),
  );

  it.effect("fails with a typed error when the node does not answer", () =>
    withStub({ status: 503, body: "node down" }, (service) =>
      service
        .generateThreadTitle({ cwd: "/repo", message: "m", modelSelection: MODEL_SELECTION })
        .pipe(
          Effect.flip,
          Effect.map((error) => {
            assert.ok(isTextGenerationError(error));
            assert.strictEqual(error.operation, "generateThreadTitle");
            assert.ok(error.detail.includes("Atlas node did not answer"));
          }),
          Effect.orDie,
        ),
    ),
  );

  it.effect("fails when the answer contains no JSON object at all", () =>
    withStub({ status: 200, body: "I could not do that." }, (service) =>
      service
        .generateThreadTitle({ cwd: "/repo", message: "m", modelSelection: MODEL_SELECTION })
        .pipe(
          Effect.flip,
          Effect.map((error) => assert.ok(error.detail.includes("no JSON object"))),
          Effect.orDie,
        ),
    ),
  );

  it.effect("fails when the JSON does not match the expected shape", () =>
    withStub({ status: 200, body: `{"headline":"wrong key"}` }, (service) =>
      service
        .generateThreadTitle({ cwd: "/repo", message: "m", modelSelection: MODEL_SELECTION })
        .pipe(
          Effect.flip,
          // A shape mismatch must not reach the UI as an empty or partial title.
          Effect.map((error) => assert.ok(error.detail.includes("did not match"))),
          Effect.orDie,
        ),
    ),
  );
});
