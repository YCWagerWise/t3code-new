//! The server's advertised `serverVersion` must be the APP version, not this
//! crate's version.
//!
//! The client decides "is this server version-skewed" by comparing what the
//! server advertises against `APP_VERSION`, which vite bakes from
//! `apps/web/package.json` (vite.config.ts:42,204 -> branding.ts:27). The Node
//! server answers the same question with `packageJson.version`
//! (apps/server/src/environment/ServerEnvironment.ts:145), so the two agree by
//! construction.
//!
//! The Rust server hardcoded `"0.0.0"`. Against a client built at 0.0.33 that
//! is a permanent version mismatch, which is why the "Server update available"
//! banner renders on every connection to this backend — offering an update path
//! for a server whose only defect is that it misreports its own version.
//!
//! Reading the same file the client reads makes the two impossible to diverge,
//! which is the point: a hardcoded constant here would be correct until the
//! next release bump and silently wrong afterwards. `cargo:rerun-if-changed`
//! ties the rebuild to that file, so a version bump is picked up rather than
//! cached into the binary.
//!
//! `T3CODE_APP_VERSION` in the environment overrides it, matching the
//! `APP_VERSION` escape hatch vite already honours for release builds where the
//! version comes from CI rather than from the checked-in manifest.

use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("cargo always sets CARGO_MANIFEST_DIR"),
    );
    // backend/ -> repo root -> apps/web/package.json
    let package_json = manifest_dir
        .parent()
        .map(|root| root.join("apps").join("web").join("package.json"));

    println!("cargo:rerun-if-env-changed=T3CODE_APP_VERSION");
    if let Some(path) = package_json.as_ref() {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let version = std::env::var("T3CODE_APP_VERSION")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| package_json.as_ref().and_then(|p| version_from(p)));

    match version {
        Some(v) => println!("cargo:rustc-env=T3CODE_APP_VERSION={v}"),
        None => {
            // Do NOT silently fall back to "0.0.0" — that is the exact value
            // that produced the phantom update banner, and a build that cannot
            // find the manifest should say so while it is still a build problem
            // rather than shipping a server that lies about its version.
            panic!(
                "could not read the app version from {:?}. Set T3CODE_APP_VERSION to override.",
                package_json
            );
        }
    }
}

/// Minimal top-level `"version"` extraction. A JSON dependency is not worth
/// adding to a build script for one string, but this deliberately reads the
/// FIRST top-level `"version"` key rather than any nested one.
fn version_from(path: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    for line in raw.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("\"version\"") else {
            continue;
        };
        let rest = rest.trim_start().strip_prefix(':')?.trim_start();
        let rest = rest.strip_prefix('"')?;
        let end = rest.find('"')?;
        let value = &rest[..end];
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}
