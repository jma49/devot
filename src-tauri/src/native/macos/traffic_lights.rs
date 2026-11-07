//! Keeps a window's traffic lights at its inset (`trafficLightPosition`) whatever AppKit does.
//!
//! tao applies the inset only in its view's `drawRect:` and after leaving full screen, but AppKit
//! lays the title bar out again on other events (key and main state, activation, screen and backing
//! changes, appearance, title) without that view drawing, and the buttons stay at the system's
//! place (#744). Here every view tao moves posts its frame changes, and the window's notifications
//! are watched too; whenever a button is off its place, the same inset tao applies is applied
//! again, at once, on the main thread.

use std::cell::{Cell, RefCell};
use std::ptr::NonNull;
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2::rc::{Retained, Weak};
use objc2::runtime::{AnyObject, NSObjectProtocol, ProtocolObject};
use objc2_app_kit::{
    NSApplicationDidBecomeActiveNotification, NSApplicationDidChangeScreenParametersNotification,
    NSApplicationDidResignActiveNotification, NSButton, NSView, NSViewFrameDidChangeNotification,
    NSWindow, NSWindowButton, NSWindowDidBecomeKeyNotification, NSWindowDidBecomeMainNotification,
    NSWindowDidChangeBackingPropertiesNotification, NSWindowDidChangeScreenNotification,
    NSWindowDidDeminiaturizeNotification, NSWindowDidEndLiveResizeNotification,
    NSWindowDidExitFullScreenNotification, NSWindowDidResignKeyNotification,
    NSWindowDidResignMainNotification, NSWindowStyleMask, NSWindowWillCloseNotification,
};
use objc2_foundation::{
    NSNotification, NSNotificationCenter, NSNotificationName, NSOperationQueue, NSPoint, NSRect,
};

use crate::native::guarded;

const TOLERANCE: f64 = 0.01;

#[derive(Clone, Copy)]
struct Inset {
    x: f64,
    y: f64,
    spacing: f64,
}

/// The views tao's inset moves: the three buttons and the title bar container two levels above
/// the close button.
struct TitleBar {
    buttons: [Retained<NSButton>; 3],
    container: Retained<NSView>,
}

impl TitleBar {
    fn of(window: &NSWindow) -> Option<Self> {
        let button = |kind| window.standardWindowButton(kind);
        let buttons = [
            button(NSWindowButton::CloseButton)?,
            button(NSWindowButton::MiniaturizeButton)?,
            button(NSWindowButton::ZoomButton)?,
        ];
        // In full screen the buttons live in another window, where the inset does not apply.
        let in_window = buttons[0]
            .window()
            .is_some_and(|own| std::ptr::eq(Retained::as_ptr(&own), window));
        if !in_window {
            return None;
        }
        // SAFETY: main thread (NSWindow is main-thread only); `superview` reads the view tree.
        let container = unsafe { buttons[0].superview()?.superview()? };
        Some(Self { buttons, container })
    }

    fn container_frame(&self, window: &NSWindow, inset: Inset) -> NSRect {
        let height = self.buttons[0].frame().size.height + inset.y;
        // The view the container sits in is already its new size while the window resizes.
        // SAFETY: main thread; `superview` reads the view tree.
        let top = unsafe { self.container.superview() }.map_or_else(
            || window.frame().size.height,
            |frame_view| frame_view.frame().size.height,
        );
        let mut frame = self.container.frame();
        frame.size.height = height;
        frame.origin.y = top - height;
        frame
    }

    fn button_x(inset: Inset, index: usize) -> f64 {
        inset.x + index as f64 * inset.spacing
    }

    fn in_place(&self, window: &NSWindow, inset: Inset) -> bool {
        let near = |a: f64, b: f64| (a - b).abs() < TOLERANCE;
        let want = self.container_frame(window, inset);
        let have = self.container.frame();
        near(have.size.height, want.size.height)
            && near(have.origin.y, want.origin.y)
            && self
                .buttons
                .iter()
                .enumerate()
                .all(|(i, button)| near(button.frame().origin.x, Self::button_x(inset, i)))
    }

    /// tao's `inset_traffic_lights`, moving only what is off its place.
    fn apply(&self, window: &NSWindow, inset: Inset) {
        let near = |a: f64, b: f64| (a - b).abs() < TOLERANCE;
        let want = self.container_frame(window, inset);
        let have = self.container.frame();
        if !near(have.size.height, want.size.height) || !near(have.origin.y, want.origin.y) {
            self.container.setFrame(want);
        }
        for (i, button) in self.buttons.iter().enumerate() {
            let origin = button.frame().origin;
            let x = Self::button_x(inset, i);
            if !near(origin.x, x) {
                button.setFrameOrigin(NSPoint::new(x, origin.y));
            }
        }
    }
}

type Observer = Retained<ProtocolObject<dyn NSObjectProtocol>>;

/// A window whose buttons are held at an inset, with what it observes.
struct Held {
    window: Weak<NSWindow>,
    address: usize,
    inset: Inset,
    window_observers: Vec<Observer>,
    watched: Vec<Weak<NSView>>,
    view_observers: Vec<Observer>,
    burst: (Instant, u32),
}

impl Drop for Held {
    fn drop(&mut self) {
        let center = NSNotificationCenter::defaultCenter();
        for observer in self.window_observers.iter().chain(&self.view_observers) {
            // SAFETY: a token `addObserverForName:object:queue:usingBlock:` returned.
            unsafe { center.removeObserver(observer.as_ref()) };
        }
    }
}

/// More placements than this in a second mean something keeps moving the buttons back: the inset
/// gives way for the rest of that second instead of fighting it.
const MAX_PLACEMENTS_PER_SECOND: u32 = 120;

thread_local! {
    static HELD: RefCell<Vec<Held>> = const { RefCell::new(Vec::new()) };
    /// Set while a check runs, so the frame changes it makes are not checked again.
    static CHECKING: Cell<bool> = const { Cell::new(false) };
    static APP_OBSERVED: Cell<bool> = const { Cell::new(false) };
    /// Times the inset was applied again, for the self-test.
    static APPLIED: Cell<usize> = const { Cell::new(0) };
}

/// Keeps the buttons of a window built with `trafficLightPosition` at `(x, y)`.
pub fn keep_traffic_lights(window: &tauri::WebviewWindow, x: f64, y: f64) {
    let target = window.clone();
    let result = window.run_on_main_thread(move || {
        let Some(ns_window) = target.ns_window().ok().filter(|w| !w.is_null()) else {
            log::warn!("W_TRAFFIC_LIGHTS_NO_WINDOW");
            return;
        };
        let held = guarded("W_TRAFFIC_LIGHTS_FAILED", || {
            // SAFETY: `ns_window()` is the window's live NSWindow, and this runs on the main
            // thread.
            Some(hold(unsafe { &*ns_window.cast::<NSWindow>() }, x, y))
        });
        if let Some(Err(code)) = held {
            log::warn!("W_TRAFFIC_LIGHTS_UNAVAILABLE {code}");
        }
    });
    if result.is_err() {
        log::warn!("W_TRAFFIC_LIGHTS_UNAVAILABLE E_NATIVE_MAIN_THREAD_UNAVAILABLE");
    }
}

/// Places the buttons at `(x, y)` and keeps them there until the window closes.
fn hold(window: &NSWindow, x: f64, y: f64) -> Result<(), &'static str> {
    let bar = TitleBar::of(window).ok_or("E_TRAFFIC_LIGHTS_NO_BUTTONS")?;
    let spacing = bar.buttons[1].frame().origin.x - bar.buttons[0].frame().origin.x;
    let inset = Inset { x, y, spacing };
    let address = std::ptr::from_ref(window) as usize;
    let known = HELD.with_borrow_mut(|held| {
        held.iter_mut()
            .find(|entry| entry.address == address)
            .map(|entry| entry.inset = inset)
            .is_some()
    });
    if !known {
        // SAFETY: AppKit string constants.
        let names = unsafe {
            [
                NSWindowDidBecomeKeyNotification,
                NSWindowDidResignKeyNotification,
                NSWindowDidBecomeMainNotification,
                NSWindowDidResignMainNotification,
                NSWindowDidChangeScreenNotification,
                NSWindowDidChangeBackingPropertiesNotification,
                NSWindowDidEndLiveResizeNotification,
                NSWindowDidExitFullScreenNotification,
                NSWindowDidDeminiaturizeNotification,
            ]
        };
        let mut window_observers: Vec<Observer> = names
            .into_iter()
            .map(|name| observe(name, Some(window), revisit, address))
            .collect();
        // SAFETY: an AppKit string constant.
        let closing = unsafe { NSWindowWillCloseNotification };
        window_observers.push(observe(closing, Some(window), release, address));
        HELD.with_borrow_mut(|held| {
            held.push(Held {
                window: Weak::new(window),
                address,
                inset,
                window_observers,
                watched: Vec::new(),
                view_observers: Vec::new(),
                burst: (Instant::now(), 0),
            })
        });
    }
    observe_app();
    check(address);
    Ok(())
}

/// Calls `handler(address)` for every `name` from `object`, on the thread that posts it.
fn observe(
    name: &NSNotificationName,
    object: Option<&AnyObject>,
    handler: fn(usize),
    address: usize,
) -> Observer {
    let block = RcBlock::new(move |_: NonNull<NSNotification>| handler(address));
    // SAFETY: the name is an NSString and the object live; with no queue the block runs where the
    // notification is posted, and every handler checks for the main thread. The centre keeps its
    // own copy of the block.
    unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(name),
            object,
            None,
            &block,
        )
    }
}

/// The app's activation and the screens' changes revisit every held window; observed once, for
/// the rest of the process.
fn observe_app() {
    if APP_OBSERVED.replace(true) {
        return;
    }
    // SAFETY: AppKit string constants.
    let names = unsafe {
        [
            NSApplicationDidBecomeActiveNotification,
            NSApplicationDidResignActiveNotification,
            NSApplicationDidChangeScreenParametersNotification,
        ]
    };
    for name in names {
        std::mem::forget(observe(name, None, revisit_all, 0));
    }
}

fn revisit_all(_: usize) {
    let addresses: Vec<usize> =
        HELD.with_borrow(|held| held.iter().map(|entry| entry.address).collect());
    addresses.into_iter().for_each(revisit);
}

/// A window notification: AppKit may lay the title bar out while posting it or just after, so
/// the buttons are checked now and once more on the next turn of the run loop.
fn revisit(address: usize) {
    check(address);
    later(move || check(address));
}

/// Lets a closing window go. Its observers are removed on the next turn of the run loop, not
/// inside the notification that one of them is handling.
fn release(address: usize) {
    if MainThreadMarker::new().is_none() {
        return;
    }
    let entry = HELD.with_borrow_mut(|held| {
        let index = held.iter().position(|entry| entry.address == address)?;
        Some(held.swap_remove(index))
    });
    if let Some(entry) = entry {
        let entry = RefCell::new(Some(entry));
        later(move || drop(entry.take()));
    }
}

fn later(work: impl Fn() + 'static) {
    let block = RcBlock::new(work);
    // SAFETY: the main queue runs the block on the main thread, where it was made.
    unsafe { NSOperationQueue::mainQueue().addOperationWithBlock(&block) };
}

/// Applies the inset again if a button is off its place.
fn check(address: usize) {
    if MainThreadMarker::new().is_none() || CHECKING.replace(true) {
        return;
    }
    let _ = guarded("W_TRAFFIC_LIGHTS_FAILED", || {
        place(address);
        Some(())
    });
    CHECKING.set(false);
}

fn place(address: usize) {
    let found = HELD.with_borrow(|held| {
        held.iter()
            .find(|entry| entry.address == address)
            .map(|entry| (entry.window.load(), entry.inset))
    });
    let Some((window, inset)) = found else {
        return;
    };
    let Some(window) = window else {
        release(address);
        return;
    };
    if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return;
    }
    let Some(bar) = TitleBar::of(&window) else {
        return;
    };
    watch(address, &bar);
    if bar.in_place(&window, inset) || !within_budget(address) {
        return;
    }
    bar.apply(&window, inset);
    APPLIED.set(APPLIED.get() + 1);
}

/// Observes the frames of the views the inset moves, again whenever AppKit has replaced them.
fn watch(address: usize, bar: &TitleBar) {
    // SAFETY: main thread; `superview` reads the view tree.
    let title_bar = unsafe { bar.buttons[0].superview() };
    let views: Vec<Retained<NSView>> = bar
        .buttons
        .iter()
        .map(|button| Retained::into_super(Retained::into_super(button.clone())))
        .chain(title_bar)
        .chain([bar.container.clone()])
        .collect();
    let same = HELD.with_borrow(|held| {
        held.iter()
            .find(|entry| entry.address == address)
            .is_some_and(|entry| {
                entry.watched.len() == views.len()
                    && entry.watched.iter().zip(&views).all(|(weak, view)| {
                        weak.load()
                            .is_some_and(|seen| Retained::as_ptr(&seen) == Retained::as_ptr(view))
                    })
            })
    });
    if same {
        return;
    }
    // SAFETY: an AppKit string constant.
    let name = unsafe { NSViewFrameDidChangeNotification };
    let observers: Vec<Observer> = views
        .iter()
        .map(|view| {
            view.setPostsFrameChangedNotifications(true);
            observe(name, Some(view), check, address)
        })
        .collect();
    let watched = views.iter().map(Weak::from_retained).collect();
    let replaced = HELD.with_borrow_mut(|held| {
        let entry = held.iter_mut().find(|entry| entry.address == address)?;
        entry.watched = watched;
        Some(std::mem::replace(&mut entry.view_observers, observers))
    });
    let center = NSNotificationCenter::defaultCenter();
    for observer in replaced.into_iter().flatten() {
        // SAFETY: a token `addObserverForName:object:queue:usingBlock:` returned.
        unsafe { center.removeObserver(observer.as_ref()) };
    }
}

fn within_budget(address: usize) -> bool {
    HELD.with_borrow_mut(|held| {
        let Some(entry) = held.iter_mut().find(|entry| entry.address == address) else {
            return false;
        };
        let now = Instant::now();
        if now.duration_since(entry.burst.0) >= Duration::from_secs(1) {
            entry.burst = (now, 0);
        }
        entry.burst.1 += 1;
        if entry.burst.1 == MAX_PLACEMENTS_PER_SECOND + 1 {
            log::warn!("W_TRAFFIC_LIGHTS_MOVED_BACK_REPEATEDLY");
        }
        entry.burst.1 <= MAX_PLACEMENTS_PER_SECOND
    })
}

/// A titled window with the overlay title bar, held at an inset: its buttons come back to the
/// inset at once when they are moved back to the system's place, as AppKit moves them, and after
/// the window's title, appearance, style mask and key state change; an inset in place is not
/// applied again; a window without buttons is refused; a closed window is let go.
#[doc(hidden)]
pub fn self_test_traffic_lights_stay() -> Result<(), &'static str> {
    use objc2::msg_send;
    use objc2_app_kit::{
        NSAppearance, NSAppearanceNameDarkAqua, NSApplication, NSBackingStoreType,
        NSWindowTitleVisibility,
    };
    use objc2_foundation::{NSSize, NSString};
    let mtm = MainThreadMarker::new().ok_or("E_NATIVE_NOT_MAIN_THREAD")?;
    let _app = NSApplication::sharedApplication(mtm);
    let make = |style: NSWindowStyleMask| {
        let rect = NSRect::new(
            NSPoint::new(-20_000.0, -20_000.0),
            NSSize::new(800.0, 600.0),
        );
        // SAFETY: the designated initializer with a valid frame, style, backing and defer flag;
        // the window is never ordered in, so nothing shows.
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                mtm.alloc(),
                rect,
                style,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        // SAFETY: the window is closed below and released by its last Retained.
        unsafe { window.setReleasedWhenClosed(false) };
        window
    };
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable
        | NSWindowStyleMask::FullSizeContentView;
    let window = make(style);
    window.setTitlebarAppearsTransparent(true);
    window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
    let bar = TitleBar::of(&window).ok_or("E_TRAFFIC_LIGHTS_TEST_NO_BUTTONS")?;
    let system: Vec<NSPoint> = bar.buttons.iter().map(|b| b.frame().origin).collect();
    let system_container = bar.container.frame();
    let spacing = system[1].x - system[0].x;
    let inset = Inset {
        x: 20.0,
        y: 28.0,
        spacing,
    };
    if bar.in_place(&window, inset) {
        return Err("E_TRAFFIC_LIGHTS_TEST_SYSTEM_PLACE_IS_INSET");
    }
    let result = (|| {
        hold(&window, inset.x, inset.y)?;
        if !bar.in_place(&window, inset) {
            return Err("E_TRAFFIC_LIGHTS_NOT_PLACED");
        }
        for (button, origin) in bar.buttons.iter().zip(&system) {
            button.setFrameOrigin(*origin);
        }
        if !bar.in_place(&window, inset) {
            return Err("E_TRAFFIC_LIGHTS_BUTTONS_STAYED_MOVED");
        }
        bar.container.setFrame(system_container);
        if !bar.in_place(&window, inset) {
            return Err("E_TRAFFIC_LIGHTS_CONTAINER_STAYED_MOVED");
        }
        let applied = APPLIED.get();
        bar.buttons[0].setFrameOrigin(system[0]);
        if !bar.in_place(&window, inset) {
            return Err("E_TRAFFIC_LIGHTS_CLOSE_STAYED_MOVED");
        }
        if APPLIED.get() != applied + 1 {
            return Err("E_TRAFFIC_LIGHTS_NOT_APPLIED_ONCE");
        }
        let applied = APPLIED.get();
        // SAFETY: an AppKit string constant.
        post(&window, unsafe { NSWindowDidBecomeKeyNotification });
        if APPLIED.get() != applied {
            return Err("E_TRAFFIC_LIGHTS_APPLIED_IN_PLACE");
        }
        window.setTitle(&NSString::from_str("Devot"));
        // SAFETY: an AppKit string constant.
        let dark = NSAppearance::appearanceNamed(unsafe { NSAppearanceNameDarkAqua });
        // SAFETY: NSWindow conforms to NSAppearanceCustomization; the appearance is live or nil.
        let _: () = unsafe { msg_send![&*window, setAppearance: dark.as_deref()] };
        window.setStyleMask(window.styleMask());
        for (button, origin) in bar.buttons.iter().zip(&system) {
            button.setFrameOrigin(*origin);
        }
        // SAFETY: an AppKit string constant.
        post(&window, unsafe { NSWindowDidBecomeKeyNotification });
        pump(0.05);
        let bar = TitleBar::of(&window).ok_or("E_TRAFFIC_LIGHTS_TEST_NO_BUTTONS")?;
        if !bar.in_place(&window, inset) {
            return Err("E_TRAFFIC_LIGHTS_STAYED_MOVED_AFTER_EVENTS");
        }
        let borderless = make(NSWindowStyleMask::Borderless);
        let refused = hold(&borderless, inset.x, inset.y).is_err();
        borderless.close();
        if !refused {
            return Err("E_TRAFFIC_LIGHTS_HELD_NO_BUTTONS");
        }
        Ok(())
    })();
    window.close();
    pump(0.05);
    result?;
    if held(&window) {
        return Err("E_TRAFFIC_LIGHTS_KEPT_AFTER_CLOSE");
    }
    Ok(())
}

fn post(window: &NSWindow, name: &'static objc2_foundation::NSNotificationName) {
    let center = objc2_foundation::NSNotificationCenter::defaultCenter();
    // SAFETY: a live window as the object, as AppKit posts it.
    unsafe { center.postNotificationName_object(name, Some(window)) };
}

fn pump(seconds: f64) {
    use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSRunLoop};
    // SAFETY: the default mode constant is a valid run loop mode.
    unsafe {
        NSRunLoop::currentRunLoop().runMode_beforeDate(
            NSDefaultRunLoopMode,
            &NSDate::dateWithTimeIntervalSinceNow(seconds),
        );
    }
}

fn held(window: &NSWindow) -> bool {
    let address = std::ptr::from_ref(window) as usize;
    HELD.with_borrow(|held| held.iter().any(|entry| entry.address == address))
}
