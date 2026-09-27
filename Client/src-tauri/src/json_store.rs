//! The client's JSON key-value stores: settings, certificate pins, identity
//! pins and the credential fallback (file names in `constants`).
//!
//! Replaces tauri-plugin-store, which wrote a store by truncating the file and
//! then writing it — on every change after a 100 ms debounce and again on exit
//! — and which turned a file it could not read into an empty store without a
//! word. A crash mid-write therefore lost saved servers, logins and trust pins.
//!
//! Here a save writes a temp file, fsyncs it and renames it over the original
//! ([`write_atomic`]), so a crash leaves either the old content or the new,
//! never a torn file. A file that does not parse is copied to
//! `<name>.corrupt-<unix seconds>` and logged. The pin stores then fail
//! closed: opening them errors until the file is repaired or removed and the
//! client restarted, because an empty pin store would trust any certificate or
//! identity key on first sight. The other stores start empty, and their next
//! save replaces the bad file.
//!
//! The on-disk format is the plugin's (a pretty-printed JSON object), so files
//! written by earlier versions load unchanged.

use crate::constants::{CERTS_STORE, IDENTITY_PINS_STORE};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime};

/// Stores whose loss would silently re-trust whatever the network presents.
const FAIL_CLOSED: [&str; 2] = [CERTS_STORE, IDENTITY_PINS_STORE];

/// One loaded store. Changes stay in memory until [`JsonStore::save`].
pub struct JsonStore {
    path: PathBuf,
    map: Mutex<Map<String, Value>>,
}

impl JsonStore {
    pub fn get(&self, key: impl AsRef<str>) -> Option<Value> {
        self.lock().get(key.as_ref()).cloned()
    }

    pub fn set(&self, key: impl Into<String>, value: Value) {
        self.lock().insert(key.into(), value);
    }

    /// Remove `key`, reporting whether it was present.
    pub fn delete(&self, key: impl AsRef<str>) -> bool {
        self.lock().remove(key.as_ref()).is_some()
    }

    pub fn keys(&self) -> Vec<String> {
        self.lock().keys().cloned().collect()
    }

    /// Write the store to disk atomically.
    pub fn save(&self) -> Result<(), String> {
        // Held across the write so two saves cannot interleave on the temp file.
        let map = self.lock();
        let bytes = serde_json::to_vec_pretty(&*map).map_err(|e| e.to_string())?;
        write_atomic(&self.path, &bytes).map_err(|e| format!("{}: {e}", self.path.display()))
    }

    fn lock(&self) -> MutexGuard<'_, Map<String, Value>> {
        self.map.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Tauri-managed registry: each store is loaded once per run. A failed load
/// is cached too, so a corrupt pin store is copied and logged once, not on
/// every lookup.
#[derive(Default)]
pub struct JsonStores(Mutex<HashMap<&'static str, Result<Arc<JsonStore>, String>>>);

/// Open the store `name` in the app data directory.
pub fn open<R: Runtime>(app: &AppHandle<R>, name: &'static str) -> Result<Arc<JsonStore>, String> {
    let registry = app.state::<JsonStores>();
    let mut stores = registry.0.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(entry) = stores.get(name) {
        return entry.clone();
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve the app data dir: {e}"))?;
    let entry = load(&dir.join(name), FAIL_CLOSED.contains(&name)).map(Arc::new);
    stores.insert(name, entry.clone());
    entry
}

/// Load the store at `path`. A missing file is an empty store.
fn load(path: &Path, fail_closed: bool) -> Result<JsonStore, String> {
    let map = match read_map(path) {
        Ok(map) => map.unwrap_or_default(),
        Err(why) => {
            let saved = preserve_corrupt(path)
                .map(|copy| format!("a copy is saved as {}", copy.display()))
                .unwrap_or_else(|e| format!("no copy could be saved: {e}"));
            log::error!(
                "[json_store] {} is unreadable ({why}); {saved}",
                path.display()
            );
            if fail_closed {
                return Err(format!(
                    "{} is unreadable ({why}); {saved}. Remove the file to reset these trust pins.",
                    path.display()
                ));
            }
            Map::new()
        }
    };
    Ok(JsonStore {
        path: path.to_path_buf(),
        map: Mutex::new(map),
    })
}

/// Read and parse a store file; `Ok(None)` when it does not exist.
fn read_map(path: &Path) -> Result<Option<Map<String, Value>>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    match serde_json::from_slice(&bytes) {
        Ok(Value::Object(map)) => Ok(Some(map)),
        Ok(_) => Err("not a JSON object".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Copy an unreadable store aside so the next save cannot destroy it.
fn preserve_corrupt(path: &Path) -> io::Result<PathBuf> {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let mut copy = path.as_os_str().to_owned();
    copy.push(format!(".corrupt-{secs}"));
    let copy = PathBuf::from(copy);
    fs::copy(path, &copy)?;
    Ok(copy)
}

/// Replace `path` with `bytes` so that a crash at any point leaves either the
/// old content or the new: write a sibling temp file, fsync it, then rename it
/// over `path` (atomic on one filesystem, replacing on Windows too).
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    // The one sanctioned truncating write: a private temp file, never the store.
    #[allow(clippy::disallowed_methods)]
    let mut file = fs::File::create(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path)?;
    // Persist the rename itself; Windows has no directory handle to sync.
    #[cfg(unix)]
    fs::File::open(dir)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // tests plant torn files directly
mod tests {
    use super::*;

    /// A fresh directory under the system temp dir, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "owncord-json-store-{tag}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn corrupt_copies(dir: &Path) -> Vec<PathBuf> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.to_string_lossy().contains(".corrupt-"))
            .collect()
    }

    #[test]
    fn a_saved_store_loads_back() {
        let dir = TempDir::new("roundtrip");
        let path = dir.0.join("settings.json");
        let store = load(&path, false).unwrap();
        store.set("theme", Value::from("dark"));
        store.save().unwrap();

        let reloaded = load(&path, false).unwrap();
        assert_eq!(reloaded.get("theme"), Some(Value::from("dark")));
    }

    #[test]
    fn a_file_written_by_the_old_plugin_loads_unchanged() {
        let dir = TempDir::new("compat");
        let path = dir.0.join("certs.json");
        fs::write(&path, b"{\n  \"example.com:8443\": \"aa:bb\"\n}").unwrap();

        let store = load(&path, true).unwrap();
        assert_eq!(store.get("example.com:8443"), Some(Value::from("aa:bb")));
    }

    #[test]
    fn a_missing_file_is_an_empty_store() {
        let dir = TempDir::new("missing");
        let store = load(&dir.0.join("certs.json"), true).unwrap();
        assert!(store.keys().is_empty());
    }

    // A write that dies midway must leave the previous content in place. The
    // temp path is occupied by a directory, so creating the temp file fails
    // exactly where a crash would interrupt a write.
    #[test]
    fn a_failed_write_leaves_the_old_content() {
        let dir = TempDir::new("interrupted");
        let path = dir.0.join("settings.json");
        let store = load(&path, false).unwrap();
        store.set("theme", Value::from("dark"));
        store.save().unwrap();

        fs::create_dir(dir.0.join("settings.json.tmp")).unwrap();
        store.set("theme", Value::from("light"));
        assert!(store.save().is_err());

        let on_disk = load(&path, false).unwrap();
        assert_eq!(on_disk.get("theme"), Some(Value::from("dark")));
    }

    // What a truncating writer left behind after a crash mid-write.
    const TORN: &[u8] = b"{\n  \"example.com:8443\": \"aa:b";

    #[test]
    fn a_torn_settings_file_is_copied_aside_and_starts_empty() {
        let dir = TempDir::new("torn-settings");
        let path = dir.0.join("settings.json");
        fs::write(&path, TORN).unwrap();

        let store = load(&path, false).unwrap();
        assert!(store.keys().is_empty());
        let copies = corrupt_copies(&dir.0);
        assert_eq!(copies.len(), 1, "the torn file must be preserved");
        assert_eq!(fs::read(&copies[0]).unwrap(), TORN);

        // The next save replaces the torn file with a readable one.
        store.set("theme", Value::from("dark"));
        store.save().unwrap();
        assert_eq!(
            load(&path, false).unwrap().get("theme"),
            Some(Value::from("dark"))
        );
    }

    #[test]
    fn a_torn_pin_store_fails_closed_and_keeps_the_file() {
        let dir = TempDir::new("torn-pins");
        let path = dir.0.join("certs.json");
        fs::write(&path, TORN).unwrap();

        let err = load(&path, true)
            .err()
            .expect("a torn pin store must not open");
        assert!(err.contains(".corrupt-"), "the error names the copy: {err}");
        assert_eq!(corrupt_copies(&dir.0).len(), 1);
        assert_eq!(
            fs::read(&path).unwrap(),
            TORN,
            "the original stays in place"
        );
    }

    #[test]
    fn a_non_object_file_is_treated_as_corrupt() {
        let dir = TempDir::new("array");
        let path = dir.0.join("identity_pins.json");
        fs::write(&path, b"[]").unwrap();

        assert!(load(&path, true).is_err());
        assert_eq!(corrupt_copies(&dir.0).len(), 1);
    }

    #[test]
    fn the_pin_stores_are_the_ones_that_fail_closed() {
        assert!(FAIL_CLOSED.contains(&CERTS_STORE));
        assert!(FAIL_CLOSED.contains(&IDENTITY_PINS_STORE));
        assert!(!FAIL_CLOSED.contains(&crate::constants::SETTINGS_STORE));
    }
}
