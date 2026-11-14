//! Icon pixels to a PNG data URL, with no image crate: an icon is a few KB, so
//! the PNG is written with stored (uncompressed) deflate blocks.

/// The side of the icon a row shows.
const ICON_SIDE: usize = 32;

/// Turn the top-down BGRA pixels of an icon's colour bitmap into RGBA. Icons
/// without an alpha channel come back with all alpha zero; then the AND mask
/// (`mask_bgra`, same size, a set pixel is transparent) decides, so the icon
/// is not drawn invisible. `None` when a buffer does not match `w * h`.
pub fn icon_rgba(w: usize, h: usize, bgra: &[u8], mask_bgra: Option<&[u8]>) -> Option<Vec<u8>> {
    let len = w.checked_mul(h)?.checked_mul(4)?;
    if len == 0 || bgra.len() != len || mask_bgra.is_some_and(|m| m.len() != len) {
        return None;
    }
    let has_alpha = bgra.as_chunks::<4>().0.iter().any(|px| px[3] != 0);
    let mut out = Vec::with_capacity(len);
    for (i, px) in bgra.as_chunks::<4>().0.iter().enumerate() {
        let alpha = if has_alpha {
            px[3]
        } else if mask_bgra.is_some_and(|m| m[i * 4] != 0 || m[i * 4 + 1] != 0) {
            0
        } else {
            255
        };
        out.extend_from_slice(&[px[2], px[1], px[0], alpha]);
    }
    Some(out)
}

/// `rgba` (`w` x `h`) as a `ICON_SIDE` square by nearest-neighbour sampling,
/// so an icon the system hands back larger than 32x32 (high DPI) still fits.
pub fn fit_icon(w: usize, h: usize, rgba: &[u8]) -> Option<Vec<u8>> {
    if w == 0 || h == 0 || rgba.len() != w.checked_mul(h)?.checked_mul(4)? {
        return None;
    }
    if w == ICON_SIDE && h == ICON_SIDE {
        return Some(rgba.to_vec());
    }
    let mut out = Vec::with_capacity(ICON_SIDE * ICON_SIDE * 4);
    for y in 0..ICON_SIDE {
        let sy = y * h / ICON_SIDE;
        for x in 0..ICON_SIDE {
            let sx = x * w / ICON_SIDE;
            let at = (sy * w + sx) * 4;
            out.extend_from_slice(&rgba[at..at + 4]);
        }
    }
    Some(out)
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn adler32(bytes: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in bytes {
        a = (a + u32::from(byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(&out[start..]);
    out.extend_from_slice(&crc.to_be_bytes());
}

/// An 8-bit RGBA PNG of `w` x `h` pixels, deflate "stored" (uncompressed):
/// an icon is a few KB and this needs no compression crate. `None` when
/// `rgba` is not `w * h * 4` bytes or the image is empty.
pub fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let row = (w as usize).checked_mul(4)?;
    if w == 0 || h == 0 || rgba.len() != row.checked_mul(h as usize)? {
        return None;
    }
    // Each scanline is a filter byte (0, none) and the pixels.
    let mut raw = Vec::with_capacity((row + 1) * h as usize);
    for line in rgba.chunks_exact(row) {
        raw.push(0);
        raw.extend_from_slice(line);
    }
    // zlib: header, stored blocks of at most 65535 bytes, Adler-32.
    let mut z = vec![0x78, 0x01];
    let mut blocks = raw.chunks(65_535).peekable();
    while let Some(block) = blocks.next() {
        z.push(u8::from(blocks.peek().is_none()));
        z.extend_from_slice(&(block.len() as u16).to_le_bytes());
        z.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
        z.extend_from_slice(block);
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA, no interlace
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    png_chunk(&mut out, b"IHDR", &ihdr);
    png_chunk(&mut out, b"IDAT", &z);
    png_chunk(&mut out, b"IEND", &[]);
    Some(out)
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ABC[(n >> 18) as usize & 63] as char);
        out.push(ABC[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ABC[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ABC[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// A 32x32 PNG data URL for an icon's colour pixels (top-down BGRA, `w` x
/// `h`) and optional AND mask, or `None` when they do not describe an image.
pub fn icon_data_url(w: usize, h: usize, bgra: &[u8], mask_bgra: Option<&[u8]>) -> Option<String> {
    let rgba = fit_icon(w, h, &icon_rgba(w, h, bgra, mask_bgra)?)?;
    let png = encode_png(ICON_SIDE as u32, ICON_SIDE as u32, &rgba)?;
    Some(format!("data:image/png;base64,{}", base64(&png)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icon_alpha_comes_from_the_mask_when_the_bitmap_has_none() {
        // two pixels, BGRA, no alpha; the second is masked out
        let bgra = [1, 2, 3, 0, 4, 5, 6, 0];
        let mask = [0, 0, 0, 0, 255, 255, 255, 0];
        assert_eq!(
            icon_rgba(2, 1, &bgra, Some(&mask)),
            Some(vec![3, 2, 1, 255, 6, 5, 4, 0])
        );
        // with real alpha the mask is ignored
        let bgra = [1, 2, 3, 128, 4, 5, 6, 0];
        assert_eq!(
            icon_rgba(2, 1, &bgra, Some(&mask)),
            Some(vec![3, 2, 1, 128, 6, 5, 4, 0])
        );
        assert_eq!(icon_rgba(2, 1, &bgra[..7], None), None);
        assert_eq!(icon_rgba(0, 0, &[], None), None);
    }

    #[test]
    fn icons_are_fitted_to_32_square() {
        let big = vec![7u8; 64 * 64 * 4];
        assert_eq!(fit_icon(64, 64, &big).map(|v| v.len()), Some(32 * 32 * 4));
        let small = vec![9u8; 16 * 16 * 4];
        assert_eq!(fit_icon(16, 16, &small).map(|v| v.len()), Some(32 * 32 * 4));
        assert_eq!(fit_icon(2, 2, &[0; 3]), None);
    }

    #[test]
    fn base64_matches_the_rfc_vectors() {
        for (raw, want) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(raw.as_bytes()), want);
        }
    }

    #[test]
    fn checksums_match_known_values() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
    }

    #[test]
    fn png_has_the_right_structure() {
        let rgba: Vec<u8> = (0..32 * 32 * 4).map(|i| (i % 251) as u8).collect();
        let png = encode_png(32, 32, &rgba).unwrap();
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");
        // IEND's CRC is the well-known constant
        assert_eq!(&png[png.len() - 4..], &[0xAE, 0x42, 0x60, 0x82]);
        assert_eq!(encode_png(2, 2, &[0; 15]), None);
        assert_eq!(encode_png(0, 2, &[]), None);
        let url = icon_data_url(32, 32, &vec![255u8; 32 * 32 * 4], None).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
    }
}
