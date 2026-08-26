//! `assets.createUrl` + the HTTP route that serves what it mints.
//!
//! The chat renderer, the file preview panel and the project favicon all show
//! BINARY content (images, PDFs). None of that can travel on the RPC socket, so
//! the contract splits it in two: an RPC mints a short-lived signed URL, and a
//! plain HTTP GET redeems it. A backend that implements only the RPC half hands
//! the UI a 404; a backend that implements only the HTTP half is an open file
//! server. Both halves live here so they cannot drift.
//!
//! Two properties are load-bearing:
//!
//! * **Confinement happens at MINT time.** `resolve` refuses any path that
//!   escapes the admitted workspace root, so a signed token can only ever name
//!   a file inside it. The HTTP side then trusts the path *because* the
//!   signature proves this server minted it — it never joins client input.
//! * **The signing key is durable.** It lives in the same `OrchStore` as
//!   settings, so URLs already rendered in an open tab keep working across a
//!   restart instead of turning into 403s.

use std::path::{Path, PathBuf};

use agent_sdk_shell::OrchStore;
use base64::Engine;
use hmac::{Mac, SimpleHmac};
use serde_json::{json, Value};
use sha2::Sha256;

/// Where minted URLs point. Matches the contract's `ASSET_ROUTE_PREFIX`.
pub const ROUTE_PREFIX: &str = "/api/assets";

/// How long a minted URL stays redeemable. Same hour the Node server used: long
/// enough that an open tab keeps rendering, short enough that a leaked URL dies.
const TTL_MS: i64 = 60 * 60 * 1000;

/// Durable key for the HMAC secret.
const SIGNING_KEY: &str = "assets:signing_key";

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

type Hmac256 = SimpleHmac<Sha256>;

/// Load the signing secret, minting one on first use.
///
/// Generated from the OS RNG and persisted: a per-process key would invalidate
/// every URL a client is holding on every restart, which is the bug this whole
/// module exists to avoid.
pub async fn signing_key(store: &OrchStore) -> Result<Vec<u8>, String> {
    // A store that cannot be read must not mint a NEW signing key: that would
    // silently invalidate every URL a client is holding.
    //
    // ABSENT and MALFORMED-PRESENT ARE DIFFERENT (#356). The `?` above already handles a
    // store that cannot be READ. What fell through was a row that reads fine and does not
    // DECODE — an odd-length value, a non-hex character, a truncated write. It skipped both
    // `if let`s, minted a fresh key, and `put_kv` overwrote the original.
    //
    // That is the outcome this comment exists to forbid, arrived at from the side: every
    // outstanding signed URL stops redeeming at once, with no error naming the cause, so the
    // operator sees broken images rather than "the signing key was replaced". And it adds a
    // worse one — before the call the old key was corrupt-but-present and possibly
    // recoverable (a partial write may be repairable, a hand-edit reversible); after it, it
    // is gone under 32 fresh random bytes.
    //
    // So minting happens ONLY for a genuinely absent row, which is the one state where it is
    // correct, and the `Some`/`None` binding already distinguishes it.
    match store.kv(SIGNING_KEY).await? {
        Some(hex) => from_hex(&hex).ok_or_else(|| {
            format!(
                "{SIGNING_KEY} is present but is not valid hex ({} byte(s)). REFUSING to mint a \
                 replacement: minting would silently invalidate every outstanding asset URL and \
                 would overwrite this row, destroying a secret that may still be recoverable. \
                 Repair the row, or delete it deliberately to accept re-minting.",
                hex.len()
            )
        }),
        None => {
            let mut key = [0u8; 32];
            getrandom(&mut key)?;
            let hex = to_hex(&key);
            store.put_kv(SIGNING_KEY, &hex).await?;
            Ok(key.to_vec())
        }
    }
}

fn getrandom(buf: &mut [u8]) -> Result<(), String> {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(buf))
        .map_err(|e| format!("read random: {e}"))
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Decode hex, over BYTES rather than over a `str` (#356).
///
/// `&hex[i..i + 2]` slices a `str` by byte index while the even-length guard also counts
/// bytes, so a value like "€x" — 4 bytes, passes the guard — panicked with "byte index 2 is
/// not a char boundary" instead of returning `None`. A durable row is foreign input; it must
/// not be able to panic the reader.
///
/// Deliberately NOT more permissive: no trimming, no skipping bad pairs, no padding an odd
/// length. A half-recovered signing key verifies nothing consistently and turns a clean
/// break into intermittent signature mismatches, which is strictly harder to diagnose.
fn from_hex(hex: &str) -> Option<Vec<u8>> {
    let b = hex.as_bytes();
    if b.is_empty() || b.len() % 2 != 0 {
        return None;
    }
    fn nibble(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    }
    b.chunks_exact(2)
        .map(|pair| Some(nibble(pair[0])? << 4 | nibble(pair[1])?))
        .collect()
}

/// A resource resolved to a real file, confined to `root`.
#[derive(Debug)]
pub struct Resolved {
    pub abs: PathBuf,
    pub file_name: String,
    /// The path the client asked for, echoed back so a preview can label it.
    pub source_path: Option<String>,
}

/// Resolve the contract's `AssetResource` union against an ALREADY-ADMITTED
/// workspace root.
///
/// `root` is the caller's business (it comes from the thread's worktree or the
/// environment workspace, both admitted by `vcs::resolve_cwd`); what happens
/// here is the second half: the resource's own path must land inside it.
pub fn resolve(resource: &Value, root: &str) -> Result<Resolved, String> {
    let tag = resource.get("_tag").and_then(Value::as_str).unwrap_or_default();
    let rel = match tag {
        "workspace-file" | "project-favicon" => resource
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| format!("{tag} requires a path"))?,
        // Attachments live in an upload store this backend does not have. That
        // is a missing feature, not a path to guess at — refusing keeps the
        // failure legible instead of serving the wrong file.
        "attachment" => return Err("attachments are not supported by this server".into()),
        other => return Err(format!("unknown asset resource `{other}`")),
    };
    let abs = confine(Path::new(root), rel)?;
    if !abs.is_file() {
        return Err(format!("asset `{rel}` was not found"));
    }
    let file_name = abs
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("asset `{rel}` has no file name"))?;
    Ok(Resolved { abs, file_name, source_path: Some(rel.to_string()) })
}

/// Resolve `rel` against `root` and refuse anything that escapes it — the same
/// rule cairn applies to agent file tools, applied to the asset surface.
fn confine(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let joined = if Path::new(rel).is_absolute() { PathBuf::from(rel) } else { root.join(rel) };
    let root = root.canonicalize().map_err(|e| format!("workspace root: {e}"))?;
    let resolved = joined.canonicalize().map_err(|_| format!("asset `{rel}` was not found"))?;
    if resolved.starts_with(&root) {
        Ok(resolved)
    } else {
        Err(format!("path `{rel}` escapes the workspace"))
    }
}

/// Mint the signed, expiring URL for a resolved file.
pub fn mint(resolved: &Resolved, key: &[u8], now_ms: i64) -> (String, i64) {
    let expires_at = now_ms + TTL_MS;
    let claims = json!({ "p": resolved.abs.to_string_lossy(), "e": expires_at });
    let payload = B64.encode(claims.to_string().as_bytes());
    let token = format!("{payload}.{}", sign(&payload, key));
    let name = url_encode(&resolved.file_name);
    (format!("{ROUTE_PREFIX}/{token}/{name}"), expires_at)
}

/// Verify a redeemed token and return the file it names.
///
/// Fails closed on every axis — shape, signature, expiry — and says which,
/// because "403 forever" with no reason is the hardest asset bug to diagnose.
pub fn verify(token: &str, key: &[u8], now_ms: i64) -> Result<PathBuf, String> {
    let (payload, signature) = token.split_once('.').ok_or("malformed asset token")?;
    // Constant-time: comparing MACs with `==` on the recomputed value leaks the
    // matching prefix length to a caller who can time it.
    let expected = sign(payload, key);
    if !constant_time_eq(signature.as_bytes(), expected.as_bytes()) {
        return Err("asset token signature does not verify".into());
    }
    let raw = B64.decode(payload).map_err(|_| "malformed asset token")?;
    let claims: Value = serde_json::from_slice(&raw).map_err(|_| "malformed asset token")?;
    let expires_at = claims.get("e").and_then(Value::as_i64).ok_or("malformed asset token")?;
    if expires_at <= now_ms {
        return Err("asset token expired".into());
    }
    let path = claims.get("p").and_then(Value::as_str).ok_or("malformed asset token")?;
    Ok(PathBuf::from(path))
}

fn sign(payload: &str, key: &[u8]) -> String {
    let mut mac = <Hmac256 as Mac>::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(payload.as_bytes());
    B64.encode(mac.finalize().into_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Percent-encode the path segment. A file name is user data — spaces, `#`, `?`
/// and non-ASCII all appear in real repositories and all break a raw URL.
fn url_encode(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for byte in name.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Best-effort content type for a served asset. The browser needs this to
/// decide between rendering an image and downloading bytes.
pub fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase().as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain; charset=utf-8",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> Vec<u8> {
        b"test-signing-key".to_vec()
    }

    /// Returns the GUARD, not a bare path: these files must survive until the
    /// test ends, and cleanup is now real rather than accidental. The guard is
    /// built from the CANONICAL path so it removes the same directory the test
    /// resolves against.
    fn workspace() -> crate::testtmp::TempRoot {
        // A UUID, not the process id: keyed on the pid every test in this binary
        // shared ONE directory. That was invisible while nothing was ever
        // cleaned up, and became a real interference bug the moment cleanup
        // started working — the first test to finish deleted the directory the
        // others were still reading.
        let raw = std::env::temp_dir().join(format!("t3-assets-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(raw.join("nested")).unwrap();
        std::fs::write(raw.join("nested/logo.png"), b"\x89PNG").unwrap();
        crate::testtmp::TempRoot::new(raw.canonicalize().unwrap())
    }

    #[test]
    fn a_minted_url_round_trips_to_the_same_file() {
        let root = workspace();
        let res = resolve(
            &json!({"_tag": "workspace-file", "threadId": "t-1", "path": "nested/logo.png"}),
            root.to_str().unwrap(),
        )
        .expect("resolves");
        let (url, expires_at) = mint(&res, &key(), 1_000);
        assert!(url.starts_with(&format!("{ROUTE_PREFIX}/")), "{url}");
        assert!(url.ends_with("/logo.png"), "the file name is the last segment: {url}");
        let token = url.trim_start_matches(&format!("{ROUTE_PREFIX}/")).split('/').next().unwrap();
        assert_eq!(verify(token, &key(), 1_000).unwrap(), root.join("nested/logo.png"));
        assert_eq!(expires_at, 1_000 + TTL_MS);
    }

    #[test]
    fn a_path_outside_the_workspace_is_refused_not_signed() {
        let root = workspace();
        for escape in ["../../etc/passwd", "/etc/passwd", "nested/../../../etc/passwd"] {
            let out = resolve(
                &json!({"_tag": "workspace-file", "threadId": "t-1", "path": escape}),
                root.to_str().unwrap(),
            );
            assert!(out.is_err(), "`{escape}` must not resolve to a signable path");
        }
    }

    #[test]
    fn a_tampered_or_expired_token_is_refused() {
        let root = workspace();
        let res =
            resolve(&json!({"_tag": "project-favicon", "cwd": ".", "path": "nested/logo.png"}), root.to_str().unwrap())
                .unwrap();
        let (url, _) = mint(&res, &key(), 1_000);
        let token = url.trim_start_matches(&format!("{ROUTE_PREFIX}/")).split('/').next().unwrap();

        // a different key never verifies
        assert!(verify(token, b"other-key", 1_000).is_err());
        // the claims cannot be swapped for another path under our signature
        let forged = format!("{}.{}", B64.encode(json!({"p": "/etc/passwd", "e": i64::MAX}).to_string()), token.split_once('.').unwrap().1);
        assert!(verify(&forged, &key(), 1_000).is_err(), "re-signed claims must fail");
        // and the token dies with its TTL
        assert!(verify(token, &key(), 1_000 + TTL_MS + 1).is_err(), "expired token must fail");
    }

    #[test]
    fn an_attachment_fails_explicitly_instead_of_guessing_a_path() {
        let root = workspace();
        let out = resolve(
            &json!({"_tag": "attachment", "attachmentId": "a-1"}),
            root.to_str().unwrap(),
        );
        assert!(out.unwrap_err().contains("attachments are not supported"));
    }
}
