//! Android file save and share. The webview hands over a file's bytes; they
//! go to the cache `outgoing/` folder and `FilesPlugin.kt` takes it from there:
//! a save copies it into the phone's shared storage (images to
//! Pictures/OwnCord, everything else to Downloads), a share hands it to the
//! system share sheet. There is no save dialog on Android and the fs plugin's
//! scope stays the log folder.
//!
//! The name and type rules are plain functions so they run in the host's tests.

/// Shared with `res/xml/file_paths.xml` and `FilesPlugin.kt`, which open only
/// files in this folder.
#[cfg(target_os = "android")]
const OUTGOING_DIR: &str = "outgoing";
/// Longest file name kept, in bytes; `MediaStore` and most file systems stop at 255.
const MAX_NAME_BYTES: usize = 120;
const FALLBACK_NAME: &str = "file";

/// Where a saved file lands on the phone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(target_os = "android", derive(serde::Serialize))]
#[cfg_attr(target_os = "android", serde(rename_all = "snake_case"))]
pub(crate) enum Folder {
    Pictures,
    Downloads,
}

/// Percent-decodes `raw` (the webview sends the name URI-encoded, since a
/// header value is ASCII only). A broken escape is kept as written.
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(b) = hex {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A safe file name from what the webview suggested: its last path segment,
/// without control or reserved characters or leading dots, at most
/// `MAX_NAME_BYTES` long with its extension kept.
pub(crate) fn safe_name(raw: &str) -> String {
    let decoded = percent_decode(raw);
    let last = decoded.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        .collect();
    let trimmed = cleaned
        .trim()
        .trim_start_matches('.')
        .trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        return FALLBACK_NAME.to_string();
    }
    if trimmed.len() <= MAX_NAME_BYTES {
        return trimmed.to_string();
    }
    let (stem, ext) = match trimmed.rfind('.') {
        Some(dot) if trimmed.len() - dot <= 16 => (&trimmed[..dot], &trimmed[dot..]),
        _ => (trimmed, ""),
    };
    let mut cut = MAX_NAME_BYTES.saturating_sub(ext.len());
    while !stem.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{ext}", &stem[..cut])
}

fn extension(name: &str) -> String {
    match name.rfind('.') {
        Some(dot) => name[dot + 1..].to_ascii_lowercase(),
        None => String::new(),
    }
}

/// The MIME type Android is told, from the name's extension.
pub(crate) fn mime_for(name: &str) -> &'static str {
    match extension(name).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "json" => "application/json",
        "txt" | "log" | "md" | "jsonl" => "text/plain",
        "csv" => "text/csv",
        "css" => "text/css",
        "html" | "htm" => "text/html",
        _ => "application/octet-stream",
    }
}

/// The bytes of a JSON number array, or None when any entry is not a byte.
pub(crate) fn bytes_from_numbers(numbers: impl Iterator<Item = Option<u64>>) -> Option<Vec<u8>> {
    numbers
        .map(|n| n.and_then(|n| u8::try_from(n).ok()))
        .collect()
}

/// Pictures takes the image types the gallery shows; everything else,
/// SVG included, goes to Downloads.
pub(crate) fn folder_for(mime: &str) -> Folder {
    match mime {
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif" | "image/bmp"
        | "image/heic" | "image/heif" => Folder::Pictures,
        _ => Folder::Downloads,
    }
}

// The commands are named by this path in `generate_handler!`, which cannot
// follow a re-export.
#[cfg(target_os = "android")]
pub(crate) mod android {
    use super::{bytes_from_numbers, folder_for, mime_for, safe_name, Folder, OUTGOING_DIR};
    use serde::{Deserialize, Serialize};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime};
    use tauri::ipc::{InvokeBody, Request};
    use tauri::plugin::{Builder, PluginApi, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Wry};

    /// The header that carries the URI-encoded file name.
    const NAME_HEADER: &str = "x-owncord-file-name";
    /// A shared file must outlive the share: the receiving app reads it after
    /// the sheet closes, and a mail draft may hold it a while. Older ones are
    /// removed at app start and at the next save or share.
    const KEEP_SHARED: Duration = Duration::from_secs(60 * 60);

    static NEXT_SLOT: AtomicU64 = AtomicU64::new(0);

    struct FilesHandle(PluginHandle<Wry>);

    /// Registers `FilesPlugin.kt`.
    pub(crate) fn init() -> TauriPlugin<Wry> {
        Builder::new("owncord-files")
            .setup(|app, api: PluginApi<Wry, ()>| {
                let handle = api.register_android_plugin("com.owncord.client", "FilesPlugin")?;
                app.manage(FilesHandle(handle));
                // A support bundle shared last week holds logs: do not keep
                // it in the cache until the next share.
                if let Ok(dir) = outgoing_dir(app) {
                    prune(&dir);
                }
                Ok(())
            })
            .build()
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FileArgs {
        path: String,
        name: String,
        mime: String,
        folder: Folder,
    }

    #[derive(Serialize)]
    struct TextArgs {
        text: String,
    }

    #[derive(Deserialize, Serialize, Debug, PartialEq)]
    #[serde(rename_all = "snake_case")]
    enum SaveStatus {
        Saved,
        /// Android 9 has no shared Downloads folder an app may write to
        /// without a storage permission: the file went to the share sheet.
        Shared,
    }

    #[derive(Deserialize)]
    struct SaveReply {
        status: SaveStatus,
    }

    /// What the webview is told about a save.
    #[derive(Serialize)]
    pub(crate) struct SaveOutcome {
        status: SaveStatus,
        folder: Folder,
    }

    fn outgoing_dir(app: &AppHandle) -> Result<PathBuf, String> {
        app.path()
            .app_cache_dir()
            .map(|cache| cache.join(OUTGOING_DIR))
            .map_err(|e| format!("no cache folder: {e}"))
    }

    /// Removes slots older than `KEEP_SHARED`. Best effort: a slot that
    /// cannot be read or removed now is tried again next time.
    fn prune(dir: &std::path::Path) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let now = SystemTime::now();
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|at| now.duration_since(at).ok())
                .is_some_and(|age| age > KEEP_SHARED);
            if old {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }

    /// Copies the request's bytes and name out of the borrowed request.
    fn request_parts(request: &Request<'_>) -> Result<(Vec<u8>, String), String> {
        // The custom-protocol IPC hands the bytes over raw; the postMessage
        // fallback hands them over as a JSON array of numbers.
        let bytes: Vec<u8> = match request.body() {
            InvokeBody::Raw(bytes) => bytes.clone(),
            InvokeBody::Json(serde_json::Value::Array(values)) => {
                bytes_from_numbers(values.iter().map(serde_json::Value::as_u64))
                    .ok_or("file bytes are not bytes")?
            }
            InvokeBody::Json(_) => return Err("file bytes missing".into()),
        };
        let raw_name = request
            .headers()
            .get(NAME_HEADER)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        Ok((bytes, safe_name(raw_name)))
    }

    /// Writes the request's bytes to a fresh slot of `outgoing/` under the
    /// name it carries. Each call gets its own slot, so two saves of the same
    /// name never write one file. The prune and the write run on a blocking
    /// thread.
    async fn stage(
        app: &AppHandle,
        bytes: Vec<u8>,
        name: String,
    ) -> Result<(PathBuf, String), String> {
        let dir = outgoing_dir(app)?;
        tauri::async_runtime::spawn_blocking(move || stage_bytes(&dir, &bytes, name))
            .await
            .map_err(|e| {
                log::warn!("[files] stage task ended early: {e}");
                "could not stage the file".to_string()
            })?
    }

    fn stage_bytes(
        dir: &std::path::Path,
        bytes: &[u8],
        name: String,
    ) -> Result<(PathBuf, String), String> {
        prune(dir);
        let slot = format!(
            "{}-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            NEXT_SLOT.fetch_add(1, Ordering::Relaxed)
        );
        let path = dir.join(slot).join(&name);
        crate::json_store::write_atomic(&path, bytes)
            .map_err(|e| format!("could not stage the file: {e}"))?;
        Ok((path, name))
    }

    fn remove_slot(path: &std::path::Path) {
        if let Some(slot) = path.parent() {
            let _ = std::fs::remove_dir_all(slot);
        }
    }

    fn file_args(path: &std::path::Path, name: String) -> FileArgs {
        let mime = mime_for(&name);
        FileArgs {
            path: path.to_string_lossy().into_owned(),
            name,
            mime: mime.to_string(),
            folder: folder_for(mime),
        }
    }

    /// Save the request's bytes into the phone's shared storage. Async so the
    /// wait for the Kotlin side never holds the main thread.
    #[tauri::command]
    pub async fn save_file(app: AppHandle, request: Request<'_>) -> Result<SaveOutcome, String> {
        let (bytes, name) = request_parts(&request)?;
        let (path, name) = stage(&app, bytes, name).await?;
        let args = file_args(&path, name);
        let folder = args.folder;
        let files = app.state::<FilesHandle>();
        let reply = files
            .0
            .run_mobile_plugin_async::<SaveReply>("saveFile", args)
            .await;
        match reply {
            Ok(reply) => {
                // A shared file is read by the receiving app later; prune
                // removes it then.
                if reply.status == SaveStatus::Saved {
                    remove_slot(&path);
                }
                Ok(SaveOutcome {
                    status: reply.status,
                    folder,
                })
            }
            Err(e) => {
                remove_slot(&path);
                Err(format!("save failed: {e}"))
            }
        }
    }

    /// Open the system share sheet on the request's bytes.
    #[tauri::command]
    pub async fn share_file(app: AppHandle, request: Request<'_>) -> Result<(), String> {
        let (bytes, name) = request_parts(&request)?;
        let (path, name) = stage(&app, bytes, name).await?;
        let args = file_args(&path, name);
        let files = app.state::<FilesHandle>();
        files
            .0
            .run_mobile_plugin_async::<serde_json::Value>("shareFile", args)
            .await
            .map(|_| ())
            .map_err(|e| {
                remove_slot(&path);
                format!("share failed: {e}")
            })
    }

    /// Open the system share sheet on a piece of text.
    #[tauri::command]
    pub async fn share_text(app: AppHandle, text: String) -> Result<(), String> {
        let files = app.state::<FilesHandle>();
        files
            .0
            .run_mobile_plugin_async::<serde_json::Value>("shareText", TextArgs { text })
            .await
            .map(|_| ())
            .map_err(|e| format!("share failed: {e}"))
    }
}

#[cfg(target_os = "android")]
pub(crate) use android::init;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_encoded_name() {
        assert_eq!(safe_name("caf%C3%A9%20menu.png"), "café menu.png");
        assert_eq!(safe_name("100%25.txt"), "100%.txt");
        assert_eq!(safe_name("bad%zz.txt"), "bad%zz.txt");
        assert_eq!(safe_name("end%2"), "end%2");
    }

    #[test]
    fn keeps_only_the_last_segment() {
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("a%2F..%2Fb.zip"), "b.zip");
        assert_eq!(safe_name("C:\\Users\\x\\report.pdf"), "report.pdf");
    }

    #[test]
    fn drops_control_and_reserved_characters() {
        assert_eq!(safe_name("a\u{0}b\nc?.txt"), "abc.txt");
        assert_eq!(safe_name("...hidden"), "hidden");
        assert_eq!(safe_name("name. . "), "name");
        assert_eq!(safe_name(""), "file");
        assert_eq!(safe_name("%2F"), "file");
    }

    #[test]
    fn caps_a_long_name_and_keeps_its_extension() {
        let long = format!("{}.png", "é".repeat(200));
        let name = safe_name(&long);
        assert!(name.len() <= MAX_NAME_BYTES, "{}", name.len());
        assert!(name.ends_with(".png"));
        let plain = "x".repeat(300);
        assert_eq!(safe_name(&plain).len(), MAX_NAME_BYTES);
    }

    #[test]
    fn images_go_to_pictures_and_the_rest_to_downloads() {
        for name in [
            "a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.heic", "g.avif",
        ] {
            assert_eq!(folder_for(mime_for(name)), Folder::Pictures, "{name}");
        }
        for name in ["a.zip", "b.pdf", "c.svg", "d.css", "e.mp4", "f", "g.exe"] {
            assert_eq!(folder_for(mime_for(name)), Folder::Downloads, "{name}");
        }
    }

    #[test]
    fn reads_a_json_byte_array_and_refuses_anything_else() {
        assert_eq!(
            bytes_from_numbers([Some(0), Some(7), Some(255)].into_iter()),
            Some(vec![0, 7, 255])
        );
        assert_eq!(bytes_from_numbers([Some(256)].into_iter()), None);
        assert_eq!(bytes_from_numbers([Some(1), None].into_iter()), None);
        assert_eq!(bytes_from_numbers(std::iter::empty()), Some(vec![]));
    }

    #[test]
    fn unknown_types_are_octet_streams() {
        assert_eq!(mime_for("noext"), "application/octet-stream");
        assert_eq!(mime_for("a.weird"), "application/octet-stream");
        assert_eq!(mime_for("theme.css"), "text/css");
        assert_eq!(mime_for("owncord-support.zip"), "application/zip");
    }
}
