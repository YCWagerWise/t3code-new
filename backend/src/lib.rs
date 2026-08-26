//! The t3code backend as a LIBRARY, so its wiring is testable from outside a
//! binary. Both bins (`t3code-agent`, `t3code-server`) are thin entrypoints
//! over this; integration tests drive the same modules the product ships.

pub mod assets;
pub mod diagnostics;
pub mod keybindings;
pub mod providers;
pub mod projects;
pub mod review;
pub mod settings;
pub mod sourcecontrol;
pub mod terminal;
// #353: the one place text gets capped for the wire.
pub mod text;
pub mod tools;
pub mod vcs;
