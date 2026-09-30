//! The taskbar and tray unread badge (DP-27). The renderer computes the count
//! (`src/features/unread-badge/unreadBadge.ts`) and pushes it only when it
//! changes; this draws it:
//!
//! - Windows: a taskbar overlay icon, the count up to 9 and "9+" above;
//! - Linux and macOS: the launcher/dock count (Linux through the Unity
//!   `LauncherEntry` D-Bus API, so KDE and Ubuntu's dock show it, stock GNOME
//!   does not);
//! - every platform: the tray tooltip, text from `text.rs`.
//!
//! It never touches the tray's menu or its status items.

use tauri::{Manager, Runtime};

use crate::{text, tray};

/// What the overlay shows for `count`: nothing at 0, the digit up to 9, "9+"
/// above.
fn badge_label(count: u32) -> Option<String> {
    match count {
        0 => None,
        1..=9 => Some(count.to_string()),
        _ => Some("9+".to_string()),
    }
}

/// Overlay icon edge, px. Windows scales it to the small-icon size.
#[cfg_attr(not(windows), allow(dead_code))]
const OVERLAY_SIZE: u32 = 32;

/// `--danger-fill` (`src/styles/tokens.css`), the app's mention badge red.
#[cfg_attr(not(windows), allow(dead_code))]
const OVERLAY_RED: [u8; 3] = [0xd0, 0x30, 0x2f];

/// A 3x5 pixel glyph, one row per entry, bit 2 the leftmost column.
#[cfg_attr(not(windows), allow(dead_code))]
fn glyph(c: char) -> [u8; 5] {
    match c {
        '0' => [7, 5, 5, 5, 7],
        '1' => [2, 6, 2, 2, 7],
        '2' => [7, 1, 7, 4, 7],
        '3' => [7, 1, 7, 1, 7],
        '4' => [5, 5, 7, 1, 1],
        '5' => [7, 4, 7, 1, 7],
        '6' => [7, 4, 7, 5, 7],
        '7' => [7, 1, 1, 1, 1],
        '8' => [7, 5, 7, 5, 7],
        '9' => [7, 5, 7, 1, 7],
        '+' => [0, 2, 7, 2, 0],
        _ => [0; 5],
    }
}

/// RGBA pixels for the overlay: a red disc with `label` in white. Drawn here
/// rather than shipped as ten PNGs, which would also need tauri's image
/// decoder feature.
#[cfg_attr(not(windows), allow(dead_code))]
fn render_overlay(label: &str) -> Vec<u8> {
    let size = OVERLAY_SIZE;
    let mut px = vec![0u8; (size * size * 4) as usize];
    let centre = size as f32 / 2.0;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 + 0.5 - centre;
            let dy = y as f32 + 0.5 - centre;
            // One pixel of edge coverage keeps the disc from looking jagged.
            let alpha = (centre - (dx * dx + dy * dy).sqrt()).clamp(0.0, 1.0);
            let i = ((y * size + x) * 4) as usize;
            let [r, g, b] = OVERLAY_RED;
            px[i..i + 4].copy_from_slice(&[r, g, b, (alpha * 255.0) as u8]);
        }
    }
    let chars = label.chars().count() as u32;
    let scale = if chars > 1 { 3 } else { 4 };
    let width = (chars * 4 - 1) * scale;
    let (left, top) = ((size - width) / 2, (size - 5 * scale) / 2);
    for (k, c) in label.chars().enumerate() {
        for (row, bits) in glyph(c).into_iter().enumerate() {
            for col in 0..3u32 {
                if (bits >> (2 - col)) & 1 == 0 {
                    continue;
                }
                let x0 = left + (k as u32 * 4 + col) * scale;
                let y0 = top + row as u32 * scale;
                for y in y0..y0 + scale {
                    for x in x0..x0 + scale {
                        let i = ((y * size + x) * 4) as usize;
                        px[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
                    }
                }
            }
        }
    }
    px
}

/// Show `count` on the taskbar button and in the tray tooltip; 0 clears both.
/// A platform that cannot draw one part is logged and the rest still applies.
#[tauri::command]
pub fn set_unread_badge<R: Runtime>(app: tauri::AppHandle<R>, count: u32) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(windows)]
        let shown = window.set_overlay_icon(badge_label(count).map(|label| {
            tauri::image::Image::new_owned(render_overlay(&label), OVERLAY_SIZE, OVERLAY_SIZE)
        }));
        #[cfg(not(windows))]
        let shown = window.set_badge_count(badge_label(count).map(|_| i64::from(count)));
        if let Err(e) = shown {
            log::warn!("[badge] cannot set the taskbar badge: {e}");
        }
    }
    if let Some(tray) = app.tray_by_id(tray::TRAY_ID) {
        if let Err(e) = tray.set_tooltip(Some(text::tray_tooltip(count))) {
            log::warn!("[badge] cannot set the tray tooltip: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn badge_label_is_cleared_at_zero_and_capped_at_nine_plus() {
        assert_eq!(badge_label(0), None);
        assert_eq!(badge_label(5), Some("5".to_string()));
        assert_eq!(badge_label(12), Some("9+".to_string()));
    }

    #[test]
    fn overlay_is_a_red_disc_with_a_white_label() {
        let px = render_overlay("9+");
        let at = |x: u32, y: u32| {
            let i = ((y * OVERLAY_SIZE + x) * 4) as usize;
            [px[i], px[i + 1], px[i + 2], px[i + 3]]
        };
        assert_eq!(px.len(), (OVERLAY_SIZE * OVERLAY_SIZE * 4) as usize);
        assert_eq!(at(0, 0)[3], 0, "the corner is outside the disc");
        assert_eq!(at(16, 2), [0xd0, 0x30, 0x2f, 255], "the disc is badge red");
        // "9+" at scale 3 starts at x=5, y=8: the 9's top-left pixel is set.
        assert_eq!(at(5, 8), [255, 255, 255, 255]);
    }
}
