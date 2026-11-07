#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
}

impl Dimensions {
    pub fn h264_output(self) -> Option<Self> {
        if self.width < 2 || self.height < 2 {
            return None;
        }
        let (w, h) = (u64::from(self.width), u64::from(self.height));
        let (numerator, denominator) = if w <= 3840 && h <= 2160 {
            (1, 1)
        } else if w * 2160 >= h * 3840 {
            (3840, w)
        } else {
            (2160, h)
        };
        let width = ((w * numerator / denominator) as u32) & !1;
        let height = ((h * numerator / denominator) as u32) & !1;
        if width < 2 || height < 2 {
            return None;
        }
        Some(Self { width, height })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ultrawide_and_odd_sources_fit_even_dimensions() {
        for (source, expected) in [
            ((5120, 1440), (3840, 1080)),
            ((7680, 4320), (3840, 2160)),
            ((1921, 1081), (1920, 1080)),
            ((1080, 5120), (454, 2160)),
        ] {
            let output = Dimensions {
                width: source.0,
                height: source.1,
            }
            .h264_output()
            .unwrap();
            assert_eq!(
                output,
                Dimensions {
                    width: expected.0,
                    height: expected.1
                }
            );
            let original_ratio = f64::from(source.0) / f64::from(source.1);
            let scaled_ratio = f64::from(output.width) / f64::from(output.height);
            assert!((original_ratio - scaled_ratio).abs() < 0.005);
        }
    }

    #[test]
    fn degenerate_dimensions_do_not_reach_encoder() {
        for (width, height) in [(0, 1080), (1920, 0), (1, 1), (u32::MAX, 2)] {
            assert_eq!(Dimensions { width, height }.h264_output(), None);
        }
    }
}
