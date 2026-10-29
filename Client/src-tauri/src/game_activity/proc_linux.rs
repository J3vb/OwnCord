//! The Linux process list, read from a `/proc` tree.
//!
//! The proc root is a parameter so tests run it over a fixture tree in a temp
//! dir. Only processes owned by the given uid are read: another user's
//! `cmdline` is often unreadable and is none of our business.

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use super::Proc;

/// Every process under `root` owned by `own_uid`, with its start time in Unix
/// milliseconds (`/proc/<pid>/stat` field 22 in clock ticks since boot, plus
/// the boot time from `/proc/stat`). `clock_ticks` is the kernel's `CLK_TCK`.
pub(super) fn read_proc_tree(root: &Path, own_uid: u32, clock_ticks: u64) -> Option<Vec<Proc>> {
    // Without a boot time no start time can be computed; every process then
    // starts "now", so none of them wins the first-started rule on a guess.
    let boot_ms = read_boot_time_ms(root);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    let entries = fs::read_dir(root).ok()?;
    let mut procs = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        if !name
            .to_str()
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        {
            continue;
        }
        if !entry.metadata().is_ok_and(|m| m.uid() == own_uid) {
            continue;
        }
        if let Some(proc) = read_proc(&entry.path(), boot_ms, now_ms, clock_ticks) {
            procs.push(proc);
        }
    }
    Some(procs)
}

fn read_proc(dir: &Path, boot_ms: Option<u64>, now_ms: u64, clock_ticks: u64) -> Option<Proc> {
    // A kernel thread or a zombie has an empty cmdline: not a game.
    let cmdline = fs::read(dir.join("cmdline")).ok()?;
    let args: Vec<String> = cmdline
        .split(|b| *b == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect();
    let program = args.first()?;
    let exe = fs::read_link(dir.join("exe"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    // A stat that cannot be read or parsed (the process exited mid-scan, or
    // an odd kernel) has no start time: skip it rather than guess an early one.
    let ticks = fs::read_to_string(dir.join("stat"))
        .ok()
        .as_deref()
        .and_then(parse_start_ticks)?;
    let started_at_ms = boot_ms.map_or(now_ms, |boot| {
        boot + ticks.saturating_mul(1000) / clock_ticks.max(1)
    });
    let mut paths = vec![program.as_str()];
    paths.extend(exe.as_deref());
    Some(Proc::new(&paths, &args.join(" "), started_at_ms))
}

/// Field 22 (`starttime`, clock ticks since boot) of a `/proc/<pid>/stat`
/// line. The command name in field 2 is in parentheses and may itself hold
/// spaces and parentheses, so the fields are counted after the last `)`.
fn parse_start_ticks(stat: &str) -> Option<u64> {
    let after_comm = &stat[stat.rfind(')')? + 1..];
    // The first field after the name is field 3 (state), so field 22 is the
    // 20th (index 19).
    after_comm.split_whitespace().nth(19)?.parse().ok()
}

fn read_boot_time_ms(root: &Path) -> Option<u64> {
    let stat = fs::read_to_string(root.join("stat")).ok()?;
    let seconds: u64 = stat
        .lines()
        .find_map(|line| line.strip_prefix("btime "))?
        .trim()
        .parse()
        .ok()?;
    Some(seconds.saturating_mul(1000))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_ticks_survive_a_command_name_with_spaces_and_parens() {
        let stat = "42 (my (odd) game) S 1 42 42 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 7 0 123456 0 0";
        assert_eq!(parse_start_ticks(stat), Some(123_456));
    }

    #[test]
    fn a_short_stat_line_has_no_start_time() {
        assert_eq!(parse_start_ticks("1 (init) S 0"), None);
        assert_eq!(parse_start_ticks("garbage"), None);
    }
}
