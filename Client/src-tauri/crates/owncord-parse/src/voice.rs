//! Checks on what the native voice backend is handed: the address the page
//! asks it to connect to, and the size of a received video frame.

use std::fmt;
use std::net::Ipv4Addr;

/// Why a voice address was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceUrlError {
    /// Not a URL at all.
    Unparsable,
    /// Not `ws:` (or `http:`, which the SDK turns into `ws:`).
    Scheme,
    /// Not `127.0.0.1` or `localhost`.
    Host,
    /// Names a user or password.
    Credentials,
}

impl fmt::Display for VoiceUrlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unparsable => "voice address is not a URL",
            Self::Scheme => "voice address must be ws:// on this machine",
            Self::Host => "voice address must be on 127.0.0.1 or localhost",
            Self::Credentials => "voice address must not carry credentials",
        })
    }
}

impl std::error::Error for VoiceUrlError {}

/// Accept only a voice address on this machine: the local tunnel the client
/// starts (`ws://127.0.0.1:<port>/<token>/livekit...`) or a local server's
/// loopback LiveKit address, the same set `isLoopbackDirectUrl` and the
/// tunnel give the page (`ws:` or `http:`, `127.0.0.1` or `localhost`).
pub fn validate_voice_url(url: &str) -> Result<(), VoiceUrlError> {
    let parsed = url::Url::parse(url).map_err(|_| VoiceUrlError::Unparsable)?;
    if !matches!(parsed.scheme(), "ws" | "http") {
        return Err(VoiceUrlError::Scheme);
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(VoiceUrlError::Credentials);
    }
    let loopback = match parsed.host() {
        Some(url::Host::Domain(name)) => name == "localhost",
        Some(url::Host::Ipv4(ip)) => ip == Ipv4Addr::LOCALHOST,
        _ => false,
    };
    if !loopback {
        return Err(VoiceUrlError::Host);
    }
    Ok(())
}

/// The longest side of a received video frame the client draws.
pub const REMOTE_FRAME_MAX_SIDE: u32 = 16_384;

/// The most pixels a received video frame may have: 8192x4320 (35.4 Mpx).
/// The app's largest sends are a "source" quality camera or screen share,
/// which keep the capture's own size; this is above 8K UHD (7680x4320) and a
/// triple-4K desktop (11520x2160).
pub const REMOTE_FRAME_MAX_PIXELS: u64 = 8_192 * 4_320;

/// Whether a received frame of `width` x `height` is drawn. A larger (or
/// empty) frame is dropped before it is converted and copied for the page.
pub fn remote_frame_fits(width: u32, height: u32) -> bool {
    width > 0
        && height > 0
        && width <= REMOTE_FRAME_MAX_SIDE
        && height <= REMOTE_FRAME_MAX_SIDE
        && u64::from(width) * u64::from(height) <= REMOTE_FRAME_MAX_PIXELS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_local_tunnel_and_loopback_addresses_are_accepted() {
        for url in [
            "ws://127.0.0.1:41234/0123abcd/livekit",
            "ws://127.0.0.1:41234/0123abcd/livekit/rtc?access_token=x",
            "ws://localhost:7880",
            "ws://LOCALHOST:7880/",
            "http://localhost:7880",
            "http://127.0.0.1:7880/",
        ] {
            assert_eq!(validate_voice_url(url), Ok(()), "{url}");
        }
    }

    #[test]
    fn any_other_address_is_refused_with_its_reason() {
        for (url, reason) in [
            ("/livekit", VoiceUrlError::Unparsable),
            ("", VoiceUrlError::Unparsable),
            ("wss://127.0.0.1:7880", VoiceUrlError::Scheme),
            ("https://localhost:7880", VoiceUrlError::Scheme),
            ("file:///etc/passwd", VoiceUrlError::Scheme),
            ("ws://192.168.1.10:7880/livekit", VoiceUrlError::Host),
            ("ws://10.0.0.1/", VoiceUrlError::Host),
            ("ws://127.0.0.2:7880", VoiceUrlError::Host),
            ("ws://[::1]:7880", VoiceUrlError::Host),
            ("ws://localhost.example.com:7880", VoiceUrlError::Host),
            ("ws://livekit:7880", VoiceUrlError::Host),
            ("ws://user:pw@127.0.0.1:7880", VoiceUrlError::Credentials),
            ("ws://user@localhost:7880", VoiceUrlError::Credentials),
        ] {
            assert_eq!(validate_voice_url(url), Err(reason), "{url}");
        }
    }

    #[test]
    fn frames_up_to_the_ceiling_are_drawn() {
        assert!(remote_frame_fits(1280, 720));
        assert!(remote_frame_fits(3840, 2160));
        assert!(remote_frame_fits(7680, 4320));
        assert!(remote_frame_fits(11_520, 2_160));
        assert!(remote_frame_fits(8_192, 4_320));
        assert!(remote_frame_fits(2, 2));
    }

    #[test]
    fn frames_past_the_ceiling_or_empty_are_dropped() {
        assert!(!remote_frame_fits(16_384, 16_384));
        assert!(!remote_frame_fits(8_192, 4_322));
        assert!(!remote_frame_fits(16_385, 2));
        assert!(!remote_frame_fits(2, 16_385));
        assert!(!remote_frame_fits(u32::MAX, u32::MAX));
        assert!(!remote_frame_fits(0, 720));
        assert!(!remote_frame_fits(1280, 0));
    }
}
