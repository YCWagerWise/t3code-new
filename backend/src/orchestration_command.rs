//! The dispatchable orchestration commands, as a CLOSED Rust type.
//!
//! WHY THIS EXISTS (#446, the generator behind #433).
//!
//! `orchestration.dispatchCommand` used to match on
//! `command.get("type").and_then(Value::as_str)` — a raw `&str` pulled out of a
//! `serde_json::Value`. Three things follow from that, and the third is the one
//! that matters:
//!
//! 1. the compiler cannot check exhaustiveness, so a `_` arm absorbs every
//!    unhandled variant, every typo, and every string the contract does not even
//!    define;
//! 2. control then fell through to the unconditional applied-ack, so the client
//!    was told a command had durably applied when nothing was written. #433
//!    counted fifteen commands in that state;
//! 3. **adding a command to `packages/contracts/src/orchestration.ts` could not
//!    fail the Rust build.** The next command added was dead on arrival by
//!    construction. That is how fifteen accumulated, and fixing fifteen arms
//!    would have left the mechanism that produced them untouched.
//!
//! The refusal-by-default fix already landed and it closed (2): an unhandled
//! command now FAILS instead of acking. This closes (1) and (3). The match in
//! `server_main.rs` is over [`CommandKind`] with **no wildcard arm**, so a
//! variant added here without an arm is a compile error, and an unknown string
//! off the wire is a DECODE failure rather than a value that flows onward.
//!
//! WHAT THIS DELIBERATELY DOES NOT DO. It does not model each command's
//! payload. The existing arms read their fields off the `Value` and changing
//! that in the same commit would bury an authority fix inside a large
//! refactor. This types the DISCRIMINANT, which is the part that was silently
//! wrong. Typed payloads are the natural next step and belong in the same
//! place this type eventually should: the goal puts orchestration authority in
//! `agent-sdk-rs`, and a copy of the command set living in the product backend
//! is still one authority too many. It is here rather than there because the
//! contract it mirrors is in this repo and the decider that consumes it is in
//! this file; moving both is a bigger change than the finding asks for, and
//! pretending otherwise by hiding the type in the SDK now would just relocate
//! the drift.
//!
//! DRIFT IS CAUGHT BY A TEST THAT READS THE CONTRACT, not by a comment asking
//! people to remember. See `the_rust_command_set_matches_the_contract_union`.

use serde::Deserialize;
use serde_json::Value;

/// Every member of `DispatchableClientOrchestrationCommand`
/// (packages/contracts/src/orchestration.ts:924), and nothing else.
///
/// There is deliberately no `#[serde(other)]` catch-all: a tag this enum does
/// not know is a decode error, which is what an unknown command off the wire
/// actually is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum CommandKind {
    #[serde(rename = "project.create")]
    ProjectCreate,
    #[serde(rename = "project.meta.update")]
    ProjectMetaUpdate,
    #[serde(rename = "project.delete")]
    ProjectDelete,
    #[serde(rename = "thread.create")]
    ThreadCreate,
    #[serde(rename = "thread.delete")]
    ThreadDelete,
    #[serde(rename = "thread.archive")]
    ThreadArchive,
    #[serde(rename = "thread.unarchive")]
    ThreadUnarchive,
    #[serde(rename = "thread.settle")]
    ThreadSettle,
    #[serde(rename = "thread.unsettle")]
    ThreadUnsettle,
    #[serde(rename = "thread.snooze")]
    ThreadSnooze,
    #[serde(rename = "thread.unsnooze")]
    ThreadUnsnooze,
    #[serde(rename = "thread.pin")]
    ThreadPin,
    #[serde(rename = "thread.unpin")]
    ThreadUnpin,
    #[serde(rename = "thread.pin.reorder")]
    ThreadPinReorder,
    #[serde(rename = "thread.meta.update")]
    ThreadMetaUpdate,
    #[serde(rename = "thread.runtime-mode.set")]
    ThreadRuntimeModeSet,
    #[serde(rename = "thread.interaction-mode.set")]
    ThreadInteractionModeSet,
    #[serde(rename = "thread.turn.start")]
    ThreadTurnStart,
    #[serde(rename = "thread.turn.interrupt")]
    ThreadTurnInterrupt,
    #[serde(rename = "thread.approval.respond")]
    ThreadApprovalRespond,
    #[serde(rename = "thread.user-input.respond")]
    ThreadUserInputRespond,
    #[serde(rename = "thread.checkpoint.revert")]
    ThreadCheckpointRevert,
    #[serde(rename = "thread.session.stop")]
    ThreadSessionStop,
}

/// The wire strings, in contract order. Used by the drift test and by error
/// messages, so a refusal can name what this runtime does understand.
pub const ALL: [(CommandKind, &str); 23] = [
    (CommandKind::ProjectCreate, "project.create"),
    (CommandKind::ProjectMetaUpdate, "project.meta.update"),
    (CommandKind::ProjectDelete, "project.delete"),
    (CommandKind::ThreadCreate, "thread.create"),
    (CommandKind::ThreadDelete, "thread.delete"),
    (CommandKind::ThreadArchive, "thread.archive"),
    (CommandKind::ThreadUnarchive, "thread.unarchive"),
    (CommandKind::ThreadSettle, "thread.settle"),
    (CommandKind::ThreadUnsettle, "thread.unsettle"),
    (CommandKind::ThreadSnooze, "thread.snooze"),
    (CommandKind::ThreadUnsnooze, "thread.unsnooze"),
    (CommandKind::ThreadPin, "thread.pin"),
    (CommandKind::ThreadUnpin, "thread.unpin"),
    (CommandKind::ThreadPinReorder, "thread.pin.reorder"),
    (CommandKind::ThreadMetaUpdate, "thread.meta.update"),
    (CommandKind::ThreadRuntimeModeSet, "thread.runtime-mode.set"),
    (
        CommandKind::ThreadInteractionModeSet,
        "thread.interaction-mode.set",
    ),
    (CommandKind::ThreadTurnStart, "thread.turn.start"),
    (CommandKind::ThreadTurnInterrupt, "thread.turn.interrupt"),
    (CommandKind::ThreadApprovalRespond, "thread.approval.respond"),
    (
        CommandKind::ThreadUserInputRespond,
        "thread.user-input.respond",
    ),
    (
        CommandKind::ThreadCheckpointRevert,
        "thread.checkpoint.revert",
    ),
    (CommandKind::ThreadSessionStop, "thread.session.stop"),
];

impl CommandKind {
    /// The wire string for this variant.
    pub fn as_wire(self) -> &'static str {
        ALL.iter()
            .find(|(k, _)| *k == self)
            .map(|(_, s)| *s)
            .expect("ALL covers every CommandKind — the drift test asserts it")
    }

    /// Read the discriminant out of a dispatch frame.
    ///
    /// A missing, non-string, or unrecognised `type` is an error. It is NOT
    /// mapped to some default variant: the whole point of #446 is that an
    /// unknown command must not acquire a meaning on the way in.
    pub fn parse(command: &Value) -> Result<CommandKind, String> {
        let tag = command
            .get("type")
            .ok_or_else(|| "orchestration command has no `type`".to_string())?;
        let tag = tag.as_str().ok_or_else(|| {
            format!("orchestration command `type` must be a string, got {tag}")
        })?;
        serde_json::from_value::<CommandKind>(Value::String(tag.to_string())).map_err(|_| {
            format!(
                "orchestration command '{tag}' is not a member of \
                 DispatchableClientOrchestrationCommand"
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_reads_the_tag_and_refuses_everything_else() {
        assert_eq!(
            CommandKind::parse(&json!({ "type": "thread.pin" })).unwrap(),
            CommandKind::ThreadPin
        );
        // Hyphenated and dotted names are the ones a hand-written match gets
        // wrong, so they are pinned explicitly rather than trusted to the
        // rename attribute.
        assert_eq!(
            CommandKind::parse(&json!({ "type": "thread.runtime-mode.set" })).unwrap(),
            CommandKind::ThreadRuntimeModeSet
        );
        assert_eq!(
            CommandKind::parse(&json!({ "type": "thread.pin.reorder" })).unwrap(),
            CommandKind::ThreadPinReorder
        );

        // An unknown tag is a DECODE failure. It must not become a variant, and
        // the message must name the offending string so an operator watching a
        // client-version mismatch can see which command drifted.
        let e = CommandKind::parse(&json!({ "type": "thread.levitate" })).unwrap_err();
        assert!(e.contains("thread.levitate"), "{e}");

        // A near-miss of a real command must NOT resolve to it. This is the
        // typo half of #446: the old `&str` match sent these to the catch-all.
        assert!(CommandKind::parse(&json!({ "type": "thread.Pin" })).is_err());
        assert!(CommandKind::parse(&json!({ "type": "thread.pin " })).is_err());

        // Missing / wrong-typed `type`.
        assert!(CommandKind::parse(&json!({ "threadId": "t-1" })).is_err());
        assert!(CommandKind::parse(&json!({ "type": 7 })).is_err());
        assert!(CommandKind::parse(&json!({ "type": null })).is_err());
    }

    #[test]
    fn as_wire_round_trips_every_variant() {
        for (kind, wire) in ALL {
            assert_eq!(kind.as_wire(), wire);
            assert_eq!(
                CommandKind::parse(&json!({ "type": wire })).unwrap(),
                kind,
                "{wire} must decode to its own variant"
            );
        }
    }

    /// THE DRIFT GUARD, and the reason #446 is about a generator rather than a
    /// list of fifteen commands.
    ///
    /// Adding a command to `DispatchableClientOrchestrationCommand` used to be
    /// invisible to Rust: the backend would accept it, match nothing, and (before
    /// the refusal fix) ack it as applied. This test READS THE CONTRACT and fails
    /// if the two sets differ, so the next command added breaks the build here
    /// instead of shipping as a silent no-op. It reads the file rather than a
    /// vendored copy on purpose — a copy drifts in exactly the way being guarded
    /// against.
    #[test]
    fn the_rust_command_set_matches_the_contract_union() {
        let contract = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../packages/contracts/src/orchestration.ts");
        let src = std::fs::read_to_string(&contract).unwrap_or_else(|e| {
            panic!("cannot read {}: {e}", contract.display());
        });

        // The union names its members; each member's struct pins a
        // `type: Schema.Literal("...")`. Walk the union, then resolve each name
        // to its literal, so a member added to the union is picked up.
        let union_start = src
            .find("const DispatchableClientOrchestrationCommand = Schema.Union([")
            .expect("the union must still be named this — if it was renamed, fix this test");
        let union_end = src[union_start..]
            .find("]);")
            .expect("unterminated union")
            + union_start;
        let members: Vec<&str> = src[union_start..union_end]
            .lines()
            .filter_map(|l| {
                let t = l.trim().trim_end_matches(',');
                t.ends_with("Command").then_some(t)
            })
            .collect();

        let mut wire: Vec<String> = Vec::new();
        for member in &members {
            let decl = format!("{member} = Schema.Struct({{");
            let at = src.find(&decl).unwrap_or_else(|| {
                panic!("union member {member} has no Schema.Struct declaration")
            });
            let lit = src[at..]
                .find("type: Schema.Literal(\"")
                .map(|o| at + o + "type: Schema.Literal(\"".len())
                .unwrap_or_else(|| panic!("{member} has no `type: Schema.Literal(...)`"));
            let end = src[lit..].find('"').unwrap() + lit;
            wire.push(src[lit..end].to_string());
        }

        let mut from_contract = wire.clone();
        from_contract.sort();
        let mut from_rust: Vec<String> = ALL.iter().map(|(_, s)| s.to_string()).collect();
        from_rust.sort();

        let missing_in_rust: Vec<&String> =
            from_contract.iter().filter(|c| !from_rust.contains(c)).collect();
        let extra_in_rust: Vec<&String> =
            from_rust.iter().filter(|r| !from_contract.contains(r)).collect();

        assert!(
            missing_in_rust.is_empty(),
            "the contract declares orchestration commands this backend has no variant for: \
             {missing_in_rust:?}\nAdd them to CommandKind. Until an arm exists in \
             server_main.rs's dispatch match, the arm must refuse — an ack is a durability \
             claim, and #433 is what happens when one is made falsely."
        );
        assert!(
            extra_in_rust.is_empty(),
            "this backend has CommandKind variants the contract no longer declares: \
             {extra_in_rust:?}\nA command the client cannot send is dead code that will \
             outlive everyone who remembers why it is here."
        );
        assert_eq!(
            from_rust.len(),
            23,
            "the union changed size; update this number deliberately rather than letting \
             the count drift, since it is the only assertion that notices a member being \
             REMOVED from both sides at once"
        );
    }
}
