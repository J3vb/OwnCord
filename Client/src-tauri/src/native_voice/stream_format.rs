//! The sample format a capture or playout stream opens its device in.
//!
//! Capture, the mixer and the echo canceller's reference all work in f32 at
//! 48 kHz. A sound server (PipeWire, PulseAudio) converts for us, but a raw
//! ALSA device (listed when none runs) may offer only integer samples, so a
//! stream opens the device in any of `FORMATS` at 48 kHz and converts at the
//! callback edge. A device with no 48 kHz config does not open.
use cpal::{
    BufferSize, ChannelCount, SampleFormat, SampleRate, StreamConfig, SupportedStreamConfigRange,
};

/// The formats a stream converts from, best first: every PCM format `cpal`
/// builds a stream in, but 64-bit (no audio device offers it). `typed!`
/// handles each.
const FORMATS: [SampleFormat; 9] = [
    SampleFormat::F32,
    SampleFormat::I16,
    SampleFormat::I32,
    SampleFormat::U16,
    SampleFormat::I24,
    SampleFormat::U24,
    SampleFormat::U32,
    SampleFormat::I8,
    SampleFormat::U8,
];

/// `$build::<T>(..)` with `T` the sample type of `$format`, one of `FORMATS`
/// (what `pick_config` returns).
macro_rules! typed {
    ($format:expr, $build:ident($($arg:expr),* $(,)?)) => {
        match $format {
            cpal::SampleFormat::I16 => $build::<i16>($($arg),*),
            cpal::SampleFormat::I32 => $build::<i32>($($arg),*),
            cpal::SampleFormat::U16 => $build::<u16>($($arg),*),
            cpal::SampleFormat::I24 => $build::<cpal::I24>($($arg),*),
            cpal::SampleFormat::U24 => $build::<cpal::U24>($($arg),*),
            cpal::SampleFormat::U32 => $build::<u32>($($arg),*),
            cpal::SampleFormat::I8 => $build::<i8>($($arg),*),
            cpal::SampleFormat::U8 => $build::<u8>($($arg),*),
            _ => $build::<f32>($($arg),*),
        }
    };
}
pub(crate) use typed;

/// The config to open at `want_rate`: on `want_channels` (the device's default
/// count) the best of `FORMATS` any range covers it in; only when no such
/// range has that count, the best format on the first channel count it
/// does. None when no range covers `want_rate` in one of `FORMATS`.
pub fn pick_config(
    supported: impl Iterator<Item = SupportedStreamConfigRange>,
    want_rate: SampleRate,
    want_channels: Option<ChannelCount>,
) -> Option<(StreamConfig, SampleFormat)> {
    supported
        .filter(|r| r.min_sample_rate() <= want_rate && want_rate <= r.max_sample_rate())
        .filter_map(|r| Some((FORMATS.iter().position(|f| *f == r.sample_format())?, r)))
        // The first of equal keys wins: the first count listed.
        .min_by_key(|(rank, r)| (Some(r.channels()) != want_channels, *rank))
        .map(|(_, r)| {
            let config = StreamConfig {
                channels: r.channels(),
                sample_rate: want_rate,
                buffer_size: BufferSize::Default,
            };
            (config, r.sample_format())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cpal::SupportedBufferSize;

    fn range(
        format: SampleFormat,
        channels: ChannelCount,
        min: SampleRate,
        max: SampleRate,
    ) -> SupportedStreamConfigRange {
        SupportedStreamConfigRange::new(channels, min, max, SupportedBufferSize::Unknown, format)
    }

    fn picked(
        ranges: Vec<SupportedStreamConfigRange>,
        want_channels: Option<ChannelCount>,
    ) -> Option<(ChannelCount, SampleFormat)> {
        pick_config(ranges.into_iter(), 48_000, want_channels).map(|(config, format)| {
            assert_eq!(config.sample_rate, 48_000);
            assert_eq!(config.buffer_size, BufferSize::Default);
            (config.channels, format)
        })
    }

    #[test]
    fn prefers_f32_at_48k() {
        let ranges = vec![
            range(SampleFormat::I16, 2, 8_000, 192_000),
            range(SampleFormat::F32, 2, 8_000, 192_000),
            range(SampleFormat::I32, 2, 8_000, 192_000),
        ];
        assert_eq!(picked(ranges, Some(2)), Some((2, SampleFormat::F32)));
    }

    #[test]
    fn falls_back_to_i16_at_48k() {
        // A raw ALSA device: no float samples, and its i32 range is 44.1 kHz.
        let ranges = vec![
            range(SampleFormat::I32, 2, 44_100, 44_100),
            range(SampleFormat::U16, 2, 48_000, 48_000),
            range(SampleFormat::I16, 2, 48_000, 48_000),
        ];
        assert_eq!(picked(ranges, Some(2)), Some((2, SampleFormat::I16)));
    }

    #[test]
    fn then_i32_then_u16() {
        let ranges = vec![
            range(SampleFormat::U16, 1, 48_000, 48_000),
            range(SampleFormat::I32, 1, 48_000, 48_000),
        ];
        assert_eq!(picked(ranges, Some(1)), Some((1, SampleFormat::I32)));
        let ranges = vec![range(SampleFormat::U16, 1, 48_000, 48_000)];
        assert_eq!(picked(ranges, Some(1)), Some((1, SampleFormat::U16)));
    }

    #[test]
    fn none_without_48k() {
        let ranges = vec![
            range(SampleFormat::F32, 2, 44_100, 44_100),
            range(SampleFormat::I16, 2, 8_000, 44_100),
            // A format no stream converts from.
            range(SampleFormat::DsdU8, 2, 48_000, 48_000),
        ];
        assert_eq!(picked(ranges, Some(2)), None);
    }

    /// A device offering only 24-bit, 8-bit or u32 PCM at 48 kHz opens too.
    #[test]
    fn opens_every_integer_pcm_format() {
        for format in [
            SampleFormat::I24,
            SampleFormat::U24,
            SampleFormat::U32,
            SampleFormat::I8,
            SampleFormat::U8,
        ] {
            let ranges = vec![range(format, 2, 48_000, 48_000)];
            assert_eq!(picked(ranges, Some(2)), Some((2, format)), "{format}");
        }
        // 24-bit before 8-bit.
        let ranges = vec![
            range(SampleFormat::U8, 2, 48_000, 48_000),
            range(SampleFormat::I24, 2, 48_000, 48_000),
        ];
        assert_eq!(picked(ranges, Some(2)), Some((2, SampleFormat::I24)));
    }

    /// PulseAudio lists every format at every channel count; the default
    /// count is the one that opens, as before formats were picked.
    #[test]
    fn keeps_the_default_channel_count() {
        let ranges = (1..=8)
            .flat_map(|c| {
                [
                    range(SampleFormat::I16, c, 1, 384_000),
                    range(SampleFormat::F32, c, 1, 384_000),
                ]
            })
            .collect();
        assert_eq!(picked(ranges, Some(6)), Some((6, SampleFormat::F32)));
    }

    /// The default count is the primary constraint: a better format on
    /// another count loses to the default count, and only a device with no
    /// usable range on it opens the best format on the first count listed.
    #[test]
    fn the_default_channel_count_outranks_the_format() {
        let ranges = vec![
            range(SampleFormat::I16, 2, 48_000, 48_000),
            range(SampleFormat::F32, 1, 48_000, 48_000),
        ];
        assert_eq!(picked(ranges, Some(2)), Some((2, SampleFormat::I16)));

        let ranges = vec![
            range(SampleFormat::I16, 1, 48_000, 48_000),
            range(SampleFormat::F32, 4, 48_000, 48_000),
            range(SampleFormat::F32, 1, 48_000, 48_000),
        ];
        assert_eq!(
            picked(ranges.clone(), Some(2)),
            Some((4, SampleFormat::F32))
        );
        assert_eq!(picked(ranges, None), Some((4, SampleFormat::F32)));
    }
}
