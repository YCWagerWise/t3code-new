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
// Test scratch dirs with a real Drop — see the module docs; this leak filled
// the build box's tmpfs and was misdiagnosed as a red base.
pub mod testtmp;
pub mod tools;
pub mod vcs;
