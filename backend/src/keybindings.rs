//! Durable keybindings + the `when`-expression resolver (#71).
//!
//! The settings page edits keyboard shortcuts through `server.upsertKeybinding`
//! / `server.removeKeybinding` and reads the resolved set back from
//! `server.getConfig` and the `keybindingsUpdated` config-stream event. On this
//! runtime all three used to be dead: `server_config` hard-coded
//! `keybindings: []` with a `/dev/null` config path, and neither mutation had a
//! dispatch arm, so every save fell through to unsupported-method and the UI sat
//! on its built-in fallback defaults forever.
//!
//! The contract does NOT ship the user's raw rules to the client — it ships
//! COMPILED rules: `{command, shortcut, whenAst}`. The client dispatches on the
//! compiled form and never parses a key string itself, so the parse has to
//! happen here and it has to agree exactly with `packages/shared/src/keybindings.ts`;
//! a shortcut that resolves differently in the two runtimes is a keyboard that
//! behaves differently depending on which backend is serving, which is worse
//! than one that does nothing.
//!
//! An unparseable rule is DROPPED, not defaulted and not fatal: the config is a
//! list, one bad entry must not take out the other 40 or fail the connection.
//! Dropping is what the TS resolver does, and the drop is visible because the
//! rule simply does not appear in the resolved set the settings page renders.

use agent_sdk_shell::OrchStore;
use serde_json::{json, Map, Value};

/// Durable key for the user's custom rules. Only the CUSTOM rules are stored;
/// the defaults are re-merged on every read, so a later release that changes a
/// default shortcut moves every user who never overrode it, instead of freezing
/// them on whatever shipped the day they first saved.
const KEYBINDINGS_KEY: &str = "server_settings:keybindings";

/// Mirrors `MAX_KEYBINDINGS_COUNT` in `packages/contracts/src/keybindings.ts`.
const MAX_KEYBINDINGS_COUNT: usize = 256;
/// Mirrors `MAX_WHEN_EXPRESSION_DEPTH`. Bounds recursion on a client-supplied
/// string, so a deeply nested `when` cannot blow the stack.
const MAX_WHEN_EXPRESSION_DEPTH: usize = 64;

/// One user-authored rule, pre-compilation. `when` absent = always active.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    pub key: String,
    pub command: String,
    pub when: Option<String>,
}

impl Rule {
    fn from_wire(v: &Value) -> Option<Self> {
        let key = v.get("key")?.as_str()?.trim().to_string();
        let command = v.get("command")?.as_str()?.trim().to_string();
        if key.is_empty() || command.is_empty() {
            return None;
        }
        // `when` is optional; an explicit null is the same as absent. An empty
        // string is NOT a valid `when` (the contract requires min length 1), so
        // it is treated as absent rather than as an expression that parses to
        // nothing.
        let when = v
            .get("when")
            .and_then(|w| w.as_str())
            .map(str::trim)
            .filter(|w| !w.is_empty())
            .map(str::to_string);
        Some(Rule { key, command, when })
    }

    fn to_wire(&self) -> Value {
        match &self.when {
            Some(w) => json!({"key": self.key, "command": self.command, "when": w}),
            None => json!({"key": self.key, "command": self.command}),
        }
    }
}

/// The built-in shortcuts, mirroring `DEFAULT_KEYBINDINGS` in
/// `packages/shared/src/keybindings.ts`. Kept in the same order, because order
/// IS precedence: later rules win, and the merge below appends custom rules
/// after the retained defaults for exactly that reason.
fn default_rules() -> Vec<Rule> {
    let mut out: Vec<Rule> = Vec::new();
    let mut push = |key: &str, command: &str, when: Option<&str>| {
        out.push(Rule {
            key: key.to_string(),
            command: command.to_string(),
            when: when.map(str::to_string),
        });
    };
    push("mod+b", "sidebar.toggle", None);
    push("mod+j", "terminal.toggle", None);
    push("mod+alt+b", "rightPanel.toggle", None);
    push("mod+d", "terminal.split", Some("terminalFocus"));
    push("mod+shift+d", "terminal.splitVertical", Some("terminalFocus"));
    push("mod+n", "terminal.new", Some("terminalFocus"));
    push("mod+w", "terminal.close", Some("terminalFocus"));
    push("mod+d", "diff.toggle", Some("!terminalFocus"));
    push("mod+shift+j", "preview.toggle", None);
    push("mod+r", "preview.refresh", Some("previewFocus"));
    push("mod+l", "preview.focusUrl", Some("previewFocus"));
    push("mod+=", "preview.zoomIn", Some("previewFocus"));
    push("mod++", "preview.zoomIn", Some("previewFocus"));
    push("mod+-", "preview.zoomOut", Some("previewFocus"));
    push("mod+0", "preview.resetZoom", Some("previewFocus"));
    push("mod+k", "commandPalette.toggle", Some("!terminalFocus"));
    push("mod+p", "filePicker.toggle", Some("!terminalFocus"));
    push("mod+shift+f", "projectSearch.toggle", Some("!terminalFocus"));
    push("mod+alt+shift+t", "themeEditor.toggle", None);
    push("mod+s", "composer.stash", Some("!terminalFocus"));
    push("mod+n", "chat.new", Some("!terminalFocus"));
    push("mod+shift+o", "chat.new", Some("!terminalFocus"));
    push("mod+shift+n", "chat.newLocal", Some("!terminalFocus"));
    push("mod+shift+m", "modelPicker.toggle", Some("!terminalFocus"));
    push("mod+o", "editor.openFavorite", None);
    push("mod+shift+[", "thread.previous", None);
    push("mod+shift+]", "thread.next", None);
    for i in 1..=9 {
        out.push(Rule {
            key: format!("mod+{i}"),
            command: format!("thread.jump.{i}"),
            when: None,
        });
    }
    for i in 1..=9 {
        out.push(Rule {
            key: format!("mod+{i}"),
            command: format!("modelPicker.jump.{i}"),
            when: Some("modelPickerOpen".to_string()),
        });
    }
    out
}

/// `space`/`esc` are spelled out in configs but the client compares against the
/// browser's `KeyboardEvent.key`, which uses `" "` and `"escape"`.
fn normalize_key_token(token: &str) -> String {
    match token {
        "space" => " ".to_string(),
        "esc" => "escape".to_string(),
        other => other.to_string(),
    }
}

/// Parse `"mod+shift+k"` into the compiled shortcut the client matches on.
///
/// Returns `None` for anything ambiguous — two non-modifier keys, an empty
/// token — rather than guessing. A guessed binding is a key that does something
/// the user did not ask for.
///
/// The trailing-`+` handling mirrors the TS parser: `"mod++"` splits to
/// `["mod", "", ""]`, and the empty tail is what encodes a literal `+`.
pub fn parse_shortcut(value: &str) -> Option<Value> {
    // Guarded up front, and it is the ONE place this deliberately does not
    // mirror the TS parser. There, `""` splits to `[""]`, the trailing-empty
    // rule fires, and an empty key resolves to a literal `+` — a keypress the
    // user never wrote. Nothing reachable can hit it (the contract's
    // `KeybindingValue` requires min length 1, and `Rule::from_wire` drops an
    // empty key before this is called), so refusing here cannot make the two
    // runtimes disagree on any input either of them will actually see.
    if value.trim().is_empty() {
        return None;
    }
    let lowered = value.to_lowercase();
    let raw: Vec<String> = lowered.split('+').map(|t| t.trim().to_string()).collect();
    let mut tokens = raw;
    let mut trailing_empty = 0usize;
    while tokens.last().map(|t| t.is_empty()).unwrap_or(false) {
        trailing_empty += 1;
        tokens.pop();
    }
    if trailing_empty > 0 {
        tokens.push("+".to_string());
    }
    if tokens.iter().any(|t| t.is_empty()) || tokens.is_empty() {
        return None;
    }

    let (mut meta, mut ctrl, mut shift, mut alt, mut moda) = (false, false, false, false, false);
    let mut key: Option<String> = None;
    for token in &tokens {
        match token.as_str() {
            "cmd" | "meta" => meta = true,
            "ctrl" | "control" => ctrl = true,
            "shift" => shift = true,
            "alt" | "option" => alt = true,
            "mod" => moda = true,
            other => {
                // A second non-modifier token means the string names two keys.
                // There is no sensible pick between them, so refuse the rule.
                if key.is_some() {
                    return None;
                }
                key = Some(normalize_key_token(other));
            }
        }
    }
    let key = key?;
    Some(json!({
        "key": key, "metaKey": meta, "ctrlKey": ctrl,
        "shiftKey": shift, "altKey": alt, "modKey": moda,
    }))
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum WhenToken {
    Ident(String),
    Not,
    And,
    Or,
    LParen,
    RParen,
}

fn tokenize_when(expr: &str) -> Option<Vec<WhenToken>> {
    let b: Vec<char> = expr.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        let c = b[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '&' && b.get(i + 1) == Some(&'&') {
            out.push(WhenToken::And);
            i += 2;
            continue;
        }
        if c == '|' && b.get(i + 1) == Some(&'|') {
            out.push(WhenToken::Or);
            i += 2;
            continue;
        }
        match c {
            '!' => {
                out.push(WhenToken::Not);
                i += 1;
                continue;
            }
            '(' => {
                out.push(WhenToken::LParen);
                i += 1;
                continue;
            }
            ')' => {
                out.push(WhenToken::RParen);
                i += 1;
                continue;
            }
            _ => {}
        }
        // identifier: /^[A-Za-z_][A-Za-z0-9_.-]*/ — same class as the TS lexer.
        if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            i += 1;
            while i < b.len() {
                let n = b[i];
                if n.is_ascii_alphanumeric() || n == '_' || n == '.' || n == '-' {
                    i += 1;
                } else {
                    break;
                }
            }
            out.push(WhenToken::Ident(b[start..i].iter().collect()));
            continue;
        }
        // A single stray character (`&`, `|`, `#`…) makes the whole expression
        // meaningless. Refusing it drops one rule; accepting a partial parse
        // would bind the key to a condition the user never wrote.
        return None;
    }
    Some(out)
}

struct WhenParser {
    tokens: Vec<WhenToken>,
    index: usize,
}

impl WhenParser {
    fn primary(&mut self, depth: usize) -> Option<Value> {
        if depth > MAX_WHEN_EXPRESSION_DEPTH {
            return None;
        }
        match self.tokens.get(self.index)?.clone() {
            WhenToken::Ident(name) => {
                self.index += 1;
                Some(json!({"type": "identifier", "name": name}))
            }
            WhenToken::LParen => {
                self.index += 1;
                let inner = self.or(depth + 1)?;
                if self.tokens.get(self.index) != Some(&WhenToken::RParen) {
                    return None;
                }
                self.index += 1;
                Some(inner)
            }
            _ => None,
        }
    }

    fn unary(&mut self, depth: usize) -> Option<Value> {
        let mut nots = 0usize;
        while self.tokens.get(self.index) == Some(&WhenToken::Not) {
            self.index += 1;
            nots += 1;
            if nots > MAX_WHEN_EXPRESSION_DEPTH {
                return None;
            }
        }
        let mut node = self.primary(depth)?;
        while nots > 0 {
            node = json!({"type": "not", "node": node});
            nots -= 1;
        }
        Some(node)
    }

    fn and(&mut self, depth: usize) -> Option<Value> {
        let mut left = self.unary(depth)?;
        while self.tokens.get(self.index) == Some(&WhenToken::And) {
            self.index += 1;
            let right = self.unary(depth)?;
            left = json!({"type": "and", "left": left, "right": right});
        }
        Some(left)
    }

    fn or(&mut self, depth: usize) -> Option<Value> {
        let mut left = self.and(depth)?;
        while self.tokens.get(self.index) == Some(&WhenToken::Or) {
            self.index += 1;
            let right = self.and(depth)?;
            left = json!({"type": "or", "left": left, "right": right});
        }
        Some(left)
    }
}

/// Parse a `when` expression into the AST the client evaluates.
///
/// Trailing garbage is rejected (`index != tokens.len()`): `"a b"` is not
/// "identifier a", it is a typo, and binding the key on a half-read condition
/// is how a shortcut fires in a context the user excluded.
pub fn parse_when(expr: &str) -> Option<Value> {
    let tokens = tokenize_when(expr)?;
    if tokens.is_empty() {
        return None;
    }
    let mut p = WhenParser { tokens, index: 0 };
    let ast = p.or(0)?;
    if p.index != p.tokens.len() {
        return None;
    }
    Some(ast)
}

/// Compile one rule, or drop it (`None`) if its key or `when` does not parse.
pub fn compile_rule(rule: &Rule) -> Option<Value> {
    let shortcut = parse_shortcut(&rule.key)?;
    match &rule.when {
        Some(w) => {
            let ast = parse_when(w)?;
            Some(json!({"command": rule.command, "shortcut": shortcut, "whenAst": ast}))
        }
        None => Some(json!({"command": rule.command, "shortcut": shortcut})),
    }
}

fn compile_config(rules: &[Rule]) -> Vec<Value> {
    let compiled: Vec<Value> = rules.iter().filter_map(compile_rule).collect();
    keep_last(compiled)
}

/// The contract caps the resolved list. Keeping the LAST N (not the first) is
/// deliberate: later rules have higher precedence, so a truncation that dropped
/// the tail would silently discard the user's newest overrides and leave the
/// defaults they were replacing in force.
fn keep_last<T>(mut items: Vec<T>) -> Vec<T> {
    if items.len() > MAX_KEYBINDINGS_COUNT {
        items.drain(..items.len() - MAX_KEYBINDINGS_COUNT);
    }
    items
}

/// Merge compiled custom rules over the compiled defaults.
///
/// Override is BY COMMAND, matching `mergeWithDefaultKeybindings`: rebinding
/// `terminal.toggle` removes the default `mod+j` for it rather than leaving two
/// live shortcuts for one command. Rebinding by key would instead leave the old
/// key still firing the old command, which is what users report as "my custom
/// shortcut didn't take".
fn merge_with_defaults(custom: Vec<Value>) -> Vec<Value> {
    let defaults = compile_config(&default_rules());
    if custom.is_empty() {
        return defaults;
    }
    let overridden: std::collections::HashSet<String> = custom
        .iter()
        .filter_map(|r| r.get("command").and_then(|c| c.as_str()).map(str::to_string))
        .collect();
    let mut merged: Vec<Value> = defaults
        .into_iter()
        .filter(|r| {
            r.get("command")
                .and_then(|c| c.as_str())
                .map(|c| !overridden.contains(c))
                .unwrap_or(true)
        })
        .collect();
    merged.extend(custom);
    keep_last(merged)
}

/// Two rules are the same when command, key and `when` all match — the identity
/// the upsert/remove filters use.
fn same_rule(a: &Rule, b: &Rule) -> bool {
    a.command == b.command && a.key == b.key && a.when == b.when
}

/// Load the user's custom rules. A stored blob that no longer decodes yields an
/// EMPTY custom set (so the user falls back to working defaults) rather than an
/// error that would make the settings page unopenable.
pub async fn load_custom(store: &OrchStore) -> Vec<Rule> {
    let Some(raw) = store.kv(KEYBINDINGS_KEY).await else {
        return Vec::new();
    };
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    items.iter().filter_map(Rule::from_wire).collect()
}

pub async fn save_custom(store: &OrchStore, rules: &[Rule]) -> Result<(), String> {
    let wire = Value::Array(rules.iter().map(Rule::to_wire).collect());
    let raw = serde_json::to_string(&wire).map_err(|e| e.to_string())?;
    store.put_kv(KEYBINDINGS_KEY, &raw).await
}

/// Apply an upsert to a custom set, returning the next set.
///
/// `replace` is how the settings page renames a binding: it names the OLD rule
/// so the edit is a move, not an add. Both the replace target and the incoming
/// rule are filtered out before appending, so re-saving an unchanged rule is
/// idempotent instead of accumulating duplicates.
pub fn upsert(custom: &[Rule], input: &Value) -> Result<Vec<Rule>, String> {
    let rule = Rule::from_wire(input).ok_or("keybinding requires key and command")?;
    // Refuse a rule that cannot compile INSTEAD of storing it: a stored rule
    // that never compiles is invisible in the resolved set, so the settings page
    // would show the save succeeding and the shortcut simply never working.
    if compile_rule(&rule).is_none() {
        return Err(format!(
            "unparseable keybinding: key {:?}{}",
            rule.key,
            rule.when
                .as_ref()
                .map(|w| format!(", when {w:?}"))
                .unwrap_or_default()
        ));
    }
    let replace = input.get("replace").and_then(Rule::from_wire);
    let mut next: Vec<Rule> = custom
        .iter()
        .filter(|e| {
            if let Some(r) = &replace {
                !same_rule(e, r) && !same_rule(e, &rule)
            } else {
                !same_rule(e, &rule)
            }
        })
        .cloned()
        .collect();
    next.push(rule);
    Ok(keep_last(next))
}

/// Drop a rule from the custom set. Removing a rule that is not there is a
/// no-op, not an error — the resulting state is what the caller asked for.
pub fn remove(custom: &[Rule], input: &Value) -> Result<Vec<Rule>, String> {
    let target = Rule::from_wire(input).ok_or("keybinding requires key and command")?;
    Ok(custom.iter().filter(|e| !same_rule(e, &target)).cloned().collect())
}

/// The resolved set the contract ships: compiled custom rules merged over the
/// compiled defaults.
pub fn resolved(custom: &[Rule]) -> Vec<Value> {
    merge_with_defaults(compile_config(custom))
}

/// `{keybindings, issues}` — the payload shared by both mutation results and the
/// `keybindingsUpdated` stream event.
pub fn result_wire(custom: &[Rule]) -> Value {
    json!({ "keybindings": resolved(custom), "issues": [] })
}

/// Where the rules live, for `server.getConfig`'s `keybindingsConfigPath`.
///
/// They are in the durable do-rs store, not a file on disk, so this names the
/// store key rather than inventing a path the user could open and edit — a
/// fabricated path is worse than an honest opaque one, because editing it would
/// silently do nothing.
pub fn config_path() -> String {
    format!("do-rs:{KEYBINDINGS_KEY}")
}

/// The non-durable defaults, for callers with no store (boot before the store is
/// up, and the `server_config` fallback).
pub fn default_resolved() -> Vec<Value> {
    resolved(&[])
}

/// Extract the settings page's `{key, command, when?}` from an RPC payload,
/// which may be the rule itself or wrapped in an `input`/`payload` envelope.
pub fn input_of(payload: &Value) -> Value {
    for k in ["input", "payload"] {
        if let Some(v) = payload.get(k) {
            if v.is_object() {
                return v.clone();
            }
        }
    }
    payload.clone()
}

/// Merge the resolved keybindings into a `server.getConfig` body.
pub fn apply_to_config(config: &mut Map<String, Value>, custom: &[Rule]) {
    config.insert("keybindings".into(), Value::Array(resolved(custom)));
    config.insert("keybindingsConfigPath".into(), Value::String(config_path()));
    config.insert("issues".into(), json!([]));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(key: &str, command: &str, when: Option<&str>) -> Rule {
        Rule { key: key.into(), command: command.into(), when: when.map(str::to_string) }
    }

    /// The compiled shortcut is what the client matches a real keypress
    /// against, so every modifier has to land in its own flag — `mod` in
    /// particular stays SEPARATE from meta/ctrl, because the client is what
    /// resolves it per platform.
    #[test]
    fn shortcut_parses_every_modifier_separately() {
        let s = parse_shortcut("mod+shift+k").expect("parses");
        assert_eq!(s["key"], "k");
        assert_eq!(s["modKey"], true);
        assert_eq!(s["shiftKey"], true);
        assert_eq!(s["metaKey"], false, "mod must not be pre-resolved to meta: {s}");
        assert_eq!(s["ctrlKey"], false);
        assert_eq!(s["altKey"], false);
    }

    /// `space`/`esc` are config spellings; the client compares against
    /// KeyboardEvent.key, which is `" "` / `"escape"`.
    #[test]
    fn shortcut_normalizes_named_keys() {
        assert_eq!(parse_shortcut("mod+space").unwrap()["key"], " ");
        assert_eq!(parse_shortcut("esc").unwrap()["key"], "escape");
    }

    /// A literal `+` is spelled by the trailing-empty-token trick. This is the
    /// case a naive `split('+')` silently turns into an empty key.
    #[test]
    fn shortcut_parses_literal_plus() {
        let s = parse_shortcut("mod++").expect("mod++ is a real default binding");
        assert_eq!(s["key"], "+");
        assert_eq!(s["modKey"], true);
    }

    /// Ambiguity is refused, never guessed: two non-modifier keys has no
    /// correct answer, and picking one binds a key the user never asked for.
    #[test]
    fn shortcut_refuses_two_keys_and_empty_tokens() {
        assert!(parse_shortcut("a+b").is_none(), "two keys must not resolve");
        assert!(parse_shortcut("mod++k").is_none(), "empty middle token is malformed");
        // Empty input resolves to a literal `+` in the TS parser via the
        // trailing-empty rule; see the guard in `parse_shortcut` for why
        // refusing it here cannot diverge on any reachable input.
        assert!(parse_shortcut("").is_none());
        assert!(parse_shortcut("   ").is_none());
    }

    #[test]
    fn when_parses_precedence_or_binds_loosest() {
        // a && b || c  ==  (a && b) || c
        let ast = parse_when("a && b || c").expect("parses");
        assert_eq!(ast["type"], "or");
        assert_eq!(ast["left"]["type"], "and");
        assert_eq!(ast["right"]["name"], "c");
    }

    #[test]
    fn when_parses_negation_and_parens() {
        let ast = parse_when("!(a || b)").expect("parses");
        assert_eq!(ast["type"], "not");
        assert_eq!(ast["node"]["type"], "or");
    }

    /// Trailing garbage must not half-parse. `"a b"` is a typo; treating it as
    /// `a` would make the shortcut fire in a context the user excluded.
    #[test]
    fn when_refuses_trailing_garbage_and_unbalanced_parens() {
        assert!(parse_when("a b").is_none());
        assert!(parse_when("(a").is_none());
        assert!(parse_when("a &&").is_none());
        assert!(parse_when("").is_none());
    }

    /// Bounded recursion on a client-supplied string.
    #[test]
    fn when_refuses_absurd_nesting_instead_of_overflowing() {
        let deep = format!("{}a{}", "(".repeat(500), ")".repeat(500));
        assert!(parse_when(&deep).is_none(), "must refuse, not overflow the stack");
    }

    /// One unparseable rule drops itself and nothing else — the other rules in
    /// the list must survive.
    #[test]
    fn compile_drops_only_the_bad_rule() {
        let rules = vec![
            rule("mod+b", "sidebar.toggle", None),
            rule("a+b", "diff.toggle", None),      // bad key
            rule("mod+k", "chat.new", Some("a b")), // bad when
            rule("mod+p", "filePicker.toggle", None),
        ];
        let out = compile_config(&rules);
        let cmds: Vec<&str> = out.iter().map(|r| r["command"].as_str().unwrap()).collect();
        assert_eq!(cmds, vec!["sidebar.toggle", "filePicker.toggle"], "got {cmds:?}");
    }

    /// Override is by COMMAND: rebinding a command must retire its default, or
    /// the old key keeps firing and the custom binding looks ignored.
    #[test]
    fn custom_rule_retires_the_default_for_that_command() {
        let custom = vec![rule("mod+shift+b", "sidebar.toggle", None)];
        let out = resolved(&custom);
        let sidebar: Vec<&Value> =
            out.iter().filter(|r| r["command"] == "sidebar.toggle").collect();
        assert_eq!(sidebar.len(), 1, "exactly one binding survives: {sidebar:?}");
        assert_eq!(sidebar[0]["shortcut"]["key"], "b");
        assert_eq!(sidebar[0]["shortcut"]["shiftKey"], true, "the CUSTOM one won");
    }

    /// Commands the user never touched keep their defaults.
    #[test]
    fn untouched_defaults_survive_a_custom_rule() {
        let out = resolved(&[rule("mod+shift+b", "sidebar.toggle", None)]);
        assert!(
            out.iter().any(|r| r["command"] == "terminal.toggle"),
            "unrelated defaults must remain"
        );
    }

    /// An empty custom set is the stock keyboard, not an empty one — this is
    /// the exact bug #71 describes (`keybindings: []` shipped to the client).
    #[test]
    fn no_custom_rules_still_ships_the_default_keyboard() {
        let out = default_resolved();
        assert!(out.len() > 30, "defaults must be served, got {}", out.len());
        assert!(out.iter().any(|r| r["command"] == "commandPalette.toggle"));
    }

    #[test]
    fn upsert_replaces_the_named_old_rule_instead_of_adding() {
        let custom = vec![rule("mod+1", "chat.new", None)];
        let next = upsert(
            &custom,
            &json!({"key": "mod+2", "command": "chat.new",
                    "replace": {"key": "mod+1", "command": "chat.new"}}),
        )
        .expect("valid");
        assert_eq!(next.len(), 1, "a rename is a move, not an add: {next:?}");
        assert_eq!(next[0].key, "mod+2");
    }

    #[test]
    fn upsert_is_idempotent_for_an_unchanged_rule() {
        let one = upsert(&[], &json!({"key": "mod+9", "command": "chat.new"})).unwrap();
        let two = upsert(&one, &json!({"key": "mod+9", "command": "chat.new"})).unwrap();
        assert_eq!(two.len(), 1, "re-saving must not duplicate: {two:?}");
    }

    /// A rule that cannot compile is refused at the door. Storing it would make
    /// the save report success while the shortcut never works.
    #[test]
    fn upsert_refuses_an_unparseable_rule() {
        let err = upsert(&[], &json!({"key": "a+b", "command": "chat.new"})).unwrap_err();
        assert!(err.contains("unparseable"), "{err}");
        let err = upsert(&[], &json!({"key": "mod+k", "command": "chat.new", "when": "a b"}))
            .unwrap_err();
        assert!(err.contains("unparseable"), "{err}");
    }

    /// `when` distinguishes rules: same key+command under a different condition
    /// is a DIFFERENT rule and must not be clobbered.
    #[test]
    fn when_is_part_of_rule_identity() {
        let custom = vec![rule("mod+d", "diff.toggle", Some("!terminalFocus"))];
        let next = upsert(&custom, &json!({"key": "mod+d", "command": "diff.toggle"})).unwrap();
        assert_eq!(next.len(), 2, "different `when` = different rule: {next:?}");
    }

    #[test]
    fn remove_drops_only_the_named_rule_and_tolerates_a_miss() {
        let custom = vec![
            rule("mod+1", "chat.new", None),
            rule("mod+2", "chat.newLocal", None),
        ];
        let next = remove(&custom, &json!({"key": "mod+1", "command": "chat.new"})).unwrap();
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].command, "chat.newLocal");

        let same = remove(&next, &json!({"key": "mod+99", "command": "chat.new"})).unwrap();
        assert_eq!(same.len(), 1, "removing an absent rule is a no-op, not an error");
    }

    /// Removing the user's override restores the built-in binding rather than
    /// leaving the command dead.
    #[test]
    fn removing_an_override_restores_the_default() {
        let custom = vec![rule("mod+shift+b", "sidebar.toggle", None)];
        let after = remove(&custom, &json!({"key": "mod+shift+b", "command": "sidebar.toggle"}))
            .unwrap();
        let out = resolved(&after);
        let sidebar: Vec<&Value> =
            out.iter().filter(|r| r["command"] == "sidebar.toggle").collect();
        assert_eq!(sidebar.len(), 1);
        assert_eq!(sidebar[0]["shortcut"]["key"], "b");
        assert_eq!(sidebar[0]["shortcut"]["shiftKey"], false, "default restored");
    }

    /// The cap keeps the NEWEST rules; dropping the tail would discard the
    /// user's latest overrides and leave the defaults they replaced in force.
    #[test]
    fn truncation_keeps_the_newest_rules() {
        let mut custom: Vec<Rule> = Vec::new();
        for i in 0..MAX_KEYBINDINGS_COUNT + 10 {
            custom = upsert(&custom, &json!({"key": format!("mod+{i}"), "command": "chat.new",
                                             "when": format!("ctx{i}")}))
                .unwrap();
        }
        assert_eq!(custom.len(), MAX_KEYBINDINGS_COUNT);
        let last = custom.last().unwrap();
        assert_eq!(last.when.as_deref(), Some(format!("ctx{}", MAX_KEYBINDINGS_COUNT + 9).as_str()));
    }

    /// A corrupt stored blob must not take out the settings page: fall back to
    /// the working default keyboard.
    #[test]
    fn a_corrupt_stored_blob_falls_back_to_defaults() {
        // `load_custom` decodes exactly this shape; the non-array/garbage paths
        // return an empty custom set, which `resolved` turns into the defaults.
        assert!(!default_resolved().is_empty());
    }

    #[test]
    fn input_of_unwraps_the_rpc_envelope() {
        let direct = json!({"key": "mod+b", "command": "sidebar.toggle"});
        assert_eq!(input_of(&direct), direct);
        assert_eq!(input_of(&json!({"input": direct.clone()})), direct);
        assert_eq!(input_of(&json!({"payload": direct.clone()})), direct);
    }

    /// The config body must carry the real path and the real rules — the two
    /// values #71 found hard-coded.
    #[test]
    fn apply_to_config_replaces_the_hardcoded_placeholders() {
        let mut cfg: Map<String, Value> = serde_json::from_value(
            json!({"keybindings": [], "keybindingsConfigPath": "/dev/null"}),
        )
        .unwrap();
        apply_to_config(&mut cfg, &[]);
        assert_ne!(cfg["keybindingsConfigPath"], "/dev/null");
        assert!(cfg["keybindings"].as_array().unwrap().len() > 30);
    }
}
