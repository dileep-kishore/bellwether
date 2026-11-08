//! `bw browser arrange`: place the Chrome window beside the Herdr window.
//!
//! Herdr's `window()` has no bounds, so on macOS the Herdr window comes from the window server's list
//! (`CGWindowListCopyWindowInfo`), whose global top-left points are the same space CDP's window
//! bounds use. This file reaches only its sibling browser modules and `crate::usage`, so
//! `tests/arrange.rs` can compile it beside them.

use std::process::ExitCode;
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::cdp::{self, Cdp};
use super::pages;

const MIN_WIDTH: f64 = 640.0;
const CALL_TIMEOUT: Duration = Duration::from_secs(3);
/// Leaving macOS full screen animates for about a second before Chrome takes new bounds.
const NORMAL_WAIT: Duration = Duration::from_secs(3);
/// Chrome reports whole points; a fractional Herdr frame rounds either way.
const SLACK: i64 = 2;
const USAGE: &str = "usage: bw browser arrange [--owner-pid <pid>]";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn right(&self) -> f64 {
        self.x + self.w
    }

    fn holds(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.y + self.h
    }

    fn overlap(&self, o: &Rect) -> f64 {
        let w = self.right().min(o.right()) - self.x.max(o.x);
        let h = (self.y + self.h).min(o.y + o.h) - self.y.max(o.y);
        w.max(0.0) * h.max(0.0)
    }
}

/// A CDP window rectangle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bounds {
    pub left: i64,
    pub top: i64,
    pub width: i64,
    pub height: i64,
}

impl Bounds {
    fn of(r: Rect) -> Bounds {
        Bounds {
            left: r.x.round() as i64,
            top: r.y.round() as i64,
            width: r.w.round() as i64,
            height: r.h.round() as i64,
        }
    }

    fn json(&self) -> Value {
        json!({"left": self.left, "top": self.top, "width": self.width, "height": self.height})
    }

    fn read(v: &Value) -> Option<Bounds> {
        Some(Bounds {
            left: v["left"].as_i64()?,
            top: v["top"].as_i64()?,
            width: v["width"].as_i64()?,
            height: v["height"].as_i64()?,
        })
    }

    fn near(&self, o: &Bounds) -> bool {
        [
            self.left - o.left,
            self.top - o.top,
            self.width - o.width,
            self.height - o.height,
        ]
        .iter()
        .all(|d| d.abs() <= SLACK)
    }
}

/// Where Chrome goes: the gap right of Herdr if at least `min_width` wide, else the gap to its left,
/// else the right half of the display holding Herdr's centre, always with Herdr's top and height.
pub fn place(herdr: Rect, displays: &[Rect], min_width: f64) -> (Rect, &'static str) {
    let (cx, cy) = (herdr.x + herdr.w / 2.0, herdr.y + herdr.h / 2.0);
    let display = displays
        .iter()
        .find(|d| d.holds(cx, cy))
        .or_else(|| {
            displays
                .iter()
                .fold(None, |best: Option<&Rect>, d| match best {
                    Some(b) if b.overlap(&herdr) >= d.overlap(&herdr) => Some(b),
                    _ => Some(d),
                })
        })
        .copied()
        .unwrap_or(herdr);
    let right_gap = display.right() - herdr.right();
    if right_gap >= min_width {
        let at = Rect {
            x: herdr.right(),
            y: herdr.y,
            w: right_gap,
            h: herdr.h,
        };
        return (at, "right");
    }
    let left_gap = herdr.x - display.x;
    if left_gap >= min_width {
        let at = Rect {
            x: display.x,
            y: herdr.y,
            w: left_gap,
            h: herdr.h,
        };
        return (at, "left");
    }
    let half = display.w / 2.0;
    let at = Rect {
        x: display.x + half,
        y: herdr.y,
        w: half,
        h: herdr.h,
    };
    (at, "over")
}

pub struct Arranged {
    pub state: &'static str,
    pub side: Option<&'static str>,
    pub bounds: Option<Bounds>,
    pub message: String,
}

impl Arranged {
    fn not(state: &'static str, message: String) -> Arranged {
        Arranged {
            state,
            side: None,
            bounds: None,
            message,
        }
    }

    pub fn json(&self) -> Value {
        json!({
            "type": "arrange",
            "state": self.state,
            "side": self.side,
            "bounds": self.bounds.map(|b| b.json()),
            "message": self.message,
        })
    }
}

/// Moves the window of Chrome's active page on `port` to `place`'s answer for `herdr`.
pub fn arrange(port: u16, herdr: Rect, displays: &[Rect]) -> Arranged {
    let ws = match cdp::browser_ws(port) {
        Ok((ws, _)) => ws,
        Err(e) => return Arranged::not("chrome_not_running", e),
    };
    let (at, side) = place(herdr, displays, MIN_WIDTH);
    match set_bounds(port, &ws, Bounds::of(at)) {
        Ok(bounds) => Arranged {
            state: "placed",
            side: Some(side),
            bounds: Some(bounds),
            message: match side {
                "right" => "Placed right of Herdr".to_string(),
                "left" => "Placed left of Herdr".to_string(),
                _ => "No room beside Herdr: Chrome covers the right half".to_string(),
            },
        },
        Err(e) => Arranged::not("failed", e),
    }
}

fn set_bounds(port: u16, ws: &str, want: Bounds) -> Result<Bounds, String> {
    let list = pages::list(port)?;
    let ids: Vec<&str> = list.iter().filter_map(|t| t["id"].as_str()).collect();
    let Some(first) = ids.first() else {
        return Err("the Bellwether Chrome has no open window".to_string());
    };
    let focused = pages::focused(port, &ids);
    let target = ids
        .iter()
        .find(|id| focused.contains(**id))
        .unwrap_or(first);
    let mut cdp = Cdp::connect(ws, CALL_TIMEOUT)?;
    let window = cdp.call("Browser.getWindowForTarget", json!({"targetId": target}))?;
    let id = window["windowId"]
        .as_i64()
        .ok_or("Browser.getWindowForTarget gave no windowId")?;
    let state = window["bounds"]["windowState"].as_str().unwrap_or("normal");
    // Bounds sent to a maximized window restore its old normal bounds instead (Task 1 probe, (e)).
    if state != "normal" {
        let normal = json!({"windowId": id, "bounds": {"windowState": "normal"}});
        cdp.call("Browser.setWindowBounds", normal)?;
        wait_normal(&mut cdp, id, state)?;
    }
    cdp.call(
        "Browser.setWindowBounds",
        json!({"windowId": id, "bounds": want.json()}),
    )?;
    let after = cdp.call("Browser.getWindowBounds", json!({"windowId": id}))?;
    let got = Bounds::read(&after["bounds"]).ok_or("Browser.getWindowBounds gave no bounds")?;
    if after["bounds"]["windowState"].as_str().unwrap_or("normal") != "normal" || !got.near(&want) {
        return Err(format!(
            "Chrome kept its window at {}, not {}",
            after["bounds"],
            want.json()
        ));
    }
    Ok(got)
}

fn wait_normal(cdp: &mut Cdp, id: i64, from: &str) -> Result<(), String> {
    let deadline = Instant::now() + NORMAL_WAIT;
    loop {
        let now = cdp.call("Browser.getWindowBounds", json!({"windowId": id}))?;
        if now["bounds"]["windowState"].as_str() == Some("normal") {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Chrome's window did not leave {from} within {NORMAL_WAIT:?}"
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(target_os = "macos")]
fn ps() -> String {
    std::env::var("BW_PS").unwrap_or_else(|_| "ps".to_string())
}

pub fn run(args: &[String]) -> ExitCode {
    let owner_pid = match args {
        [] => None,
        [flag, pid] if flag == "--owner-pid" => match pid.parse::<i32>() {
            Ok(pid) if pid > 0 => Some(pid),
            _ => return crate::usage(&format!("--owner-pid {pid:?} is not a pid; {USAGE}")),
        },
        _ => return crate::usage(USAGE),
    };
    println!("{}", arrange_here(owner_pid).json());
    ExitCode::SUCCESS
}

#[cfg(target_os = "macos")]
fn arrange_here(owner_pid: Option<i32>) -> Arranged {
    use super::chrome;
    let port = chrome::port();
    // Only a listener that `up` would reuse, so arrange never attaches to another program or Chrome.
    let found = chrome::probe(port, &chrome::profile_dir());
    match found.state {
        "running" => {}
        "stopped" => {
            let e = format!("the Bellwether Chrome is not running (nothing listens on {port})");
            return Arranged::not("chrome_not_running", e);
        }
        "port_taken" => {
            let e = format!("{}, not the Bellwether Chrome", found.message);
            return Arranged::not("chrome_not_running", e);
        }
        _ => return Arranged::not("chrome_not_running", found.message),
    }
    let herdr = match herdr_window(owner_pid) {
        Ok(r) => r,
        Err(e) => return Arranged::not("no_herdr_window", e),
    };
    arrange(port, herdr, &displays())
}

#[cfg(not(target_os = "macos"))]
fn arrange_here(_owner_pid: Option<i32>) -> Arranged {
    Arranged::not(
        "unsupported",
        "Arrange needs macOS's window list".to_string(),
    )
}

#[cfg(target_os = "macos")]
struct Window {
    pid: i32,
    owner: String,
    bounds: Rect,
}

/// On-screen layer-0 windows, front to back.
#[cfg(target_os = "macos")]
fn windows() -> Vec<Window> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::geometry::CGRect;
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowBounds, kCGWindowLayer,
        kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly, kCGWindowOwnerName,
        kCGWindowOwnerPID,
    };

    let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    let Some(list) = copy_window_info(options, kCGNullWindowID) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in list.iter() {
        // SAFETY: each element of the window list is a CFDictionary the list keeps alive.
        let dict: CFDictionary =
            unsafe { CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef) };
        let get = |key: CFStringRef| -> Option<CFType> {
            // SAFETY: the key is a CoreGraphics constant and found values are CF objects `dict` owns.
            unsafe {
                dict.find(key as *const _)
                    .map(|v| CFType::wrap_under_get_rule(*v as _))
            }
        };
        // SAFETY: reading CoreGraphics' immutable key constants.
        let (layer_key, pid_key, owner_key, bounds_key) = unsafe {
            (
                kCGWindowLayer,
                kCGWindowOwnerPID,
                kCGWindowOwnerName,
                kCGWindowBounds,
            )
        };
        let number = |key| get(key)?.downcast::<CFNumber>()?.to_i64();
        if number(layer_key) != Some(0) {
            continue;
        }
        let Some(pid) = number(pid_key).and_then(|p| i32::try_from(p).ok()) else {
            continue;
        };
        let owner = get(owner_key)
            .and_then(|v| v.downcast::<CFString>())
            .map(|s| s.to_string())
            .unwrap_or_default();
        let Some(rect) = get(bounds_key)
            .and_then(|v| v.downcast::<CFDictionary>())
            .and_then(|d| CGRect::from_dict_representation(&d))
        else {
            continue;
        };
        if rect.size.width <= 0.0 || rect.size.height <= 0.0 {
            continue;
        }
        out.push(Window {
            pid,
            owner,
            bounds: Rect {
                x: rect.origin.x,
                y: rect.origin.y,
                w: rect.size.width,
                h: rect.size.height,
            },
        });
    }
    out
}

/// The pid owning the frontmost on-screen window; `BW_FRONT_PID` stands in for it in tests.
pub fn front_pid() -> Option<i32> {
    if let Ok(v) = std::env::var("BW_FRONT_PID") {
        return v.trim().parse().ok();
    }
    front_window_pid()
}

#[cfg(target_os = "macos")]
fn front_window_pid() -> Option<i32> {
    windows().first().map(|w| w.pid)
}

#[cfg(not(target_os = "macos"))]
fn front_window_pid() -> Option<i32> {
    None
}

/// The Herdr window: `owner_pid`'s frontmost window, else that of the nearest ancestor of `bw`
/// that owns one, else the frontmost window of an app whose name holds "herdr".
#[cfg(target_os = "macos")]
pub fn herdr_window(owner_pid: Option<i32>) -> Result<Rect, String> {
    let windows = windows();
    let of = |pid: i32| windows.iter().find(|w| w.pid == pid).map(|w| w.bounds);
    if let Some(pid) = owner_pid {
        return of(pid).ok_or_else(|| {
            format!(
                "pid {pid} owns no on-screen window ({} listed)",
                windows.len()
            )
        });
    }
    let mut pid = std::os::unix::process::parent_id() as i32;
    for _ in 0..64 {
        if pid <= 1 {
            break;
        }
        if let Some(r) = of(pid) {
            return Ok(r);
        }
        match parent_of(pid) {
            Some(p) => pid = p,
            None => break,
        }
    }
    windows
        .iter()
        .find(|w| w.owner.to_lowercase().contains("herdr"))
        .map(|w| w.bounds)
        .ok_or_else(|| {
            format!(
                "no on-screen window belongs to bw's parent processes or to an app named Herdr \
                 ({} listed)",
                windows.len()
            )
        })
}

#[cfg(target_os = "macos")]
fn parent_of(pid: i32) -> Option<i32> {
    let out = Command::new(ps())
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// Active displays' bounds in global points, top-left origin.
#[cfg(target_os = "macos")]
pub fn displays() -> Vec<Rect> {
    use core_graphics::display::CGDisplay;
    CGDisplay::active_displays()
        .unwrap_or_default()
        .into_iter()
        .map(|id| {
            let b = CGDisplay::new(id).bounds();
            Rect {
                x: b.origin.x,
                y: b.origin.y,
                w: b.size.width,
                h: b.size.height,
            }
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
pub fn displays() -> Vec<Rect> {
    Vec::new()
}
