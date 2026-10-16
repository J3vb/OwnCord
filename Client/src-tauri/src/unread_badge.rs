//! The taskbar and tray unread badge (DP-27). The renderer computes the count
//! (`src/features/unread-badge/unreadBadge.ts`) and pushes it when it changes,
//! and again when the window is shown or focused (Windows drops the overlay
//! when the taskbar button is recreated); this draws it:
//!
//! - Windows: a taskbar overlay icon, the count up to 9 and "9+" above;
//! - Linux: two paths at once. The launcher count, as a Unity `LauncherEntry`
//!   D-Bus signal sent straight to the session bus, which KDE Plasma and
//!   Ubuntu's dock read; and the tray icon swapped for a red-dot variant with
//!   the count as the tray title, which is all stock GNOME (with its
//!   AppIndicator extension) can show;
//! - macOS: the dock count;
//! - The tray tooltip, text from `text.rs`; libappindicator has none, so on
//!   Linux the dot and title carry the count.
//!
//! It never touches the tray's menu or its status items.

#[cfg(any(windows, target_os = "macos"))]
use tauri::Manager;
use tauri::Runtime;

use crate::{text, tray};

/// What the overlay shows for `count`: nothing at 0, the digit up to 9, "9+"
/// above.
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn badge_label(count: u32) -> Option<String> {
    match count {
        0 => None,
        1..=9 => Some(count.to_string()),
        _ => Some("9+".to_string()),
    }
}

/// What the Linux badge shows for `count`: the launcher count and the tray's
/// red dot and title. Both paths always apply, as no one desktop is known to
/// read only one; the plan is a function so that stays checkable.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
struct LinuxBadgePlan {
    launcher_count: u32,
    tray_dot: bool,
    tray_title: Option<String>,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linux_badge_plan(count: u32) -> LinuxBadgePlan {
    LinuxBadgePlan {
        launcher_count: count,
        tray_dot: count > 0,
        tray_title: badge_label(count),
    }
}

/// The `.desktop` ids the launcher count is sent to. The installed packages
/// ship `<product name>.desktop`. An AppImage is not installed: once an
/// integrator (AppImageLauncher, appimaged) adds its launcher entry, it is
/// named `appimagekit_<md5 of the AppImage's file URI>-<product name>`, with
/// the URI taken as `file://` plus the `$APPIMAGE` path (from memory of the
/// AppImage desktop-integration naming; unverified on a real integrator).
/// `appimage` is that variable's value; only an absolute path counts.
#[cfg(target_os = "linux")]
fn launcher_desktop_ids(product_name: &str, appimage: Option<&str>) -> Vec<String> {
    use md5::{Digest, Md5};

    let mut ids = vec![product_name.to_string()];
    if let Some(path) = appimage.filter(|p| p.starts_with('/')) {
        let digest = Md5::digest(format!("file://{path}").as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        ids.push(format!("appimagekit_{hex}-{product_name}"));
    }
    ids
}

/// Tray dot radius as a share of the icon's shorter edge.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const DOT_RADIUS: f32 = 0.24;

/// `rgba` (`width` x `height`) with a red dot in the top-right corner, edges
/// blended over what was there. Drawn here for the same reason as the
/// overlay: no second image to ship or decode.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn with_red_dot(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut px = rgba.to_vec();
    if px.len() != (width * height * 4) as usize {
        return px;
    }
    let r = width.min(height) as f32 * DOT_RADIUS;
    let (cx, cy) = (width as f32 - r, r);
    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let cover = (r - (dx * dx + dy * dy).sqrt() + 0.5).clamp(0.0, 1.0);
            if cover == 0.0 {
                continue;
            }
            let i = ((y * width + x) * 4) as usize;
            let under = f32::from(px[i + 3]) / 255.0;
            let out = cover + under * (1.0 - cover);
            for (k, red) in OVERLAY_RED.into_iter().enumerate() {
                let c = f32::from(red) * cover + f32::from(px[i + k]) * under * (1.0 - cover);
                px[i + k] = (c / out) as u8;
            }
            px[i + 3] = (out * 255.0) as u8;
        }
    }
    px
}

/// Overlay icon edge, px. Windows scales it to the small-icon size.
#[cfg_attr(not(windows), allow(dead_code))]
const OVERLAY_SIZE: u32 = 32;

/// `--danger-fill` (`src/styles/tokens.css`), the app's mention badge red.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
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

/// The Unity `LauncherEntry.Update` signal that sets the launcher count of
/// `<desktop_name>.desktop`; a count of 0 hides it.
#[cfg(target_os = "linux")]
fn launcher_entry_update(desktop_name: &str, count: u32) -> dbus::Message {
    use dbus::arg::{PropMap, RefArg, Variant};

    let mut props = PropMap::new();
    props.insert(
        "count".into(),
        Variant(Box::new(i64::from(count)) as Box<dyn RefArg>),
    );
    props.insert(
        "count-visible".into(),
        Variant(Box::new(count > 0) as Box<dyn RefArg>),
    );
    dbus::Message::new_signal("/", "com.canonical.Unity.LauncherEntry", "Update")
        .expect("static signal names are valid")
        .append2(format!("application://{desktop_name}.desktop"), props)
}

/// Send the launcher count over the session bus, once per desktop id. The connection is kept for
/// the app's lifetime: the docks drop an entry once its sender leaves the bus.
#[cfg(target_os = "linux")]
fn send_launcher_count(desktop_names: &[String], count: u32) {
    use dbus::blocking::Connection;
    use std::sync::Mutex;

    static SESSION: Mutex<Option<Connection>> = Mutex::new(None);
    let mut session = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    if session.is_none() {
        match Connection::new_session() {
            Ok(conn) => *session = Some(conn),
            Err(e) => {
                log::debug!("[badge] no session bus for the launcher count: {e}");
                return;
            }
        }
    }
    let Some(conn) = session.as_ref() else { return };
    for desktop_name in desktop_names {
        if conn
            .channel()
            .send(launcher_entry_update(desktop_name, count))
            .is_err()
        {
            log::debug!("[badge] cannot send the launcher count");
            *session = None;
            return;
        }
    }
    conn.channel().flush();
}

/// Show `count` on the taskbar button and in the tray tooltip; 0 clears both.
/// A platform that cannot draw one part is logged and the rest still applies.
#[tauri::command]
pub fn set_unread_badge<R: Runtime>(app: tauri::AppHandle<R>, count: u32) {
    #[cfg(any(windows, target_os = "macos"))]
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(windows)]
        let shown = window.set_overlay_icon(badge_label(count).map(|label| {
            tauri::image::Image::new_owned(render_overlay(&label), OVERLAY_SIZE, OVERLAY_SIZE)
        }));
        #[cfg(target_os = "macos")]
        let shown = window.set_badge_count(badge_label(count).map(|_| i64::from(count)));
        if let Err(e) = shown {
            log::warn!("[badge] cannot set the taskbar badge: {e}");
        }
    }
    #[cfg(target_os = "linux")]
    let plan = linux_badge_plan(count);
    #[cfg(target_os = "linux")]
    send_launcher_count(
        &launcher_desktop_ids(
            &app.package_info().name,
            std::env::var("APPIMAGE").ok().as_deref(),
        ),
        plan.launcher_count,
    );
    if let Some(tray) = app.tray_by_id(tray::TRAY_ID) {
        #[cfg(target_os = "linux")]
        set_linux_tray(&app, &tray, &plan);
        if let Err(e) = tray.set_tooltip(Some(text::tray_tooltip(count))) {
            log::warn!("[badge] cannot set the tray tooltip: {e}");
        }
    }
}

/// Swap the tray icon for the red-dot variant (or back) and set its title.
#[cfg(target_os = "linux")]
fn set_linux_tray<R: Runtime>(
    app: &tauri::AppHandle<R>,
    tray: &tauri::tray::TrayIcon<R>,
    plan: &LinuxBadgePlan,
) {
    static DOT_SHOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let changed =
        DOT_SHOWN.swap(plan.tray_dot, std::sync::atomic::Ordering::Relaxed) != plan.tray_dot;
    if let Some(base) = app.default_window_icon().filter(|_| changed) {
        let icon = if plan.tray_dot {
            tauri::image::Image::new_owned(
                with_red_dot(base.rgba(), base.width(), base.height()),
                base.width(),
                base.height(),
            )
        } else {
            base.clone()
        };
        if let Err(e) = tray.set_icon(Some(icon)) {
            log::warn!("[badge] cannot set the tray icon: {e}");
        }
    }
    if let Err(e) = tray.set_title(plan.tray_title.as_deref()) {
        log::warn!("[badge] cannot set the tray title: {e}");
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

    #[cfg(target_os = "linux")]
    #[test]
    fn launcher_entry_update_sets_the_count_and_hides_it_at_zero() {
        use dbus::arg::{prop_cast, PropMap};

        for (count, visible) in [(0, false), (5, true), (12, true)] {
            let msg = launcher_entry_update("OwnCord", count);
            assert_eq!(msg.path().as_deref(), Some("/"));
            assert_eq!(
                msg.interface().as_deref(),
                Some("com.canonical.Unity.LauncherEntry")
            );
            assert_eq!(msg.member().as_deref(), Some("Update"));
            let (uri, props): (String, PropMap) = msg.read2().unwrap();
            assert_eq!(uri, "application://OwnCord.desktop");
            assert_eq!(prop_cast::<i64>(&props, "count"), Some(&i64::from(count)));
            assert_eq!(prop_cast::<bool>(&props, "count-visible"), Some(&visible));
        }
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

    #[test]
    fn linux_plan_uses_both_paths_and_clears_both_at_zero() {
        assert_eq!(
            linux_badge_plan(0),
            LinuxBadgePlan {
                launcher_count: 0,
                tray_dot: false,
                tray_title: None
            }
        );
        assert_eq!(
            linux_badge_plan(12),
            LinuxBadgePlan {
                launcher_count: 12,
                tray_dot: true,
                tray_title: Some("9+".to_string())
            }
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn desktop_ids_add_the_appimage_integration_id_only_for_an_absolute_path() {
        assert_eq!(launcher_desktop_ids("OwnCord", None), ["OwnCord"]);
        assert_eq!(launcher_desktop_ids("OwnCord", Some("")), ["OwnCord"]);
        assert_eq!(
            launcher_desktop_ids("OwnCord", Some("Apps/OwnCord.AppImage")),
            ["OwnCord"]
        );
        // printf %s 'file:///home/u/Apps/OwnCord.AppImage' | md5sum
        assert_eq!(
            launcher_desktop_ids("OwnCord", Some("/home/u/Apps/OwnCord.AppImage")),
            [
                "OwnCord",
                "appimagekit_ccf4709ec530cf6c5277db1389fb46f9-OwnCord"
            ]
        );
    }

    #[test]
    fn red_dot_marks_only_the_top_right_corner() {
        let (w, h) = (32u32, 32u32);
        let base = vec![10u8; (w * h * 4) as usize];
        let out = with_red_dot(&base, w, h);
        let at = |x: u32, y: u32| {
            let i = ((y * w + x) * 4) as usize;
            [out[i], out[i + 1], out[i + 2], out[i + 3]]
        };
        assert_eq!(
            at(27, 4),
            [0xd0, 0x30, 0x2f, 255],
            "dot centre is badge red"
        );
        assert_eq!(at(2, 28), [10, 10, 10, 10], "far corner is untouched");
    }

    #[test]
    fn red_dot_leaves_a_malformed_buffer_alone() {
        assert_eq!(with_red_dot(&[1, 2, 3], 32, 32), vec![1, 2, 3]);
    }
}
