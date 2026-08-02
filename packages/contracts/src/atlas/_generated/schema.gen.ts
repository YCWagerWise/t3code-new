// Generated from atlas-protocol (the Atlas wire contract). Do not edit manually.
// Atlas protocolVersion: 1
// Regenerate: (in atlas-rs) cargo run -p atlas-protocol --bin emit-schema -- --flat
//             then here: pnpm --filter @t3tools/contracts generate:atlas

import * as Schema from "effect/Schema";

export type AnswerPayload = { readonly request_id: string; readonly value?: unknown };
export const AnswerPayload = Schema.Struct({
  request_id: Schema.String,
  value: Schema.optionalKey(Schema.Unknown.annotate({ default: null })),
});

export type ApprovalPayload = {
  readonly args?: unknown;
  readonly reason?: string | null;
  readonly request_id: string;
  readonly request_type?: string | null;
  readonly tool?: string | null;
};
export const ApprovalPayload = Schema.Struct({
  args: Schema.optionalKey(Schema.Unknown.annotate({ default: null })),
  reason: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  request_id: Schema.String,
  request_type: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  tool: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
});

export type ApprovePayload = { readonly approved: boolean; readonly request_id: string };
export const ApprovePayload = Schema.Struct({
  approved: Schema.Boolean,
  request_id: Schema.String,
});

export type AttemptIdentity = {
  readonly attempt_id: string;
  readonly attempt_number: number;
  readonly resume_of_attempt_id?: string | null;
  readonly resumed_from_checkpoint_id?: string | null;
  readonly retry_of_run_id?: string | null;
};
export const AttemptIdentity = Schema.Struct({
  attempt_id: Schema.String,
  attempt_number: Schema.Number.annotate({ format: "uint64" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  resume_of_attempt_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  resumed_from_checkpoint_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  retry_of_run_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
});

export type CmdPayload = { readonly attachments?: ReadonlyArray<unknown>; readonly text: string };
export const CmdPayload = Schema.Struct({
  attachments: Schema.optionalKey(Schema.Array(Schema.Unknown).annotate({ default: [] })),
  text: Schema.String,
});

export type CtxPayload = { readonly used: number; readonly window: number };
export const CtxPayload = Schema.Struct({
  used: Schema.Number.annotate({ format: "uint64" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  window: Schema.Number.annotate({ format: "uint64" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ description: "Context pressure. Both in tokens." });

export type DenyPayload = {
  readonly args?: unknown;
  readonly call_id?: string | null;
  readonly reason: string;
  readonly tool: string;
};
export const DenyPayload = Schema.Struct({
  args: Schema.optionalKey(Schema.Unknown.annotate({ default: null })),
  call_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  reason: Schema.String,
  tool: Schema.String,
});

export type DiffFile = { readonly path: string; readonly status?: string | null };
export const DiffFile = Schema.Struct({
  path: Schema.String,
  status: Schema.optionalKey(
    Schema.Union([
      Schema.String.annotate({
        description: "`A` added · `M` modified · `D` deleted · `R` renamed · `T` type-changed.",
      }),
      Schema.Null,
    ]),
  ),
});

export type EdgePayload = {
  readonly detail?: unknown;
  readonly edge?: string | null;
  readonly ms?: number | null;
  readonly run_id?: string | null;
  readonly state?: string | null;
  readonly task?: string | null;
  readonly to?: string | null;
};
export const EdgePayload = Schema.Struct({
  detail: Schema.optionalKey(Schema.Unknown.annotate({ default: null })),
  edge: Schema.optionalKey(
    Schema.Union([
      Schema.String.annotate({
        description: "`delegate` when the caller waited, `delegate_async` when it did not.",
      }),
      Schema.Null,
    ]),
  ),
  ms: Schema.optionalKey(
    Schema.Union([Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()), Schema.Null]),
  ),
  run_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  state: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  task: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  to: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
}).annotate({
  description:
    "A fleet delegation edge — one run handing work to another, possibly on another node.\n\nThere is deliberately no `from`: the edge is published on the *caller's* feed via\n`publish_current`, so the origin is the feed it arrives on. Sending it would be a second,\nforgeable copy of a fact the envelope already carries.",
});

export type ErrorClass = "provider" | "transport" | "permission" | "validation";
export const ErrorClass = Schema.Literals(["provider", "transport", "permission", "validation"]);

export type EventCursor = { readonly epoch: number; readonly seq: number };
export const EventCursor = Schema.Struct({
  epoch: Schema.Number.annotate({ format: "uint64" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  seq: Schema.Number.annotate({ format: "uint64" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
});

export type ExecutionLimits = {
  readonly max_tokens?: number | null;
  readonly max_tool_calls?: number | null;
  readonly max_turn_requests?: number | null;
  readonly max_wall_time_ms?: number | null;
  readonly session_budget_id?: string | null;
};
export const ExecutionLimits = Schema.Struct({
  max_tokens: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({ format: "uint64" })
        .check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.Null,
    ]),
  ),
  max_tool_calls: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({ format: "uint64" })
        .check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.Null,
    ]),
  ),
  max_turn_requests: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({ format: "uint64" })
        .check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.Null,
    ]),
  ),
  max_wall_time_ms: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({ format: "uint64" })
        .check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.Null,
    ]),
  ),
  session_budget_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
});

export type ExecutionUsage = {
  readonly tokens?: number;
  readonly tool_calls?: number;
  readonly turn_requests?: number;
  readonly wall_time_ms?: number;
};
export const ExecutionUsage = Schema.Struct({
  tokens: Schema.optionalKey(
    Schema.Number.annotate({ default: 0, format: "uint64" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  tool_calls: Schema.optionalKey(
    Schema.Number.annotate({ default: 0, format: "uint64" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  turn_requests: Schema.optionalKey(
    Schema.Number.annotate({ default: 0, format: "uint64" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  wall_time_ms: Schema.optionalKey(
    Schema.Number.annotate({ default: 0, format: "uint64" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});

export type InterruptPayload = { readonly reason?: string | null };
export const InterruptPayload = Schema.Struct({
  reason: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
});

export type LifecycleTerminal = { readonly detail?: unknown; readonly reason: string };
export const LifecycleTerminal = Schema.Struct({
  detail: Schema.optionalKey(Schema.Unknown.annotate({ default: null })),
  reason: Schema.String,
});

export type LimitReason =
  | "max_turn_requests"
  | "max_tokens"
  | "session_budget_exceeded"
  | "max_tool_calls"
  | "max_wall_time";
export const LimitReason = Schema.Literals([
  "max_turn_requests",
  "max_tokens",
  "session_budget_exceeded",
  "max_tool_calls",
  "max_wall_time",
]);

export type QuestionPayload = {
  readonly choices?: ReadonlyArray<unknown>;
  readonly prompt?: string | null;
  readonly request_id: string;
};
export const QuestionPayload = Schema.Struct({
  choices: Schema.optionalKey(Schema.Array(Schema.Unknown).annotate({ default: [] })),
  prompt: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  request_id: Schema.String,
});

export type Role = "agent" | "console" | "system";
export const Role = Schema.Literals(["agent", "console", "system"]).annotate({
  description:
    "Who authored a frame.\n\nNot decoration: `console` is the only role a lens may write, and it may write only the\nfour command kinds. The enforcement lives in `atlas-host` (a policy decision about who\nmay say what), not here (the vocabulary itself).",
});

export type RunState =
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_input"
  | "cancelling"
  | "completed"
  | "limited"
  | "failed"
  | "stalled"
  | "cancelled";
export const RunState = Schema.Literals([
  "queued",
  "starting",
  "running",
  "waiting_for_input",
  "cancelling",
  "completed",
  "limited",
  "failed",
  "stalled",
  "cancelled",
]);

export type StructuredError = {
  readonly code: string;
  readonly details?: unknown;
  readonly message: string;
  readonly request_id?: string | null;
  readonly retryable: boolean;
  readonly trace_id: string;
};
export const StructuredError = Schema.Struct({
  code: Schema.String,
  details: Schema.optionalKey(Schema.Unknown.annotate({ default: null })),
  message: Schema.String,
  request_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  retryable: Schema.Boolean,
  trace_id: Schema.String,
}).annotate({ title: "StructuredError" });

export type Subscription = { readonly resource: string; readonly resource_id: string };
export const Subscription = Schema.Struct({ resource: Schema.String, resource_id: Schema.String });

export type TextPayload = { readonly text?: string };
export const TextPayload = Schema.Struct({
  text: Schema.optionalKey(Schema.String.annotate({ default: "" })),
});

export type ToolCallPayload = {
  readonly args?: unknown;
  readonly call_id?: string | null;
  readonly tool: string;
};
export const ToolCallPayload = Schema.Struct({
  args: Schema.optionalKey(Schema.Unknown.annotate({ default: null })),
  call_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  tool: Schema.String,
});

export type ToolResultPayload = {
  readonly call_id?: string | null;
  readonly duration_ms?: number | null;
  readonly ok: boolean;
  readonly summary?: string | null;
  readonly tool: string;
};
export const ToolResultPayload = Schema.Struct({
  call_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  duration_ms: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({ format: "uint64" })
        .check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.Null,
    ]),
  ),
  ok: Schema.Boolean,
  summary: Schema.optionalKey(
    Schema.Union([
      Schema.String.annotate({
        description:
          "The tool's error message or result summary. A memoized replay reports ~0 duration,\nwhich is honest — nothing ran.",
      }),
      Schema.Null,
    ]),
  ),
  tool: Schema.String,
});

export type TurnState = "start" | "done" | "error" | "cancelled";
export const TurnState = Schema.Literals(["start", "done", "error", "cancelled"]).annotate({
  description:
    "The four legacy turn states.\n\n`Cancelled` is its own state rather than a flavour of `Done` or `Error`, because both\nalternatives are wrong in a way a user notices: `done` shows a green finished turn for\nwork they deliberately stopped, `error` shows a failure that never happened.",
});

export type UsagePayload = {
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cached?: boolean | null;
  readonly input_tokens?: number | null;
  readonly model?: string | null;
  readonly output_tokens?: number | null;
  readonly usd?: number | null;
};
export const UsagePayload = Schema.Struct({
  cache_creation_input_tokens: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({ format: "uint64" })
        .check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.Null,
    ]),
  ),
  cache_read_input_tokens: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({ format: "uint64" })
        .check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.Null,
    ]),
  ),
  cached: Schema.optionalKey(
    Schema.Union([
      Schema.Boolean.annotate({
        description:
          "Whether this reply was served from the run's idempotency cache rather than a fresh\nmodel call — a flag, not a token count. (Was mistyped `u64` until a live frame\ncarrying `false` refused to decode in the generated client, 2026-08-02.)",
      }),
      Schema.Null,
    ]),
  ),
  input_tokens: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({ format: "uint64" })
        .check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.Null,
    ]),
  ),
  model: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  output_tokens: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({ format: "uint64" })
        .check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.Null,
    ]),
  ),
  usd: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({ format: "double" }).check(Schema.isFinite()),
      Schema.Null,
    ]),
  ),
});

export type WarningPayload = { readonly detail?: unknown; readonly message: string };
export const WarningPayload = Schema.Struct({
  detail: Schema.optionalKey(Schema.Unknown.annotate({ default: null })),
  message: Schema.String,
});

export type DiffPayload = {
  readonly checkpoint?: number | null;
  readonly files?: ReadonlyArray<DiffFile>;
  readonly unified?: string | null;
};
export const DiffPayload = Schema.Struct({
  checkpoint: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({
        description:
          "The checkpoint's `seq`, not its commit hash — a monotonic number within the\nworkspace's checkpoint stack, which is what `/_vcs/restore` addresses.",
        format: "int64",
      }).check(Schema.isInt()),
      Schema.Null,
    ]),
  ),
  files: Schema.optionalKey(Schema.Array(DiffFile).annotate({ default: [] })),
  unified: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
}).annotate({
  description:
    "What the turn did to the filesystem, derived from a git checkpoint at the turn boundary\nrather than from tool calls — so it reports an edit made by `sed` inside `run_bash`, or\nby a CLI body's own shell that the tool Registry never sees.",
});

export type ReplayBoundary = {
  readonly run_id: string;
  readonly snapshot_version: number;
  readonly through: EventCursor;
};
export const ReplayBoundary = Schema.Struct({
  run_id: Schema.String,
  snapshot_version: Schema.Number.annotate({ format: "uint64" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  through: EventCursor,
});

export type ReplayRequest = { readonly after: EventCursor; readonly run_id: string };
export const ReplayRequest = Schema.Struct({ after: EventCursor, run_id: Schema.String });

export type RunCommand =
  | { readonly kind: "start"; readonly limits: ExecutionLimits; readonly text: string }
  | { readonly kind: "cancel" }
  | {
      readonly kind: "retry";
      readonly limits: ExecutionLimits;
      readonly new_attempt: AttemptIdentity;
      readonly source_run_id: string;
    }
  | {
      readonly acknowledge_side_effect_uncertainty: boolean;
      readonly checkpoint_id: string;
      readonly kind: "resume";
      readonly limits: ExecutionLimits;
      readonly new_attempt: AttemptIdentity;
      readonly source_attempt_id: string;
    }
  | { readonly answer: unknown; readonly kind: "resolve_input"; readonly request_ref: string };
export const RunCommand = Schema.Union(
  [
    Schema.Struct({ kind: Schema.Literal("start"), limits: ExecutionLimits, text: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("cancel") }),
    Schema.Struct({
      kind: Schema.Literal("retry"),
      limits: ExecutionLimits,
      new_attempt: AttemptIdentity,
      source_run_id: Schema.String,
    }),
    Schema.Struct({
      acknowledge_side_effect_uncertainty: Schema.Boolean,
      checkpoint_id: Schema.String,
      kind: Schema.Literal("resume"),
      limits: ExecutionLimits,
      new_attempt: AttemptIdentity,
      source_attempt_id: Schema.String,
    }),
    Schema.Struct({
      answer: Schema.Unknown,
      kind: Schema.Literal("resolve_input"),
      request_ref: Schema.String,
    }),
  ],
  { mode: "oneOf" },
);

export type CheckpointObservation = {
  readonly artifact_ref: string;
  readonly body_id: string;
  readonly body_version: string;
  readonly checkpoint_id: string;
  readonly model_id: string;
  readonly protocol_version: number;
  readonly side_effects_after_checkpoint_unknown?: boolean;
  readonly usage: ExecutionUsage;
};
export const CheckpointObservation = Schema.Struct({
  artifact_ref: Schema.String,
  body_id: Schema.String,
  body_version: Schema.String,
  checkpoint_id: Schema.String,
  model_id: Schema.String,
  protocol_version: Schema.Number.annotate({ format: "uint32" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  side_effects_after_checkpoint_unknown: Schema.optionalKey(
    Schema.Boolean.annotate({ default: false }),
  ),
  usage: ExecutionUsage,
});

export type ProviderStopReason =
  | { readonly outcome: "completed"; readonly provider_code?: string | null }
  | {
      readonly enforced_by?: string | null;
      readonly limit: number;
      readonly observed: number;
      readonly outcome: "limited";
      readonly reason: LimitReason;
      readonly unit: string;
    }
  | {
      readonly error_class?: string | null;
      readonly outcome: "failed";
      readonly provider_code: string;
      readonly retryable: boolean;
    }
  | { readonly outcome: "cancelled"; readonly provider_code?: string | null };
export const ProviderStopReason = Schema.Union(
  [
    Schema.Struct({
      outcome: Schema.Literal("completed"),
      provider_code: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
    }),
    Schema.Struct({
      enforced_by: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
      limit: Schema.Number.annotate({ format: "uint64" })
        .check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0)),
      observed: Schema.Number.annotate({ format: "uint64" })
        .check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0)),
      outcome: Schema.Literal("limited"),
      reason: LimitReason,
      unit: Schema.String,
    }),
    Schema.Struct({
      error_class: Schema.optionalKey(
        Schema.Union([
          Schema.String.annotate({
            description:
              'WHOSE failure it was — the body\'s (`provider_error`) or the machinery\'s\n(`transport_error`). Mirrors `feed::ErrorClass`.\n\nOptional and defaulted so an older worker\'s envelope still decodes (rule 3), but a\nworker that knows should say: "the model errored" and "the run could not be\nadvanced at all" are different things to put in front of a user, and a supervisor\nthat flattens them makes every driver fault look like a provider fault.',
          }),
          Schema.Null,
        ]),
      ),
      outcome: Schema.Literal("failed"),
      provider_code: Schema.String,
      retryable: Schema.Boolean,
    }),
    Schema.Struct({
      outcome: Schema.Literal("cancelled"),
      provider_code: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
    }),
  ],
  { mode: "oneOf" },
);

export type LifecyclePayload = {
  readonly attempt_id?: string | null;
  readonly attempt_number?: number | null;
  readonly run_id?: string | null;
  readonly snapshot_version?: number | null;
  readonly state: RunState;
  readonly terminal?: LifecycleTerminal | null;
  readonly thread_id?: string | null;
};
export const LifecyclePayload = Schema.Struct({
  attempt_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  attempt_number: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({ format: "uint64" })
        .check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.Null,
    ]),
  ),
  run_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  snapshot_version: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({ format: "uint64" })
        .check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.Null,
    ]),
  ),
  state: RunState,
  terminal: Schema.optionalKey(
    Schema.Union([LifecycleTerminal, Schema.Null]).annotate({ default: null }),
  ),
  thread_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
});

export type TerminalOutcome = {
  readonly detail?: unknown;
  readonly reason: string;
  readonly state: RunState;
  readonly terminal_at_ms: number;
};
export const TerminalOutcome = Schema.Struct({
  detail: Schema.optionalKey(Schema.Unknown.annotate({ default: null })),
  reason: Schema.String,
  state: RunState,
  terminal_at_ms: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
});

export type TurnPayload = {
  readonly class?: string | null;
  readonly plugin?: string | null;
  readonly state: TurnState;
  readonly text?: string | null;
};
export const TurnPayload = Schema.Struct({
  class: Schema.optionalKey(
    Schema.Union([
      Schema.String.annotate({
        description: "Whose failure it was, on an `error` boundary. Mirrors `feed::ErrorClass`.",
      }),
      Schema.Null,
    ]),
  ),
  plugin: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  state: TurnState,
  text: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
});

export type ServerReady = {
  readonly authenticated_subject: string;
  readonly capabilities?: ReadonlyArray<string>;
  readonly connection_id: string;
  readonly fleet_id: string;
  readonly granted_scopes?: ReadonlyArray<string>;
  readonly heartbeat_interval_ms: number;
  readonly protocol_version: number;
  readonly replay_boundaries?: ReadonlyArray<ReplayBoundary>;
  readonly server_time_ms: number;
};
export const ServerReady = Schema.Struct({
  authenticated_subject: Schema.String,
  capabilities: Schema.optionalKey(Schema.Array(Schema.String).annotate({ default: [] })),
  connection_id: Schema.String,
  fleet_id: Schema.String,
  granted_scopes: Schema.optionalKey(Schema.Array(Schema.String).annotate({ default: [] })),
  heartbeat_interval_ms: Schema.Number.annotate({ format: "uint64" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  protocol_version: Schema.Number.annotate({ format: "uint32" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  replay_boundaries: Schema.optionalKey(Schema.Array(ReplayBoundary).annotate({ default: [] })),
  server_time_ms: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
}).annotate({
  description: "The only frame that establishes authenticated control-plane readiness.",
});

export type ClientHello = {
  readonly fleet_id: string;
  readonly protocol_version: number;
  readonly replay?: ReadonlyArray<ReplayRequest>;
  readonly requested_scopes?: ReadonlyArray<string>;
  readonly session_binding: string;
  readonly subscriptions?: ReadonlyArray<Subscription>;
};
export const ClientHello = Schema.Struct({
  fleet_id: Schema.String,
  protocol_version: Schema.Number.annotate({ format: "uint32" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  replay: Schema.optionalKey(Schema.Array(ReplayRequest).annotate({ default: [] })),
  requested_scopes: Schema.optionalKey(Schema.Array(Schema.String).annotate({ default: [] })),
  session_binding: Schema.String,
  subscriptions: Schema.optionalKey(Schema.Array(Subscription).annotate({ default: [] })),
}).annotate({
  description:
    "The first application frame a client sends after transport upgrade.\n\nA WebSocket being open is not authentication and is not readiness.",
});

export type ChildRunSnapshot = {
  readonly attempt: AttemptIdentity;
  readonly child_run_id: string;
  readonly deadline_at_ms?: number | null;
  readonly event_head: EventCursor;
  readonly last_heartbeat_at_ms?: number | null;
  readonly last_progress_at_ms?: number | null;
  readonly last_progress_marker?: string | null;
  readonly lease_generation: number;
  readonly limits: ExecutionLimits;
  readonly parent_run_id: string;
  readonly required: boolean;
  readonly resumable_checkpoint_id?: string | null;
  readonly settlement_policy: string;
  readonly state: RunState;
  readonly state_version: number;
  readonly terminal?: TerminalOutcome | null;
  readonly usage: ExecutionUsage;
};
export const ChildRunSnapshot = Schema.Struct({
  attempt: AttemptIdentity,
  child_run_id: Schema.String,
  deadline_at_ms: Schema.optionalKey(
    Schema.Union([Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()), Schema.Null]),
  ),
  event_head: EventCursor,
  last_heartbeat_at_ms: Schema.optionalKey(
    Schema.Union([Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()), Schema.Null]),
  ),
  last_progress_at_ms: Schema.optionalKey(
    Schema.Union([Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()), Schema.Null]),
  ),
  last_progress_marker: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  lease_generation: Schema.Number.annotate({ format: "uint64" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  limits: ExecutionLimits,
  parent_run_id: Schema.String,
  required: Schema.Boolean,
  resumable_checkpoint_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  settlement_policy: Schema.String,
  state: RunState,
  state_version: Schema.Number.annotate({ format: "uint64" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  terminal: Schema.optionalKey(
    Schema.Union([TerminalOutcome, Schema.Null]).annotate({ default: null }),
  ),
  usage: ExecutionUsage,
});

export type WorkerObservation =
  | { readonly type: "provider_connected" }
  | { readonly type: "heartbeat" }
  | {
      readonly expires_at_ms?: number | null;
      readonly request_ref: string;
      readonly type: "waiting_for_input";
    }
  | { readonly request_ref: string; readonly type: "input_resolved" }
  | { readonly evidence: unknown; readonly phase: string; readonly type: "progress" }
  | { readonly content_ref: string; readonly type: "assistant_content_committed" }
  | { readonly tool_id: string; readonly type: "tool_started" }
  | { readonly result_ref: string; readonly tool_id: string; readonly type: "tool_completed" }
  | { readonly checkpoint: CheckpointObservation; readonly type: "checkpoint_committed" }
  | { readonly child: ChildRunSnapshot; readonly type: "child_started" }
  | {
      readonly child_run_id: string;
      readonly evidence: unknown;
      readonly phase: string;
      readonly type: "child_progress";
    }
  | { readonly child_run_id: string; readonly type: "child_heartbeat" }
  | {
      readonly child_run_id: string;
      readonly expires_at_ms?: number | null;
      readonly request_ref: string;
      readonly type: "child_waiting_for_input";
    }
  | {
      readonly child_run_id: string;
      readonly request_ref: string;
      readonly type: "child_input_resolved";
    }
  | {
      readonly child_run_id: string;
      readonly stop: ProviderStopReason;
      readonly type: "child_stopped";
    }
  | { readonly stop: ProviderStopReason; readonly type: "provider_stopped" };
export const WorkerObservation = Schema.Union(
  [
    Schema.Struct({ type: Schema.Literal("provider_connected") }),
    Schema.Struct({ type: Schema.Literal("heartbeat") }),
    Schema.Struct({
      expires_at_ms: Schema.optionalKey(
        Schema.Union([
          Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
          Schema.Null,
        ]),
      ),
      request_ref: Schema.String,
      type: Schema.Literal("waiting_for_input"),
    }),
    Schema.Struct({ request_ref: Schema.String, type: Schema.Literal("input_resolved") }),
    Schema.Struct({
      evidence: Schema.Unknown,
      phase: Schema.String,
      type: Schema.Literal("progress"),
    }),
    Schema.Struct({
      content_ref: Schema.String,
      type: Schema.Literal("assistant_content_committed"),
    }),
    Schema.Struct({ tool_id: Schema.String, type: Schema.Literal("tool_started") }),
    Schema.Struct({
      result_ref: Schema.String,
      tool_id: Schema.String,
      type: Schema.Literal("tool_completed"),
    }),
    Schema.Struct({
      checkpoint: CheckpointObservation,
      type: Schema.Literal("checkpoint_committed"),
    }),
    Schema.Struct({ child: ChildRunSnapshot, type: Schema.Literal("child_started") }),
    Schema.Struct({
      child_run_id: Schema.String,
      evidence: Schema.Unknown,
      phase: Schema.String,
      type: Schema.Literal("child_progress"),
    }),
    Schema.Struct({ child_run_id: Schema.String, type: Schema.Literal("child_heartbeat") }),
    Schema.Struct({
      child_run_id: Schema.String,
      expires_at_ms: Schema.optionalKey(
        Schema.Union([
          Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
          Schema.Null,
        ]),
      ),
      request_ref: Schema.String,
      type: Schema.Literal("child_waiting_for_input"),
    }),
    Schema.Struct({
      child_run_id: Schema.String,
      request_ref: Schema.String,
      type: Schema.Literal("child_input_resolved"),
    }),
    Schema.Struct({
      child_run_id: Schema.String,
      stop: ProviderStopReason,
      type: Schema.Literal("child_stopped"),
    }),
    Schema.Struct({ stop: ProviderStopReason, type: Schema.Literal("provider_stopped") }),
  ],
  { mode: "oneOf" },
);

export type CommandEnvelope = {
  readonly actor: string;
  readonly command: RunCommand;
  readonly expected_lease_generation?: number | null;
  readonly fleet_id: string;
  readonly protocol_version: number;
  readonly request_id: string;
  readonly run_id: string;
  readonly thread_id: string;
};
export const CommandEnvelope = Schema.Struct({
  actor: Schema.String,
  command: RunCommand,
  expected_lease_generation: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({ format: "uint64" })
        .check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.Null,
    ]),
  ),
  fleet_id: Schema.String,
  protocol_version: Schema.Number.annotate({ format: "uint32" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  request_id: Schema.String.annotate({ description: "Caller-generated stable idempotency key." }),
  run_id: Schema.String,
  thread_id: Schema.String,
}).annotate({ title: "CommandEnvelope" });

export type EventEnvelope = {
  readonly cursor: EventCursor;
  readonly fleet_id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly protocol_version: number;
  readonly recorded_at_ms: number;
  readonly run_id: string;
};
export const EventEnvelope = Schema.Struct({
  cursor: EventCursor,
  fleet_id: Schema.String,
  kind: Schema.String,
  payload: Schema.Unknown,
  protocol_version: Schema.Number.annotate({ format: "uint32" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  recorded_at_ms: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
  run_id: Schema.String,
}).annotate({ title: "EventEnvelope" });

export type FeedFrame =
  | {
      readonly kind: "turn";
      readonly payload: TurnPayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "lifecycle";
      readonly payload: LifecyclePayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "user";
      readonly payload: TextPayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "assistant";
      readonly payload: TextPayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "thinking";
      readonly payload: TextPayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "tool_call";
      readonly payload: ToolCallPayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "tool_result";
      readonly payload: ToolResultPayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "deny";
      readonly payload: DenyPayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "approval";
      readonly payload: ApprovalPayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "question";
      readonly payload: QuestionPayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "warning";
      readonly payload: WarningPayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "ctx";
      readonly payload: CtxPayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "usage";
      readonly payload: UsagePayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "edge";
      readonly payload: EdgePayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "diff";
      readonly payload: DiffPayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "cmd";
      readonly payload: CmdPayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "interrupt";
      readonly payload: InterruptPayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "approve";
      readonly payload: ApprovePayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly kind: "answer";
      readonly payload: AnswerPayload;
      readonly epoch: number;
      readonly role: Role;
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    };
export const FeedFrame = Schema.Union(
  [
    Schema.Struct({
      kind: Schema.Literal("turn"),
      payload: TurnPayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
      title: "FeedFrame",
    }),
    Schema.Struct({
      kind: Schema.Literal("lifecycle"),
      payload: LifecyclePayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
      title: "FeedFrame",
    }),
    Schema.Struct({
      kind: Schema.Literal("user"),
      payload: TextPayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      title: "FeedFrame",
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
    }),
    Schema.Struct({
      kind: Schema.Literal("assistant"),
      payload: TextPayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      title: "FeedFrame",
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
    }),
    Schema.Struct({
      kind: Schema.Literal("thinking"),
      payload: TextPayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      title: "FeedFrame",
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
    }),
    Schema.Struct({
      kind: Schema.Literal("tool_call"),
      payload: ToolCallPayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      title: "FeedFrame",
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
    }),
    Schema.Struct({
      kind: Schema.Literal("tool_result"),
      payload: ToolResultPayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      title: "FeedFrame",
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
    }),
    Schema.Struct({
      kind: Schema.Literal("deny"),
      payload: DenyPayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      title: "FeedFrame",
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
    }),
    Schema.Struct({
      kind: Schema.Literal("approval"),
      payload: ApprovalPayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      title: "FeedFrame",
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
    }),
    Schema.Struct({
      kind: Schema.Literal("question"),
      payload: QuestionPayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      title: "FeedFrame",
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
    }),
    Schema.Struct({
      kind: Schema.Literal("warning"),
      payload: WarningPayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
      title: "FeedFrame",
    }),
    Schema.Struct({
      kind: Schema.Literal("ctx"),
      payload: CtxPayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      title: "FeedFrame",
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
    }),
    Schema.Struct({
      kind: Schema.Literal("usage"),
      payload: UsagePayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      title: "FeedFrame",
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
    }),
    Schema.Struct({
      kind: Schema.Literal("edge"),
      payload: EdgePayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      title: "FeedFrame",
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
    }),
    Schema.Struct({
      kind: Schema.Literal("diff"),
      payload: DiffPayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      title: "FeedFrame",
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
    }),
    Schema.Struct({
      kind: Schema.Literal("cmd"),
      payload: CmdPayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      title: "FeedFrame",
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
    }),
    Schema.Struct({
      kind: Schema.Literal("interrupt"),
      payload: InterruptPayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      title: "FeedFrame",
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
    }),
    Schema.Struct({
      kind: Schema.Literal("approve"),
      payload: ApprovePayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      title: "FeedFrame",
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
    }),
    Schema.Struct({
      kind: Schema.Literal("answer"),
      payload: AnswerPayload,
      epoch: Schema.Number.annotate({
        description:
          "Identifies the feed incarnation. `seq` restarts at zero when the isolate is\nrecreated, so a `seq` is only meaningful paired with the epoch it was issued under.",
        format: "int64",
      }).check(Schema.isInt()),
      role: Role,
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      title: "FeedFrame",
      description:
        "One durable row off a run's feed.\n\n# Handling this exhaustively\n\nA consumer wants two different behaviours that look identical if you are careless:\n\n- a kind it does not *know* (this build predates it) → ignore, silently, forever\n- a kind it knows but has not *handled* → a bug, and one a compiler can catch\n\nDecode first, then match. An unknown kind fails decoding and never reaches the match;\na known-but-unhandled kind is a non-exhaustive match. A single catch-all arm over a raw\nstring — which is what the lens does today — collapses both into silence.",
    }),
  ],
  { mode: "oneOf" },
);

export type HandshakeFrame =
  | { readonly payload: ClientHello; readonly type: "client_hello" }
  | { readonly payload: ServerReady; readonly type: "server_ready" }
  | { readonly payload: StructuredError; readonly type: "connection_rejected" };
export const HandshakeFrame = Schema.Union(
  [
    Schema.Struct({ payload: ClientHello, type: Schema.Literal("client_hello") }),
    Schema.Struct({ payload: ServerReady, type: Schema.Literal("server_ready") }),
    Schema.Struct({ payload: StructuredError, type: Schema.Literal("connection_rejected") }),
  ],
  { mode: "oneOf" },
).annotate({ title: "HandshakeFrame" });

export type ObservationEnvelope = {
  readonly attempt_id: string;
  readonly event_id: string;
  readonly fleet_id: string;
  readonly lease_generation: number;
  readonly observation: WorkerObservation;
  readonly protocol_version: number;
  readonly provider_seq: number;
  readonly run_id: string;
  readonly thread_id: string;
};
export const ObservationEnvelope = Schema.Struct({
  attempt_id: Schema.String,
  event_id: Schema.String.annotate({
    description: "Stable idempotency key assigned by the worker/harness.",
  }),
  fleet_id: Schema.String,
  lease_generation: Schema.Number.annotate({ format: "uint64" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  observation: WorkerObservation,
  protocol_version: Schema.Number.annotate({ format: "uint32" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  provider_seq: Schema.Number.annotate({
    description: "Strictly increases within one attempt plus lease generation.",
    format: "uint64",
  })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  run_id: Schema.String,
  thread_id: Schema.String,
}).annotate({ title: "ObservationEnvelope" });

export type RunSnapshot = {
  readonly attempt: AttemptIdentity;
  readonly children?: ReadonlyArray<ChildRunSnapshot>;
  readonly deadline_at_ms?: number | null;
  readonly event_head: EventCursor;
  readonly fleet_id: string;
  readonly last_heartbeat_at_ms?: number | null;
  readonly last_progress_at_ms?: number | null;
  readonly last_progress_marker?: string | null;
  readonly last_provider_seq?: number;
  readonly lease_generation: number;
  readonly limits: ExecutionLimits;
  readonly protocol_version: number;
  readonly resumable_checkpoint_id?: string | null;
  readonly run_id: string;
  readonly snapshot_version: number;
  readonly state: RunState;
  readonly state_version: number;
  readonly terminal?: TerminalOutcome | null;
  readonly thread_id: string;
  readonly usage: ExecutionUsage;
};
export const RunSnapshot = Schema.Struct({
  attempt: AttemptIdentity,
  children: Schema.optionalKey(Schema.Array(ChildRunSnapshot).annotate({ default: [] })),
  deadline_at_ms: Schema.optionalKey(
    Schema.Union([Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()), Schema.Null]),
  ),
  event_head: EventCursor,
  fleet_id: Schema.String,
  last_heartbeat_at_ms: Schema.optionalKey(
    Schema.Union([Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()), Schema.Null]),
  ),
  last_progress_at_ms: Schema.optionalKey(
    Schema.Union([Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()), Schema.Null]),
  ),
  last_progress_marker: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  last_provider_seq: Schema.optionalKey(
    Schema.Number.annotate({ default: 0, format: "uint64" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  lease_generation: Schema.Number.annotate({ format: "uint64" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  limits: ExecutionLimits,
  protocol_version: Schema.Number.annotate({ format: "uint32" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  resumable_checkpoint_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  run_id: Schema.String,
  snapshot_version: Schema.Number.annotate({ format: "uint64" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  state: RunState,
  state_version: Schema.Number.annotate({ format: "uint64" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
  terminal: Schema.optionalKey(
    Schema.Union([TerminalOutcome, Schema.Null]).annotate({ default: null }),
  ),
  thread_id: Schema.String,
  usage: ExecutionUsage,
}).annotate({ title: "RunSnapshot" });

export type TransportFrame =
  | {
      readonly epoch: number;
      readonly kind: "hb";
      readonly run_id: string;
      readonly seq: number;
      readonly ts: number;
      readonly version: number;
    }
  | {
      readonly class: ErrorClass;
      readonly error: string;
      readonly kind: "error";
      readonly version: number;
    };
export const TransportFrame = Schema.Union(
  [
    Schema.Struct({
      epoch: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      kind: Schema.Literal("hb"),
      run_id: Schema.String,
      seq: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ts: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      description:
        "Liveness a browser lens can observe — `ping`/`pong` never reaches JavaScript.\n\nCarries a whole cursor. It shipped with `seq` alone, which a lens cannot compare\nagainst anything, so the gap detection it exists for never fired.",
    }),
    Schema.Struct({
      class: ErrorClass,
      error: Schema.String,
      kind: Schema.Literal("error"),
      version: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
    }).annotate({
      description:
        "Terminal, and about the *connection* — a refused handshake, a lost socket. A failed\nturn is not this; that is a lifecycle terminal state.",
    }),
  ],
  { mode: "oneOf" },
).annotate({
  title: "TransportFrame",
  description: "Connection-scoped frames. Never stored, never replayed.",
});
