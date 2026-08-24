import { test, expect } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { ReviewDiffPreviewResult, ReviewDiffFileContentsResult } from "@t3tools/contracts";

// generatedAt is Schema.DateTimeUtc (OptionFromSelf-like): its wire form is the
// ISO string the RPC codec reconstructs — exactly what Rust now_iso() emits.
// Prove the wire form by the schema's own encode, then round-trip decode it.
test("review generatedAt wire form is the RFC3339 string Rust emits", () => {
  const S = Schema.Struct({ generatedAt: Schema.DateTimeUtc });
  const dt = (DateTime as any).fromDateUnsafe(new Date("2026-08-19T00:00:00.000Z"));
  const encoded: any = Schema.encodeUnknownSync(S)({ generatedAt: dt } as any);
  expect(JSON.parse(JSON.stringify(encoded)).generatedAt).toBe("2026-08-19T00:00:00.000Z");
  // and the encoded value round-trips back through the schema.
  Schema.decodeUnknownSync(ReviewDiffPreviewResult)({
    cwd: "/w",
    generatedAt: encoded.generatedAt,
    sources: [],
  } as any);
});

test("review.getDiffFileContents wire decodes", () => {
  Schema.decodeUnknownSync(ReviewDiffFileContentsResult)({
    oldContents: "a\n",
    newContents: "b\n",
  });
});
