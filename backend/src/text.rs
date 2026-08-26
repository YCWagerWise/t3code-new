//! Truncating text for the wire, without panicking on it.
//!
//! Every "cap this at N bytes and back up to a line boundary" site in this
//! backend goes through [`cap_at_line_boundary`]. That is the whole point of
//! the module: there used to be two hand-written copies of this operation, and
//! **one of them was wrong** (#229 / #353).
//!
//! The wrong one is worth stating precisely, because it looks correct:
//!
//! ```ignore
//! let cut = s[..MAX].rfind('\n').unwrap_or(MAX);   // panics before rfind runs
//! ```
//!
//! `s[..MAX]` is a BYTE slice of a `str`. If byte `MAX` lands inside a
//! multi-byte UTF-8 sequence, that expression panics with "byte index N is not
//! a char boundary" — and it is evaluated *before* `rfind`, so searching for a
//! line boundary cannot rescue it. `projects.rs` recorded the consequence when
//! it hit this on ordinary data: "a valid large file (any non-ASCII source, any
//! CJK text) took the backend down instead of returning a preview."
//!
//! It is also **deterministic**, not flaky: the same repository reproduces it on
//! every request, so the affected panel is permanently broken rather than
//! occasionally.
//!
//! The cap stays a BYTE cap on purpose. `chars().take(n)` would make it a
//! CHARACTER cap, and these limits exist to bound what is serialised to a
//! client — 400_000 characters of UTF-8 can be 1.6 MB on the wire. The bound is
//! right; only the boundary handling was wrong.

/// Cap `s` at `max_bytes`, backing up to a char boundary and then, if possible,
/// to the end of the last whole line.
///
/// Returns the slice and whether anything was dropped. `truncated` reports
/// whether the INPUT exceeded `max_bytes` — not whether the returned slice is
/// shorter — so a caller can tell the client how much it is not seeing even
/// when the line-boundary walk happens to land on the end.
///
/// Order matters and is the fix: walk back to a valid char boundary FIRST, then
/// look for a newline inside the slice that walk produced. Doing it the other
/// way round is the bug this module exists to delete.
pub fn cap_at_line_boundary(s: &str, max_bytes: usize) -> (&str, bool) {
    if s.len() <= max_bytes {
        return (s, false);
    }
    // 1. A byte index that is safe to slice at.
    let mut cap = max_bytes;
    while cap > 0 && !s.is_char_boundary(cap) {
        cap -= 1;
    }
    // 2. Prefer a whole final line, so a client never renders half a hunk
    //    header or half a source line. `rfind` on an already-valid slice
    //    returns an already-valid index, so this cannot reintroduce the bug.
    let cut = s[..cap].rfind('\n').unwrap_or(cap);
    (&s[..cut], true)
}

#[cfg(test)]
mod tests {
    use super::cap_at_line_boundary;

    #[test]
    fn short_input_is_returned_whole_and_not_marked_truncated() {
        assert_eq!(cap_at_line_boundary("abc", 400), ("abc", false));
        // exactly at the cap is NOT truncation
        assert_eq!(cap_at_line_boundary("abcd", 4), ("abcd", false));
    }

    /// THE PANIC (#353). The cap lands inside a multi-byte character.
    ///
    /// `é` is 2 bytes, so with `max_bytes` on its second byte the old
    /// `s[..max].rfind('\n')` panics before `rfind` is ever called. Asserting on
    /// the RETURNED VALUE, not on `is_ok()`: a panic is not an `Err`, so a test
    /// that only caught unwind would pass for the wrong reason.
    #[test]
    fn a_cap_inside_a_multibyte_character_truncates_instead_of_panicking() {
        let s = "aé"; // bytes: 'a', 0xC3, 0xA9
        assert_eq!(s.len(), 3);
        let (out, truncated) = cap_at_line_boundary(s, 2); // inside 'é'
        assert!(truncated);
        assert_eq!(out, "a", "backed up to the boundary before the character");
    }

    /// The realistic shape of the bug: a large mostly-ASCII payload with one
    /// non-ASCII character straddling the cap — an accented identifier, an emoji
    /// in a fixture, CJK text, a box-drawing character in captured output.
    #[test]
    fn a_large_diff_whose_cap_lands_on_a_continuation_byte_is_truncated() {
        const MAX: usize = 400_000;
        // Pad to MAX-1 so a 3-byte character straddles byte MAX.
        let mut s = "a".repeat(MAX - 1);
        s.push('☃'); // 3 bytes: MAX-1, MAX, MAX+1
        s.push_str("\ntail\n");
        assert!(!s.is_char_boundary(MAX), "the fixture must actually straddle");

        let (out, truncated) = cap_at_line_boundary(&s, MAX);
        assert!(truncated);
        assert!(out.len() < MAX);
        // valid UTF-8 out, and it did not slice the snowman in half
        assert!(!out.contains('\u{FFFD}'));
        assert_eq!(out, "a".repeat(MAX - 1), "stopped before the straddling char");
    }

    /// When a newline is available inside the capped region, prefer it — a
    /// client must never render half a hunk header.
    #[test]
    fn prefers_the_last_whole_line_inside_the_cap() {
        let s = "one\ntwo\nthree-is-long";
        let (out, truncated) = cap_at_line_boundary(s, 12);
        assert!(truncated);
        assert_eq!(out, "one\ntwo", "cut back to the last newline");
    }

    /// No newline at all is a real case (a single enormous line), and it must
    /// still return the char-safe prefix rather than nothing.
    #[test]
    fn falls_back_to_the_char_boundary_when_there_is_no_newline() {
        let s = "ααααα"; // 2 bytes each
        let (out, truncated) = cap_at_line_boundary(s, 5); // odd -> mid-character
        assert!(truncated);
        assert_eq!(out, "αα", "backed up one byte to the boundary");
    }

    /// Degenerate but reachable: the cap is smaller than the first character.
    #[test]
    fn a_cap_below_the_first_character_yields_empty_rather_than_panicking() {
        let (out, truncated) = cap_at_line_boundary("☃x", 1);
        assert!(truncated);
        assert_eq!(out, "");
    }
}
