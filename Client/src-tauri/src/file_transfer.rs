//! Files dragged in or copied from a Linux file manager.
//!
//! WebKitGTK hands the page only the file manager's `text/uri-list`, never
//! `File` objects, so a drop or a Ctrl+V of copied files attached nothing.
//! On Linux the main window runs with the native drop handler on, and the
//! host reads the files itself: a drop or a clipboard read stages the regular
//! files it names, the page gets their names and sizes, and reads each one
//! once by its token. The page can never name a path of its own.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, State};

use crate::sync::lock;

/// The event the page listens on for drags from the file manager.
pub const DRAG_EVENT: &str = "native-file-drag";

/// No file this large is read into memory; the page's own upload limit is
/// far below it.
const MAX_READ_BYTES: u64 = 1024 * 1024 * 1024;

/// How long a clipboard read may take before the paste falls back to text.
const CLIPBOARD_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedFile {
    pub token: u64,
    pub name: String,
    pub size: u64,
}

#[derive(Default)]
struct Staged {
    next: u64,
    files: HashMap<u64, PathBuf>,
}

/// The files of the latest drop or paste, each readable once.
#[derive(Default)]
pub struct StagedFiles {
    inner: Mutex<Staged>,
}

impl StagedFiles {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace what is staged with the regular files among `paths`.
    /// Folders, missing files and anything that is not a plain file are left out.
    pub fn stage(&self, paths: impl IntoIterator<Item = PathBuf>) -> Vec<StagedFile> {
        let mut staged = lock(&self.inner);
        staged.files.clear();
        let mut out = Vec::new();
        for path in paths {
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            staged.next += 1;
            let token = staged.next;
            staged.files.insert(token, path);
            out.push(StagedFile {
                token,
                name,
                size: meta.len(),
            });
        }
        out
    }

    /// The path behind `token`, removed so it can be read only once.
    pub fn take(&self, token: u64) -> Option<PathBuf> {
        let mut staged = lock(&self.inner);
        staged.files.remove(&token)
    }
}

/// Local paths in a `text/uri-list` or `x-special/gnome-copied-files` body.
/// Comment lines, the gnome "copy"/"cut" verb and non-file URIs are skipped.
pub fn paths_from_uri_list(text: &str) -> Vec<PathBuf> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(path_from_uri)
        .collect()
}

fn path_from_uri(uri: &str) -> Option<PathBuf> {
    let url = url::Url::parse(uri).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    // A file URI on another host is not a local file.
    match url.host_str() {
        None | Some("") | Some("localhost") => {}
        Some(_) => return None,
    }
    url.to_file_path().ok()
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum DragPayload {
    Over {
        x: f64,
        y: f64,
    },
    Drop {
        x: f64,
        y: f64,
        files: Vec<StagedFile>,
    },
    Leave,
}

/// Forward the main window's native drag events to the page, staging the
/// files of a drop.
pub fn on_drag_drop(app: &AppHandle, event: &DragDropEvent) {
    let payload = match event {
        DragDropEvent::Enter { position, .. } | DragDropEvent::Over { position } => {
            DragPayload::Over {
                x: position.x,
                y: position.y,
            }
        }
        DragDropEvent::Drop { paths, position } => {
            let files = app.state::<StagedFiles>().stage(paths.iter().cloned());
            DragPayload::Drop {
                x: position.x,
                y: position.y,
                files,
            }
        }
        DragDropEvent::Leave => DragPayload::Leave,
        _ => return,
    };
    if let Err(err) = app.emit_to("main", DRAG_EVENT, payload) {
        log::warn!("file_transfer: drag event not delivered: {err}");
    }
}

fn read_capped(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("cannot read file: {e}"))?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_READ_BYTES {
        return Err("file too large".into());
    }
    std::fs::read(path).map_err(|e| format!("cannot read file: {e}"))
}

/// The bytes of a staged file. Each token reads once.
#[tauri::command]
pub async fn read_staged_file(
    token: u64,
    state: State<'_, StagedFiles>,
) -> Result<tauri::ipc::Response, String> {
    let path = state
        .take(token)
        .ok_or_else(|| "file is no longer available".to_string())?;
    let bytes = tauri::async_runtime::spawn_blocking(move || read_capped(&path))
        .await
        .map_err(|e| format!("read task failed: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The files on the clipboard, copied from a file manager. Empty when the
/// clipboard holds no files, so the paste stays text.
#[tauri::command]
pub async fn clipboard_files(
    app: AppHandle,
    state: State<'_, StagedFiles>,
) -> Result<Vec<StagedFile>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    app.run_on_main_thread(move || request_clipboard_uris(tx))
        .map_err(|e| format!("clipboard unavailable: {e}"))?;
    let body = match tokio::time::timeout(CLIPBOARD_TIMEOUT, rx).await {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => String::new(),
        Err(_) => {
            log::warn!("file_transfer: clipboard read timed out");
            String::new()
        }
    };
    Ok(state.stage(paths_from_uri_list(&body)))
}

/// Ask GTK for the clipboard's file list: `text/uri-list` first, then the
/// gnome copied-files target some file managers offer alone. Runs on the GTK
/// main thread; the answer goes to `tx` as a uri-list body.
fn request_clipboard_uris(tx: tokio::sync::oneshot::Sender<String>) {
    let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
    clipboard.request_uris(move |clipboard, uris| {
        if !uris.is_empty() {
            let body = uris
                .iter()
                .map(|u| u.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let _ = tx.send(body);
            return;
        }
        let target = gtk::gdk::Atom::intern("x-special/gnome-copied-files");
        clipboard.request_contents(&target, move |_, data| {
            let _ = tx.send(String::from_utf8_lossy(&data.data()).into_owned());
        });
    });
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // tests plant files directly
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "owncord-file-transfer-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn uri_list_keeps_local_files_only() {
        let body = "# comment\r\nfile:///home/me/a%20b.png\r\nhttps://example.com/x.png\r\nfile://otherhost/c.txt\r\nfile://localhost/tmp/d.txt\r\n";
        assert_eq!(
            paths_from_uri_list(body),
            vec![
                PathBuf::from("/home/me/a b.png"),
                PathBuf::from("/tmp/d.txt")
            ]
        );
    }

    #[test]
    fn gnome_copied_files_skips_the_verb() {
        let body = "copy\nfile:///tmp/one.txt\nfile:///tmp/two.txt";
        assert_eq!(
            paths_from_uri_list(body),
            vec![PathBuf::from("/tmp/one.txt"), PathBuf::from("/tmp/two.txt")]
        );
    }

    #[test]
    fn plain_text_paths_are_not_files() {
        assert!(paths_from_uri_list("/home/me/notes.txt\nhello").is_empty());
    }

    #[test]
    fn stage_keeps_regular_files_and_reads_each_once() {
        let dir = TempDir::new();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, b"hello").expect("write");
        let staged = StagedFiles::new();
        let out = staged.stage(vec![
            file.clone(),
            dir.path().to_path_buf(),
            dir.path().join("missing.txt"),
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "a.txt");
        assert_eq!(out[0].size, 5);
        assert_eq!(staged.take(out[0].token), Some(file));
        assert_eq!(staged.take(out[0].token), None);
    }

    #[test]
    fn a_new_drop_retires_the_old_tokens() {
        let dir = TempDir::new();
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        std::fs::write(&a, b"a").expect("write");
        std::fs::write(&b, b"b").expect("write");
        let staged = StagedFiles::new();
        let first = staged.stage(vec![a]);
        let second = staged.stage(vec![b.clone()]);
        assert_eq!(staged.take(first[0].token), None);
        assert_ne!(first[0].token, second[0].token);
        assert_eq!(staged.take(second[0].token), Some(b));
    }

    #[test]
    fn read_capped_refuses_a_folder() {
        let dir = TempDir::new();
        assert!(read_capped(dir.path()).is_err());
    }
}
