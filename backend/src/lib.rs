//! The t3code backend as a LIBRARY, so its wiring is testable from outside a
//! binary. Both bins (`t3code-agent`, `t3code-server`) are thin entrypoints
//! over this; integration tests drive the same modules the product ships.

pub mod assets;
// Test-only scratch dirs that clean up in Drop. Not gated behind a feature: it
// is referenced from `#[cfg(test)]` blocks across the crate, and a leaked temp
// dir here is what filled the build box's tmpfs and turned into SIGBUS in
// do-storage's mmap'd coordination segment.
#[cfg(test)]
pub mod testtmp;
pub mod diagnostics;
pub mod keybindings;
pub mod paths;
pub mod projects;
pub mod providers;
pub mod review;
pub mod settings;
pub mod sourcecontrol;
pub mod terminal;
// #353: the one place text gets capped for the wire.
pub mod text;
pub mod tools;
pub mod vcs;
