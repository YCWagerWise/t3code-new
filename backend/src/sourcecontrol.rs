//! `server.discoverSourceControl` — what version-control systems and hosting
//! providers this machine can actually reach.
//!
//! The Source Control settings panel and the publish-readiness path are driven
//! entirely by this one RPC: it is what tells a user "git is here, `gh` is here
//! and you are logged in as X, `glab` is not installed and here is how to get
//! it". Without it the panel cannot light up at all, which is the blocker this
//! module closes.
//!
//! Three rules, because discovery is where a backend is most tempted to lie:
//!
//! 1. **A missing tool is a REPORTED fact, not an error.** Every probe that
//!    fails becomes a `missing` row carrying its `installHint`. Failing the
//!    whole RPC because `glab` is absent would blank a panel whose entire job
//!    is to tell you `glab` is absent.
//! 2. **Unknown is distinct from unauthenticated.** If a provider's CLI is not
//!    installed we cannot know whether the user has an account, and saying
//!    `unauthenticated` would prompt them to log into a tool they do not have.
//! 3. **Every probe argv is a CONSTANT.** No request input reaches a command
//!    line here — the RPC takes no arguments at all. This is deliberately not
//!    the banned `git_out` pattern, which interpolated a client-supplied ref
//!    into git's argv; there is nothing to interpolate in `git --version`.

use std::time::Duration;

use serde_json::{json, Value};

/// Probes are killed rather than allowed to hang the settings panel. A CLI that
/// blocks on a network call (an auth check against an unreachable host) reports
/// as `unknown`, which is the truth.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Cairn config the discovery RPC runs its probes under (#375).
///
/// Reviewer's rule: source-control EXECUTION goes through cairn's screened exec
/// surface, not `tokio::process::Command::new` here. Cairn's default policy
/// allows `git`/`gh`; discovery also probes `glab`, `jj`, and `az` for their
/// `--version` and auth-status banners, so this widens the command allow-list
/// to exactly those four. Env prefixes stay at cairn's default (`GIT_AUTHOR_`,
/// `GIT_COMMITTER_`) — no widening. Timeouts and sandbox come from cairn.
fn discovery_cfg() -> cairn::Config {
    let mut policy = cairn::ExecPolicy::default();
    for cmd in ["glab", "jj", "az"] {
        if !policy.commands.iter().any(|c| c == cmd) {
            policy.commands.push(cmd.to_string());
        }
    }
    cairn::Config::default().policy(policy)
}

/// Effect `Schema.Option` on the wire. effect-smol's encoded Option carries an
/// `"_id":"Option"` discriminator alongside `_tag`; without it the frontend
/// decode fails with "Expected Option" and the whole discovery result is
/// rejected — so both fields are mandatory here, not just `_tag`.
fn some(v: impl Into<String>) -> Value {
    json!({ "_id": "Option", "_tag": "Some", "value": v.into() })
}
fn none() -> Value {
    json!({ "_id": "Option", "_tag": "None" })
}

/// `Option`, but an empty/whitespace string collapses to `None` — a version
/// field rendered as an empty string looks like a UI bug, and it is not
/// information.
fn maybe(v: Option<String>) -> Value {
    match v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(s) => some(s),
        None => none(),
    }
}

struct Probe {
    exit_ok: bool,
    stdout: String,
    stderr: String,
}

/// Run a fixed argv through cairn's screened exec surface (#375).
///
/// Product-side source-control EXECUTION lives in cairn — the same screen,
/// spawner, sandbox, and env-prefix policy the rest of the app uses for
/// `git`/`gh`. `None` means either cairn REFUSED the command (a program not on
/// the discovery policy — which is a bug in this file, not a real probe result)
/// or the binary could not be spawned at all (not installed / not on PATH).
/// The refusal case logs so it does not silently look like a missing binary.
async fn run(program: &str, args: &[&str]) -> Option<Probe> {
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let cfg = discovery_cfg();
    let req = cairn::Exec {
        command: program,
        args: &owned,
        stdin: None,
        env: &[],
        timeout_ms: PROBE_TIMEOUT.as_millis() as u64,
        max_output_bytes: 256 * 1024,
    };
    match cairn::exec_at(&std::env::temp_dir(), &req, &cfg).await {
        Ok(out) => Some(Probe {
            exit_ok: out.exit_code == 0,
            stdout: out.stdout,
            stderr: out.stderr,
        }),
        Err(cairn::ExecError::Refused(why)) => {
            tracing::error!(%program, %why, "discovery probe refused by cairn policy — widen discovery_cfg or drop the probe");
            None
        }
        Err(cairn::ExecError::Failed(_)) => None,
    }
}

/// A CLI's version banner is its first non-empty line — of stdout, or of stderr
/// for the tools that print it there.
fn first_line(p: &Probe) -> Option<String> {
    p.stdout
        .lines()
        .chain(p.stderr.lines())
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

struct VcsProbe {
    kind: &'static str,
    label: &'static str,
    executable: &'static str,
    /// Whether THIS backend can actually drive it, independent of whether the
    /// binary exists. `jj` being installed does not mean we speak jj, and a
    /// panel that offered it would hand the user a dead button.
    implemented: bool,
    install_hint: &'static str,
}

const VCS_PROBES: &[VcsProbe] = &[
    VcsProbe {
        kind: "git",
        label: "Git",
        executable: "git",
        implemented: true,
        install_hint: "Install Git from https://git-scm.com/downloads or with your package manager.",
    },
    VcsProbe {
        kind: "jj",
        label: "Jujutsu",
        executable: "jj",
        implemented: false,
        install_hint: "Install Jujutsu with `brew install jj` or from https://github.com/jj-vcs/jj.",
    },
];

async fn discover_vcs(p: &VcsProbe) -> Value {
    let probe = run(p.executable, &["--version"]).await;
    let (status, version, detail) = match probe {
        Some(pr) if pr.exit_ok => ("available", maybe(first_line(&pr)), none()),
        // it exists but would not answer — name that, rather than reporting it
        // as missing and telling the user to install what they already have
        Some(pr) => (
            "missing",
            none(),
            some(first_line(&pr).unwrap_or_else(|| format!("`{} --version` failed", p.executable))),
        ),
        None => ("missing", none(), some(p.install_hint)),
    };
    json!({
        "kind": p.kind,
        "implemented": p.implemented,
        "label": p.label,
        "executable": p.executable,
        "status": status,
        "version": version,
        "installHint": p.install_hint,
        "detail": detail,
    })
}

struct ProviderProbe {
    kind: &'static str,
    label: &'static str,
    executable: &'static str,
    auth_args: &'static [&'static str],
    install_hint: &'static str,
}

const PROVIDER_PROBES: &[ProviderProbe] = &[
    ProviderProbe {
        kind: "github",
        label: "GitHub",
        executable: "gh",
        auth_args: &["auth", "status"],
        install_hint: "Install the GitHub command-line tool (`gh`) via https://cli.github.com/ or your package manager (for example `brew install gh`).",
    },
    ProviderProbe {
        kind: "gitlab",
        label: "GitLab",
        executable: "glab",
        auth_args: &["auth", "status"],
        install_hint: "Install the GitLab command-line tool (`glab`) from https://gitlab.com/gitlab-org/cli or your package manager (for example `brew install glab`).",
    },
    ProviderProbe {
        kind: "azure-devops",
        label: "Azure DevOps",
        executable: "az",
        auth_args: &["account", "show", "--query", "user.name", "-o", "tsv"],
        install_hint: "Install the Azure command-line tools (`az`), then enable Azure DevOps support with `az extension add --name azure-devops`.",
    },
];

/// Bitbucket has no CLI here — it is configured by server-side credentials, so
/// "is it available" is a question about this process's environment.
const BITBUCKET_ENV: [&str; 2] = ["T3CODE_BITBUCKET_EMAIL", "T3CODE_BITBUCKET_API_TOKEN"];
const BITBUCKET_HINT: &str = "Set T3CODE_BITBUCKET_EMAIL and T3CODE_BITBUCKET_API_TOKEN on the server (use a Bitbucket API token with pull request, repository, and user read scopes).";

fn auth(status: &str, account: Value, host: Value, detail: Value) -> Value {
    json!({ "status": status, "account": account, "host": host, "detail": detail })
}

/// Pull the logged-in account out of a CLI's auth banner, best effort.
///
/// `gh` prints "✓ Logged in to github.com account NAME (keyring)"; `glab`
/// prints "✓ Logged in to gitlab.com as NAME". Best effort is the honest
/// posture: a banner we cannot parse still means AUTHENTICATED (the command
/// exited 0), just without a name to show. Reporting unauthenticated because a
/// message changed wording would be a lie the user cannot act on.
fn parse_account(text: &str) -> (Option<String>, Option<String>) {
    let mut account = None;
    let mut host = None;
    for line in text.lines() {
        let l = line.trim();
        if let Some(rest) = l.split("Logged in to ").nth(1) {
            let mut it = rest.split_whitespace();
            host = it.next().map(str::to_string);
            // "… account NAME (keyring)" | "… as NAME"
            let mut words = rest.split_whitespace().peekable();
            while let Some(w) = words.next() {
                if (w == "account" || w == "as") && account.is_none() {
                    account = words.peek().map(|n| n.trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_' && c != '@' && c != '.').to_string());
                }
            }
        }
    }
    (account.filter(|a| !a.is_empty()), host)
}

async fn discover_provider(p: &ProviderProbe) -> Value {
    let version_probe = run(p.executable, &["--version"]).await;
    let Some(vp) = version_probe else {
        // not installed: we cannot know anything about the user's account, and
        // `unauthenticated` would tell them to log into a tool they lack.
        return json!({
            "kind": p.kind, "label": p.label, "executable": p.executable,
            "status": "missing", "version": none(), "installHint": p.install_hint,
            "detail": some(p.install_hint),
            "auth": auth("unknown", none(), none(), some(format!("`{}` is not installed", p.executable))),
        });
    };
    if !vp.exit_ok {
        return json!({
            "kind": p.kind, "label": p.label, "executable": p.executable,
            "status": "missing", "version": none(), "installHint": p.install_hint,
            "detail": some(first_line(&vp).unwrap_or_else(|| format!("`{} --version` failed", p.executable))),
            "auth": auth("unknown", none(), none(), none()),
        });
    }

    let auth_value = match run(p.executable, p.auth_args).await {
        None => auth("unknown", none(), none(), some("the auth check could not be run")),
        Some(ap) if ap.exit_ok => {
            let combined = format!("{}\n{}", ap.stdout, ap.stderr);
            let (account, host) = parse_account(&combined);
            auth("authenticated", maybe(account), maybe(host), none())
        }
        Some(ap) => auth(
            "unauthenticated",
            none(),
            none(),
            maybe(first_line(&ap)),
        ),
    };
    json!({
        "kind": p.kind, "label": p.label, "executable": p.executable,
        "status": "available", "version": maybe(first_line(&vp)),
        "installHint": p.install_hint, "detail": none(),
        "auth": auth_value,
    })
}

fn discover_bitbucket() -> Value {
    let missing: Vec<&str> = BITBUCKET_ENV
        .iter()
        .copied()
        .filter(|k| std::env::var(k).map(|v| v.trim().is_empty()).unwrap_or(true))
        .collect();
    let configured = missing.is_empty();
    json!({
        "kind": "bitbucket",
        "label": "Bitbucket",
        "status": if configured { "available" } else { "missing" },
        "version": none(),
        "installHint": BITBUCKET_HINT,
        "detail": if configured { none() } else { some(format!("not configured: {}", missing.join(", "))) },
        // credentials being PRESENT is not proof they WORK — claiming
        // authenticated here would show a green check for a revoked token. The
        // honest answer until something actually calls the API is `unknown`.
        "auth": auth(
            if configured { "unknown" } else { "unauthenticated" },
            none(),
            none(),
            if configured { some("credentials are configured but have not been verified") } else { some(BITBUCKET_HINT) },
        ),
    })
}

/// The RPC body. Probes run CONCURRENTLY — six sequential CLI spawns, each able
/// to take seconds, is a settings panel that feels broken.
pub async fn discover() -> Value {
    let (vcs, providers) = tokio::join!(
        futures::future::join_all(VCS_PROBES.iter().map(discover_vcs)),
        futures::future::join_all(PROVIDER_PROBES.iter().map(discover_provider)),
    );
    let mut providers = providers;
    providers.push(discover_bitbucket());
    json!({ "versionControlSystems": vcs, "sourceControlProviders": providers })
}

// ── repository actions: lookup / clone / publish (#58) ──────────────────────
//
// Discovery says which providers this environment HAS. These are the actions it
// unlocks, and without them the Source Control settings can report a healthy
// GitHub CLI and still do nothing. Every one of them goes through a real tool —
// `gh` for provider metadata, Cairn for the git work — and reports an explicit,
// actionable error when the tool is absent rather than pretending.

/// `nameWithOwner` → the four fields the contract's `SourceControlRepositoryInfo`
/// carries. GitHub is the only provider with a CLI we can drive here; the others
/// report honestly that this environment cannot look them up.
pub async fn lookup_repository(input: &Value) -> Result<Value, String> {
    let provider = input.get("provider").and_then(Value::as_str).unwrap_or("unknown");
    let repository = input
        .get("repository")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("repository is required")?;
    if provider != "github" {
        return Err(format!(
            "this environment can only look up github repositories (asked for {provider})"
        ));
    }
    // Through CAIRN, not a product subprocess (#375). There is no repository to
    // hang this off — a lookup necessarily precedes the clone — but the absence
    // of a worktree is a reason `Repo::exec` does not fit, not a reason to skip
    // the screen: what is screened is the argv and the environment, and neither
    // needs a worktree to exist. `gh_repo_view` runs it through the same
    // `ExecPolicy`, sandbox, timeout and output ceiling every other cairn
    // consumer gets, which is also what finally makes `ExecPolicy::git_only()`
    // mean something on this path.
    // cairn returns a TYPED `GitHubRepository`, not loose JSON. The product
    // shapes it into the wire object the T3 client expects and does nothing
    // else — which is the whole job of this layer.
    //
    // The three `unwrap_or` fallbacks this replaced (repository / "" / "") were
    // covering for an untyped `Value` in which a field could simply be absent.
    // With a typed result the fields exist or the call failed, so a missing
    // `url` can no longer reach the client as an empty string that looks like a
    // successful lookup.
    let repo = cairn::gh_repo_view(repository, &cairn::Config::default())
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "provider": "github",
        "nameWithOwner": repo.name_with_owner,
        "url": repo.url,
        "sshUrl": repo.ssh_url,
    }))
}

/// Clone into `destinationPath`. The remote can be given directly (`remoteUrl`)
/// or resolved from a provider repository first.
pub async fn clone_repository(input: &Value, workspace_root: &str) -> Result<Value, String> {
    let requested = input
        .get("destinationPath")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("destinationPath is required")?;
    // The DESTINATION is this environment's authority to decide, not the
    // client's: without this a frontend can put a checkout anywhere the backend
    // user can write (#178).
    let destination_owned = crate::vcs::admit_new_directory(requested, workspace_root)?;
    let destination = destination_owned.as_str();
    if std::path::Path::new(destination).exists() {
        return Err(format!("{destination} already exists — refusing to clone over it"));
    }
    let protocol = input.get("protocol").and_then(Value::as_str).unwrap_or("auto");

    // Either an explicit remote, or one resolved through the provider.
    let (remote_url, repository) = match input.get("remoteUrl").and_then(Value::as_str) {
        Some(url) if !url.trim().is_empty() => (url.to_string(), Value::Null),
        _ => {
            let info = lookup_repository(input).await?;
            let url = match protocol {
                "ssh" => info["sshUrl"].as_str().unwrap_or_default().to_string(),
                _ => info["url"].as_str().unwrap_or_default().to_string(),
            };
            (url, info)
        }
    };
    if remote_url.trim().is_empty() {
        return Err("no remote url to clone from".into());
    }
    // Through CAIRN (#375). `clone_repository` validates the remote URL FIRST —
    // `git clone` accepts URL forms that execute code on the cloning machine —
    // and then runs the clone through the screened surface. The product no
    // longer decides whether git may run, only where the result goes.
    cairn::clone_repository(
        &remote_url,
        std::path::Path::new(destination),
        &cairn::Config::default(),
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(json!({ "cwd": destination, "remoteUrl": remote_url, "repository": repository }))
}

/// Create the remote repository for a local checkout and push to it.
///
/// Reports which of the two states it reached: `pushed` when the branch is
/// upstream, `remote_added` when the remote exists but the push did not land —
/// a user who is told only "failed" cannot tell whether to retry the push or
/// create the repo again.
pub async fn publish_repository(input: &Value, workspace_root: &str) -> Result<Value, String> {
    let requested_cwd = input
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("cwd is required")?;
    // Publishing PUSHES a repository to a remote. Trusting the client's cwd
    // would let the frontend publish any local repository the backend user can
    // see, not just this environment's workspace or one of its worktrees (#181).
    let cwd_owned = crate::vcs::resolve_cwd(requested_cwd, workspace_root).await?;
    let cwd = cwd_owned.as_str();
    let repository = input
        .get("repository")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("repository is required")?;
    let provider = input.get("provider").and_then(Value::as_str).unwrap_or("github");
    if provider != "github" {
        return Err(format!(
            "this environment can only publish to github (asked for {provider})"
        ));
    }
    let visibility = input.get("visibility").and_then(Value::as_str).unwrap_or("private");
    let remote_name = input.get("remoteName").and_then(Value::as_str).unwrap_or("origin");

    let repo = crate::vcs::open(cwd).await.ok_or("cwd is not a git repository")?;
    let branch = repo
        .branch()
        .await
        .ok_or("the repository is on a detached HEAD — nothing to publish")?;

    // Through CAIRN's screened exec, not a product subprocess (#375). This one
    // has a repository in hand, so `Repo::exec` applies the same argument
    // screen every other consumer of that seam gets — including the refusal of
    // the option shapes that turn an allow-listed program into an arbitrary
    // one. The product still chooses the arguments; it no longer decides
    // whether the process may run.
    let args: Vec<String> = [
        "repo",
        "create",
        repository,
        &format!("--{visibility}"),
        "--source",
        ".",
        "--remote",
        remote_name,
        "--push",
    ]
    .iter()
    .map(|a| (*a).to_string())
    .collect();
    let out = repo
        .exec(&cairn::exec::Exec {
            command: "gh",
            args: &args,
            stdin: None,
            env: &[],
            timeout_ms: 120_000,
            max_output_bytes: 256 * 1024,
        })
        .await
        .map_err(|e| format!("gh is not available in this environment: {e}"))?;
    let pushed = out.exit_code == 0;
    if !pushed {
        let stderr = out.stderr.clone();
        // The repo may exist already — that is a different problem from a
        // failed push, and the caller needs to know which.
        if !stderr.contains("already exists") {
            return Err(format!("gh repo create: {}", stderr.trim()));
        }
    }
    let info = lookup_repository(&json!({ "provider": "github", "repository": repository })).await?;
    let remote_url = info["url"].as_str().unwrap_or_default().to_string();
    Ok(json!({
        "repository": info,
        "remoteName": remote_name,
        "remoteUrl": remote_url,
        "branch": branch,
        "upstreamBranch": if pushed { json!(branch) } else { Value::Null },
        "status": if pushed { "pushed" } else { "remote_added" },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opt(v: &Value) -> Option<&str> {
        (v["_tag"] == "Some").then(|| v["value"].as_str().unwrap())
    }

    /// The shape the contract demands, against the REAL host.
    #[tokio::test]
    async fn discovery_reports_every_probe_with_contract_fields() {
        let d = discover().await;
        let vcs = d["versionControlSystems"].as_array().unwrap();
        let provs = d["sourceControlProviders"].as_array().unwrap();
        assert_eq!(vcs.len(), 2, "git + jj are both REPORTED, present or not");
        assert_eq!(provs.len(), 4, "github, gitlab, azure-devops, bitbucket");

        for item in vcs.iter().chain(provs.iter()) {
            for field in ["kind", "label", "status", "version", "installHint", "detail"] {
                assert!(!item[field].is_null(), "{field} missing from {item}");
            }
            assert!(
                item["status"] == "available" || item["status"] == "missing",
                "status is a literal: {item}"
            );
            // Options are the tagged Effect encoding, never a bare string/null
            for field in ["version", "detail"] {
                assert!(
                    item[field]["_tag"] == "Some" || item[field]["_tag"] == "None",
                    "{field} must be an encoded Option: {item}"
                );
            }
            assert!(!item["installHint"].as_str().unwrap().is_empty(), "a hint a user can act on");
        }
        for p in provs {
            let status = p["auth"]["status"].as_str().unwrap();
            assert!(
                matches!(status, "authenticated" | "unauthenticated" | "unknown"),
                "auth status literal: {p}"
            );
        }
    }

    /// git is installed on any machine running this backend, so this asserts the
    /// happy path is really wired: available, implemented, with a version.
    #[tokio::test]
    async fn git_is_discovered_as_available_and_implemented() {
        let d = discover().await;
        let git = d["versionControlSystems"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["kind"] == "git")
            .unwrap()
            .clone();
        assert_eq!(git["status"], "available");
        assert_eq!(git["implemented"], true);
        let version = opt(&git["version"]).expect("a version banner");
        assert!(version.to_lowercase().contains("git"), "real banner: {version}");
    }

    /// jj is reported even when installed, and never as implemented — the
    /// backend does not speak it, and an enabled button that cannot work is
    /// worse than a disabled one.
    #[tokio::test]
    async fn an_unimplemented_vcs_is_listed_but_never_implemented() {
        let d = discover().await;
        let jj = d["versionControlSystems"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["kind"] == "jj")
            .unwrap()
            .clone();
        assert_eq!(jj["implemented"], false);
        assert!(!jj["installHint"].as_str().unwrap().is_empty());
    }

    /// A tool that is not installed cannot tell us anything about the user's
    /// account. `unauthenticated` there would prompt a login for a missing CLI.
    #[tokio::test]
    async fn a_missing_provider_cli_reports_unknown_auth_not_unauthenticated() {
        let missing = ProviderProbe {
            kind: "github",
            label: "Nope",
            executable: "t3code-no-such-binary-xyz",
            auth_args: &["auth", "status"],
            install_hint: "install the thing",
        };
        let v = discover_provider(&missing).await;
        assert_eq!(v["status"], "missing");
        assert_eq!(v["auth"]["status"], "unknown", "not unauthenticated");
        assert_eq!(opt(&v["detail"]), Some("install the thing"));
        assert_eq!(v["version"]["_tag"], "None");
    }

    /// Configured-but-unverified credentials are `unknown`, not authenticated —
    /// a green check for a revoked token is the failure this prevents.
    #[test]
    fn bitbucket_credentials_present_is_not_a_claim_that_they_work() {
        let v = discover_bitbucket();
        assert_eq!(v["kind"], "bitbucket");
        let configured = v["status"] == "available";
        if configured {
            assert_eq!(v["auth"]["status"], "unknown");
        } else {
            assert_eq!(v["auth"]["status"], "unauthenticated");
            assert!(opt(&v["detail"]).unwrap().contains("T3CODE_BITBUCKET"));
        }
    }

    #[test]
    fn auth_banners_yield_an_account_and_a_host() {
        let (a, h) = parse_account("✓ Logged in to github.com account octocat (keyring)");
        assert_eq!(a.as_deref(), Some("octocat"));
        assert_eq!(h.as_deref(), Some("github.com"));

        let (a, h) = parse_account("✓ Logged in to gitlab.com as sam");
        assert_eq!(a.as_deref(), Some("sam"));
        assert_eq!(h.as_deref(), Some("gitlab.com"));

        // an unparseable banner yields no name — and the CALLER still reports
        // authenticated, because the exit code, not the wording, is the fact
        let (a, _) = parse_account("you are all set!");
        assert_eq!(a, None);
    }

    #[test]
    fn an_empty_string_is_none_not_an_empty_option() {
        assert_eq!(maybe(Some("   ".into())), none());
        assert_eq!(maybe(None), none());
        assert_eq!(maybe(Some(" v1 ".into())), some("v1"));
    }
}
