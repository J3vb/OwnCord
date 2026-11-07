//! Portable scheduling primitives and an opt-in, standalone Windows capture experiment.

mod pacing;
mod queue;
mod scaling;

pub use pacing::Pacer;
pub use queue::LatestQueue;
pub use scaling::Dimensions;

#[cfg(windows)]
pub mod windows;
