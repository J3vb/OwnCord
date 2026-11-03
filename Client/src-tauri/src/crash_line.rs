//! Log lines written where nothing may allocate: a signal handler (Linux) or
//! an unhandled-exception filter (Windows) formats into a fixed buffer, in
//! the log plugin's own format, and writes it once.

/// Writes `[YYYY-MM-DD][HH:MM:SS]` (UTC), the log plugin's timestamp.
pub(crate) fn put_timestamp(w: &mut Writer<'_>, unix_secs: i64) {
    let (date, time) = (unix_secs.div_euclid(86_400), unix_secs.rem_euclid(86_400));
    let (year, month, day) = civil_from_days(date);
    w.put(b"[");
    w.num(year, 4);
    w.put(b"-");
    w.num(month, 2);
    w.put(b"-");
    w.num(day, 2);
    w.put(b"][");
    w.num(time / 3600, 2);
    w.put(b":");
    w.num(time / 60 % 60, 2);
    w.put(b":");
    w.num(time % 60, 2);
    w.put(b"]");
}

/// `unix_secs` as `YYYY-MM-DD HH:MM:SS UTC`, for lines that read back a time.
pub fn utc(unix_secs: i64) -> String {
    let mut buf = [0u8; 32];
    let mut w = Writer::new(&mut buf);
    put_timestamp(&mut w, unix_secs);
    let len = w.len();
    let text = String::from_utf8_lossy(&buf[1..len - 1]).into_owned();
    format!("{} UTC", text.replace("][", " "))
}

/// Days since 1970-01-01 to a proleptic Gregorian (year, month, day).
pub(crate) fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// A proleptic Gregorian date to days since 1970-01-01; the inverse of
/// [`civil_from_days`].
#[cfg(any(windows, test))]
pub(crate) fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// A short plain name for a Windows exception or NTSTATUS crash code, for
/// the codes a desktop app meets; "exception" for the rest.
#[cfg(any(windows, test))]
pub(crate) fn exception_name(code: u32) -> &'static str {
    match code {
        0xC000_0005 => "access violation",
        0xC000_0006 => "in-page error (a file or drive the code was mapped from went away)",
        0xC000_0017 => "out of memory",
        0xC000_001D => "illegal instruction",
        0xC000_0094 => "integer divide by zero",
        0xC000_00FD => "stack overflow",
        0xC000_0374 => "heap corruption",
        0xC000_0409 => "fail fast (stack buffer overrun or a deliberate abort)",
        0xC000_041D => "unhandled exception in a user callback",
        0xC000_0602 => "fail fast",
        0x8000_0003 => "breakpoint",
        0xE06D_7363 => "C++ exception",
        _ => "exception",
    }
}

/// Appends to a fixed buffer, silently truncating.
pub(crate) struct Writer<'a> {
    buf: &'a mut [u8],
    len: usize,
}

impl<'a> Writer<'a> {
    pub(crate) fn new(buf: &'a mut [u8]) -> Self {
        Self { buf, len: 0 }
    }

    pub(crate) fn len(&self) -> usize {
        self.len
    }

    pub(crate) fn put(&mut self, bytes: &[u8]) {
        let n = bytes.len().min(self.buf.len() - self.len);
        self.buf[self.len..self.len + n].copy_from_slice(&bytes[..n]);
        self.len += n;
    }

    /// `value` in decimal, zero-padded to `width` digits.
    pub(crate) fn num(&mut self, value: i64, width: usize) {
        let mut digits = [0u8; 20];
        let mut v = value.unsigned_abs();
        let mut n = 0;
        while v > 0 || n < width {
            digits[n] = b'0' + (v % 10) as u8;
            v /= 10;
            n += 1;
        }
        if value < 0 {
            self.put(b"-");
        }
        digits[..n].reverse();
        self.put(&digits[..n]);
    }

    /// `value` as `0x` and at least `width` uppercase hex digits.
    #[cfg(any(windows, test))]
    pub(crate) fn hex(&mut self, value: u64, width: usize) {
        let mut digits = [0u8; 16];
        let mut v = value;
        let mut n = 0;
        while v > 0 || n < width.min(16) {
            digits[n] = b"0123456789ABCDEF"[(v % 16) as usize];
            v /= 16;
            n += 1;
        }
        digits[..n].reverse();
        self.put(b"0x");
        self.put(&digits[..n]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_reads_like_the_log() {
        assert_eq!(utc(1_790_958_439), "2026-10-02 16:27:19 UTC");
    }

    #[test]
    fn dates_round_trip() {
        for days in [-1, 0, 59, 60, 365, 11_016, 20_728, 30_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(days_from_civil(2026, 10, 2), 1_790_958_439 / 86_400);
    }

    #[test]
    fn writes_truncate_and_format_numbers() {
        let mut buf = [0u8; 12];
        let mut w = Writer::new(&mut buf);
        w.num(7, 3);
        w.put(b" ");
        w.hex(0xC000_0005, 8);
        w.put(b"overflow");
        assert_eq!(w.len(), 12);
        assert_eq!(&buf, b"007 0xC00000");
        let mut buf = [0u8; 8];
        let mut w = Writer::new(&mut buf);
        w.hex(0x1f, 4);
        let n = w.len();
        assert_eq!(&buf[..n], b"0x001F");
    }

    #[test]
    fn exception_codes_have_plain_names() {
        assert_eq!(exception_name(0xC000_0005), "access violation");
        assert_eq!(exception_name(0xE06D_7363), "C++ exception");
        assert_eq!(exception_name(0x1234), "exception");
    }
}
