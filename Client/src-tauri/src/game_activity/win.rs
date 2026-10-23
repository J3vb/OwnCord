//! The Windows process list and Steam's registry location.
//!
//! Uses `windows-sys` like `windows_app_audio.rs`'s Toolhelp walk, which
//! already carries the `Win32_System_Diagnostics_ToolHelp` feature.

use std::path::PathBuf;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::{filetime_to_unix_ms, Proc};

/// Longest image path asked for, in UTF-16 units (the extended-length limit).
const MAX_IMAGE_PATH: usize = 32_768;

/// Every process in a Toolhelp snapshot. The image path and start time come
/// from a `PROCESS_QUERY_LIMITED_INFORMATION` handle; where the OS refuses
/// one (protected processes, some Microsoft Store games) the snapshot's
/// program name stands in for the path and the start time is "now", which
/// sorts such a process after every one whose start time is known. The caller
/// keeps the first start time it saw for a running game, so that "now" does
/// not move the answer on every poll.
pub(super) fn processes() -> Option<Vec<Proc>> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
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
                let mut started_at_ms = now_ms;
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
