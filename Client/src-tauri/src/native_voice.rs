//! Native LiveKit backend for Linux voice/video — phase 0: build plumbing only.
//!
//! No mainstream WebKitGTK build ships WebRTC, so the system webview on Linux
//! has no `RTCPeerConnection` and the browser LiveKit path cannot work there.
//! The fix (approved design: `docs/architecture/voice-e2ee.md`) is to run the
//! LiveKit Rust SDK in this backend on Linux only, with the webview kept as the
//! UI and driven over IPC. The TS E2EE key exchange stays in the frontend, so
//! only the final room key crosses IPC and encryption stays byte-compatible
//! with Windows clients.
//!
//! This module deliberately contains no voice behaviour yet. Its single command
//! exists so the `livekit` dependency (and with it the prebuilt libwebrtc) is
//! actually linked into the binary, which is what makes the Linux build itself
//! the proof that the toolchain plumbing works. The real session/audio/video
//! commands land in phase 1.

/// Report the native LiveKit SDK version and confirm libwebrtc is linked.
///
/// `create_random_uuid` is the cheapest call that resolves a libwebrtc symbol,
/// so a successful link is the evidence that the prebuilt archive matched the
/// toolchain. Phase 0 has no frontend consumer; the command is invoked by the
/// `cargo test` below and is the seam phase 1 extends.
#[tauri::command]
pub fn native_voice_build_info() -> String {
    let probe = livekit::webrtc::native::create_random_uuid();
    format!("livekit {} libwebrtc-ok {probe}", livekit::SDK_VERSION)
}

#[cfg(test)]
mod tests {
    use super::native_voice_build_info;

    /// Proves both that the SDK version is readable and that a libwebrtc symbol
    /// links and runs. If the prebuilt archive were missing or ABI-mismatched,
    /// this binary would not link at all.
    #[test]
    fn build_info_reports_sdk_and_libwebrtc() {
        let info = native_voice_build_info();
        assert!(info.contains("livekit 0.9.1"), "unexpected: {info}");
        assert!(info.contains("libwebrtc-ok"), "unexpected: {info}");
    }
}
