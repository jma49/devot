//! Keeps a window's traffic lights at its inset (`trafficLightPosition`): tao applies it only when
//! its view draws and after full screen, while AppKit moves the buttons back whenever it lays the
//! title bar out again (#744).

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

    fn spacing(&self) -> f64 {
        self.buttons[1].frame().origin.x - self.buttons[0].frame().origin.x
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
    x: f64,
    y: f64,
    /// Measured when the buttons are first found in the window.
    spacing: Option<f64>,
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
    /// Windows being checked, so the frame changes a check makes are not checked again.
    static CHECKING: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
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

/// Places the buttons at `(x, y)` and keeps them there until the window closes. A titled window
/// whose buttons are elsewhere for now (full screen) is held all the same and placed when they
/// come back.
fn hold(window: &NSWindow, x: f64, y: f64) -> Result<(), &'static str> {
    if !window.styleMask().contains(NSWindowStyleMask::Titled) {
        return Err("E_TRAFFIC_LIGHTS_UNTITLED");
    }
    let address = std::ptr::from_ref(window) as usize;
    // An entry at this address whose window is gone belonged to a window that was freed without
    // closing; this window reused its address.
    let (known, stale) = HELD.with_borrow_mut(|held| {
        let Some(index) = held.iter().position(|entry| entry.address == address) else {
            return (false, None);
        };
        if held[index].window.load().is_some() {
            held[index].x = x;
            held[index].y = y;
            (true, None)
        } else {
            (false, Some(held.swap_remove(index)))
        }
    });
    drop(stale);
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
                x,
                y,
                spacing: None,
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

/// Calls `handler(address)` on the main thread for every `name` from `object`.
fn observe(
    name: &NSNotificationName,
    object: Option<&AnyObject>,
    handler: fn(usize),
    address: usize,
) -> Observer {
    let block = RcBlock::new(move |_: NonNull<NSNotification>| on_main(handler, address));
    // SAFETY: the name is an NSString and the object live. With no queue the block runs where the
    // notification is posted, so a frame change is corrected before the display cycle draws it.
    // The centre keeps its own copy of the block.
    unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(name),
            object,
            None,
            &block,
        )
    }
}

/// `HELD` lives on the main thread, so a notification posted on another thread is handled on the
/// main queue rather than dropped.
fn on_main(handler: fn(usize), address: usize) {
    if MainThreadMarker::new().is_some() {
        handler(address);
    } else {
        later(move || handler(address));
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

/// Removes observers on the next turn of the run loop, not inside a notification one of them may
/// be handling.
fn remove_later(observers: Vec<Observer>) {
    if observers.is_empty() {
        return;
    }
    let observers = RefCell::new(observers);
    later(move || {
        let center = NSNotificationCenter::defaultCenter();
        for observer in observers.take() {
            // SAFETY: a token `addObserverForName:object:queue:usingBlock:` returned.
            unsafe { center.removeObserver(observer.as_ref()) };
        }
    });
}

fn later(work: impl Fn() + 'static) {
    let block = RcBlock::new(work);
    // SAFETY: the main queue runs the block on the main thread. Blocks made on other threads
    // capture only a handler and an address.
    unsafe { NSOperationQueue::mainQueue().addOperationWithBlock(&block) };
}

fn check(address: usize) {
    if MainThreadMarker::new().is_none() {
        return;
    }
    let entered = CHECKING.with_borrow_mut(|checking| {
        let entered = !checking.contains(&address);
        if entered {
            checking.push(address);
        }
        entered
    });
    if !entered {
        return;
    }
    let _ = guarded("W_TRAFFIC_LIGHTS_FAILED", || {
        place(address);
        Some(())
    });
    CHECKING.with_borrow_mut(|checking| checking.retain(|&other| other != address));
}

fn place(address: usize) {
    let found = HELD.with_borrow(|held| {
        held.iter()
            .find(|entry| entry.address == address)
            .map(|entry| (entry.window.load(), entry.x, entry.y, entry.spacing))
    });
    let Some((window, x, y, spacing)) = found else {
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
    let spacing = spacing.unwrap_or_else(|| {
        let spacing = bar.spacing();
        HELD.with_borrow_mut(|held| {
            if let Some(entry) = held.iter_mut().find(|entry| entry.address == address) {
                entry.spacing = Some(spacing);
            }
        });
        spacing
    });
    let inset = Inset { x, y, spacing };
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
    let views: [Option<&NSView>; 5] = [
        Some(&bar.buttons[0]),
        Some(&bar.buttons[1]),
        Some(&bar.buttons[2]),
        title_bar.as_deref(),
        Some(&bar.container),
    ];
    let views = || views.iter().flatten().copied();
    let same = HELD.with_borrow(|held| {
        held.iter()
            .find(|entry| entry.address == address)
            .is_some_and(|entry| {
                entry.watched.len() == views().count()
                    && entry.watched.iter().zip(views()).all(|(weak, view)| {
                        weak.load()
                            .is_some_and(|seen| std::ptr::eq(Retained::as_ptr(&seen), view))
                    })
            })
    });
    if same {
        return;
    }
    // SAFETY: an AppKit string constant.
    let name = unsafe { NSViewFrameDidChangeNotification };
    let observers: Vec<Observer> = views()
        .map(|view| {
            view.setPostsFrameChangedNotifications(true);
            observe(name, Some(view), check, address)
        })
        .collect();
    let watched = views().map(Weak::new).collect();
    let stale =
        HELD.with_borrow_mut(
            |held| match held.iter_mut().find(|entry| entry.address == address) {
                Some(entry) => {
                    entry.watched = watched;
                    std::mem::replace(&mut entry.view_observers, observers)
                }
                None => observers,
            },
        );
    remove_later(stale);
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

/// A held window's buttons come back to the inset whatever moves them, and are left alone in place.
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
        let address = std::ptr::from_ref(&*window) as usize;
        CHECKING.with_borrow_mut(|checking| checking.push(address));
        for (button, origin) in bar.buttons.iter().zip(&system) {
            button.setFrameOrigin(*origin);
        }
        CHECKING.with_borrow_mut(|checking| checking.retain(|&other| other != address));
        if bar.in_place(&window, inset) {
            return Err("E_TRAFFIC_LIGHTS_TEST_NOT_MOVED");
        }
        std::thread::spawn(|| {
            // SAFETY: an AppKit string constant, posted with no object; the centre is thread-safe.
            unsafe {
                NSNotificationCenter::defaultCenter().postNotificationName_object(
                    NSApplicationDidChangeScreenParametersNotification,
                    None,
                );
            }
        })
        .join()
        .map_err(|_| "E_TRAFFIC_LIGHTS_TEST_THREAD")?;
        pump(0.05);
        if !bar.in_place(&window, inset) {
            return Err("E_TRAFFIC_LIGHTS_OTHER_THREAD_DROPPED");
        }
        let borderless = make(NSWindowStyleMask::Borderless);
        let refused = hold(&borderless, inset.x, inset.y).is_err();
        borderless.close();
        if !refused {
            return Err("E_TRAFFIC_LIGHTS_HELD_UNTITLED");
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
    let until = NSDate::dateWithTimeIntervalSinceNow(seconds);
    while until.timeIntervalSinceNow() > 0.0 {
        // SAFETY: the default mode constant is a valid run loop mode.
        unsafe { NSRunLoop::currentRunLoop().runMode_beforeDate(NSDefaultRunLoopMode, &until) };
    }
}

fn held(window: &NSWindow) -> bool {
    let address = std::ptr::from_ref(window) as usize;
    HELD.with_borrow(|held| held.iter().any(|entry| entry.address == address))
}
