//! Windows half of the music share: the default output's audio sessions, each
//! app's name and icon, and the check that a picked pid is still the app that
//! was listed.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;

use windows::core::Interface as _;
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, AudioSessionStateActive, AudioSessionStateExpired, IAudioSessionControl2,
    IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows_sys::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Shell::ExtractIconExW;
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

use super::icon_png::icon_data_url;
use super::music::{
    assemble_apps, check_music_target, exe_file_name, exe_stem, exe_unchanged, group_sessions,
    AudioSession, Listing,
};
use super::windows_impl::parent_map;
use super::{own_process_ancestors, own_process_tree};

// -- music share: sessions, names, icons ----------------------------------

/// Balances a successful `CoInitializeEx` on this thread. A thread that
/// already has a different apartment (`RPC_E_CHANGED_MODE`) still has
/// COM, so that case is not an error and is not uninitialised.
struct ComGuard(bool);

impl ComGuard {
    fn init() -> Self {
        // SAFETY: balanced by CoUninitialize in Drop when it succeeded.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        Self(hr.is_ok())
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: matches the successful CoInitializeEx in `init`.
            unsafe { CoUninitialize() };
        }
    }
}

/// Every live session on the default render endpoint. Expired sessions
/// (no stream left) and system sounds are left out.
fn enumerate_sessions() -> windows::core::Result<Vec<AudioSession>> {
    // SAFETY: COM calls on interfaces this thread created; each result
    // is checked and every interface is released on drop.
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
        let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
        let sessions = manager.GetSessionEnumerator()?;
        let count = sessions.GetCount()?;
        let mut out = Vec::new();
        for index in 0..count {
            // One session that fails to answer must not hide the rest.
            let Ok(control) = sessions.GetSession(index) else {
                continue;
            };
            let Ok(state) = control.GetState() else {
                continue;
            };
            if state == AudioSessionStateExpired {
                continue;
            }
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                continue;
            };
            let Ok(pid) = control2.GetProcessId() else {
                continue;
            };
            out.push(AudioSession {
                pid,
                playing: state == AudioSessionStateActive,
            });
        }
        Ok(out)
    }
}

fn to_wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The full image path of a process, if it can be opened for query.
fn exe_path(pid: u32) -> Option<String> {
    // SAFETY: the handle is checked, used for one query with a buffer
    // whose length is passed, and closed.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 32_768];
        let mut len = buf.len() as u32;
        let named = QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut len) != 0;
        windows_sys::Win32::Foundation::CloseHandle(process);
        named.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// One string of the version resource, e.g. `FileDescription`.
fn version_string(block: &[u32], lang: u16, codepage: u16, key: &str) -> Option<String> {
    let sub = to_wide(&format!(
        "\\StringFileInfo\\{lang:04x}{codepage:04x}\\{key}"
    ));
    let mut value: *mut c_void = std::ptr::null_mut();
    let mut chars = 0u32;
    // SAFETY: `block` is a version block filled by GetFileVersionInfoW;
    // the returned pointer, when set, points into it for `chars` UTF-16
    // units and is copied before `block` goes away. `block` is a `u32`
    // slice only so that it starts 4-byte aligned, as the version API expects.
    let found =
        unsafe { VerQueryValueW(block.as_ptr().cast(), sub.as_ptr(), &mut value, &mut chars) != 0 };
    if !found || value.is_null() || chars == 0 {
        return None;
    }
    // SAFETY: see above; the unit count includes the terminator. Units are
    // read one by one, unaligned, so no `&[u16]` is formed over a pointer that
    // may not be 2-byte aligned.
    let units: Vec<u16> = (0..chars as usize)
        .map(|i| unsafe { (value as *const u16).add(i).read_unaligned() })
        .take_while(|&unit| unit != 0)
        .collect();
    let text = String::from_utf16_lossy(&units).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// The exe's `FileDescription`, if it has one.
fn file_description(path: &str) -> Option<String> {
    let wide = to_wide(path);
    let mut handle = 0u32;
    // SAFETY: plain queries on a NUL-terminated path; the buffer is sized
    // by the first call and passed with its length to the second.
    let block = unsafe {
        let size = GetFileVersionInfoSizeW(wide.as_ptr(), &mut handle);
        if size == 0 || size > 4 * 1024 * 1024 {
            return None;
        }
        // Whole u32s: the block is 4-byte aligned and at least `size` bytes.
        let mut block = vec![0u32; (size as usize).div_ceil(4)];
        if GetFileVersionInfoW(wide.as_ptr(), 0, size, block.as_mut_ptr().cast()) == 0 {
            return None;
        }
        block
    };
    // The file's own (language, codepage) pairs first, then the two the
    // common toolchains write.
    let mut pairs: Vec<(u16, u16)> = Vec::new();
    let sub = to_wide("\\VarFileInfo\\Translation");
    let mut value: *mut c_void = std::ptr::null_mut();
    let mut bytes = 0u32;
    // SAFETY: as in `version_string`; the translation table is `bytes`
    // bytes of (u16, u16) pairs, read as plain bytes.
    unsafe {
        if VerQueryValueW(block.as_ptr().cast(), sub.as_ptr(), &mut value, &mut bytes) != 0
            && !value.is_null()
        {
            let raw = std::slice::from_raw_parts(value as *const u8, bytes as usize);
            for pair in raw.as_chunks::<4>().0 {
                pairs.push((
                    u16::from_le_bytes([pair[0], pair[1]]),
                    u16::from_le_bytes([pair[2], pair[3]]),
                ));
            }
        }
    }
    pairs.extend([(0x0409, 0x04B0), (0x0409, 0x04E4)]);
    pairs
        .into_iter()
        .find_map(|(lang, cp)| version_string(&block, lang, cp, "FileDescription"))
}

/// Pixels of one bitmap as top-down 32-bit BGRA.
///
/// # Safety
/// `hdc` and `bitmap` must be live GDI handles.
unsafe fn bitmap_bgra(hdc: HDC, bitmap: HBITMAP, w: usize, h: usize) -> Option<Vec<u8>> {
    let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
    info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = w as i32;
    info.bmiHeader.biHeight = -(h as i32);
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    let mut buf = vec![0u8; w * h * 4];
    // SAFETY: `buf` holds w*h 32-bit pixels, the size `info` describes.
    let lines = unsafe {
        GetDIBits(
            hdc,
            bitmap,
            0,
            h as u32,
            buf.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    (lines == h as i32).then_some(buf)
}

/// The exe's first icon at the system's large size (32x32, more at high
/// DPI), as a 32x32 PNG data URL. Best effort: `None` on any failure.
fn icon_url(path: &str) -> Option<String> {
    let wide = to_wide(path);
    let mut large: HICON = std::ptr::null_mut();
    // SAFETY: `wide` is NUL-terminated; `large` is a valid out pointer
    // for the one icon asked for; the icon is destroyed below.
    let got = unsafe { ExtractIconExW(wide.as_ptr(), 0, &mut large, std::ptr::null_mut(), 1) };
    if got == 0 || large.is_null() {
        return None;
    }
    let url = icon_pixels(large)
        .and_then(|(w, h, color, mask)| icon_data_url(w, h, &color, mask.as_deref()));
    // SAFETY: destroying the icon ExtractIconExW created, once.
    unsafe {
        DestroyIcon(large);
    }
    url
}

/// Width, height, colour pixels and, when present, mask pixels of an icon.
type IconPixels = (usize, usize, Vec<u8>, Option<Vec<u8>>);

fn icon_pixels(icon: HICON) -> Option<IconPixels> {
    // SAFETY: GDI calls on handles GetIconInfo gave us, all released
    // before returning; the screen DC is released too.
    unsafe {
        let mut info: ICONINFO = std::mem::zeroed();
        if GetIconInfo(icon, &mut info) == 0 {
            return None;
        }
        let result = (|| {
            if info.hbmColor.is_null() {
                return None;
            }
            let mut bmp: BITMAP = std::mem::zeroed();
            let size = std::mem::size_of::<BITMAP>() as i32;
            if GetObjectW(info.hbmColor, size, (&mut bmp as *mut BITMAP).cast()) == 0 {
                return None;
            }
            let (w, h) = (bmp.bmWidth as usize, bmp.bmHeight as usize);
            if w == 0 || h == 0 || w > 256 || h > 256 {
                return None;
            }
            let hdc = GetDC(std::ptr::null_mut());
            if hdc.is_null() {
                return None;
            }
            let color = bitmap_bgra(hdc, info.hbmColor, w, h);
            let mask = if info.hbmMask.is_null() {
                None
            } else {
                bitmap_bgra(hdc, info.hbmMask, w, h)
            };
            ReleaseDC(std::ptr::null_mut(), hdc);
            Some((w, h, color?, mask))
        })();
        DeleteObject(info.hbmColor);
        if !info.hbmMask.is_null() {
            DeleteObject(info.hbmMask);
        }
        result
    }
}

/// Executable paths by pid, so a process is opened once per listing.
#[derive(Default)]
struct ExePaths(RefCell<HashMap<u32, Option<String>>>);

impl ExePaths {
    fn get(&self, pid: u32) -> Option<String> {
        self.0
            .borrow_mut()
            .entry(pid)
            .or_insert_with(|| exe_path(pid))
            .clone()
    }
}

/// A root process's display name and icon.
fn describe(paths: &ExePaths, pid: u32) -> (String, Option<String>) {
    let path = paths.get(pid);
    let name = path
        .as_deref()
        .and_then(file_description)
        .or_else(|| path.as_deref().and_then(exe_stem))
        .unwrap_or_else(|| format!("Process {pid}"));
    (name, path.as_deref().and_then(icon_url))
}

/// The apps with a session on the default output, one row per app, and each
/// row's executable name for the pid check at start.
pub fn list_apps() -> Result<Listing, String> {
    let _com = ComGuard::init();
    let sessions = enumerate_sessions().map_err(|e| {
        log::warn!("[app_audio] listing audio sessions: {e}");
        "internal".to_string()
    })?;
    let parents = parent_map()?;
    let me = std::process::id();
    let own = own_process_tree(me, &parents);
    let ancestors = own_process_ancestors(me, &parents);
    let paths = ExePaths::default();
    let groups = group_sessions(
        &sessions,
        &parents,
        |pid| paths.get(pid).as_deref().and_then(exe_file_name),
        &own,
        &ancestors,
    );
    let exes = groups
        .iter()
        .map(|group| {
            let exe = paths.get(group.root_pid);
            (
                group.root_pid,
                exe.as_deref().and_then(exe_file_name).unwrap_or_default(),
            )
        })
        .collect();
    let apps = assemble_apps(&groups, |pid| describe(&paths, pid));
    Ok(Listing { apps, exes })
}

/// Check a picked app's root pid is still there, is not OwnCord, and still
/// runs the executable the listing saw (`listed`; a pid freed by an app that
/// quit may have been reused by another program).
pub fn resolve_music_pid(pid: u32, listed: Option<String>) -> Result<u32, String> {
    let parents = parent_map()?;
    let me = std::process::id();
    let own = own_process_tree(me, &parents);
    let ancestors = own_process_ancestors(me, &parents);
    check_music_target(pid, &parents, &own, &ancestors).map_err(str::to_string)?;
    let current = exe_path(pid)
        .as_deref()
        .and_then(exe_file_name)
        .unwrap_or_default();
    exe_unchanged(listed.as_deref(), &current).map_err(str::to_string)?;
    Ok(pid)
}
