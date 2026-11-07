use super::Result;
use crate::Dimensions;
use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::*;

pub struct Device {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
}

impl Device {
    pub fn new(adapter: &IDXGIAdapter1) -> Result<Self> {
        let mut device = None;
        let mut context = None;
        // SAFETY: output pointers are live; the selected adapter remains owned by the caller.
        unsafe {
            D3D11CreateDevice(
                adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )?;
        }
        let device = device.ok_or("D3D11 returned no device")?;
        let context: ID3D11DeviceContext = context.ok_or("D3D11 returned no context")?;
        let multithread: ID3D11Multithread = context.cast()?;
        // SAFETY: Media Foundation can use this device on its own worker threads.
        unsafe {
            let _ = multithread.SetMultithreadProtected(true);
        }
        Ok(Self { device, context })
    }

    pub fn texture(
        &self,
        size: Dimensions,
        format: DXGI_FORMAT,
        staging: bool,
    ) -> Result<ID3D11Texture2D> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: size.width,
            Height: size.height,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: if staging {
                D3D11_USAGE_STAGING
            } else {
                D3D11_USAGE_DEFAULT
            },
            BindFlags: if staging {
                0
            } else {
                D3D11_BIND_RENDER_TARGET.0 as u32 | D3D11_BIND_SHADER_RESOURCE.0 as u32
            },
            CPUAccessFlags: if staging {
                D3D11_CPU_ACCESS_READ.0 as u32
            } else {
                0
            },
            ..Default::default()
        };
        let mut texture = None;
        // SAFETY: descriptor and output storage live through this synchronous call.
        unsafe {
            self.device
                .CreateTexture2D(&desc, None, Some(&mut texture))?;
        }
        Ok(texture.ok_or("D3D11 returned no texture")?)
    }

    pub fn copy_region(
        &self,
        source: &ID3D11Texture2D,
        region: D3D11_BOX,
    ) -> Result<ID3D11Texture2D> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: source is an owned texture; bounds are checked before issuing the GPU copy.
        unsafe {
            source.GetDesc(&mut desc);
        }
        if region.right > desc.Width
            || region.bottom > desc.Height
            || region.left >= region.right
            || region.top >= region.bottom
        {
            return Err("capture region is outside the source texture".into());
        }
        let texture = self.texture(
            Dimensions {
                width: region.right - region.left,
                height: region.bottom - region.top,
            },
            desc.Format,
            false,
        )?;
        // SAFETY: both resources belong to this device and the region fits both allocations.
        unsafe {
            self.context
                .CopySubresourceRegion(&texture, 0, 0, 0, 0, source, 0, Some(&region));
        }
        Ok(texture)
    }
}
