use super::{device::Device, Result};
use crate::Dimensions;
use std::collections::BTreeMap;
use std::mem::ManuallyDrop;
use std::time::{Duration, Instant};
use windows::core::{Interface, GUID, PWSTR, VARIANT};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_NV12;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::*;

const SOFTWARE_ENCODER: GUID = GUID::from_u128(0x6ca50344_051a_4ded_9779_a43305165e35);
// Allow hardware encoder priming while keeping input ownership strictly bounded.
pub(super) const MAX_IN_FLIGHT: usize = 4;

pub struct Packet {
    pub bytes: Vec<u8>,
    pub captured: Instant,
    pub timestamp: i64,
    pub encode_ms: f64,
    pub reused_capture: bool,
}
struct Pending {
    captured: Instant,
    submitted: Instant,
    reused_capture: bool,
}

pub struct Encoder {
    transform: IMFTransform,
    manager: Option<IMFDXGIDeviceManager>,
    events: Option<IMFMediaEventGenerator>,
    input_credits: u32,
    output_credits: u32,
    pending: BTreeMap<i64, Pending>,
    input_id: u32,
    output_id: u32,
    size: Dimensions,
    header_written: bool,
    created: Instant,
    has_output: bool,
    pub hardware: bool,
    pub name: String,
    pub drained: bool,
}

impl Encoder {
    pub fn new(gpu: &Device, size: Dimensions, bitrate: u32, software: bool) -> Result<Self> {
        if !software {
            for activation in hardware_encoders().unwrap_or_else(|e| {
                eprintln!("hardware encoder enumeration failed: {e}");
                Vec::new()
            }) {
                let name = friendly_name(&activation);
                // SAFETY: MFStartup and COM initialization are owned by the enclosing runtime.
                let candidate: windows::core::Result<IMFTransform> =
                    unsafe { activation.ActivateObject() };
                let candidate = candidate.map_err(Into::into).and_then(|transform| {
                    Self::configure(transform, gpu, size, bitrate, true, name.clone())
                });
                match candidate {
                    Ok(encoder) => return Ok(encoder),
                    Err(e) => {
                        eprintln!("hardware encoder rejected: {name}: {e}");
                        // SAFETY: the failed activation is no longer used.
                        unsafe {
                            let _ = activation.ShutdownObject();
                        }
                    }
                }
            }
            eprintln!("no compatible D3D11 hardware encoder; using software with NV12 readback");
        }
        // SAFETY: creates the inbox Microsoft H.264 encoder in this COM apartment.
        let transform: IMFTransform =
            unsafe { CoCreateInstance(&SOFTWARE_ENCODER, None, CLSCTX_INPROC_SERVER)? };
        Self::configure(
            transform,
            gpu,
            size,
            bitrate,
            false,
            "Microsoft H.264 software MFT".into(),
        )
    }

    fn configure(
        transform: IMFTransform,
        gpu: &Device,
        size: Dimensions,
        bitrate: u32,
        hardware: bool,
        name: String,
    ) -> Result<Self> {
        // SAFETY: all calls operate on owned COM interfaces in the initialized MTA.
        unsafe {
            let attributes = transform.GetAttributes()?;
            let asynchronous = attributes.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) != 0;
            if asynchronous {
                attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
            }
            attributes.SetUINT32(&MF_LOW_LATENCY, 1)?;
            let manager = if hardware {
                if attributes.GetUINT32(&MF_SA_D3D11_AWARE).unwrap_or(0) == 0 {
                    return Err("hardware MFT does not accept D3D11 surfaces".into());
                }
                let mut token = 0;
                let mut manager = None;
                MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
                let manager = manager.ok_or("no DXGI device manager")?;
                manager.ResetDevice(&gpu.device, token)?;
                transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)?;
                Some(manager)
            } else {
                None
            };
            let codec: ICodecAPI = transform.cast()?;
            codec.SetValue(&CODECAPI_AVLowLatencyMode, &VARIANT::from(true))?;
            codec.SetValue(
                &CODECAPI_AVEncMPVDefaultBPictureCount,
                &VARIANT::from(0_u32),
            )?;
            let mut input_id = [0];
            let mut output_id = [0];
            if let Err(e) = transform.GetStreamIDs(&mut input_id, &mut output_id) {
                if e.code() != windows::Win32::Foundation::E_NOTIMPL {
                    return Err(e.into());
                }
            }
            let output = media_type(size, MFVideoFormat_H264)?;
            output.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
            output.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main.0 as u32)?;
            transform.SetOutputType(output_id[0], &output, 0)?;
            transform.SetInputType(input_id[0], &media_type(size, MFVideoFormat_NV12)?, 0)?;
            codec.SetValue(&CODECAPI_AVLowLatencyMode, &VARIANT::from(true))?;
            let events = if asynchronous {
                Some(transform.cast()?)
            } else {
                None
            };
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            Ok(Self {
                transform,
                manager,
                events,
                input_credits: 0,
                output_credits: 0,
                pending: BTreeMap::new(),
                input_id: input_id[0],
                output_id: output_id[0],
                size,
                header_written: false,
                created: Instant::now(),
                has_output: false,
                hardware,
                name,
                drained: false,
            })
        }
    }

    pub fn poll_events(&mut self) -> Result<()> {
        let Some(events) = &self.events else {
            return Ok(());
        };
        for _ in 0..64 {
            // SAFETY: NO_WAIT ensures capture cannot be blocked by the encoder's event queue.
            let event = match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(event) => event,
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => break,
                Err(e) => return Err(e.into()),
            };
            // SAFETY: event type and status are read from an owned MF event.
            unsafe {
                event.GetStatus()?.ok()?;
                let kind = event.GetType()? as i32;
                if kind == METransformNeedInput.0 {
                    self.input_credits = self.input_credits.saturating_add(1);
                }
                if kind == METransformHaveOutput.0 {
                    self.output_credits = self.output_credits.saturating_add(1);
                }
                if kind == METransformDrainComplete.0 {
                    self.drained = true;
                }
            }
        }
        Ok(())
    }

    pub fn ready(&self) -> bool {
        self.pending.len() < MAX_IN_FLIGHT && (self.events.is_none() || self.input_credits > 0)
    }
    pub fn check_progress(&self) -> Result<()> {
        let timeout = Duration::from_secs(2);
        if (!self.has_output && self.created.elapsed() > timeout)
            || self
                .pending
                .values()
                .any(|frame| frame.submitted.elapsed() > timeout)
        {
            return Err(format!("encoder made no progress within two seconds (pending={}, input_credits={}, output_credits={})", self.pending.len(), self.input_credits, self.output_credits).into());
        }
        Ok(())
    }

    pub fn pending(&self) -> usize {
        self.pending.len()
    }
    pub fn drain_complete(&self) -> bool {
        self.pending.is_empty() && (self.events.is_none() || self.drained)
    }

    pub fn submit(
        &mut self,
        gpu: &Device,
        texture: &ID3D11Texture2D,
        captured: Instant,
        timestamp: i64,
        reused_capture: bool,
    ) -> Result<bool> {
        if !self.ready() {
            return Ok(false);
        }
        let submitted = Instant::now();
        // SAFETY: buffers own their texture or memory until the MFT releases its input sample.
        unsafe {
            let buffer = if self.hardware {
                {
                    let buffer =
                        MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, texture, 0, false)?;
                    let two_d: IMF2DBuffer = buffer.cast()?;
                    buffer.SetCurrentLength(two_d.GetContiguousLength()?)?;
                    buffer
                }
            } else {
                readback(gpu, texture, self.size)?
            };
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(timestamp)?;
            sample.SetSampleDuration(10_000_000 / 60)?;
            match self.transform.ProcessInput(self.input_id, &sample, 0) {
                Ok(()) => {}
                Err(e) if e.code() == MF_E_NOTACCEPTING => return Ok(false),
                Err(e) => return Err(format!("MFT ProcessInput: {e}").into()),
            }
        }
        if self.events.is_some() {
            self.input_credits -= 1;
        }
        self.pending.insert(
            timestamp,
            Pending {
                captured,
                submitted,
                reused_capture,
            },
        );
        Ok(true)
    }

    pub fn output(&mut self) -> Result<Option<Packet>> {
        if self.events.is_some() && self.output_credits == 0 {
            return Ok(None);
        }
        // SAFETY: manual COM fields are taken back on every path, including ProcessOutput failure.
        unsafe {
            let info = self.transform.GetOutputStreamInfo(self.output_id)?;
            let sample = if info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0 {
                None
            } else {
                let sample = MFCreateSample()?;
                sample.AddBuffer(&MFCreateAlignedMemoryBuffer(
                    info.cbSize.max(self.size.width * self.size.height * 2),
                    info.cbAlignment,
                )?)?;
                Some(sample)
            };
            let mut output = MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: self.output_id,
                pSample: ManuallyDrop::new(sample),
                ..Default::default()
            };
            let mut status = 0;
            let result =
                self.transform
                    .ProcessOutput(0, std::slice::from_mut(&mut output), &mut status);
            let sample = ManuallyDrop::take(&mut output.pSample);
            drop(ManuallyDrop::take(&mut output.pEvents));
            match result {
                Ok(()) => {}
                Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => {
                    if self.events.is_some() {
                        self.output_credits -= 1;
                    }
                    return Ok(None);
                }
                Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                    let media = self.transform.GetOutputAvailableType(self.output_id, 0)?;
                    if media.GetGUID(&MF_MT_SUBTYPE)? != MFVideoFormat_H264
                        || media.GetUINT64(&MF_MT_FRAME_SIZE)?
                            != pack(self.size.width, self.size.height)
                    {
                        return Err("encoder requested an unexpected output format".into());
                    }
                    self.transform.SetOutputType(self.output_id, &media, 0)?;
                    self.header_written = false;
                    return Ok(None);
                }
                Err(e) => return Err(e.into()),
            }
            if self.events.is_some() {
                self.output_credits -= 1;
            }
            let Some(sample) = sample else {
                return Ok(None);
            };
            let timestamp = sample.GetSampleTime()?;
            let pending = self
                .pending
                .remove(&timestamp)
                .ok_or("encoder returned an unknown frame timestamp")?;
            let mut bytes = Vec::new();
            if !self.header_written {
                let media = self.transform.GetOutputCurrentType(self.output_id)?;
                if let Ok(size) = media.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) {
                    bytes.resize(size as usize, 0);
                    media.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut bytes, None)?;
                    require_annex_b(&bytes)?;
                }
                self.header_written = true;
            }
            let data = sample.ConvertToContiguousBuffer()?;
            let mut ptr = std::ptr::null_mut();
            let mut len = 0;
            data.Lock(&mut ptr, None, Some(&mut len))?;
            if len > 0 {
                bytes.extend_from_slice(std::slice::from_raw_parts(ptr, len as usize));
            }
            data.Unlock()?;
            require_annex_b(&bytes)?;
            self.has_output = true;
            Ok(Some(Packet {
                bytes,
                captured: pending.captured,
                timestamp,
                encode_ms: pending.submitted.elapsed().as_secs_f64() * 1000.0,
                reused_capture: pending.reused_capture,
            }))
        }
    }
    pub fn drain(&mut self) -> Result<()> {
        // SAFETY: end-of-stream followed by drain preserves all accepted frames.
        unsafe {
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)?;
        }
        Ok(())
    }
}
impl Drop for Encoder {
    fn drop(&mut self) {
        // SAFETY: shutdown precedes destruction of the device manager and enclosing MF runtime.
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            if let Ok(shutdown) = self.transform.cast::<IMFShutdown>() {
                let _ = shutdown.Shutdown();
            }
        }
        self.manager.take();
    }
}

fn pack(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}
fn media_type(size: Dimensions, subtype: GUID) -> Result<IMFMediaType> {
    // SAFETY: attributes contain scalar values or copied GUIDs, with no borrowed pointers.
    unsafe {
        let media = MFCreateMediaType()?;
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media.SetGUID(&MF_MT_SUBTYPE, &subtype)?;
        media.SetUINT64(&MF_MT_FRAME_SIZE, pack(size.width, size.height))?;
        media.SetUINT64(&MF_MT_FRAME_RATE, pack(60, 1))?;
        media.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
        media.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        media.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        media.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
        Ok(media)
    }
}
fn hardware_encoders() -> Result<Vec<IMFActivate>> {
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let mut array = std::ptr::null_mut();
    let mut count = 0;
    // SAFETY: MFTEnumEx allocates an array with CoTaskMemAlloc. Move each reference out before freeing it.
    unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            None,
            Some(&output),
            &mut array,
            &mut count,
        )?;
        if count == 0 {
            CoTaskMemFree(Some(array.cast()));
            return Ok(Vec::new());
        }
        if array.is_null() {
            return Err("MFT enumeration returned a null array".into());
        }
        let encoders = std::slice::from_raw_parts_mut(array, count as usize)
            .iter_mut()
            .filter_map(Option::take)
            .collect();
        CoTaskMemFree(Some(array.cast()));
        Ok(encoders)
    }
}
fn friendly_name(activation: &IMFActivate) -> String {
    let mut name = PWSTR::null();
    let mut length = 0;
    // SAFETY: the returned UTF-16 allocation is read within its length and freed once.
    unsafe {
        if activation
            .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut length)
            .is_err()
        {
            return "unnamed hardware MFT".into();
        }
        let text = if name.is_null() {
            "unnamed hardware MFT".into()
        } else {
            String::from_utf16_lossy(std::slice::from_raw_parts(name.0, length as usize))
        };
        CoTaskMemFree(Some(name.0.cast()));
        text
    }
}
fn require_annex_b(bytes: &[u8]) -> Result<()> {
    if !bytes.is_empty() && !bytes.starts_with(&[0, 0, 1]) && !bytes.starts_with(&[0, 0, 0, 1]) {
        return Err(
            "MFT returned non-Annex-B H.264; refusing to write an invalid raw stream".into(),
        );
    }
    Ok(())
}
fn readback(gpu: &Device, texture: &ID3D11Texture2D, size: Dimensions) -> Result<IMFMediaBuffer> {
    let staging = gpu.texture(size, DXGI_FORMAT_NV12, true)?;
    let bytes = size.width * size.height * 3 / 2;
    // SAFETY: Map's row pitch is honored for both NV12 planes. Every successful lock and map is released.
    unsafe {
        gpu.context.CopyResource(&staging, texture);
        let buffer = MFCreateMemoryBuffer(bytes)?;
        let mut destination = std::ptr::null_mut();
        buffer.Lock(&mut destination, None, None)?;
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        let result = gpu
            .context
            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped));
        if let Err(e) = result {
            buffer.Unlock()?;
            return Err(e.into());
        }
        if mapped.RowPitch < size.width {
            gpu.context.Unmap(&staging, 0);
            buffer.Unlock()?;
            return Err("NV12 row pitch is too short".into());
        }
        for row in 0..(size.height * 3 / 2) as usize {
            std::ptr::copy_nonoverlapping(
                (mapped.pData as *const u8).add(row * mapped.RowPitch as usize),
                destination.add(row * size.width as usize),
                size.width as usize,
            );
        }
        gpu.context.Unmap(&staging, 0);
        buffer.Unlock()?;
        buffer.SetCurrentLength(bytes)?;
        Ok(buffer)
    }
}
