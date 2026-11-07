use super::{device::Device, Result};
use crate::Dimensions;
use std::time::{Duration, Instant};
use windows::core::{factory, Interface};
use windows::Graphics::Capture::*;
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dwm::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Performance::*;
use windows::Win32::System::WinRT::Direct3D11::*;
use windows::Win32::System::WinRT::Graphics::Capture::*;
use windows::Win32::UI::WindowsAndMessaging::*;

#[derive(Clone, Copy, Debug)]
pub enum Target {
    Monitor(usize),
    Window(isize),
}

pub struct Output {
    pub adapter: IDXGIAdapter1,
    pub output: IDXGIOutput1,
    pub desc: DXGI_OUTPUT_DESC,
}

pub fn outputs() -> Result<Vec<Output>> {
    // SAFETY: enumeration owns every returned COM reference; NOT_FOUND terminates each list.
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
        let mut outputs = Vec::new();
        let mut a = 0;
        loop {
            let adapter = match factory.EnumAdapters1(a) {
                Ok(adapter) => adapter,
                Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(e) => return Err(e.into()),
            };
            a += 1;
            let mut o = 0;
            loop {
                let output = match adapter.EnumOutputs(o) {
                    Ok(output) => output,
                    Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                    Err(e) => return Err(e.into()),
                };
                o += 1;
                let desc = output.GetDesc()?;
                if desc.AttachedToDesktop.as_bool() {
                    outputs.push(Output {
                        adapter: adapter.clone(),
                        output: output.cast()?,
                        desc,
                    });
                }
            }
        }
        Ok(outputs)
    }
}

impl Target {
    pub fn output(self) -> Result<Output> {
        let mut all = outputs()?;
        match self {
            Self::Monitor(index) if index < all.len() => Ok(all.remove(index)),
            Self::Monitor(_) => Err("monitor index is not present; use --list".into()),
            Self::Window(value) => {
                let hwnd = HWND(value as *mut _);
                // SAFETY: Win32 validates this external window handle; no process memory is accessed.
                let monitor = unsafe {
                    if !IsWindow(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                        return Err("window is missing or minimized".into());
                    }
                    MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
                };
                all.into_iter()
                    .find(|o| o.desc.Monitor == monitor)
                    .ok_or("window monitor is unavailable".into())
            }
        }
    }
}

pub struct Frame {
    pub texture: ID3D11Texture2D,
    pub captured: Instant,
    pub size: Dimensions,
}

struct Clock {
    frequency: i64,
}
impl Clock {
    fn new() -> Result<Self> {
        let mut frequency = 0;
        // SAFETY: a valid output pointer is supplied to the monotonic clock query.
        unsafe {
            QueryPerformanceFrequency(&mut frequency)?;
        }
        if frequency <= 0 {
            return Err("invalid performance-counter frequency".into());
        }
        Ok(Self { frequency })
    }
    fn instant(&self, timestamp: i64, units: i64) -> Result<Instant> {
        let mut now = 0;
        // SAFETY: a valid output pointer is supplied to the monotonic clock query.
        unsafe {
            QueryPerformanceCounter(&mut now)?;
        }
        let age_ns = ((i128::from(now) * 1_000_000_000 / i128::from(self.frequency))
            - (i128::from(timestamp) * 1_000_000_000 / i128::from(units)))
        .max(0)
        .min(i128::from(u64::MAX)) as u64;
        Ok(Instant::now()
            .checked_sub(Duration::from_nanos(age_ns))
            .ok_or("capture timestamp out of range")?)
    }
}

pub enum Capture {
    Wgc(Wgc),
    Duplication(Duplication),
}
impl Capture {
    pub fn new(target: Target, output: &Output, gpu: &Device, force_dxgi: bool) -> Result<Self> {
        if !force_dxgi {
            match Wgc::new(target, output, gpu) {
                Ok(wgc) => {
                    eprintln!("capture=wgc");
                    return Ok(Self::Wgc(wgc));
                }
                Err(e) => eprintln!("WGC unavailable: {e}; trying DXGI Desktop Duplication"),
            }
        }
        if matches!(target, Target::Window(_)) {
            eprintln!("capture=dxgi window_crop=true occluding_windows_visible=true");
        } else {
            eprintln!("capture=dxgi");
        }
        Ok(Self::Duplication(Duplication::new(target, output, gpu)?))
    }
    pub fn poll(&mut self, gpu: &Device) -> Result<Option<Frame>> {
        match self {
            Self::Wgc(c) => c.poll(gpu),
            Self::Duplication(c) => c.poll(gpu),
        }
    }
}

pub struct Wgc {
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    clock: Clock,
    size: Dimensions,
}
impl Wgc {
    fn new(target: Target, output: &Output, gpu: &Device) -> Result<Self> {
        if !GraphicsCaptureSession::IsSupported()? {
            return Err("Windows Graphics Capture is unsupported".into());
        }
        let interop: IGraphicsCaptureItemInterop =
            factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        // SAFETY: handles are selected from attached monitors or validated by Target::output.
        let item: GraphicsCaptureItem = unsafe {
            match target {
                Target::Monitor(_) => interop.CreateForMonitor(output.desc.Monitor)?,
                Target::Window(hwnd) => interop.CreateForWindow(HWND(hwnd as *mut _))?,
            }
        };
        let size = item.Size()?;
        if size.Width < 2 || size.Height < 2 {
            return Err("capture source is too small".into());
        }
        let dxgi: IDXGIDevice = gpu.device.cast()?;
        // SAFETY: this wraps the owned D3D11 device as the WinRT device required by WGC.
        let device: IDirect3DDevice =
            unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size,
        )?;
        let session = pool.CreateCaptureSession(&item)?;
        session.StartCapture()?;
        Ok(Self {
            pool,
            session,
            clock: Clock::new()?,
            size: Dimensions {
                width: size.Width as u32,
                height: size.Height as u32,
            },
        })
    }
    fn poll(&mut self, gpu: &Device) -> Result<Option<Frame>> {
        let frame = match self.pool.TryGetNextFrame() {
            Ok(frame) => frame,
            Err(e) if e.code() == E_BOUNDS || e.code() == E_POINTER || e.code() == S_OK => {
                return Ok(None)
            }
            Err(e) => return Err(e.into()),
        };
        let result = (|| {
            let size = frame.ContentSize()?;
            if size.Width != self.size.width as i32 || size.Height != self.size.height as i32 {
                return Err(
                    "source resized; stop and restart capture to renegotiate encoder dimensions"
                        .into(),
                );
            }
            let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
            // SAFETY: WGC owns the surface until Close; the GPU copy occurs before releasing it.
            let source: ID3D11Texture2D = unsafe { access.GetInterface()? };
            let texture = gpu.copy_region(
                &source,
                D3D11_BOX {
                    right: self.size.width,
                    bottom: self.size.height,
                    back: 1,
                    ..Default::default()
                },
            )?;
            let captured = self
                .clock
                .instant(frame.SystemRelativeTime()?.Duration, 10_000_000)?;
            Ok(Some(Frame {
                texture,
                captured,
                size: self.size,
            }))
        })();
        frame.Close()?;
        result
    }
}
impl Drop for Wgc {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

pub struct Duplication {
    duplication: IDXGIOutputDuplication,
    target: Target,
    monitor_rect: RECT,
    clock: Clock,
    size: Option<Dimensions>,
}
impl Duplication {
    fn new(target: Target, output: &Output, gpu: &Device) -> Result<Self> {
        if output.desc.Rotation != DXGI_MODE_ROTATION_IDENTITY {
            return Err("DXGI rotated-monitor capture is not implemented; use WGC".into());
        }
        // SAFETY: the device was created on the selected output's adapter.
        let duplication = unsafe { output.output.DuplicateOutput(&gpu.device)? };
        Ok(Self {
            duplication,
            target,
            monitor_rect: output.desc.DesktopCoordinates,
            clock: Clock::new()?,
            size: None,
        })
    }
    fn region(&self) -> Result<D3D11_BOX> {
        let mut rect = self.monitor_rect;
        if let Target::Window(hwnd) = self.target {
            // SAFETY: Win32 validates the handle and writes only to the supplied rectangle.
            unsafe {
                let hwnd = HWND(hwnd as *mut _);
                if IsIconic(hwnd).as_bool() {
                    return Err("window minimized during DXGI capture".into());
                }
                DwmGetWindowAttribute(
                    hwnd,
                    DWMWA_EXTENDED_FRAME_BOUNDS,
                    (&mut rect as *mut RECT).cast(),
                    std::mem::size_of::<RECT>() as u32,
                )?;
            }
            if rect.left < self.monitor_rect.left
                || rect.top < self.monitor_rect.top
                || rect.right > self.monitor_rect.right
                || rect.bottom > self.monitor_rect.bottom
            {
                return Err("DXGI window crop must fit entirely inside one monitor".into());
            }
        }
        Ok(D3D11_BOX {
            left: (rect.left - self.monitor_rect.left) as u32,
            top: (rect.top - self.monitor_rect.top) as u32,
            right: (rect.right - self.monitor_rect.left) as u32,
            bottom: (rect.bottom - self.monitor_rect.top) as u32,
            front: 0,
            back: 1,
        })
    }
    fn poll(&mut self, gpu: &Device) -> Result<Option<Frame>> {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource = None;
        // SAFETY: acquisition is nonblocking and every successful acquisition is released below.
        match unsafe {
            self.duplication
                .AcquireNextFrame(0, &mut info, &mut resource)
        } {
            Ok(()) => {}
            Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(None),
            Err(e) => {
                return Err(format!(
                    "DXGI acquisition failed (restart after display/device changes): {e}"
                )
                .into())
            }
        }
        let result = (|| {
            if info.LastPresentTime == 0 {
                return Ok(None);
            }
            let source: ID3D11Texture2D = resource.ok_or("DXGI returned no resource")?.cast()?;
            let region = self.region()?;
            let size = Dimensions {
                width: region.right - region.left,
                height: region.bottom - region.top,
            };
            if self.size.is_some_and(|old| old != size) {
                return Err("source resized; restart capture".into());
            }
            self.size = Some(size);
            let texture = gpu.copy_region(&source, region)?;
            let captured = self
                .clock
                .instant(info.LastPresentTime, self.clock.frequency)?;
            Ok(Some(Frame {
                texture,
                captured,
                size,
            }))
        })();
        // SAFETY: acquisition above succeeded; release even when the copy or validation failed.
        let release = unsafe { self.duplication.ReleaseFrame() };
        release?;
        result
    }
}
