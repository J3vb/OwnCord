//! Keeps the Linux login entry pointing at this app. `tauri-plugin-autostart`
//! writes `~/.config/autostart/<name>.desktop` with the path unquoted and
//! never rewrites it: an AppImage renamed, moved or replaced by a manual
//! update left an entry that started nothing at login while Settings still
//! showed it on, and a path with a space never worked. When the webview
//! turns the entry on, its `Exec=` is rewritten with the path quoted when it
//! has to be; at each start, an entry whose program is gone is pointed at
//! this app. An entry that still starts something (a user's own edit,
//! another install) is left as it is, an entry is never created here, and
//! its other lines (a desktop's own "disabled" key) are kept. A symlinked
//! entry belongs to a dotfile manager and is not touched.
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Runtime};

/// At start-up: point an existing login entry whose program is gone at this
/// app; logs what it did.
#[cfg(target_os = "linux")]
pub fn repair<R: Runtime>(app: &AppHandle<R>) {
    match repair_linux(app, When::ProgramGone) {
        Ok(true) => log::info!("[autostart] login entry now points at this app"),
        Ok(false) => {}
        Err(e) => log::warn!("[autostart] login entry not updated: {e}"),
    }
}

/// The webview just turned launch on login on: the plugin wrote the entry
/// with the path unquoted. No-op off Linux.
#[tauri::command]
pub fn autostart_fix_entry<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        repair_linux(&app, When::Always).map(|_| ())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Ok(())
    }
}

/// When an existing entry's `Exec=` line is rewritten.
#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
enum When {
    /// Whenever it differs: the plugin has just written it.
    Always,
    /// Only when the program it starts is an absolute path to no file.
    ProgramGone,
}

#[cfg(target_os = "linux")]
fn repair_linux<R: Runtime>(app: &AppHandle<R>, when: When) -> Result<bool, String> {
    use tauri::Manager;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    // Where and how the plugin writes it: named after the app, the AppImage
    // file when we run from one, else this executable.
    let entry = entry_path(&home, &app.package_info().name);
    let exe = match app.env().appimage {
        Some(appimage) => PathBuf::from(appimage),
        None => std::env::current_exe().map_err(|e| e.to_string())?,
    };
    let Some(exe) = exe.to_str() else {
        return Err("the app's path is not UTF-8".into());
    };
    if exe.chars().any(char::is_control) {
        return Err("the app's path has a control character".into());
    }
    let exec = exec_line(exe, &[crate::window_prefs::MINIMIZED_ARG]);
    repair_file(&entry, &exec, |current| match when {
        When::Always => true,
        When::ProgramGone => program_gone(current, |p| Path::new(p).is_file()),
    })
    .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn entry_path(home: &Path, name: &str) -> PathBuf {
    home.join(".config")
        .join("autostart")
        .join(format!("{name}.desktop"))
}

/// Rewrite the entry at `path` with `exec` when it exists, is a regular
/// file, has another `Exec=` line and `rewrite` agrees on its value. Whether
/// it was rewritten.
#[cfg(target_os = "linux")]
fn repair_file(path: &Path, exec: &str, rewrite: impl Fn(&str) -> bool) -> std::io::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => return Ok(false),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    }
    let text = std::fs::read_to_string(path)?;
    match repaired(&text, exec, rewrite) {
        Some(fixed) => crate::json_store::write_atomic(path, fixed.as_bytes()).map(|()| true),
        None => Ok(false),
    }
}

/// The `Exec=` line for `exe` and `args`, as the plugin writes it, with the
/// path quoted per the Desktop Entry spec when it needs to be.
#[cfg(target_os = "linux")]
fn exec_line(exe: &str, args: &[&str]) -> String {
    format!("Exec={} {}", exec_arg(exe), args.join(" "))
}

/// One `Exec` argument: as is when plain, otherwise double-quoted with `"`,
/// `` ` ``, `$` and `\` escaped (a backslash doubled once more for the key's
/// own string escaping). A `%` is doubled either way, or it reads as a field
/// code.
#[cfg(target_os = "linux")]
fn exec_arg(arg: &str) -> String {
    const RESERVED: &[char] = &[
        ' ', '\t', '\n', '"', '\'', '\\', '>', '<', '~', '|', '&', ';', '$', '*', '?', '#', '(',
        ')', '`',
    ];
    let arg = arg.replace('%', "%%");
    if !arg.contains(RESERVED) {
        return arg;
    }
    let mut quoted = String::from("\"");
    for c in arg.chars() {
        match c {
            '\\' => quoted.push_str("\\\\\\\\"),
            '"' | '`' | '$' => {
                quoted.push_str("\\\\");
                quoted.push(c);
            }
            _ => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

/// `entry` with the `[Desktop Entry]` group's `Exec=` line replaced by
/// `exec`, or `None` when it already is that line, there is none, or
/// `rewrite` turns down its current value.
#[cfg(target_os = "linux")]
fn repaired(entry: &str, exec: &str, rewrite: impl Fn(&str) -> bool) -> Option<String> {
    let mut in_main = false;
    let mut found = false;
    let mut changed = false;
    let lines: Vec<&str> = entry
        .split('\n')
        .map(|line| {
            let key = line.trim_start();
            if key.starts_with('[') {
                in_main = key.trim_end() == "[Desktop Entry]";
            } else if in_main && !found && key.starts_with("Exec=") {
                found = true;
                let current = key.trim_end().trim_start_matches("Exec=");
                if line.trim_end() != exec && rewrite(current) {
                    changed = true;
                    return exec;
                }
            }
            line
        })
        .collect();
    changed.then(|| lines.join("\n"))
}

/// Whether the `Exec` value starts an absolute path that `is_file` says is
/// not there, or cannot be read at all. A plain command name (`env`, a
/// program on `PATH`) counts as there.
#[cfg(target_os = "linux")]
fn program_gone(exec: &str, is_file: impl Fn(&str) -> bool) -> bool {
    match program(exec) {
        Some(program) => program.starts_with('/') && !is_file(&program),
        None => true,
    }
}

/// The first argument of an `Exec` value, with the key's string escapes and
/// the argument's quoting undone; `None` when its quote is never closed.
#[cfg(target_os = "linux")]
fn program(exec: &str) -> Option<String> {
    let value = unescape(exec.trim_start_matches([' ', '\t']));
    let mut chars = value.chars();
    let mut out = String::new();
    if value.starts_with('"') {
        chars.next();
        loop {
            match chars.next()? {
                '"' => break,
                '\\' => out.push(chars.next()?),
                c => out.push(c),
            }
        }
    } else {
        out.extend(chars.take_while(|c| *c != ' ' && *c != '\t'));
    }
    Some(out.replace("%%", "%"))
}

/// A desktop entry string value with `\s`, `\n`, `\t`, `\r` and `\\`
/// undone.
#[cfg(target_os = "linux")]
fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    /// What the plugin writes (auto-launch's `build_xdg_autostart_data`).
    fn plugin_entry(exe: &str) -> String {
        format!(
            "[Desktop Entry]\nType=Application\nVersion=1.0\nName=OwnCord\nComment=OwnCord startup script\nExec={exe} --minimized\nStartupNotify=false\nTerminal=false"
        )
    }

    #[test]
    fn a_plain_path_is_written_as_the_plugin_writes_it() {
        assert_eq!(
            exec_line("/opt/OwnCord.AppImage", &["--minimized"]),
            "Exec=/opt/OwnCord.AppImage --minimized"
        );
        assert_eq!(
            repaired(
                &plugin_entry("/opt/OwnCord.AppImage"),
                &exec_line("/opt/OwnCord.AppImage", &["--minimized"]),
                |_| true
            ),
            None,
            "an entry that already points here is left alone"
        );
    }

    #[test]
    fn paths_that_need_it_are_quoted_and_escaped() {
        assert_eq!(
            exec_arg("/home/u/My Apps/OwnCord.AppImage"),
            "\"/home/u/My Apps/OwnCord.AppImage\""
        );
        assert_eq!(exec_arg("/a/b$c"), "\"/a/b\\\\$c\"");
        assert_eq!(exec_arg("/a/b\\c"), "\"/a/b\\\\\\\\c\"");
        assert_eq!(exec_arg("/a/100%.AppImage"), "/a/100%%.AppImage");
    }

    #[test]
    fn only_the_main_group_exec_line_changes() {
        let entry = format!(
            "{}\nX-GNOME-Autostart-enabled=false\n[Desktop Action other]\nExec=/somewhere/else\n",
            plugin_entry("/home/u/Downloads/OwnCord_2.9.0.AppImage")
        );
        let exec = exec_line("/home/u/Apps/OwnCord.AppImage", &["--minimized"]);
        let fixed = repaired(&entry, &exec, |_| true).unwrap();
        assert!(fixed.contains("\nExec=/home/u/Apps/OwnCord.AppImage --minimized\n"));
        assert!(fixed.contains("X-GNOME-Autostart-enabled=false"));
        assert!(fixed.contains("Exec=/somewhere/else"));
        assert!(!fixed.contains("2.9.0"));
        assert_eq!(repaired("[Desktop Entry]\nName=x\n", &exec, |_| true), None);
    }

    #[test]
    fn the_program_is_read_back_as_written() {
        for path in [
            "/opt/OwnCord.AppImage",
            "/home/u/My Apps/OwnCord.AppImage",
            "/a/b$c `d` \"e\"",
            "/a/b\\c",
            "/a/100%.AppImage",
        ] {
            let line = exec_line(path, &["--minimized"]);
            let value = line.strip_prefix("Exec=").unwrap();
            assert_eq!(program(value).as_deref(), Some(path), "{line}");
        }
        assert_eq!(program("env A=1 /opt/x").as_deref(), Some("env"));
        assert_eq!(program("\"/never closed").as_deref(), None);
    }

    /// At start-up an entry is rewritten only when its program is gone: a
    /// moved AppImage, or a spaced path the plugin wrote unquoted.
    #[test]
    fn at_start_only_an_entry_whose_program_is_gone_is_rewritten() {
        let present = ["/opt/OwnCord.AppImage", "/home/u/My Apps/OwnCord.AppImage"];
        let gone = |value: &str| program_gone(value, |p| present.contains(&p));
        assert!(!gone("/opt/OwnCord.AppImage --minimized"));
        assert!(!gone("\"/home/u/My Apps/OwnCord.AppImage\" --minimized"));
        assert!(gone("/home/u/Downloads/OwnCord_2.9.0.AppImage --minimized"));
        assert!(gone("/home/u/My Apps/OwnCord.AppImage --minimized"));
        assert!(gone("\"/never closed"));
        assert!(!gone(
            "env WEBKIT_DISABLE_DMABUF_RENDERER=1 /gone --minimized"
        ));
        assert!(!gone("owncord --minimized"));

        let exec = exec_line("/opt/OwnCord.AppImage", &["--minimized"]);
        let edited = plugin_entry("env A=1 /home/u/old.AppImage");
        assert_eq!(repaired(&edited, &exec, gone), None, "a user's own edit");
        let moved = plugin_entry("/home/u/Downloads/OwnCord_2.9.0.AppImage");
        assert!(repaired(&moved, &exec, gone).is_some());
    }

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    /// A stale entry is rewritten; with launch on login off there is no
    /// entry, and none is created.
    #[test]
    fn an_existing_entry_is_repaired_and_a_missing_one_left_missing() {
        let dir =
            Dir(std::env::temp_dir().join(format!("owncord-autostart-{}", std::process::id())));
        let path = entry_path(&dir.0, "OwnCord");
        let exec = exec_line("/home/u/My Apps/OwnCord.AppImage", &["--minimized"]);
        assert!(!repair_file(&path, &exec, |_| true).unwrap());
        assert!(!path.exists());

        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        crate::json_store::write_atomic(
            &path,
            plugin_entry("/home/u/My Apps/OwnCord.AppImage").as_bytes(),
        )
        .unwrap();
        assert!(repair_file(&path, &exec, |_| true).unwrap());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("Exec=\"/home/u/My Apps/OwnCord.AppImage\" --minimized"));
        assert!(
            !repair_file(&path, &exec, |_| true).unwrap(),
            "already current"
        );
    }

    /// A dotfile manager's symlinked entry is never replaced by a file.
    #[test]
    fn a_symlinked_entry_is_left_alone() {
        let dir = Dir(
            std::env::temp_dir().join(format!("owncord-autostart-link-{}", std::process::id()))
        );
        let path = entry_path(&dir.0, "OwnCord");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let target = dir.0.join("managed.desktop");
        let stale = plugin_entry("/home/u/Downloads/OwnCord_2.9.0.AppImage");
        crate::json_store::write_atomic(&target, stale.as_bytes()).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        let exec = exec_line("/opt/OwnCord.AppImage", &["--minimized"]);
        assert!(!repair_file(&path, &exec, |_| true).unwrap());
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), stale);
    }
}
