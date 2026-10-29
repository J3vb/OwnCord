//! The Windows process list, Steam's registry location and the GOG and
//! Battle.net registry keys.
//!
//! Uses `windows-sys` like `windows_app_audio.rs`'s Toolhelp walk, which
//! already carries the `Win32_System_Diagnostics_ToolHelp` feature.

use std::path::PathBuf;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_MORE_DATA, FILETIME, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER,
    HKEY_LOCAL_MACHINE, KEY_ENUMERATE_SUB_KEYS, KEY_QUERY_VALUE, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
    RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::launchers::RegKey;
use super::{filetime_to_unix_ms, Proc, UNKNOWN_START};

/// Longest image path asked for, in UTF-16 units (the extended-length limit).
const MAX_IMAGE_PATH: usize = 32_768;

/// Every process in a Toolhelp snapshot. The image path and start time come
/// from a `PROCESS_QUERY_LIMITED_INFORMATION` handle; where the OS refuses
/// one (protected processes, some Microsoft Store games) the snapshot's
/// program name stands in for the path and the start time is UNKNOWN_START,
/// which sorts such a process after every one whose start time is known. The
/// caller keeps the first start time it showed for that game, so the answer
/// does not move on every poll.
pub(super) fn processes() -> Option<Vec<Proc>> {
    let mut path_buf = vec![0u16; MAX_IMAGE_PATH];
    let mut procs = Vec::new();
    // SAFETY: the snapshot handle is checked, used only by the two Process32
    // calls below with a correctly sized entry, and closed. Each process
    // handle is closed on every path out of the block that opens it, and the
    // out-pointers passed to the queries outlive the calls.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            if entry.th32ProcessID != 0 {
                let exe_len = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let exe_name = String::from_utf16_lossy(&entry.szExeFile[..exe_len]);
                let mut full_path = None;
                let mut started_at_ms = UNKNOWN_START;
                let process =
                    OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                if !process.is_null() {
                    let mut len = path_buf.len() as u32;
                    if QueryFullProcessImageNameW(process, 0, path_buf.as_mut_ptr(), &mut len) != 0
                    {
                        full_path = Some(String::from_utf16_lossy(&path_buf[..len as usize]));
                    }
                    let zero = FILETIME {
                        dwLowDateTime: 0,
                        dwHighDateTime: 0,
                    };
                    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
                    if GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user)
                        != 0
                    {
                        let ticks = (u64::from(created.dwHighDateTime) << 32)
                            | u64::from(created.dwLowDateTime);
                        started_at_ms = filetime_to_unix_ms(ticks);
                    }
                    CloseHandle(process);
                }
                let path = full_path.as_deref().unwrap_or(&exe_name);
                // The command line is not read: that needs PROCESS_VM_READ,
                // which anti-cheat flags, so `args` rules never match here.
                procs.push(Proc::new(&[path], "", started_at_ms));
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    Some(procs)
}

/// `HKCU\Software\Valve\Steam\SteamPath`, Steam's install folder.
pub(super) fn steam_path_from_registry() -> Option<PathBuf> {
    let subkey: Vec<u16> = "Software\\Valve\\Steam\0".encode_utf16().collect();
    let value: Vec<u16> = "SteamPath\0".encode_utf16().collect();
    let mut buf = vec![0u16; 1024];
    let mut bytes = (buf.len() * 2) as u32;
    // SAFETY: both names are NUL-terminated, and `buf` holds `bytes` bytes.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            null_mut(),
            buf.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    if status != 0 {
        return None;
    }
    let units = (bytes as usize / 2).min(buf.len());
    let path = String::from_utf16_lossy(&buf[..units]);
    let path = path.trim_end_matches('\0');
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// The most subkeys read under one registry parent.
const MAX_SUBKEYS: u32 = 4096;
/// Longest registry value read, in UTF-16 units.
const MAX_VALUE_UNITS: usize = 4096;

/// Registry parents holding the games of GOG Galaxy and Battle.net, and the
/// string values read from each of their subkeys.
const REGISTRY_PARENTS: &[(&str, &[&str])] = &[
    ("Software\\GOG.com\\Games", &["gameName", "path"]),
    (
        "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        &[
            "DisplayName",
            "InstallLocation",
            "Publisher",
            "UninstallString",
        ],
    ),
];

/// A NUL-terminated UTF-16 copy of `text`.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A string value (`REG_SZ` or `REG_EXPAND_SZ`, expanded) of `subkey` under an
/// open key; `None` when absent, not a string or too long.
fn read_string(parent: HKEY, subkey: &[u16], value: &str) -> Option<String> {
    let name = wide(value);
    let mut buf = vec![0u16; MAX_VALUE_UNITS];
    let mut bytes = (buf.len() * 2) as u32;
    // SAFETY: `subkey` and `name` are NUL-terminated, `parent` is an open key
    // and `buf` holds `bytes` bytes.
    let status = unsafe {
        RegGetValueW(
            parent,
            subkey.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
            null_mut(),
            buf.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    if status != 0 {
        return None;
    }
    let units = (bytes as usize / 2).min(buf.len());
    let text = String::from_utf16_lossy(&buf[..units]);
    Some(text.trim_end_matches('\0').to_string())
}

/// The subkeys of `parent_path` under HKLM, seen through one registry view
/// (`KEY_WOW64_32KEY` or `KEY_WOW64_64KEY`), each with the named string values.
fn read_view(parent_path: &str, values: &[&str], view: u32) -> Vec<RegKey> {
    let path = wide(parent_path);
    let mut parent: HKEY = null_mut();
    // SAFETY: `path` is NUL-terminated and `parent` outlives the call; it is
    // closed below on every path after a successful open.
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            path.as_ptr(),
            0,
            KEY_ENUMERATE_SUB_KEYS | KEY_QUERY_VALUE | view,
            &mut parent,
        )
    };
    if status != 0 {
        return Vec::new();
    }
    let mut keys = Vec::new();
    for index in 0..MAX_SUBKEYS {
        let mut name = vec![0u16; 256];
        let mut len = name.len() as u32;
        // SAFETY: `parent` is open, `name` holds `len` units, and the unused
        // out-pointers are null as the API allows.
        let status = unsafe {
            RegEnumKeyExW(
                parent,
                index,
                name.as_mut_ptr(),
                &mut len,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
            )
        };
        // ERROR_MORE_DATA: a subkey name longer than any game's key; skip it
        // rather than stop the walk. Anything else (ERROR_NO_MORE_ITEMS) ends it.
        if status == ERROR_MORE_DATA {
            continue;
        }
        if status != 0 {
            break;
        }
        let units = (len as usize).min(name.len() - 1);
        let sub = String::from_utf16_lossy(&name[..units]);
        let sub_wide = wide(&sub);
        let found: Vec<(String, String)> = values
            .iter()
            .filter_map(|v| Some(((*v).to_string(), read_string(parent, &sub_wide, v)?)))
            .collect();
        keys.push(RegKey {
            path: format!("{parent_path}\\{sub}"),
            values: found,
        });
    }
    // SAFETY: `parent` was opened above and is closed once.
    unsafe { RegCloseKey(parent) };
    keys
}

/// The GOG Galaxy and Battle.net keys of HKLM, in both registry views. Keys
/// with no readable values are kept (the pure readers skip them).
pub(super) fn registry_keys() -> Vec<RegKey> {
    let mut keys: Vec<RegKey> = Vec::new();
    for (parent, values) in REGISTRY_PARENTS {
        for view in [KEY_WOW64_32KEY, KEY_WOW64_64KEY] {
            for key in read_view(parent, values, view) {
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
        }
    }
    keys
}
