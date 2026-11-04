//! The OS regional format, for date order and the default clock.
//!
//! The webview reports the display language (`navigator.language`), which on
//! Windows is the UI language, not the region the user picked for dates and
//! times: English Windows with a Belgian region still says `en-US`. This
//! answers the region's locale tag so the frontend can follow it.
//!
//! - Windows: `GetUserDefaultLocaleName`, the user's regional format.
//! - Linux: `LC_ALL`, then `LC_TIME`, then `LANG` (POSIX `nl_BE.UTF-8` becomes
//!   `nl-BE`); `C` and `POSIX` say nothing.
//! - Anything else: `None`, and the frontend keeps `navigator.language`.

/// The regional format as a BCP 47 tag ("nl-BE"), or `None` when the OS
/// cannot say. Read-only, argument-free and cheap; read once at startup.
#[tauri::command]
pub fn system_region_locale() -> Option<String> {
    platform_region_locale()
}

#[cfg(windows)]
fn platform_region_locale() -> Option<String> {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;

    const LOCALE_NAME_MAX_LENGTH: usize = 85;
    let mut buf = [0u16; LOCALE_NAME_MAX_LENGTH];
    // SAFETY: `buf` is a live, writable buffer of the length passed.
    let written = unsafe { GetUserDefaultLocaleName(buf.as_mut_ptr(), buf.len() as i32) };
    // The count includes the terminating NUL; 0 is failure.
    let len = usize::try_from(written).ok()?.checked_sub(1)?;
    normalize_tag(&String::from_utf16_lossy(&buf[..len]))
}

#[cfg(target_os = "linux")]
fn platform_region_locale() -> Option<String> {
    ["LC_ALL", "LC_TIME", "LANG"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .find(|value| !value.is_empty())
        .and_then(|value| normalize_tag(&value))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn platform_region_locale() -> Option<String> {
    None
}

/// A POSIX or Windows locale name as a BCP 47 tag: the encoding and modifier
/// dropped (`nl_BE.UTF-8@euro` is `nl-BE`), underscores as hyphens. `C`,
/// `POSIX` and anything that is not letters, digits and hyphens is `None`.
#[cfg_attr(not(any(windows, target_os = "linux", test)), allow(dead_code))]
fn normalize_tag(raw: &str) -> Option<String> {
    let base = raw.split(['.', '@']).next()?.trim();
    if base.is_empty() || base == "C" || base == "POSIX" {
        return None;
    }
    let tag = base.replace('_', "-");
    let valid = tag.split('-').all(|part| {
        !part.is_empty() && part.len() <= 8 && part.chars().all(|c| c.is_ascii_alphanumeric())
    });
    valid.then_some(tag)
}

#[cfg(test)]
mod tests {
    use super::normalize_tag;

    #[test]
    fn posix_names_become_bcp47_tags() {
        assert_eq!(normalize_tag("nl_BE.UTF-8").as_deref(), Some("nl-BE"));
        assert_eq!(normalize_tag("de_DE.UTF-8@euro").as_deref(), Some("de-DE"));
        assert_eq!(normalize_tag("en-GB").as_deref(), Some("en-GB"));
        assert_eq!(normalize_tag("sr-Latn-RS").as_deref(), Some("sr-Latn-RS"));
    }

    #[test]
    fn neutral_and_malformed_names_say_nothing() {
        assert_eq!(normalize_tag("C"), None);
        assert_eq!(normalize_tag("POSIX.UTF-8"), None);
        assert_eq!(normalize_tag(""), None);
        assert_eq!(normalize_tag("en__US"), None);
        assert_eq!(normalize_tag("en US"), None);
    }
}
