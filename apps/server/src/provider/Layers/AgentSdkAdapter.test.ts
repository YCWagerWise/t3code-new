import { describe, expect, it } from "vite-plus/test";

import { isEmptyTurnRequest, resolveTurnModel } from "./AgentSdkAdapter.ts";

/**
 * PROOF (#217): an in-session model switch is the SESSION's model afterwards.
 *
 * The adapter applied a switch to the live runtime but left `session.model`
 * stale, so a following turn without an explicit `modelSelection` — the normal
 * case, since the reactor only forwards one when the caller supplies it —
 * reverted to the model from before the switch, with the UI showing the new one.
 */
describe("resolveTurnModel", () => {
  const instance = "claudeAgent";

  it("keeps a switched model across a later turn that carries no selection", () => {
    // turn 1: the thread's original model
    const first = resolveTurnModel({
      sessionModel: "claude-sonnet-5",
      boundInstanceId: instance,
      selection: undefined,
    });
    expect(first.model).toBe("claude-sonnet-5");

    // turn 2: the user switches mid-thread
    const second = resolveTurnModel({
      sessionModel: first.nextSessionModel,
      boundInstanceId: instance,
      selection: { instanceId: instance, model: "claude-opus-5" },
    });
    expect(second.model).toBe("claude-opus-5");
    expect(second.nextSessionModel).toBe("claude-opus-5");

    // turn 3: no explicit selection — it must STAY switched
    const third = resolveTurnModel({
      sessionModel: second.nextSessionModel,
      boundInstanceId: instance,
      selection: undefined,
    });
    expect(third.model).toBe("claude-opus-5");
    expect(third.nextSessionModel).toBe("claude-opus-5");
  });

  // #284: `resolveTurnModel` is now DEFENSE IN DEPTH — a cross-provider
  // selection reaching this pure function returns the session model
  // unchanged (never routes the wrong instance), but the REAL refusal
  // lives at `sendTurn`, which throws a visible
  // `ProviderAdapterValidationError` BEFORE any state mutation. See
  // AgentSdkAdapter.ts sendTurn guard "Cross-provider switch requires a
  // new session". The pure function's fallback stays as a belt on the
  // outer guard.
  it("cross-provider selection: pure function falls back to session model (defense-in-depth); real refusal lives at sendTurn (#284)", () => {
    const out = resolveTurnModel({
      sessionModel: "claude-opus-5",
      boundInstanceId: instance,
      selection: { instanceId: "codex", model: "gpt-5-codex" },
    });
    expect(out.model).toBe("claude-opus-5");
    expect(out.nextSessionModel).toBe("claude-opus-5");
  });

  it("leaves the session model unset when nothing has ever been chosen", () => {
    const out = resolveTurnModel({
      sessionModel: undefined,
      boundInstanceId: instance,
      selection: undefined,
    });
    expect(out.model).toBeUndefined();
    expect(out.nextSessionModel).toBeUndefined();
  });
});

describe("isEmptyTurnRequest", () => {
  // #272: `ProviderService` only rejects a falsy `input`, so a whitespace-only
  // send reaches the adapter. It used to be discovered AFTER
  // `runtime.setModel` had run and the turn had been marked active — a
  // rejected send that nonetheless changed which model the next real turn uses.
  it("treats whitespace-only text with no attachments as empty", () => {
    expect(isEmptyTurnRequest({ input: "   " })).toBe(true);
    expect(isEmptyTurnRequest({ input: "\n\t " })).toBe(true);
    expect(isEmptyTurnRequest({ input: "", attachments: [] })).toBe(true);
    expect(isEmptyTurnRequest({})).toBe(true);
  });

  it("does not call a real send empty", () => {
    expect(isEmptyTurnRequest({ input: "hello" })).toBe(false);
    // Whitespace around real text is still real text.
    expect(isEmptyTurnRequest({ input: "  hi  " })).toBe(false);
  });

  it("an attachment alone is a turn — an image with no caption is a real send", () => {
    expect(isEmptyTurnRequest({ input: "   ", attachments: [{ id: "a1" }] })).toBe(false);
    expect(isEmptyTurnRequest({ attachments: [{ id: "a1" }] })).toBe(false);
  });
});
