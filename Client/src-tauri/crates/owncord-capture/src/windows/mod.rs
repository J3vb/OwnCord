//! Windows-only capture experiment. This module is never linked into the desktop app.
mod capture;
mod convert;
mod device;
mod encode;

use crate::{LatestQueue, Pacer};
pub use capture::Target;
use capture::{Capture, Frame};
use convert::Converter;
use device::Device;
use encode::{Encoder, Packet, MAX_IN_FLIGHT};
use std::fs::OpenOptions;
use std::io::{BufWriter, Write};
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::*;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Threading::*;
use windows::Win32::System::WinRT::*;
use windows::Win32::UI::HiDpi::*;
use windows::Win32::UI::WindowsAndMessaging::*;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub struct Options {
    pub target: Target,
    pub output: PathBuf,
    pub seconds: u32,
    pub bitrate: u32,
    pub force_dxgi: bool,
    pub software: bool,
}

struct Runtime;
impl Runtime {
    fn new() -> Result<Self> {
        // SAFETY: this CLI owns initialization on its main thread and drops all native resources first.
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED)?;
            if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                RoUninitialize();
                return Err(e.into());
            }
        }
        Ok(Self)
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        // SAFETY: every capture, transform and device has been destroyed before this guard.
        unsafe {
            let _ = MFShutdown();
            RoUninitialize();
        }
    }
}

pub fn list_sources() -> Result<()> {
    let _runtime = Runtime::new()?;
    for (index, output) in capture::outputs()?.iter().enumerate() {
        let end = output
            .desc
            .DeviceName
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(output.desc.DeviceName.len());
        println!(
            "monitor={index} device={} rect={:?}",
            String::from_utf16_lossy(&output.desc.DeviceName[..end]),
            output.desc.DesktopCoordinates
        );
    }
    let mut windows = Vec::<(isize, String)>::new();
    // SAFETY: callback receives a live Vec pointer for the duration of synchronous enumeration.
    unsafe {
        EnumWindows(
            Some(enumerate_window),
            LPARAM(&mut windows as *mut _ as isize),
        )?;
    }
    for (handle, title) in windows {
        println!("hwnd=0x{handle:x} title={title}");
    }
    Ok(())
}
unsafe extern "system" fn enumerate_window(hwnd: HWND, data: LPARAM) -> BOOL {
    // SAFETY: EnumWindows provides a valid handle and the caller supplies the Vec pointer.
    unsafe {
        if IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() {
            let mut text = [0_u16; 512];
            let len = GetWindowTextW(hwnd, &mut text);
            if len > 0 {
                (&mut *(data.0 as *mut Vec<(isize, String)>)).push((
                    hwnd.0 as isize,
                    String::from_utf16_lossy(&text[..len as usize]),
                ));
            }
        }
    }
    true.into()
}

pub fn run(options: Options) -> Result<()> {
    if options.seconds == 0 || options.seconds > 3600 {
        return Err("--seconds must be between 1 and 3600".into());
    }
    if options.bitrate < 100_000 || options.bitrate > 100_000_000 {
        return Err("--bitrate must be between 100000 and 100000000 bits/s".into());
    }
    if options.output.extension().and_then(|s| s.to_str()) != Some("h264") {
        return Err("output must have the .h264 extension".into());
    }
    let _runtime = Runtime::new()?;
    // SAFETY: the standalone process sets physical-pixel coordinates before any capture begins.
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)?;
    }
    let output = options.target.output()?;
    // SAFETY: the selected adapter is owned for the duration of capture.
    let adapter = unsafe { output.adapter.GetDesc1()? };
    let end = adapter
        .Description
        .iter()
        .position(|c| *c == 0)
        .unwrap_or(adapter.Description.len());
    eprintln!(
        "gpu={} vendor=0x{:04x} device=0x{:04x}",
        String::from_utf16_lossy(&adapter.Description[..end]),
        adapter.VendorId,
        adapter.DeviceId
    );
    let gpu = Device::new(&output.adapter)?;
    let mut capture = Capture::new(options.target, &output, &gpu, options.force_dxgi)?;
    let first = match first_frame(&mut capture, &gpu) {
        Ok(frame) => frame,
        Err(e) if !options.force_dxgi && matches!(capture, Capture::Wgc(_)) => {
            eprintln!("WGC produced no usable first frame: {e}; trying DXGI");
            capture = Capture::new(options.target, &output, &gpu, true)?;
            first_frame(&mut capture, &gpu)?
        }
        Err(e) => return Err(e),
    };
    let size = first
        .size
        .h264_output()
        .ok_or("source cannot fit valid H.264 dimensions")?;
    let converter = Converter::new(&gpu, first.size, size)?;
    let mut encoder = Encoder::new(&gpu, size, options.bitrate, options.software)?;
    eprintln!("encoder={} hardware={} gpu_input={} source={}x{} output={}x{} target_fps=60 max_in_flight={MAX_IN_FLIGHT} queue_capacity=2 gpu_pct=unavailable",
        encoder.name, encoder.hardware, encoder.hardware, first.size.width, first.size.height, size.width, size.height);
    // create_new prevents an accidental overwrite of an earlier measurement.
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&options.output)?;
    let mut writer = BufWriter::new(file);
    let mut queue = LatestQueue::new(NonZeroUsize::new(2).ok_or("invalid queue capacity")?);
    queue.push(first);
    let mut latest: Option<Frame> = None;
    let started = Instant::now();
    let cpu = Cpu::new()?;
    let mut pacer = Pacer::new(60).ok_or("invalid output fps")?;
    let mut encoded = 0_u64;
    let mut encoder_skipped = 0_u64;
    let mut last_submitted_capture = None;
    let duration = Duration::from_secs(u64::from(options.seconds));
    while started.elapsed() < duration {
        if let Some(frame) = capture.poll(&gpu)? {
            queue.push(frame);
        }
        encoder.poll_events()?;
        write_packets(
            &mut encoder,
            &mut writer,
            &mut encoded,
            started,
            queue.dropped(),
            encoder_skipped,
            pacer.missed(),
            &cpu,
        )?;
        if let Err(error) = encoder.check_progress() {
            if encoder.hardware && encoded == 0 {
                eprintln!("hardware encoder startup failed: {error}; switching to software before first output");
                encoder_skipped += encoder.pending() as u64;
                drop(encoder);
                encoder = Encoder::new(&gpu, size, options.bitrate, true)?;
                eprintln!(
                    "encoder={} hardware=false gpu_input=false startup_fallback=true",
                    encoder.name
                );
                last_submitted_capture = None;
            } else {
                return Err(format!("{error}; retry with --software").into());
            }
        }
        if let Some(slot) = pacer.poll(started.elapsed()) {
            if let Some(frame) = queue.take_latest() {
                latest = Some(frame);
            }
            if !encoder.ready() {
                encoder_skipped += 1;
            } else if let Some(frame) = &latest {
                let texture = converter
                    .convert(&gpu, &frame.texture)
                    .map_err(|e| format!("GPU color conversion: {e}"))?;
                let timestamp = (u128::from(slot) * 10_000_000 / 60) as i64;
                let reused = last_submitted_capture == Some(frame.captured);
                if !encoder
                    .submit(&gpu, &texture, frame.captured, timestamp, reused)
                    .map_err(|e| format!("encoder input: {e}"))?
                {
                    encoder_skipped += 1;
                } else {
                    last_submitted_capture = Some(frame.captured);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    encoder.drain()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        encoder.poll_events()?;
        write_packets(
            &mut encoder,
            &mut writer,
            &mut encoded,
            started,
            queue.dropped(),
            encoder_skipped,
            pacer.missed(),
            &cpu,
        )?;
        if encoder.drain_complete() {
            break;
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "encoder drain timed out with {} frames in flight",
                encoder.pending()
            )
            .into());
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    writer.flush()?;
    writer.get_ref().sync_all()?;
    if encoded == 0 {
        return Err("encoder produced no frames".into());
    }
    eprintln!("summary frames={encoded} fps={:.2} queue_dropped={} encoder_skipped={encoder_skipped} missed_slots={} cpu_one_core_pct={:.2} gpu_pct=unavailable",
        encoded as f64 / started.elapsed().as_secs_f64(), queue.dropped(), pacer.missed(), cpu.percent()?);
    Ok(())
}

fn first_frame(capture: &mut Capture, gpu: &Device) -> Result<Frame> {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Some(frame) = capture.poll(gpu)? {
            return Ok(frame);
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    Err("no capture frame within five seconds".into())
}

#[allow(clippy::too_many_arguments)]
fn write_packets(
    encoder: &mut Encoder,
    writer: &mut impl Write,
    encoded: &mut u64,
    started: Instant,
    dropped: u64,
    skipped: u64,
    missed: u64,
    cpu: &Cpu,
) -> Result<()> {
    for _ in 0..8 {
        let Some(Packet {
            bytes,
            captured,
            timestamp,
            encode_ms,
            reused_capture,
        }) = encoder
            .output()
            .map_err(|e| format!("encoder output: {e}"))?
        else {
            break;
        };
        let latency = captured.elapsed().as_secs_f64() * 1000.0;
        writer.write_all(&bytes)?;
        *encoded += 1;
        println!("frame={} pts_100ns={timestamp} capture_to_encoded_ms={latency:.3} encode_ms={encode_ms:.3} reused_capture={reused_capture} fps={:.2} queue_dropped={dropped} encoder_skipped={skipped} missed_slots={missed} cpu_one_core_pct={:.2} gpu_pct=unavailable bytes={}",
            *encoded, *encoded as f64 / started.elapsed().as_secs_f64(), cpu.percent()?, bytes.len());
    }
    Ok(())
}
struct Cpu {
    ticks: u64,
    started: Instant,
}
impl Cpu {
    fn new() -> Result<Self> {
        Ok(Self {
            ticks: process_ticks()?,
            started: Instant::now(),
        })
    }
    fn percent(&self) -> Result<f64> {
        Ok(process_ticks()?.saturating_sub(self.ticks) as f64
            / 100_000.0
            / self.started.elapsed().as_secs_f64().max(0.000001))
    }
}
fn process_ticks() -> Result<u64> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: the pseudo process handle is borrowed and all FILETIME pointers are valid.
    unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )?;
    }
    Ok(
        ((u64::from(kernel.dwHighDateTime) << 32) | u64::from(kernel.dwLowDateTime))
            + ((u64::from(user.dwHighDateTime) << 32) | u64::from(user.dwLowDateTime)),
    )
}
