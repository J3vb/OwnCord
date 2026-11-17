//! The fallback-file move into the Android Keystore, with both stores
//! injected so its order is testable without a device.

use super::{ReadFailure, SERVICE};

/// Core of the fallback move, with both stores injected so the order is
/// testable without a device. Returns how many entries left the file.
pub(super) fn migrate_fallback_with(
    accounts: &[String],
    store_get: impl Fn(&str) -> Result<Option<String>, ReadFailure>,
    store_set: impl Fn(&str, &str) -> Result<(), String>,
    store_delete: impl Fn(&str) -> Result<(), String>,
    fallback_get: impl Fn(&str) -> Result<Option<String>, String>,
    fallback_clear: impl Fn(&str) -> Result<(), String>,
) -> usize {
    accounts
        .iter()
        .filter(|account| {
            migrate_one(
                account,
                &store_get,
                &store_set,
                &store_delete,
                &fallback_get,
                &fallback_clear,
            )
        })
        .count()
}

/// Move one entry. The file copy is removed only once the Keystore copy has
/// read back byte for byte, so a kill at any point leaves the secret in at
/// least one store.
fn migrate_one(
    account: &str,
    store_get: &impl Fn(&str) -> Result<Option<String>, ReadFailure>,
    store_set: &impl Fn(&str, &str) -> Result<(), String>,
    store_delete: &impl Fn(&str) -> Result<(), String>,
    fallback_get: &impl Fn(&str) -> Result<Option<String>, String>,
    fallback_clear: &impl Fn(&str) -> Result<(), String>,
) -> bool {
    match store_get(account) {
        // `get` returns the Keystore copy first, so the file copy is never read.
        Ok(Some(_)) => return fallback_clear(account).is_ok(),
        Ok(None) => {}
        // `get` falls back to the file copy while the Keystore fails: keep it.
        Err(_) => return false,
    }
    let secret = match fallback_get(account) {
        Ok(Some(secret)) => secret,
        Ok(None) => return true,
        Err(_) => return false,
    };
    if let Err(e) = store_set(account, &secret) {
        log::warn!("{SERVICE}: fallback entry '{account}' stays in the file: {e}");
        return false;
    }
    match store_get(account) {
        Ok(Some(ref got)) if *got == secret => fallback_clear(account).is_ok(),
        Ok(Some(_)) => {
            // A wrong Keystore value would shadow the good file copy on read.
            if let Err(e) = store_delete(account) {
                log::warn!(
                    "{SERVICE}: could not remove a wrong Keystore entry for '{account}': {e}"
                );
            }
            false
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failed(message: &str) -> ReadFailure {
        ReadFailure {
            message: message.to_string(),
            no_store: false,
        }
    }

    /// Two in-memory stores and the order of every write, for the fallback move.
    #[derive(Default)]
    struct MoveRig {
        keystore: std::cell::RefCell<std::collections::HashMap<String, String>>,
        file: std::cell::RefCell<std::collections::HashMap<String, String>>,
        log: std::cell::RefCell<Vec<String>>,
        refuse_write: bool,
        garble_read_back: bool,
        fail_read: bool,
        fail_clear: bool,
        unreadable_file: bool,
    }

    impl MoveRig {
        fn with_file(entries: &[(&str, &str)]) -> Self {
            let rig = MoveRig::default();
            for (k, v) in entries {
                rig.file
                    .borrow_mut()
                    .insert((*k).to_string(), (*v).to_string());
            }
            rig
        }

        fn run(&self) -> usize {
            let accounts: Vec<String> = self.file.borrow().keys().cloned().collect();
            migrate_fallback_with(
                &accounts,
                |a| {
                    if self.fail_read {
                        return Err(failed("keystore unavailable"));
                    }
                    let got = self.keystore.borrow().get(a).cloned();
                    Ok(got.map(|v| {
                        if self.garble_read_back {
                            format!("{v}!")
                        } else {
                            v
                        }
                    }))
                },
                |a, s| {
                    if self.refuse_write {
                        return Err("refused".into());
                    }
                    self.log.borrow_mut().push(format!("store_set {a}"));
                    self.keystore.borrow_mut().insert(a.into(), s.into());
                    Ok(())
                },
                |a| {
                    self.log.borrow_mut().push(format!("store_delete {a}"));
                    self.keystore.borrow_mut().remove(a);
                    Ok(())
                },
                |a| {
                    if self.unreadable_file {
                        return Err("did not open".into());
                    }
                    Ok(self.file.borrow().get(a).cloned())
                },
                |a| {
                    if self.fail_clear {
                        return Err("flush failed".into());
                    }
                    self.log.borrow_mut().push(format!("file_clear {a}"));
                    self.file.borrow_mut().remove(a);
                    Ok(())
                },
            )
        }
    }

    /// The Android bridge names the plugin's commands as text; nothing of
    /// either side runs off a phone, so pin that they agree.
    #[test]
    fn the_android_bridge_and_plugin_name_the_same_commands() {
        let bridge = include_str!("../android_secrets.rs");
        let plugin =
            include_str!("../../gen/android/app/src/main/java/com/owncord/client/SecretsPlugin.kt");
        assert!(
            bridge.contains("register_android_plugin(\"com.owncord.client\", \"SecretsPlugin\")")
        );
        assert!(plugin.contains("class SecretsPlugin("));
        for command in ["secretSet", "secretGet", "secretDelete"] {
            assert!(
                bridge.contains(&format!("\"{command}\"")),
                "bridge lacks {command}"
            );
            assert!(
                plugin.contains(&format!("fun {command}(invoke: Invoke)")),
                "plugin lacks {command}"
            );
        }
        assert!(plugin.contains("put(\"value\""));
        assert!(bridge.contains("value: Option<String>"));
    }

    #[test]
    fn the_move_writes_the_keystore_before_it_clears_the_file() {
        let rig = MoveRig::with_file(&[("identity:a", "key")]);
        assert_eq!(rig.run(), 1);
        assert_eq!(
            *rig.log.borrow(),
            vec!["store_set identity:a", "file_clear identity:a"]
        );
        assert_eq!(
            rig.keystore.borrow().get("identity:a").map(String::as_str),
            Some("key")
        );
        assert!(rig.file.borrow().is_empty());
    }

    #[test]
    fn the_move_keeps_the_file_copy_when_the_keystore_refuses_the_write() {
        let rig = MoveRig {
            refuse_write: true,
            ..MoveRig::with_file(&[("login:a", "cred")])
        };
        assert_eq!(rig.run(), 0);
        assert_eq!(
            rig.file.borrow().get("login:a").map(String::as_str),
            Some("cred")
        );
    }

    #[test]
    fn the_move_drops_a_keystore_copy_that_reads_back_wrong_and_keeps_the_file() {
        let rig = MoveRig {
            garble_read_back: true,
            ..MoveRig::with_file(&[("login:a", "cred")])
        };
        assert_eq!(rig.run(), 0);
        assert!(rig.keystore.borrow().is_empty());
        assert_eq!(
            rig.file.borrow().get("login:a").map(String::as_str),
            Some("cred")
        );
        assert_eq!(
            *rig.log.borrow(),
            vec!["store_set login:a", "store_delete login:a"]
        );
    }

    #[test]
    fn the_move_never_overwrites_a_keystore_value_and_drops_the_shadowed_file_copy() {
        let rig = MoveRig::with_file(&[("login:a", "old")]);
        rig.keystore
            .borrow_mut()
            .insert("login:a".into(), "new".into());
        assert_eq!(rig.run(), 1);
        assert_eq!(
            rig.keystore.borrow().get("login:a").map(String::as_str),
            Some("new")
        );
        assert!(rig.file.borrow().is_empty());
    }

    #[test]
    fn the_move_touches_nothing_while_the_keystore_cannot_be_read() {
        let rig = MoveRig {
            fail_read: true,
            ..MoveRig::with_file(&[("login:a", "cred")])
        };
        assert_eq!(rig.run(), 0);
        assert!(rig.log.borrow().is_empty());
        assert_eq!(rig.file.borrow().len(), 1);
    }

    #[test]
    fn the_move_keeps_a_file_entry_it_cannot_open() {
        let rig = MoveRig {
            unreadable_file: true,
            ..MoveRig::with_file(&[("identity:a", "key")])
        };
        assert_eq!(rig.run(), 0);
        assert!(rig.keystore.borrow().is_empty());
        assert_eq!(rig.file.borrow().len(), 1);
    }

    #[test]
    fn a_move_cut_short_after_the_keystore_write_finishes_on_the_next_run() {
        let mut rig = MoveRig {
            fail_clear: true,
            ..MoveRig::with_file(&[("identity:a", "key")])
        };
        assert_eq!(rig.run(), 0);
        assert_eq!(
            rig.keystore.borrow().get("identity:a").map(String::as_str),
            Some("key")
        );
        assert_eq!(rig.file.borrow().len(), 1);

        rig.fail_clear = false;
        assert_eq!(rig.run(), 1);
        assert!(rig.file.borrow().is_empty());
        assert_eq!(
            rig.keystore.borrow().get("identity:a").map(String::as_str),
            Some("key")
        );
    }
}
