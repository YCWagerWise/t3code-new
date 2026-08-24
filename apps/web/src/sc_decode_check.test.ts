import { test, expect } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { VcsDiscoveryItem, SourceControlProviderDiscoveryItem } from "@t3tools/contracts";

// Build items the effect-native way (Option instances), ENCODE them, and assert
// the JSON matches the exact shape the Rust sourcecontrol.rs now emits — the
// real wire contract, since Schema.Option is OptionFromSelf and only the RPC
// JSON codec (which produces Option's serialized {_id,_tag,value}) crosses.
test("rust VCS option encoding matches the schema's own encode output", () => {
  const encoded = Schema.encodeUnknownSync(VcsDiscoveryItem)({
    kind: "git",
    implemented: true,
    label: "Git",
    executable: "git",
    status: "available",
    version: Option.some("git 2.50"),
    installHint: "Install Git.",
    detail: Option.none(),
  } as any) as any;
  // this is what the Rust `some()/none()` helpers now produce:
  expect(JSON.parse(JSON.stringify(encoded.version))).toEqual({
    _id: "Option",
    _tag: "Some",
    value: "git 2.50",
  });
  expect(JSON.parse(JSON.stringify(encoded.detail))).toEqual({ _id: "Option", _tag: "None" });
});

test("rust provider auth option encoding matches", () => {
  const encoded = Schema.encodeUnknownSync(SourceControlProviderDiscoveryItem)({
    kind: "github",
    label: "GitHub",
    executable: "gh",
    status: "available",
    version: Option.some("gh 2.92"),
    installHint: "gh",
    detail: Option.none(),
    auth: {
      status: "authenticated",
      account: Option.some("me"),
      host: Option.some("github.com"),
      detail: Option.none(),
    },
  } as any) as any;
  expect(JSON.parse(JSON.stringify(encoded.auth.account))).toEqual({
    _id: "Option",
    _tag: "Some",
    value: "me",
  });
});
