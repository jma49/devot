//! The crash handler: Mach exceptions and `SIGABRT`, handed to the crash reporter.

const CRASH_EXCEPTIONS: mach2::exception_types::exception_mask_t = {
    use mach2::exception_types::*;
    EXC_MASK_BAD_ACCESS
        | EXC_MASK_BAD_INSTRUCTION
        | EXC_MASK_ARITHMETIC
        | EXC_MASK_BREAKPOINT
        | EXC_MASK_CRASH
        | EXC_MASK_RESOURCE
        | EXC_MASK_GUARD
};
/// `EXC_TYPES_COUNT` in `<mach/exception_types.h>`.
const EXCEPTION_TYPES: usize = 14;

struct Before {
    abort: libc::sigaction,
    count: usize,
    masks: [mach2::exception_types::exception_mask_t; EXCEPTION_TYPES],
    ports: [mach2::port::mach_port_t; EXCEPTION_TYPES],
    behaviors: [mach2::exception_types::exception_behavior_t; EXCEPTION_TYPES],
    flavors: [mach2::thread_status::thread_state_flavor_t; EXCEPTION_TYPES],
}

static BEFORE: std::sync::OnceLock<Before> = std::sync::OnceLock::new();
static HANDLER_ABORT: std::sync::OnceLock<libc::sigaction> = std::sync::OnceLock::new();

pub struct CrashHandler {
    _handler: crash_handler::CrashHandler,
}

/// `on_crash` runs on the handler's own thread while every other thread is suspended; it returns
/// whether the crash was handed to the crash reporter. Once a crash has been reported the process
/// ends as it would have without the handler: a Mach exception goes on to the handlers that were
/// there before, and a `SIGABRT` is raised again under the action that was there before. One
/// handler per process; it is never attached again (`detach_crash_handler`).
pub fn attach_crash_handler(
    on_crash: impl Fn(&crash_handler::CrashContext) -> bool + Send + Sync + 'static,
) -> Result<CrashHandler, crash_handler::Error> {
    // SAFETY: `make_crash_event` is unsafe because its closure runs while the
    // process is crashing. On macOS the closure runs on the handler's own
    // thread, not in a signal handler, with the other threads suspended; the
    // caller's `on_crash` only sends one Mach message and waits for the reply,
    // so it takes no lock and allocates nothing that a suspended thread could
    // be holding.
    let event = unsafe {
        crash_handler::make_crash_event(move |context| {
            crash_handler::CrashEventResult::Handled(on_crash(context))
        })
    };
    if BEFORE.get().is_none() {
        let before = save_crash_handling()
            .ok_or_else(|| crash_handler::Error::Io(std::io::Error::last_os_error()))?;
        let _ = BEFORE.set(before);
    }
    // SAFETY: a signal set on this thread's stack, filled by sigemptyset and
    // sigaddset before pthread_sigmask reads it; `previous` is written by
    // pthread_sigmask before it is read back below.
    let previous = unsafe {
        let mut abort: libc::sigset_t = std::mem::zeroed();
        let mut previous: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut abort);
        libc::sigaddset(&mut abort, libc::SIGABRT);
        libc::pthread_sigmask(libc::SIG_BLOCK, &abort, &mut previous);
        previous
    };
    // The handler's thread starts here and inherits this thread's signal
    // mask, so a SIGABRT sent to the process never lands on the one thread
    // that must answer it (its handler would wait for that thread).
    let handler = crash_handler::CrashHandler::attach(event);
    // SAFETY: restores this thread's mask from the value saved above.
    unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut()) };
    let handler = handler?;
    // SAFETY: reads the SIGABRT action crash_handler installed into a
    // zeroed sigaction, then installs `on_abort` (a plain extern "C"
    // function with the SA_SIGINFO signature) over it; `on_abort` calls the
    // saved action itself.
    unsafe {
        let mut installed: libc::sigaction = std::mem::zeroed();
        libc::sigaction(libc::SIGABRT, std::ptr::null(), &mut installed);
        let _ = HANDLER_ABORT.set(installed);
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = on_abort as *const () as libc::sighandler_t;
        action.sa_flags = libc::SA_SIGINFO;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaddset(&mut action.sa_mask, libc::SIGABRT);
        libc::sigaction(libc::SIGABRT, &action, std::ptr::null_mut());
    }
    Ok(CrashHandler { _handler: handler })
}

fn save_crash_handling() -> Option<Before> {
    // SAFETY: plain C structs and arrays on this stack, filled by sigaction
    // and task_get_exception_ports, which write at most `count` entries.
    unsafe {
        let mut before: Before = std::mem::zeroed();
        if libc::sigaction(libc::SIGABRT, std::ptr::null(), &mut before.abort) != 0 {
            return None;
        }
        let mut count = EXCEPTION_TYPES as u32;
        let saved = mach2::task::task_get_exception_ports(
            mach2::traps::mach_task_self(),
            CRASH_EXCEPTIONS,
            before.masks.as_mut_ptr(),
            &mut count,
            before.ports.as_mut_ptr(),
            before.behaviors.as_mut_ptr(),
            before.flavors.as_mut_ptr(),
        );
        if saved != mach2::kern_return::KERN_SUCCESS {
            return None;
        }
        before.count = (count as usize).min(EXCEPTION_TYPES);
        Some(before)
    }
}

/// The `SIGABRT` action and the exception ports go back to what they were before it was attached,
/// so a crash takes the system's default course. Safe to call more than once, and from a signal
/// handler (it only makes system calls). The handler's own thread stays, idle. Returns whether
/// there was anything to restore.
pub fn detach_crash_handler() -> bool {
    let Some(before) = BEFORE.get() else {
        return false;
    };
    // SAFETY: restores values saved by `save_crash_handling`; sigaction and
    // task_set_exception_ports are system calls that are safe in a signal
    // handler.
    unsafe {
        libc::sigaction(libc::SIGABRT, &before.abort, std::ptr::null_mut());
        let task = mach2::traps::mach_task_self();
        for i in 0..before.count {
            mach2::task::task_set_exception_ports(
                task,
                before.masks[i],
                before.ports[i],
                before.behaviors[i],
                before.flavors[i],
            );
        }
    }
    true
}

pub fn crash_handler_attached() -> bool {
    let Some(before) = BEFORE.get() else {
        return false;
    };
    // SAFETY: plain C structs and arrays on this stack, filled by sigaction
    // and task_get_exception_ports, which write at most `count` entries.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        libc::sigaction(libc::SIGABRT, std::ptr::null(), &mut action);
        if action.sa_sigaction == on_abort as *const () as libc::sighandler_t {
            return true;
        }
        let mask = mach2::exception_types::EXC_MASK_BAD_ACCESS;
        let mut masks = [0; EXCEPTION_TYPES];
        let mut ports = [0; EXCEPTION_TYPES];
        let mut behaviors = [0; EXCEPTION_TYPES];
        let mut flavors = [0; EXCEPTION_TYPES];
        let mut count = EXCEPTION_TYPES as u32;
        mach2::task::task_get_exception_ports(
            mach2::traps::mach_task_self(),
            mask,
            masks.as_mut_ptr(),
            &mut count,
            ports.as_mut_ptr(),
            behaviors.as_mut_ptr(),
            flavors.as_mut_ptr(),
        );
        let port_for = |masks: &[u32], ports: &[u32]| {
            masks
                .iter()
                .zip(ports)
                .find(|(m, _)| *m & mask != 0)
                .map_or(0, |(_, p)| *p)
        };
        let now = port_for(&masks[..count as usize], &ports[..count as usize]);
        now != port_for(&before.masks[..before.count], &before.ports[..before.count])
    }
}

/// Hands the crash to `crash_handler` (which waits for the reporter), then detaches and raises the
/// signal again. The signal stays blocked until this returns, so it is then taken by the action
/// from before: by default, the process ends with `SIGABRT`.
extern "C" fn on_abort(
    signal: libc::c_int,
    info: *mut libc::siginfo_t,
    context: *mut libc::c_void,
) {
    if let Some(action) = HANDLER_ABORT.get() {
        // SAFETY: crash_handler installed this action with SA_SIGINFO, so its
        // handler takes these three arguments, passed on as received.
        unsafe { run_action(action, signal, info, context) };
    }
    // SAFETY: without a saved action, the default one ends the process;
    // signal and raise are system calls, and raise only signals this thread.
    unsafe {
        if !detach_crash_handler() {
            libc::signal(signal, libc::SIG_DFL);
        }
        libc::raise(signal);
    }
}

/// # Safety
/// `info` and `context` must be what the kernel passed to the running
/// signal handler.
unsafe fn run_action(
    action: &libc::sigaction,
    signal: libc::c_int,
    info: *mut libc::siginfo_t,
    context: *mut libc::c_void,
) {
    let handler = action.sa_sigaction;
    if handler == libc::SIG_DFL || handler == libc::SIG_IGN {
        return;
    }
    if action.sa_flags & libc::SA_SIGINFO != 0 {
        // SAFETY: an SA_SIGINFO action's handler has this signature.
        let run: extern "C" fn(libc::c_int, *mut libc::siginfo_t, *mut libc::c_void) =
            unsafe { std::mem::transmute(handler) };
        run(signal, info, context);
    } else {
        // SAFETY: any other action's handler takes the signal number alone.
        let run: extern "C" fn(libc::c_int) = unsafe { std::mem::transmute(handler) };
        run(signal);
    }
}

/// Loads a Mach-O bundle (a plug-in, as AppKit and WebKit load), so that
/// the native crash tests crash a process that has one loaded.
#[cfg(debug_assertions)]
#[doc(hidden)]
pub fn load_bundle(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: a NUL-terminated path; the handle is kept open for the
    // process's life.
    !unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_NOW) }.is_null()
}

/// Stops the process with a bad memory access (`EXC_BAD_ACCESS`), as a crash
/// inside AppKit or WebKit would. Only the native crash tests call it.
#[cfg(debug_assertions)]
#[doc(hidden)]
pub fn crash_with_bad_access() -> ! {
    let unmapped = std::ptr::without_provenance_mut::<u64>(0x10);
    // SAFETY: deliberately unsound, to crash: the first 4 GiB of a macOS
    // process are never mapped, so this write faults and the process stops.
    unsafe { unmapped.write_volatile(0) };
    unreachable!("E_BAD_ACCESS_DID_NOT_CRASH")
}

/// Stops the process by calling a function at `address`, where no code is:
/// what calling a pointer made of data (note text) does. Only the native
/// crash tests call it.
#[cfg(debug_assertions)]
#[doc(hidden)]
pub fn crash_with_call_to(address: usize) -> ! {
    // SAFETY: deliberately unsound, to crash: the caller passes an address
    // nothing is mapped at, so the call faults and the process stops.
    let call = unsafe { std::mem::transmute::<usize, extern "C" fn()>(address) };
    std::hint::black_box(call)();
    unreachable!("E_CALL_DID_NOT_CRASH")
}
