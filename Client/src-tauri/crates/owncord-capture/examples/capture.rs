#[cfg(windows)]
fn main() {
    if let Err(error) = run() {
        eprintln!("capture failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The capture CLI requires Windows; portable tests run on every platform.");
    std::process::exit(1);
}

#[cfg(windows)]
fn run() -> owncord_capture::windows::Result<()> {
    use owncord_capture::windows::{self, Options, Target};
    let mut args = std::env::args().skip(1);
    let mut target = None;
    let mut output = None;
    let mut seconds = 10;
    let mut bitrate = 20_000_000;
    let mut force_dxgi = false;
    let mut software = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--list" => return windows::list_sources(),
            "--monitor" | "--hwnd" => {
                if target.is_some() {
                    return Err("select exactly one --monitor or --hwnd".into());
                }
                let value = args.next().ok_or("missing capture target")?;
                target = Some(if arg == "--monitor" {
                    Target::Monitor(value.parse()?)
                } else {
                    let value = if let Some(hex) = value.strip_prefix("0x") {
                        isize::from_str_radix(hex, 16)?
                    } else {
                        value.parse()?
                    };
                    if value == 0 {
                        return Err("window handle must be nonzero".into());
                    }
                    Target::Window(value)
                });
            }
            "--output" => output = Some(args.next().ok_or("missing output path")?.into()),
            "--seconds" => seconds = args.next().ok_or("missing duration")?.parse()?,
            "--bitrate" => bitrate = args.next().ok_or("missing bitrate")?.parse()?,
            "--dxgi" => force_dxgi = true,
            "--software" => software = true,
            "--help" | "-h" => {
                println!("capture --list\ncapture (--monitor INDEX | --hwnd 0xHANDLE) --output FILE.h264 [--seconds 10] [--bitrate 20000000] [--dxgi] [--software]");
                return Ok(());
            }
            _ => return Err(format!("unknown argument: {arg}; use --help").into()),
        }
    }
    windows::run(Options {
        target: target.ok_or("choose --monitor or --hwnd; use --list")?,
        output: output.ok_or("choose --output FILE.h264")?,
        seconds,
        bitrate,
        force_dxgi,
        software,
    })
}
