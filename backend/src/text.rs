//! Capping text for the wire, in one place.
//!
//! #353. Two RPCs need the same operation — "bound this text at N BYTES, then
//! back up to a whole line" — and each had written it out longhand. One of the
//! two got it wrong, and the wrong one is still the pre-fix version of code
//! whose sibling carries an incident report as its comment:
//!
//! > Slice on a CHAR boundary, not a byte count (#229). `MAX_READ_BYTES` can
//! > land in the middle of a multibyte codepoint, and slicing a `String` there
//! > panics — a valid large file (any non-ASCII source, any CJK text) took the
//! > backend down instead of returning a preview.
//!
//! That fix landed where the crash was observed and nowhere else, so
//! `review.rs` kept `diff[..MAX_DIFF_BYTES].rfind('\n')` — a byte slice whose
//! index is not checked for a char boundary, evaluated BEFORE the `rfind` that
//! looks like it would save it.
//!
//! The seam is the fix. Patching the second site without extracting the helper
//! recreates the same situation one site later, and the next "truncate a large
//! text" call site starts from the same coin flip.
//!
//! WHY BYTES AND NOT `chars().take(n)`: the bound exists to limit what is
//! serialised to the client. A 400_000-CHARACTER cap is up to 1.6 MB of UTF-8,
//! which is not the contract either caller wants. The cap stays in bytes; it
//! just has to land somewhere it is legal to cut.

/// Bound `s` to at most `max_bytes`, cutting on a whole line where possible and
/// always on a valid UTF-8 boundary. Returns the slice and whether anything was
/// dropped.
///
/// Order matters and is the whole point:
///  1. walk the byte cap DOWN to a char boundary — `is_char_boundary` is what
///     stops the panic, and it has to happen before any slicing;
///  2. only then look for the last `\n` inside that already-valid prefix, so a
///     client never renders half a hunk header or half a line.
///
/// `rfind` returns the index OF the newline, so the newline itself is excluded
/// — the caller gets whole lines with no dangling terminator.
pub fn cap_at_line_boundary(s: &str, max_bytes: usize) -> (&str, bool) {
    if s.len() <= max_bytes {
        return (s, false);
    }
    let mut cap = max_bytes;
    while cap > 0 && !s.is_char_boundary(cap) {
        cap -= 1;
    }
    // Prefer a whole final line, but only within the prefix already proven safe.
    let cut = s[..cap].rfind('\n').unwrap_or(cap);
    (&s[..cut], true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact shape that panicked: the byte at the cap is a UTF-8
    /// CONTINUATION byte, so slicing there is illegal.
    #[test]
    fn a_cap_landing_inside_a_multibyte_character_does_not_panic() {
        // 3-byte character straddling the cap: bytes 8,9,10 are one char, so
        // capping at 9 or 10 lands mid-character.
        let s = format!("{}{}", "a".repeat(8), "€"); // '€' is 3 bytes
        assert!(!s.is_char_boundary(9) && !s.is_char_boundary(10));

        for cap in [9usize, 10] {
            let (out, truncated) = cap_at_line_boundary(&s, cap);
            assert!(truncated, "cap {cap} is below the length, so it truncates");
            assert_eq!(out, "a".repeat(8), "backed up to the char boundary at 8");
            // The real assertion is that we got here at all.
            assert!(std::str::from_utf8(out.as_bytes()).is_ok());
        }
    }

    /// A cap that IS a boundary still prefers a whole line.
    #[test]
    fn a_legal_cap_still_cuts_on_the_last_newline() {
        let s = "alpha\nbravo\ncharlie";
        let (out, truncated) = cap_at_line_boundary(s, 14);
        assert!(truncated);
        assert_eq!(out, "alpha\nbravo", "cut at the last newline inside the cap");
    }

    /// No newline inside the cap: cut at the (boundary-adjusted) cap rather
    /// than returning nothing.
    #[test]
    fn text_with_no_newline_in_range_is_cut_at_the_cap() {
        let s = "aaaaaaaaaaaaaaaaaaaa";
        let (out, truncated) = cap_at_line_boundary(s, 5);
        assert!(truncated);
        assert_eq!(out, "aaaaa");
    }

    /// Under the cap is returned whole and NOT marked truncated — the flag is
    /// what the client uses to say "you are not seeing all of this".
    #[test]
    fn text_within_the_cap_is_untouched() {
        let s = "short\ntext";
        assert_eq!(cap_at_line_boundary(s, 400_000), (s, false));
        // Exactly at the cap is not truncation either.
        assert_eq!(cap_at_line_boundary(s, s.len()), (s, false));
    }

    /// Every byte offset over a multibyte-dense string is safe. This is the
    /// property, rather than the three examples above.
    #[test]
    fn no_cap_offset_can_panic_on_any_input() {
        let s = "日本語のテキスト\nこんにちは\n世界🌍end";
        for cap in 0..=s.len() + 4 {
            let (out, _) = cap_at_line_boundary(s, cap);
            assert!(s.starts_with(out), "the result is always a real prefix");
        }
    }
}
