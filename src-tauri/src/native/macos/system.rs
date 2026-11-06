//! C library and Mach calls the standard library has no safe form for.

unsafe extern "C" {
    fn getpeereid(socket: std::ffi::c_int, euid: *mut u32, egid: *mut u32) -> std::ffi::c_int;
}

/// The effective user of the process at the other end of a Unix socket (the MCP bridge's).
pub fn peer_uid(socket: std::os::fd::RawFd) -> Option<u32> {
    let (mut uid, mut gid) = (u32::MAX, u32::MAX);
    // SAFETY: `socket` is a descriptor the caller holds open for the call, and both pointers are
    // to live locals; getpeereid only writes through them and fails on any other descriptor.
    let done = unsafe { getpeereid(socket, &raw mut uid, &raw mut gid) };
    (done == 0).then_some(uid)
}

/// The strings in a CoreFoundation array (the system proxy's bypass list); other items are skipped.
pub fn cf_array_strings(
    list: &system_configuration::core_foundation::array::CFArray,
) -> Vec<String> {
    use system_configuration::core_foundation::base::{CFType, CFTypeRef, TCFType};
    use system_configuration::core_foundation::string::CFString;
    list.iter()
        .map(|item| {
            // SAFETY: every item of a CFArray is a live CoreFoundation object the array retains
            // while `list` is borrowed; the get rule takes a retain of its own.
            unsafe { CFType::wrap_under_get_rule(*item as CFTypeRef) }
        })
        .filter_map(|item| item.downcast::<CFString>())
        .map(|text| text.to_string())
        .collect()
}

/// As Activity Monitor shows it; the main-thread tests read it to check that native work frees what
/// it used.
#[doc(hidden)]
pub fn memory_footprint() -> Option<u64> {
    use mach2::task_info::{TASK_VM_INFO, task_vm_info};
    let mut info = task_vm_info::default();
    let mut count = (size_of::<task_vm_info>() / size_of::<mach2::vm_types::natural_t>())
        as mach2::message::mach_msg_type_number_t;
    // SAFETY: `task_info` writes at most `count` naturals (the size of
    // `info`, a plain struct that lives for the whole call) into `info` and
    // the number written into `count`; the task port is this process's own.
    let result = unsafe {
        mach2::task::task_info(
            mach2::traps::mach_task_self(),
            TASK_VM_INFO,
            (&raw mut info).cast(),
            &raw mut count,
        )
    };
    (result == mach2::kern_return::KERN_SUCCESS).then_some(info.phys_footprint)
}

pub fn executable_of(pid: u32) -> Option<std::path::PathBuf> {
    let pid = libc::c_int::try_from(pid).ok()?;
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: proc_pidpath writes at most `buffer.len()` bytes into the
    // buffer and returns how many it wrote (0 or less on failure).
    let written =
        unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    let written = usize::try_from(written).ok().filter(|&n| n > 0)?;
    buffer.truncate(written);
    use std::os::unix::ffi::OsStringExt;
    Some(std::ffi::OsString::from_vec(buffer).into())
}

/// `CLOCK_MONOTONIC` keeps counting while the Mac sleeps (`Instant` is `CLOCK_UPTIME_RAW`, which
/// stops), and setting the time does not move it. `None` if the call fails.
pub fn time_since_boot() -> Option<std::time::Duration> {
    let mut now = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: `now` is a valid, writable timespec that outlives the call, and
    // CLOCK_MONOTONIC is a clock macOS has (10.12 and later).
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now) } != 0 {
        return None;
    }
    Some(std::time::Duration::new(
        u64::try_from(now.tv_sec).ok()?,
        u32::try_from(now.tv_nsec).ok()?,
    ))
}

/// The user's own temporary folder (`DARWIN_USER_TEMP_DIR`), the same whatever `TMPDIR` says.
pub fn user_temp_dir() -> Option<std::path::PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    let mut buf = vec![0u8; 1024];
    // SAFETY: `buf` is writable for `buf.len()` bytes, and confstr writes at most that many,
    // the terminating NUL included; it returns the length it needed, NUL included, or 0.
    let needed = unsafe {
        libc::confstr(
            libc::_CS_DARWIN_USER_TEMP_DIR,
            buf.as_mut_ptr().cast(),
            buf.len(),
        )
    };
    if needed < 2 || needed > buf.len() {
        return None;
    }
    buf.truncate(needed - 1);
    Some(std::ffi::OsString::from_vec(buf).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_since_boot_runs_forward() {
        let first = time_since_boot().expect("clock");
        let then = time_since_boot().expect("clock");
        assert!(first > std::time::Duration::ZERO);
        assert!(then >= first);
    }
}
