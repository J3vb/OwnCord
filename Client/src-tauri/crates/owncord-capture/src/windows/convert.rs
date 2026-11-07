use super::{device::Device, Result};
use crate::Dimensions;
use std::mem::ManuallyDrop;
use windows::core::Interface;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;

pub struct Converter {
    device: ID3D11VideoDevice,
    context: ID3D11VideoContext1,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    pub output: Dimensions,
}
impl Converter {
    pub fn new(gpu: &Device, input: Dimensions, output: Dimensions) -> Result<Self> {
        let device: ID3D11VideoDevice = gpu.device.cast()?;
        let context: ID3D11VideoContext1 = gpu.context.cast()?;
        let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL {
                Numerator: 60,
                Denominator: 1,
            },
            InputWidth: input.width,
            InputHeight: input.height,
            OutputFrameRate: DXGI_RATIONAL {
                Numerator: 60,
                Denominator: 1,
            },
            OutputWidth: output.width,
            OutputHeight: output.height,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        // SAFETY: all interfaces share one device; dimensions have passed the portable bounds check.
        unsafe {
            let enumerator = device.CreateVideoProcessorEnumerator(&desc)?;
            let input_support = enumerator.CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM)?;
            let output_support = enumerator.CheckVideoProcessorFormat(DXGI_FORMAT_NV12)?;
            if input_support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT.0 as u32 == 0
                || output_support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT.0 as u32 == 0
            {
                return Err("GPU video processor cannot convert BGRA to NV12".into());
            }
            let processor = device.CreateVideoProcessor(&enumerator, 0)?;
            context.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            context.VideoProcessorSetStreamSourceRect(
                &processor,
                0,
                true,
                Some(&RECT {
                    left: 0,
                    top: 0,
                    right: input.width as i32,
                    bottom: input.height as i32,
                }),
            );
            context.VideoProcessorSetStreamDestRect(
                &processor,
                0,
                true,
                Some(&RECT {
                    left: 0,
                    top: 0,
                    right: output.width as i32,
                    bottom: output.height as i32,
                }),
            );
            context.VideoProcessorSetStreamColorSpace1(
                &processor,
                0,
                DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
            );
            context.VideoProcessorSetOutputColorSpace1(
                &processor,
                DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
            );
            Ok(Self {
                device,
                context,
                enumerator,
                processor,
                output,
            })
        }
    }
    pub fn convert(&self, gpu: &Device, source: &ID3D11Texture2D) -> Result<ID3D11Texture2D> {
        let texture = gpu.texture(self.output, DXGI_FORMAT_NV12, false)?;
        let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            ..Default::default()
        };
        let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            ..Default::default()
        };
        let mut input = None;
        let mut output = None;
        // SAFETY: views borrow owned textures from this device. The manual COM field is released on both result paths.
        unsafe {
            self.device.CreateVideoProcessorInputView(
                source,
                &self.enumerator,
                &input_desc,
                Some(&mut input),
            )?;
            self.device.CreateVideoProcessorOutputView(
                &texture,
                &self.enumerator,
                &output_desc,
                Some(&mut output),
            )?;
            let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: ManuallyDrop::new(input),
                ..Default::default()
            };
            let result = self.context.VideoProcessorBlt(
                &self.processor,
                output.as_ref().ok_or("no video output view")?,
                0,
                std::slice::from_ref(&stream),
            );
            ManuallyDrop::drop(&mut stream.pInputSurface);
            result?;
            // Submit queued GPU work before handing the surface to another media component.
            // This does not wait for GPU completion or read pixels back to the CPU.
            gpu.context.Flush();
        }
        Ok(texture)
    }
}
