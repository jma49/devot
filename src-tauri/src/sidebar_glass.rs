//! The floating sidebar's glass in the Glass interface. On macOS 26 the system's glass
//! (NSGlassEffectView) is drawn under the web view where the page says the sidebar is; the page
//! sends the sidebar's frame whenever it moves (sidebarGlass.ts) and `None` when the sidebar or the
//! window material goes. Before macOS 26, and on other systems, there is no such view: the command
//! answers false and the page draws a tint of its own.

use serde::Deserialize;

const MAX_POINTS: f64 = 100_000.0;
const MAX_RADIUS: f64 = 1_000.0;

/// In points from the web view's top-left corner.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct GlassFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub radius: f64,
}

pub fn checked(frame: Option<GlassFrame>) -> Result<Option<GlassFrame>, &'static str> {
    let Some(frame) = frame else { return Ok(None) };
    let within =
        |value: f64, low: f64, high: f64| value.is_finite() && value >= low && value <= high;
    let fits = within(frame.x, 0.0, MAX_POINTS)
        && within(frame.y, 0.0, MAX_POINTS)
        && within(frame.width, 1.0, MAX_POINTS)
        && within(frame.height, 1.0, MAX_POINTS)
        && within(frame.radius, 0.0, MAX_RADIUS);
    if fits {
        Ok(Some(frame))
    } else {
        Err("E_SIDEBAR_GLASS_FRAME_INVALID")
    }
}

/// An AppKit rect `(x, y, width, height)` in the web view's superview for `frame`. AppKit's origin
/// is the bottom-left corner unless the superview is flipped.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn superview_rect(
    web_view: (f64, f64, f64, f64),
    superview_flipped: bool,
    frame: &GlassFrame,
) -> (f64, f64, f64, f64) {
    let (left, bottom, _, height) = web_view;
    let y = if superview_flipped {
        bottom + frame.y
    } else {
        bottom + height - frame.y - frame.height
    };
    (left + frame.x, y, frame.width, frame.height)
}

/// Whether the system's glass is now under the sidebar.
#[tauri::command]
pub async fn sidebar_glass(
    window: tauri::WebviewWindow,
    frame: Option<GlassFrame>,
) -> Result<bool, String> {
    let frame = checked(frame).map_err(String::from)?;
    if !crate::main_windows::is_main(window.label()) {
        return Err(String::from("E_SIDEBAR_GLASS_NOT_MAIN"));
    }
    #[cfg(target_os = "macos")]
    {
        let (reply, shown) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                let _ = reply.send(crate::native::macos::set_sidebar_glass(&webview, frame));
            })
            .map_err(|_| String::from("E_NATIVE_WEBVIEW_UNAVAILABLE"))?;
        shown
            .await
            .map_err(|_| String::from("E_SIDEBAR_GLASS_FAILED"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = frame;
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame() -> GlassFrame {
        GlassFrame {
            x: 8.0,
            y: 8.0,
            width: 200.0,
            height: 684.0,
            radius: 18.0,
        }
    }

    #[test]
    fn takes_a_frame_inside_the_window_and_none() {
        assert_eq!(checked(Some(frame())), Ok(Some(frame())));
        assert_eq!(checked(None), Ok(None));
    }

    #[test]
    fn refuses_a_frame_that_is_not_a_place_in_a_window() {
        let bad = [
            GlassFrame { x: -1.0, ..frame() },
            GlassFrame {
                y: f64::NAN,
                ..frame()
            },
            GlassFrame {
                width: 0.0,
                ..frame()
            },
            GlassFrame {
                height: f64::INFINITY,
                ..frame()
            },
            GlassFrame {
                width: 1e9,
                ..frame()
            },
            GlassFrame {
                radius: -2.0,
                ..frame()
            },
            GlassFrame {
                radius: 5_000.0,
                ..frame()
            },
        ];
        for one in bad {
            assert_eq!(checked(Some(one)), Err("E_SIDEBAR_GLASS_FRAME_INVALID"));
        }
    }

    #[test]
    fn places_the_glass_from_the_bottom_in_an_unflipped_superview() {
        let web_view = (0.0, 0.0, 1280.0, 700.0);
        assert_eq!(
            superview_rect(web_view, false, &frame()),
            (8.0, 8.0, 200.0, 684.0)
        );
        let short = GlassFrame {
            height: 300.0,
            ..frame()
        };
        assert_eq!(
            superview_rect(web_view, false, &short),
            (8.0, 392.0, 200.0, 300.0)
        );
    }

    #[test]
    fn places_the_glass_from_the_top_in_a_flipped_superview_and_follows_the_web_view() {
        let web_view = (10.0, 20.0, 1280.0, 700.0);
        let short = GlassFrame {
            height: 300.0,
            ..frame()
        };
        assert_eq!(
            superview_rect(web_view, true, &short),
            (18.0, 28.0, 200.0, 300.0)
        );
        assert_eq!(
            superview_rect(web_view, false, &short),
            (18.0, 412.0, 200.0, 300.0)
        );
    }
}
