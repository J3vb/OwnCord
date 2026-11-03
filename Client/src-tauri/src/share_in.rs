//! Shares from other apps on Android ("Share" > OwnCord). `ShareInPlugin.kt`
//! copies the shared files into the cache `incoming/` folder as they arrive
//! and keeps the latest share; `take_shared` hands it to the webview once
//! (and says when a copy is still running, so the page asks again),
//! staging its files in the same registry a Linux drop uses
//! (`file_transfer.rs`), so the page reads each one by its token and never
//! names a path. A new share retires the tokens of the last one.

use std::path::{Path, PathBuf};

#[cfg(target_os = "android")]
pub(crate) use android::init;

/// Shared with `ShareInPlugin.kt`, which writes only into this folder.
#[cfg(target_os = "android")]
const INCOMING_DIR: &str = "incoming";

/// The paths among `files` that lie inside `incoming`; anything else is
/// dropped, so a confused plugin can never hand the page another file.
fn inside_incoming(incoming: &Path, files: Vec<String>) -> Vec<PathBuf> {
    let Ok(root) = incoming.canonicalize() else {
        return Vec::new();
    };
    files
        .into_iter()
        .filter_map(|f| PathBuf::from(f).canonicalize().ok())
        .filter(|p| p.starts_with(&root))
        .collect()
}

#[cfg(target_os = "android")]
pub(crate) mod android {
    use super::{inside_incoming, INCOMING_DIR};
    use serde::{Deserialize, Serialize};
    use tauri::plugin::{Builder, PluginApi, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Wry};

    use crate::file_transfer::{StagedFile, StagedFiles};

    struct ShareInHandle(PluginHandle<Wry>);

    /// Registers `ShareInPlugin.kt` and the staged-file registry the page reads
    /// shared files from.
    pub(crate) fn init() -> TauriPlugin<Wry> {
        Builder::new("owncord-share-in")
            .setup(|app, api: PluginApi<Wry, ()>| {
                let handle = api.register_android_plugin("com.owncord.client", "ShareInPlugin")?;
                app.manage(ShareInHandle(handle));
                app.manage(StagedFiles::new());
                Ok(())
            })
            .build()
    }

    #[derive(Deserialize, Default)]
    struct Oversized {
        name: String,
        size: u64,
    }

    #[derive(Deserialize, Default)]
    struct RawShare {
        #[serde(default)]
        text: String,
        #[serde(default)]
        files: Vec<String>,
        #[serde(default)]
        oversized: Vec<Oversized>,
    }

    #[derive(Deserialize)]
    struct Taken {
        #[serde(default)]
        share: Option<RawShare>,
        #[serde(default)]
        copying: bool,
    }

    /// A file too large to copy: the page shows it as refused.
    #[derive(Serialize, Debug, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    pub struct RefusedFile {
        name: String,
        size: u64,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Share {
        text: String,
        files: Vec<StagedFile>,
        oversized: Vec<RefusedFile>,
    }

    /// The share that arrived since the last call, once; `copying` while a
    /// newer share's files are still being copied, so the page asks again.
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TakeResult {
        share: Option<Share>,
        copying: bool,
    }

    #[tauri::command]
    pub async fn take_shared(app: AppHandle) -> Result<TakeResult, String> {
        let taken = app
            .state::<ShareInHandle>()
            .0
            .run_mobile_plugin_async::<Taken>("takeShare", ())
            .await
            .map_err(|e| format!("share: {e}"))?;
        let copying = taken.copying;
        let Some(raw) = taken.share else {
            return Ok(TakeResult {
                share: None,
                copying,
            });
        };
        let incoming = app
            .path()
            .app_cache_dir()
            .map(|cache| cache.join(INCOMING_DIR))
            .map_err(|e| format!("no cache folder: {e}"))?;
        let paths = inside_incoming(&incoming, raw.files);
        let files = app.state::<StagedFiles>().stage(paths);
        let oversized = raw
            .oversized
            .into_iter()
            .map(|o| RefusedFile {
                name: o.name,
                size: o.size,
            })
            .collect();
        Ok(TakeResult {
            share: Some(Share {
                text: raw.text,
                files,
                oversized,
            }),
            copying,
        })
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // tests plant files directly
mod tests {
    use super::inside_incoming;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("owncord-share-in-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn keeps_only_files_inside_the_incoming_folder() {
        let tmp = TempDir::new();
        let incoming = tmp.0.join("incoming");
        std::fs::create_dir_all(incoming.join("1/0")).unwrap();
        let inside = incoming.join("1/0/photo.jpg");
        std::fs::write(&inside, b"jpg").unwrap();
        let outside = tmp.0.join("secret.txt");
        std::fs::write(&outside, b"no").unwrap();
        let sneaky = incoming.join("1/../../secret.txt");
        let kept = inside_incoming(
            &incoming,
            vec![
                inside.display().to_string(),
                outside.display().to_string(),
                sneaky.display().to_string(),
                incoming.join("missing.png").display().to_string(),
            ],
        );
        assert_eq!(kept, vec![inside.canonicalize().unwrap()]);
    }

    #[test]
    fn no_incoming_folder_keeps_nothing() {
        let tmp = TempDir::new();
        let file = tmp.0.join("a.txt");
        std::fs::write(&file, b"a").unwrap();
        assert!(
            inside_incoming(&tmp.0.join("incoming"), vec![file.display().to_string()]).is_empty()
        );
    }
}
