//! The pure parsers of the OwnCord desktop client: everything that turns bytes
//! or text from outside the native side (a loopback HTTP client, the webview,
//! a store file on disk) into a decision. Kept free of Tauri, sockets and
//! libwebrtc so property tests and fuzz targets build in seconds.

pub mod pins;
pub mod proxy;
pub mod store;
