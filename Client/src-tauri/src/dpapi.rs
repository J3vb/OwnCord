//! Windows DPAPI (Data Protection API) wrappers.
//!
//! Used only by [`crate::secret_store`]'s last-resort fallback: when the OS
//! credential store accepts a write but will not return it, the secret is
//! encrypted here and parked in a file under the app data dir instead.
//!
//! Protection is **user-scoped** (no `CRYPTPROTECT_LOCAL_MACHINE`), so the
//! ciphertext is only decryptable by the same Windows user account on the same
//! machine. `CRYPTPROTECT_UI_FORBIDDEN` guarantees the call never blocks on a
//! prompt — this runs inside a Tauri command, not on a UI thread.
//!
//! This module holds no Tauri types on purpose: it is pure bytes-in/bytes-out
//! so the Win32 surface can be compiled and reviewed on its own.

use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};
use zeroize::Zeroize;

/// A Win32 error code from `GetLastError`.
pub type Win32Error = u32;

/// Owns a `CRYPT_INTEGER_BLOB` that DPAPI allocated for us.
///
/// DPAPI hands back a `LocalAlloc`ed buffer the caller must release. Wrapping it
/// means an early return or a panic while copying the payload out still frees
/// it, and lets the scrub-then-free order live in one place.
struct OutBlob(CRYPT_INTEGER_BLOB);

impl OutBlob {
    fn to_vec(&self) -> Vec<u8> {
        if self.0.pbData.is_null() || self.0.cbData == 0 {
            return Vec::new();
        }
        // SAFETY: only constructed after DPAPI reported success, which means
        // pbData points at cbData initialized bytes.
        unsafe { std::slice::from_raw_parts(self.0.pbData, self.0.cbData as usize) }.to_vec()
    }
}

impl Drop for OutBlob {
    fn drop(&mut self) {
        if self.0.pbData.is_null() {
            return;
        }
        // Scrub first: on the unprotect path this buffer holds the plaintext
        // identity key, and LocalFree does not zero what it releases.
        // SAFETY: as in `to_vec`, plus the range is ours alone to write.
        let bytes =
            unsafe { std::slice::from_raw_parts_mut(self.0.pbData, self.0.cbData as usize) };
        bytes.zeroize();
        // SAFETY: pbData came from DPAPI's LocalAlloc, and `Drop` runs at most
        // once, so it is freed exactly once.
        unsafe { LocalFree(self.0.pbData.cast()) };
    }
}

/// Build an input blob over `buf`.
///
/// `CRYPT_INTEGER_BLOB::pbData` is `*mut u8` even for inputs DPAPI only reads,
/// so callers lend a mutable buffer rather than casting away a `&`.
fn in_blob(buf: &mut [u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: buf.len() as u32,
        pbData: buf.as_mut_ptr(),
    }
}

fn empty_out() -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    }
}

/// Encrypt `plaintext` with the current user's DPAPI master key.
///
/// `entropy` is mixed into the key derivation, so a blob protected for one
/// account cannot be decrypted as another even if the file is edited by hand.
pub fn protect(plaintext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, Win32Error> {
    // Both buffers must be mutable to be addressed by CRYPT_INTEGER_BLOB, and
    // `plaintext` is key material, so these are scrubbed local copies.
    let mut input = plaintext.to_vec();
    let mut entropy = entropy.to_vec();
    let mut out = empty_out();

    let in_b = in_blob(&mut input);
    let ent_b = in_blob(&mut entropy);
    // SAFETY: `in_b`/`ent_b` borrow live, correctly sized buffers that outlive
    // the call; the description, reserved and prompt-struct pointers are null,
    // which the API documents as "not supplied"; `out` is a valid destination
    // that is only read after the return value is checked.
    let ok = unsafe {
        CryptProtectData(
            &in_b,
            std::ptr::null(),
            &ent_b,
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    };

    input.zeroize();
    entropy.zeroize();
    finish(ok, out)
}

/// Inverse of [`protect`]. Fails if the blob was protected by a different user,
/// on a different machine, or with different `entropy`.
pub fn unprotect(ciphertext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, Win32Error> {
    let mut input = ciphertext.to_vec();
    let mut entropy = entropy.to_vec();
    let mut out = empty_out();

    let in_b = in_blob(&mut input);
    let ent_b = in_blob(&mut entropy);
    // SAFETY: as in `protect`. The extra `*mut PWSTR` out-param is the
    // description string, which is null here to decline it.
    let ok = unsafe {
        CryptUnprotectData(
            &in_b,
            std::ptr::null_mut(),
            &ent_b,
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    };

    entropy.zeroize();
    finish(ok, out)
}

/// Turn a Win32 `BOOL` plus its out-blob into a `Result`.
///
/// On failure DPAPI allocates nothing, so there is no blob to release.
fn finish(ok: i32, out: CRYPT_INTEGER_BLOB) -> Result<Vec<u8>, Win32Error> {
    if ok == 0 {
        // SAFETY: no preconditions; reads the calling thread's last error.
        return Err(unsafe { GetLastError() });
    }
    Ok(OutBlob(out).to_vec())
}
