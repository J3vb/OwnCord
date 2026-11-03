//! The Application event log's record of a run that ended without a word
//! (Windows), read from `wevtutil`'s XML.
//!
//! Windows Error Reporting writes an "Application Error" record (event 1000)
//! for a process that crashed, with the faulting module, exception code and
//! offset, and an "Application Hang" record (event 1002) for a window it
//! closed as not responding. Both name the process by image name and pid, so
//! a record is matched to an ended run by both, and by time. Only the module's
//! file name is copied: the records' paths hold the user's home folder.
use super::{EndedRun, WINDOW_SECS};
use crate::crash_line::{days_from_civil, exception_name};

/// `wevtutil` arguments: crash and hang records of the last 30 days, newest
/// first. Provider names are not localized, so this matches on every
/// Windows language.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) const QUERY_ARGS: [&str; 6] = [
    "qe",
    "Application",
    "/q:*[System[(Provider[@Name='Application Error'] or Provider[@Name='Application Hang']) \
     and (EventID=1000 or EventID=1002) and TimeCreated[timediff(@SystemTime) <= 2592000000]]]",
    "/f:xml",
    "/rd:true",
    "/c:100",
];

const APPLICATION_ERROR: u32 = 1000;
const APPLICATION_HANG: u32 = 1002;

/// One event record: its id, time (Unix seconds) and data fields, each with
/// its name when the record names them (newer Windows) or by position only.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Event {
    id: u32,
    time: Option<i64>,
    data: Vec<(Option<String>, String)>,
}

impl Event {
    /// A data field by name, or by its position in records without names.
    fn field(&self, name: &str, position: usize) -> Option<&str> {
        if self.data.iter().any(|(n, _)| n.is_some()) {
            self.data
                .iter()
                .find(|(n, _)| n.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(name)))
                .map(|(_, v)| v.as_str())
        } else {
            self.data.get(position).map(|(_, v)| v.as_str())
        }
    }
}

/// The log lines for `runs`: what the event log recorded of each, or that it
/// recorded nothing.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn report_lines(xml: &str, exe: &str, runs: &[EndedRun]) -> Vec<String> {
    let events = parse_events(xml);
    runs.iter()
        .map(|run| {
            events
                .iter()
                .find(|e| matches_run(e, exe, *run))
                .map_or_else(|| no_record_line(run.pid), |e| record_line(e, run.pid))
        })
        .collect()
}

fn no_record_line(pid: u32) -> String {
    format!(
        "[exit] the Windows event log has no crash or hang record for pid {pid}: it was ended \
         (End task, sign-out or shutdown), lost power, or ended without a report"
    )
}

fn record_line(event: &Event, pid: u32) -> String {
    let field = |name, position| event.field(name, position).unwrap_or("").trim();
    if event.id == APPLICATION_HANG {
        return format!(
            "[exit] Windows recorded that the previous run (pid {pid}) stopped responding and \
             was closed (Application Hang), version {}",
            or_unknown(field("AppVersion", 1))
        );
    }
    let code = u32::from_str_radix(field("ExceptionCode", 6).trim_start_matches("0x"), 16).ok();
    let code_text = code.map_or_else(
        || "an unknown exception".to_string(),
        |c| format!("exception 0x{c:08X} ({})", exception_name(c)),
    );
    let module = file_name(field("ModuleName", 3));
    format!(
        "[exit] Windows recorded a crash of the previous run (pid {pid}): {code_text} in module \
         '{}' version {} at offset {}, app version {}",
        or_unknown(module),
        or_unknown(file_name(field("ModuleVersion", 4))),
        or_unknown(file_name(field("FaultingOffset", 7))),
        or_unknown(file_name(field("AppVersion", 1))),
    )
}

fn or_unknown(value: &str) -> &str {
    if value.is_empty() {
        "unknown"
    } else {
        value
    }
}

/// The last component of a Windows or Unix path: a module field is a bare
/// name in the records seen so far, but never let a path (and the home folder
/// in it) through.
fn file_name(value: &str) -> &str {
    value.rsplit(['\\', '/']).next().unwrap_or(value)
}

fn matches_run(event: &Event, exe: &str, run: EndedRun) -> bool {
    let (app, pid) = match event.id {
        APPLICATION_ERROR => (event.field("AppName", 0), event.field("ProcessId", 8)),
        APPLICATION_HANG => (event.field("AppName", 0), event.field("ProcessID", 2)),
        _ => return false,
    };
    let same_app = app.is_some_and(|a| !exe.is_empty() && a.trim().eq_ignore_ascii_case(exe));
    let same_pid = pid.is_some_and(|p| pid_matches(p, run.pid));
    // A crash record lands after the last heartbeat; a hang's can land a
    // while later, when the user gives up on the frozen window.
    let in_time = match (event.time, run.last_seen) {
        (Some(t), Some(seen)) => t >= seen - WINDOW_SECS && t <= seen + 3 * WINDOW_SECS,
        _ => true,
    };
    same_app && same_pid && in_time
}

/// Whether a record's pid field is `pid`. Crash records write it as `0x…`,
/// hang records as bare hex; decimal is accepted too.
fn pid_matches(field: &str, pid: u32) -> bool {
    let field = field.trim();
    if let Some(hex) = field
        .strip_prefix("0x")
        .or_else(|| field.strip_prefix("0X"))
    {
        return u32::from_str_radix(hex, 16) == Ok(pid);
    }
    u32::from_str_radix(field, 16) == Ok(pid) || field.parse::<u32>() == Ok(pid)
}

/// The `<Event>` records in `wevtutil qe /f:xml` output (no root element).
fn parse_events(xml: &str) -> Vec<Event> {
    xml.split("<Event ")
        .skip(1)
        .filter_map(|chunk| {
            let body = chunk.split("</Event>").next()?;
            let id = element_text(body, "EventID")?.trim().parse().ok()?;
            let time = attribute(body, "TimeCreated", "SystemTime").and_then(parse_time);
            Some(Event {
                id,
                time,
                data: data_fields(body),
            })
        })
        .collect()
}

/// The text of the first `<name …>text</name>`.
fn element_text<'a>(body: &'a str, name: &str) -> Option<&'a str> {
    let start = body.find(&format!("<{name}"))?;
    let rest = &body[start..];
    let open_end = rest.find('>')?;
    if rest[..open_end].ends_with('/') {
        return Some("");
    }
    let text = &rest[open_end + 1..];
    let close = text.find(&format!("</{name}>"))?;
    Some(&text[..close])
}

/// The value of `attr` on the first `<element …>`, quoted either way.
fn attribute<'a>(body: &'a str, element: &str, attr: &str) -> Option<&'a str> {
    let start = body.find(&format!("<{element}"))?;
    let tag = &body[start..start + body[start..].find('>')?];
    attribute_in_tag(tag, attr)
}

fn attribute_in_tag<'a>(tag: &'a str, attr: &str) -> Option<&'a str> {
    let at = tag.find(&format!(" {attr}="))? + attr.len() + 2;
    let quote = tag[at..].chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let value = &tag[at + 1..];
    Some(&value[..value.find(quote)?])
}

/// Every `<Data>` of the record's `<EventData>`, in order.
fn data_fields(body: &str) -> Vec<(Option<String>, String)> {
    let Some(start) = body.find("<EventData") else {
        return Vec::new();
    };
    let end = body.find("</EventData>").unwrap_or(body.len()).max(start);
    let mut rest = &body[start..end];
    let mut fields = Vec::new();
    while let Some(at) = rest.find("<Data") {
        rest = &rest[at..];
        let Some(open_end) = rest.find('>') else {
            break;
        };
        let tag = &rest[..open_end];
        // `<DataX>` is not a `<Data>` element.
        if !matches!(tag.as_bytes().get(5), None | Some(b' ' | b'/')) {
            rest = &rest[5..];
            continue;
        }
        let name = attribute_in_tag(tag, "Name").map(unescape);
        if tag.ends_with('/') {
            fields.push((name, String::new()));
            rest = &rest[open_end + 1..];
            continue;
        }
        let text = &rest[open_end + 1..];
        let close = text.find("</Data>").unwrap_or(text.len());
        fields.push((name, unescape(&text[..close])));
        rest = &text[close..];
    }
    fields
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// `2026-11-03T18:51:36.1234567Z` to Unix seconds.
fn parse_time(text: &str) -> Option<i64> {
    let (date, time) = text.split_once('T')?;
    let mut d = date.splitn(3, '-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: i64 = d.next()?.parse().ok()?;
    let day: i64 = d.next()?.parse().ok()?;
    let mut t = time.splitn(3, ':');
    let hour: i64 = t.next()?.parse().ok()?;
    let minute: i64 = t.next()?.parse().ok()?;
    let second: i64 = t.next()?.get(..2)?.parse().ok()?;
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An Application Error record as newer Windows writes it, with named
    /// fields and the user's home folder in its paths.
    const CRASH_NAMED: &str = r"<Event xmlns='event-ns'><System><Provider Name='Application Error' Guid='{a0e9b465-b939-57d7-b27d-95d8e925ff57}'/><EventID>1000</EventID><Version>0</Version><Level>2</Level><Task>100</Task><TimeCreated SystemTime='2026-11-03T18:51:36.1234567Z'/><Computer>DESKTOP-SECRET</Computer></System><EventData><Data Name='AppName'>OwnCord.exe</Data><Data Name='AppVersion'>2.8.0.0</Data><Data Name='AppTimeStamp'>672f1e2a</Data><Data Name='ModuleName'>nvwgf2umx.dll</Data><Data Name='ModuleVersion'>32.0.15.6094</Data><Data Name='ModuleTimeStamp'>66f5a1b2</Data><Data Name='ExceptionCode'>c0000005</Data><Data Name='FaultingOffset'>0x00000000001a2b3c</Data><Data Name='ProcessId'>0x2c18</Data><Data Name='ProcessCreationTime'>0x1db2e0a0b0c0d0e</Data><Data Name='AppPath'>C:\Users\jdoe\AppData\Local\OwnCord\OwnCord.exe</Data><Data Name='ModulePath'>C:\WINDOWS\System32\DriverStore\FileRepository\nv.inf_amd64\nvwgf2umx.dll</Data><Data Name='IntegratorReportId'>0f1e2d3c</Data><Data Name='PackageFullName'></Data><Data Name='PackageRelativeAppId'/></EventData></Event>";

    /// The same kind of record as older Windows 10 writes it: by position.
    const CRASH_POSITIONAL: &str = r"<Event xmlns='event-ns'><System><Provider Name='Application Error'/><EventID Qualifiers='0'>1000</EventID><TimeCreated SystemTime='2026-11-03T18:51:36.000Z'/></System><EventData><Data>OwnCord.exe</Data><Data>2.8.0.0</Data><Data>672f1e2a</Data><Data>ucrtbase.dll</Data><Data>10.0.19041.3636</Data><Data>81cf5d89</Data><Data>c0000409</Data><Data>000000000007286e</Data><Data>2c18</Data><Data>01db2e0a0b0c0d0e</Data><Data>C:\Users\jdoe\AppData\Local\OwnCord\OwnCord.exe</Data><Data>C:\WINDOWS\System32\ucrtbase.dll</Data><Data>0f1e2d3c</Data><Data></Data><Data></Data></EventData></Event>";

    const HANG: &str = r"<Event xmlns='event-ns'><System><Provider Name='Application Hang'/><EventID Qualifiers='0'>1002</EventID><TimeCreated SystemTime='2026-11-03T18:53:10.5Z'/></System><EventData><Data>OwnCord.exe</Data><Data>2.8.0.0</Data><Data>2c18</Data><Data>01db2e0a0b0c0d0e</Data><Data>4294967295</Data><Data>C:\Users\jdoe\AppData\Local\OwnCord\OwnCord.exe</Data><Data>0f1e2d3c</Data><Data></Data><Data></Data><Binary>55006E006B0000</Binary></EventData></Event>";

    /// Another app's crash at the same moment, with the same pid.
    const OTHER_APP: &str = r"<Event xmlns='x'><System><Provider Name='Application Error'/><EventID>1000</EventID><TimeCreated SystemTime='2026-11-03T18:51:30Z'/></System><EventData><Data Name='AppName'>msedgewebview2.exe</Data><Data Name='ProcessId'>0x2c18</Data><Data Name='ExceptionCode'>80000003</Data></EventData></Event>";

    const PID: u32 = 0x2c18;
    /// 2026-11-03 18:51:30 UTC.
    const LAST_SEEN: i64 = 1_793_731_890;

    fn run(last_seen: Option<i64>) -> EndedRun {
        EndedRun {
            pid: PID,
            last_seen,
        }
    }

    #[test]
    fn a_named_crash_record_names_the_module_and_code_without_paths() {
        let lines = report_lines(CRASH_NAMED, "OwnCord.exe", &[run(Some(LAST_SEEN))]);
        assert_eq!(
            lines,
            [
                "[exit] Windows recorded a crash of the previous run (pid 11288): exception \
              0xC0000005 (access violation) in module 'nvwgf2umx.dll' version 32.0.15.6094 \
              at offset 0x00000000001a2b3c, app version 2.8.0.0"
            ]
        );
        assert!(!lines[0].contains("jdoe") && !lines[0].contains("DESKTOP"));
    }

    #[test]
    fn a_positional_crash_record_reads_the_same_fields() {
        let lines = report_lines(CRASH_POSITIONAL, "owncord.EXE", &[run(Some(LAST_SEEN))]);
        assert!(
            lines[0].contains("exception 0xC0000409 (fail fast")
                && lines[0].contains("module 'ucrtbase.dll' version 10.0.19041.3636")
                && lines[0].contains("offset 000000000007286e"),
            "{lines:?}"
        );
        assert!(!lines[0].contains("jdoe"));
    }

    #[test]
    fn a_hang_record_says_windows_closed_the_window() {
        let lines = report_lines(HANG, "OwnCord.exe", &[run(Some(LAST_SEEN))]);
        assert!(
            lines[0].contains("stopped responding and was closed (Application Hang)")
                && lines[0].contains("version 2.8.0.0"),
            "{lines:?}"
        );
    }

    #[test]
    fn records_of_another_app_pid_or_time_do_not_match() {
        let xml = format!("{OTHER_APP}{CRASH_NAMED}");
        // Newest first, but the other app's record is skipped.
        assert!(
            report_lines(&xml, "OwnCord.exe", &[run(Some(LAST_SEEN))])[0].contains("nvwgf2umx.dll")
        );
        let other_pid = EndedRun {
            pid: PID + 1,
            last_seen: Some(LAST_SEEN),
        };
        assert!(report_lines(&xml, "OwnCord.exe", &[other_pid])[0].contains("has no crash"));
        // A week-old run with a reused pid is not this record's.
        let old = run(Some(LAST_SEEN - 7 * 86_400));
        assert!(report_lines(&xml, "OwnCord.exe", &[old])[0].contains("has no crash"));
        // Unknown time: app and pid decide.
        assert!(report_lines(&xml, "OwnCord.exe", &[run(None)])[0].contains("nvwgf2umx.dll"));
        // No own image name: nothing can match.
        assert!(report_lines(&xml, "", &[run(None)])[0].contains("has no crash"));
    }

    #[test]
    fn empty_or_broken_output_reports_no_record() {
        for xml in [
            "",
            "garbage",
            "<Event ",
            "<Event x><EventID>abc</EventID></Event>",
            "<Event x><EventID>1000</EventID><EventData><Data Name='AppName'>OwnCord.exe",
        ] {
            let lines = report_lines(xml, "OwnCord.exe", &[run(Some(LAST_SEEN))]);
            assert_eq!(lines.len(), 1);
            assert!(
                lines[0].contains("no crash or hang record for pid 11288"),
                "{xml}"
            );
        }
    }

    #[test]
    fn records_parse_ids_times_and_escaped_data() {
        let xml = r#"<Event a='1'><System><EventID>1000</EventID><TimeCreated SystemTime="1970-01-02T00:00:01Z"/></System><EventData><Data Name='AppName'>a&amp;b&lt;c&gt;</Data><DataX>no</DataX><Data Name='Empty'/></EventData></Event>"#;
        assert_eq!(
            parse_events(xml),
            [Event {
                id: 1000,
                time: Some(86_401),
                data: vec![
                    (Some("AppName".into()), "a&b<c>".into()),
                    (Some("Empty".into()), String::new()),
                ],
            }]
        );
    }

    #[test]
    fn pids_read_as_prefixed_or_bare_hex_or_decimal() {
        assert!(pid_matches("0x2c18", 11_288));
        assert!(pid_matches("2C18", 11_288));
        assert!(pid_matches("11288", 11_288));
        assert!(!pid_matches("0x2c19", 11_288));
        assert!(!pid_matches("", 11_288));
    }

    #[test]
    fn a_module_path_is_cut_to_its_file_name() {
        assert_eq!(file_name(r"C:\Users\jdoe\x.dll"), "x.dll");
        assert_eq!(file_name("x.dll"), "x.dll");
    }

    #[test]
    fn times_parse_with_and_without_fractions() {
        assert_eq!(parse_time("2026-11-03T18:51:30.1234567Z"), Some(LAST_SEEN));
        assert_eq!(parse_time("2026-11-03T18:51:30Z"), Some(LAST_SEEN));
        assert_eq!(parse_time("nonsense"), None);
    }
}
