//! Mouse side buttons (Mouse 4/5, the Windows XBUTTON1/XBUTTON2) for push to
//! talk on Linux.
//!
//! `device_query` reads the pointer through core `XQueryPointer`, whose mask
//! stops at Button5, and X11's buttons 4 and 5 are the scroll wheel. The side
//! buttons are X buttons 8 and 9, which only XInput2's `XIQueryPointer`
//! reports. Xlib and libXi are loaded at runtime through `x11-dl` (already in
//! the tree under tao), so a system without libXi, or a session with no X
//! display, simply reports no side buttons.

use std::os::raw::{c_double, c_int, c_uint, c_ulong};
use std::ptr;

use x11_dl::xinput2::{XIButtonState, XIModifierState, XInput2};
use x11_dl::xlib::{Display, Xlib};

/// X button numbers of the back and forward side buttons.
const X_BUTTON_BACK: usize = 8;
const X_BUTTON_FORWARD: usize = 9;

/// Whether X button `button` is set in an XInput2 button mask.
fn mask_has(mask: &[u8], button: usize) -> bool {
    mask.get(button / 8)
        .is_some_and(|byte| byte & (1 << (button % 8)) != 0)
}

/// (Mouse 4, Mouse 5) held, read from an XInput2 button mask.
pub fn side_buttons_from_mask(mask: &[u8]) -> (bool, bool) {
    (
        mask_has(mask, X_BUTTON_BACK),
        mask_has(mask, X_BUTTON_FORWARD),
    )
}

/// An X display connection that can read the side buttons. One per polling
/// thread: the display pointer is not shared across threads.
pub struct SideButtons {
    xlib: Xlib,
    xi: XInput2,
    display: *mut Display,
    root: c_ulong,
}

impl SideButtons {
    /// Opens the default display and checks it speaks XInput 2.0. `None`
    /// when Xlib or libXi cannot be loaded, no display is reachable, or the
    /// server lacks XInput2.
    pub fn open() -> Option<Self> {
        let xlib = Xlib::open().ok()?;
        let xi = XInput2::open().ok()?;
        // SAFETY: a null name opens $DISPLAY; a null result is handled.
        let display = unsafe { (xlib.XOpenDisplay)(ptr::null()) };
        if display.is_null() {
            return None;
        }
        let (mut major, mut minor): (c_int, c_int) = (2, 0);
        // SAFETY: display is a live connection; XIQueryVersion only writes
        // the two ints. Success is 0.
        if unsafe { (xi.XIQueryVersion)(display, &mut major, &mut minor) } != 0 {
            // SAFETY: display came from XOpenDisplay and is closed once.
            unsafe { (xlib.XCloseDisplay)(display) };
            return None;
        }
        // SAFETY: display is a live connection.
        let root = unsafe { (xlib.XDefaultRootWindow)(display) };
        // The server picks this client's ClientPointer lazily, on its first
        // core pointer request; until then XIGetClientPointer reports none.
        let (mut r, mut c): (c_ulong, c_ulong) = (0, 0);
        let (mut rx, mut ry, mut wx, mut wy): (c_int, c_int, c_int, c_int) = (0, 0, 0, 0);
        let mut core_mask: c_uint = 0;
        // SAFETY: display and root are live; every out pointer is a local.
        unsafe {
            (xlib.XQueryPointer)(
                display,
                root,
                &mut r,
                &mut c,
                &mut rx,
                &mut ry,
                &mut wx,
                &mut wy,
                &mut core_mask,
            )
        };
        Some(Self {
            xlib,
            xi,
            display,
            root,
        })
    }

    /// (Mouse 4, Mouse 5) held right now on the client pointer.
    pub fn held(&self) -> (bool, bool) {
        let mut device: c_int = 0;
        // SAFETY: display is live; a None window (0) asks for this client's
        // pointer. Its return value says whether the pointer was set
        // explicitly, not whether `device` was written, so check the id.
        // Read on every poll so a removed master never reaches XIQueryPointer
        // (a BadDevice error would go to the process-wide Xlib handler).
        unsafe { (self.xi.XIGetClientPointer)(self.display, 0, &mut device) };
        if device == 0 {
            return (false, false);
        }
        let (mut root_return, mut child_return): (c_ulong, c_ulong) = (0, 0);
        let (mut root_x, mut root_y, mut win_x, mut win_y): (
            c_double,
            c_double,
            c_double,
            c_double,
        ) = (0.0, 0.0, 0.0, 0.0);
        let mut buttons = XIButtonState::default();
        let mut mods = XIModifierState::default();
        let mut group = XIModifierState::default();
        // SAFETY: every out pointer is a live local; on success the server
        // allocates `buttons.mask`, freed below with XFree.
        let ok = unsafe {
            (self.xi.XIQueryPointer)(
                self.display,
                device,
                self.root,
                &mut root_return,
                &mut child_return,
                &mut root_x,
                &mut root_y,
                &mut win_x,
                &mut win_y,
                &mut buttons,
                &mut mods,
                &mut group,
            )
        };
        if buttons.mask.is_null() {
            return (false, false);
        }
        let held = if ok != 0 && buttons.mask_len > 0 {
            // SAFETY: Xlib allocated mask_len bytes at mask.
            let mask =
                unsafe { std::slice::from_raw_parts(buttons.mask, buttons.mask_len as usize) };
            side_buttons_from_mask(mask)
        } else {
            (false, false)
        };
        // SAFETY: mask was allocated by Xlib for this call and is freed once.
        unsafe { (self.xlib.XFree)(buttons.mask.cast()) };
        held
    }
}

impl Drop for SideButtons {
    fn drop(&mut self) {
        // SAFETY: display came from XOpenDisplay and is closed only here.
        unsafe { (self.xlib.XCloseDisplay)(self.display) };
    }
}

#[cfg(test)]
mod tests {
    use super::{side_buttons_from_mask, SideButtons};

    #[test]
    fn reads_buttons_8_and_9_from_the_second_mask_byte() {
        assert_eq!(side_buttons_from_mask(&[0, 0b0000_0001]), (true, false));
        assert_eq!(side_buttons_from_mask(&[0, 0b0000_0010]), (false, true));
        assert_eq!(side_buttons_from_mask(&[0, 0b0000_0011]), (true, true));
    }

    #[test]
    fn the_scroll_wheel_and_main_buttons_are_not_side_buttons() {
        // Buttons 1-7: left, middle, right, wheel up/down, wheel left/right.
        assert_eq!(side_buttons_from_mask(&[0b1111_1110, 0]), (false, false));
        assert_eq!(side_buttons_from_mask(&[0b1111_1110]), (false, false));
        assert_eq!(side_buttons_from_mask(&[]), (false, false));
    }

    /// Needs a display: `xvfb-run cargo test -- --ignored x11`. Presses the
    /// side buttons through XTest on a second connection, as a mouse would.
    #[test]
    #[ignore = "needs an X display (xvfb-run)"]
    fn x11_reads_held_side_buttons_from_the_server() {
        use std::ptr;
        use x11_dl::xlib::Xlib;
        use x11_dl::xtest::Xf86vmode as XTest;

        let side = SideButtons::open().expect("X display with XInput2");
        assert_eq!(side.held(), (false, false));

        let xlib = Xlib::open().expect("Xlib");
        let xtest = XTest::open().expect("libXtst");
        // SAFETY: a separate test connection, closed at the end.
        let display = unsafe { (xlib.XOpenDisplay)(ptr::null()) };
        assert!(!display.is_null());
        let press = |button: u32, down: bool| {
            // SAFETY: display is live; XSync waits until the server applied it.
            unsafe {
                (xtest.XTestFakeButtonEvent)(display, button, i32::from(down), 0);
                (xlib.XSync)(display, 0);
            }
        };

        press(8, true);
        assert_eq!(side.held(), (true, false));
        press(9, true);
        assert_eq!(side.held(), (true, true));
        press(8, false);
        press(9, false);
        assert_eq!(side.held(), (false, false));

        // SAFETY: opened above and closed once.
        unsafe { (xlib.XCloseDisplay)(display) };
    }
}
