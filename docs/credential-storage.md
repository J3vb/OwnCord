# Credential storage

The desktop client persists two secrets per server, both in the OS credential
store under the service name `com.owncord.client`:

| Secret | Account name | Contents |
| --- | --- | --- |
| Login credential | `{host}` | JSON `{"username","token","password"}` |
| Voice-E2EE identity private key | `identity:{host}` | base64 JWK (P-256 private key) |

The identity key is the long-term key peers pin under trust-on-first-use. Its
public half is published to the server (`users.identity_public_key`) and its
private half signs the ephemeral-key announce in a voice session. **If the key
is not the same one across a reconnect, the published key is not the key that
signed, and peers correctly reject the announce** — voice E2EE key exchange then
times out and the client log shows:

```
peer announce signature invalid - rejecting (MITM?)
```

That rejection is the fail-closed behaviour working as intended. The bug in that
scenario is always on the storage side, never the verification side.

## Root cause of the 2026-07 identity-key regression

The client depended on `keyring = "3"` with no feature list.

**The `keyring` crate declares no `default` feature.** Each platform arm in its
`lib.rs` selects a backend only when that platform's feature is enabled, and
otherwise falls through to the mock store:

```rust
#[cfg(all(target_os = "windows", not(feature = "windows-native")))]
pub use mock as default;
#[cfg(all(target_os = "macos",   not(feature = "apple-native")))]
pub use mock as default;
// ...and the equivalent Linux arm for the secret-service / keyutils features
```

So the shipped client used the **mock credential store on Windows, macOS and
Linux alike**. The mock is documented as "platform-independent, provides no
persistence… there is no persistence other than in the entry itself", and its
builder returns a fresh `MockCredential` for every `Entry::new`. Because each
command built its own `Entry`, the sequence was:

```
save_identity_key -> Entry::new(..) -> set_password -> Ok(())    // Entry dropped here
load_identity_key -> Entry::new(..) -> get_password -> NoEntry   // brand-new empty cell
```

This reproduces every reported symptom exactly:

- The save returns `Ok`, so no "Failed to save identity key" line is ever logged.
- The very next read **in the same process** returns nothing.
- `NoEntry` is mapped to `Ok(None)`, so the read logs nothing either.
- Windows Credential Manager and `cmdkey /list` show no `com.owncord.client`
  entries **on any machine**, including ones where the client otherwise behaves
  — because nothing was ever written to Credential Manager.

Whether a given user visibly regenerates their key therefore depends on process
lifetime and on the publish step being idempotent, not on their machine. It is
not a Windows policy fault, a roaming-profile fault, or a target-name fault.

### The fix

`src-tauri/Cargo.toml` now names the backends explicitly:

```toml
keyring = { version = "3", default-features = false, features = [
    "windows-native",       # Windows Credential Manager
    "apple-native",         # macOS Keychain
    "sync-secret-service",  # Linux Secret Service (GNOME Keyring / KWallet)
    "crypto-rust",          # pure-Rust session crypto for Secret Service
] }
```

`sync-secret-service` links libdbus, so Linux builds need `libdbus-1-dev`.

Two guards keep this from regressing silently:

- `secret_store::tests::compiled_keyring_backend_is_persistent` fails the build
  if the compiled backend is not disk-persistent. It inspects the backend, so it
  needs no live keychain and runs in CI.
- Every write is read back before `save_*` returns (see below).

## Verifying the credential store on a machine

### From the client

The client logs its compiled backend at startup, to the rotating log file in the
OS app-log dir:

```
credential store: OS keyring, persists until deleted (on disk)
```

Anything else is an error line naming the problem.

For a live end-to-end check there is a `probe_credential_store` command. It
writes, reads back and deletes a throwaway entry and reports which backend
served it, touching no real credential:

```js
await invoke("probe_credential_store")
// { ok: true, backend: "keyring", error: null }
```

### From Windows directly

Use `cmdkey`, **not** the Credential Manager control panel — the control panel
filters out generic credentials written by applications, so it shows nothing
even on a perfectly healthy machine.

`keyring` composes the Windows target name as `{account}.{service}`, so the
identity key for `test.example` is stored as:

```
identity:test.example.com.owncord.client
```

Note the order: account first, service second. To check for a real entry:

```
cmdkey /list | findstr /i owncord
```

A hand-rolled `cmdkey /generic:... ` round-trip is a **weak** test and can pass
while the client still fails, for two reasons:

- `cmdkey /generic:` writes with `CRED_PERSIST_LOCAL_MACHINE`, whereas `keyring`
  hardcodes `CRED_PERSIST_ENTERPRISE` (`windows.rs`, `save_credential`). Only
  the latter is subject to roaming-credential policy.
- It exercises a target name the client never uses unless you spell it in the
  `{account}.{service}` order above.

If you do want the exact repro:

```
cmdkey /generic:identity:test.example.com.owncord.client /user:x /pass:y
cmdkey /list | findstr /i owncord
```

## Environment causes that remain possible

These were not the cause of the 2026-07 regression, but they can genuinely stop
Windows persisting credentials, and the client now detects and reports them
instead of silently regenerating keys.

| Cause | Check | Fix |
| --- | --- | --- |
| Credential Manager service stopped | `sc query VaultSvc` | `sc config VaultSvc start= auto && sc start VaultSvc` |
| "Network access: Do not allow storage of passwords and credentials for network authentication" | `reg query HKLM\SYSTEM\CurrentControlSet\Control\Lsa /v DisableDomainCreds` | Set the policy to *Disabled* (`secpol.msc` → Local Policies → Security Options), i.e. `DisableDomainCreds = 0`. Note this blocks *domain* credentials and makes writes fail with `ERROR_NO_SUCH_LOGON_SESSION`, which the client surfaces as an error rather than silently. |
| No roaming profile, with `CRED_PERSIST_ENTERPRISE` | — | Documented Windows behaviour: the credential simply persists locally instead of roaming. Harmless. |
| App running as a different user than the vault being inspected | `whoami` in the app's context vs. the one running `cmdkey` | Credentials are per-user; compare like for like. |

Blob size is not a plausible cause: `CRED_MAX_CREDENTIAL_BLOB_SIZE` is 2560
bytes and `keyring` stores the secret as UTF-16, so the ceiling is ~1280
characters. The identity blob is a ~256-character base64 JWK (~512 bytes), and
an oversized secret would be rejected up front with a `TooLong` error, not
silently dropped.

## Write verification and the fallback store

`secret_store::set` reads every write back and compares it before reporting
success. A store that accepts a write and does not return it is the one failure
a `Result` cannot express, and it is exactly what caused this incident.

When that check fails **on Windows**, the secret is encrypted with DPAPI
(`CryptProtectData`, user-scoped, `CRYPTPROTECT_UI_FORBIDDEN`) and parked in
`credential_fallback.json` in the app data dir. The account name is mixed into
the DPAPI entropy, so a blob cannot be moved between entries and still decrypt.
The fallback:

- engages **only** after a write has been proven not to round-trip — never as
  the default;
- is cleared automatically as soon as the OS credential store works again, so a
  repaired machine returns to the real store with no migration step;
- exists on Windows only. On macOS and Linux a failing Keychain / Secret Service
  is reported as an error instead, because writing a login password or an
  identity private key to a plaintext file there would be a worse outcome than
  not persisting it.

None of this weakens the fail-closed E2EE posture: a peer whose announce
signature does not verify is still rejected. The fallback only affects whether
*our own* key survives a restart.
