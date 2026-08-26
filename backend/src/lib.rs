//! The t3code backend as a LIBRARY, so its wiring is testable from outside a
//! binary. Both bins (`t3code-agent`, `t3code-server`) are thin entrypoints
//! over this; integration tests drive the same modules the product ships.

pub mod assets;
pub mod diagnostics;
pub mod keybindings;
pub mod paths;
pub mod projects;
pub mod providers;
pub mod review;
pub mod settings;
pub mod sourcecontrol;
pub mod terminal;
pub mod tools;
pub mod vcs;
