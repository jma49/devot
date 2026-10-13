//! What a crash report may carry: an allowlist, field by field.
//!
//! `scrub_event` builds a new event from a fixed list of the fields of the
//! one it is given, and keeps each value only in the shape its field must
//! have: a code (`E_NOTE_PUT`), a name made of a few known characters (an
//! error type, a function, a binary's file name, a source file), a number, or
//! an address inside one of the binaries the event lists. Every other field,
//! and any value of another shape, is left out. Note text, titles, file
//! paths that name the user and memory contents (attachments included) so
//! never leave the device, whatever an event was filled with. Panics, native
//! crashes and saved native crash reports all pass through it, the last ones
//! both when they are saved and when they are sent.

use crate::{crash_reporter, logs};
use sentry::protocol::{
    AppleDebugImage, CError, ClientSdkInfo, Context, DebugImage, DebugMeta, DeviceContext, Event,
    Exception, Frame, MachException, Map, Mechanism, MechanismMeta, OsContext, PosixSignal,
    RuntimeContext, Stacktrace, SymbolicDebugImage, Thread, ThreadId, Values,
};
use std::borrow::Cow;

const REDACTED: &str = "<redacted>";
/// A fault address below this is a null pointer and a small offset, too
/// small to hold more than a character of anything.
pub(crate) const NEAR_NULL: u64 = 0x1000;
/// A binary is loaded at a page boundary; text read as an address never is.
const PAGE: u64 = 0x1000;
const MAX_NAME: usize = 128;
const MAX_SYMBOL: usize = 512;
const MAX_PATH: usize = 512;
/// The files a code location may name: source code, never a document.
const SOURCE_EXTENSIONS: [&str; 19] = [
    "rs", "c", "cc", "cpp", "cxx", "h", "hh", "hpp", "m", "mm", "swift", "s", "js", "mjs", "cjs",
    "jsx", "ts", "tsx", "mts",
];

/// Up to `max` bytes, at least one, each one `allowed`.
fn made_of(text: &str, max: usize, allowed: impl Fn(u8) -> bool) -> bool {
    !text.is_empty() && text.len() <= max && text.bytes().all(allowed)
}

fn starts_with(text: &str, first: impl Fn(&u8) -> bool) -> bool {
    text.as_bytes().first().is_some_and(first)
}

/// `SIGABRT`, `ENOENT`, `EXC_BAD_ACCESS`.
fn is_constant(text: &str) -> bool {
    starts_with(text, u8::is_ascii_uppercase)
        && made_of(text, 64, |b| {
            b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'
        })
}

/// A mechanism: `panic`, `minidump`.
fn is_word(text: &str) -> bool {
    starts_with(text, u8::is_ascii_lowercase)
        && made_of(text, 64, |b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.')
        })
}

/// Thread names are fixed words: `devot-db`, `tokio-runtime-worker`.
fn is_thread_name(text: &str) -> bool {
    made_of(text, 64, |b| {
        b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.' | b':')
    })
}

/// A function or symbol name: printable ASCII, as compilers write them.
fn is_symbol(text: &str) -> bool {
    made_of(text, MAX_SYMBOL, |b| (0x20..0x7f).contains(&b))
}

/// A thread ID: a number, sometimes written as text.
fn thread_id(id: &ThreadId) -> Option<ThreadId> {
    match id {
        ThreadId::Int(n) => Some(ThreadId::Int(*n)),
        ThreadId::String(s) => made_of(s, 20, |b| b.is_ascii_digit()).then(|| id.clone()),
    }
}

/// `arm64`, `x86_64`.
fn is_arch(text: &str) -> bool {
    made_of(text, 16, |b| {
        b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'
    })
}

/// A version number: `26.1.0`, `0.49.3`, `1.99.0-nightly`.
fn is_version(text: &str) -> bool {
    starts_with(text, u8::is_ascii_digit)
        && made_of(text, 32, |b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-')
        })
}

/// `devot@0.1.0`.
fn is_release(text: &str) -> bool {
    text.split_once('@').is_some_and(|(name, version)| {
        made_of(name, 32, |b| b.is_ascii_lowercase() || b == b'-')
            && made_of(version, 64, |b| {
                b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-')
            })
    })
}

/// A Mac model identifier: `MacBookPro18,3`, `Mac14,2`.
fn is_model(text: &str) -> bool {
    let Some((left, right)) = text.split_once(',') else {
        return false;
    };
    let letters = left.trim_end_matches(|c: char| c.is_ascii_digit());
    made_of(right, 4, |b| b.is_ascii_digit())
        && letters.len() < left.len()
        && left.len() - letters.len() <= 4
        && made_of(letters, 32, |b| b.is_ascii_alphabetic())
}

/// A binary's file name (`devot`, `libsystem_c.dylib`, `WebKit`), never the
/// folder it was loaded from; a name of another shape is not shown.
fn binary_name(path: &str) -> String {
    let name = crash_reporter::file_name(path);
    if made_of(name, MAX_NAME, |b| {
        b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-')
    }) {
        name.into()
    } else {
        REDACTED.into()
    }
}

/// A source file a frame is in, with the user name in a home folder path
/// replaced and any query or fragment of a script URL dropped.
fn source_path(path: &str) -> Option<String> {
    let path = path.split(['?', '#']).next()?;
    let extension = path.rsplit_once('.')?.1;
    if extension.contains('/')
        || !SOURCE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
    {
        return None;
    }
    let path = logs::scrub_paths(path);
    made_of(&path, MAX_PATH, |b| (0x20..0x7f).contains(&b)).then_some(path)
}

/// The code a text starts with, or a placeholder.
fn redact(text: &str) -> String {
    match logs::panic_code(text) {
        "E_UNKNOWN" => REDACTED.into(),
        code => code.into(),
    }
}

/// An identifier or a path of them: `panic`, `EXC_BAD_ACCESS`, `std::io::Error`.
fn is_type_name(text: &str) -> bool {
    text.len() <= 64
        && text.split("::").all(|part| {
            starts_with(part, |b| b.is_ascii_alphabetic() || *b == b'_')
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
}

/// An error type: the names it starts with (`EXC_GUARD / GUARD_TYPE_USER`),
/// without the numbers a crash reason can go on with.
fn error_type(text: &str) -> String {
    let names: Vec<&str> = text
        .split('/')
        .map(str::trim)
        .take_while(|part| is_type_name(part))
        .collect();
    if names.is_empty() {
        REDACTED.into()
    } else {
        names.join(" / ")
    }
}

/// A binary the event lists, and where it is loaded.
struct Listed {
    image: DebugImage,
    start: u64,
    end: u64,
}

fn listed(image: DebugImage, start: u64, size: u64) -> Option<Listed> {
    (start.is_multiple_of(PAGE) && size > 0).then(|| Listed {
        image,
        start,
        end: start.saturating_add(size),
    })
}

/// A native binary by file name, debug ID and load address; other kinds
/// of image (and images at no page boundary) go.
fn scrub_image(image: &DebugImage) -> Option<Listed> {
    match image {
        DebugImage::Symbolic(i) => listed(
            DebugImage::Symbolic(SymbolicDebugImage {
                name: binary_name(&i.name),
                arch: i.arch.clone().filter(|a| is_arch(a)),
                image_addr: i.image_addr,
                image_size: i.image_size,
                image_vmaddr: i.image_vmaddr,
                id: i.id,
                code_id: i.code_id.clone().filter(|c| c.as_str().len() <= 64),
                debug_file: i
                    .debug_file
                    .as_deref()
                    .map(binary_name)
                    .filter(|name| name != REDACTED),
            }),
            i.image_addr.0,
            i.image_size,
        ),
        DebugImage::Apple(i) => listed(
            DebugImage::Apple(AppleDebugImage {
                name: binary_name(&i.name),
                arch: i.arch.clone().filter(|a| is_arch(a)),
                cpu_type: i.cpu_type,
                cpu_subtype: i.cpu_subtype,
                image_addr: i.image_addr,
                image_size: i.image_size,
                image_vmaddr: i.image_vmaddr,
                uuid: i.uuid,
            }),
            i.image_addr.0,
            i.image_size,
        ),
        _ => None,
    }
}

/// The listed binary an address falls in: of those whose range holds it,
/// the one loaded last below it (the ranges of system libraries overlap).
fn image_of(images: &[Listed], address: u64) -> Option<usize> {
    images
        .iter()
        .enumerate()
        .filter(|(_, image)| image.start <= address && address < image.end)
        .max_by_key(|(_, image)| image.start)
        .map(|(i, _)| i)
}

/// The binaries the kept addresses are in.
struct Images {
    listed: Vec<Listed>,
    used: Vec<bool>,
}

impl Images {
    /// Whether `address` is inside a listed binary, which the event then
    /// keeps.
    fn holds(&mut self, address: u64) -> bool {
        let found = image_of(&self.listed, address);
        if let Some(i) = found {
            self.used[i] = true;
        }
        found.is_some()
    }
}

/// The parts of a frame that locate code: names, a source file and line,
/// and addresses inside a listed binary. A frame left with none of them goes.
fn scrub_frame(frame: &Frame, images: &mut Images) -> Option<Frame> {
    let instruction_addr = frame.instruction_addr.filter(|a| images.holds(a.0));
    let out = Frame {
        function: frame.function.clone().filter(|f| is_symbol(f)),
        symbol: frame.symbol.clone().filter(|s| is_symbol(s)),
        package: frame.package.as_deref().map(binary_name),
        filename: frame.filename.as_deref().and_then(source_path),
        abs_path: frame.abs_path.as_deref().and_then(source_path),
        lineno: frame.lineno,
        colno: frame.colno,
        in_app: frame.in_app,
        instruction_addr,
        image_addr: frame
            .image_addr
            .filter(|a| images.listed.iter().any(|image| image.start == a.0)),
        symbol_addr: frame
            .symbol_addr
            .filter(|a| image_of(&images.listed, a.0).is_some()),
        ..Default::default()
    };
    let locates = out.instruction_addr.is_some()
        || out.function.is_some()
        || out.symbol.is_some()
        || out.filename.is_some()
        || out.abs_path.is_some();
    locates.then_some(out)
}

fn scrub_stack(stack: Option<&Stacktrace>, images: &mut Images) -> Option<Stacktrace> {
    let frames: Vec<Frame> = stack?
        .frames
        .iter()
        .filter_map(|frame| scrub_frame(frame, images))
        .collect();
    (!frames.is_empty()).then(|| Stacktrace {
        frames,
        ..Default::default()
    })
}

/// The mechanism's type, flags, and the signal, errno and Mach exception
/// by number and constant name. A Mach exception's subcode (for a bad
/// access, the address that faulted) stays only near null or inside a
/// listed binary; anywhere else it could be data used as a pointer, and
/// the Mach exception goes (its type and code are in the error type too).
fn scrub_mechanism(mechanism: &Mechanism, images: &mut Images) -> Mechanism {
    let meta = &mechanism.meta;
    Mechanism {
        ty: if is_word(&mechanism.ty) {
            mechanism.ty.clone()
        } else {
            "generic".into()
        },
        handled: mechanism.handled,
        synthetic: mechanism.synthetic,
        meta: MechanismMeta {
            errno: meta.errno.as_ref().map(|errno| CError {
                number: errno.number,
                name: errno.name.clone().filter(|n| is_constant(n)),
            }),
            signal: meta.signal.as_ref().map(|signal| PosixSignal {
                number: signal.number,
                code: signal.code,
                name: signal.name.clone().filter(|n| is_constant(n)),
                code_name: signal.code_name.clone().filter(|n| is_constant(n)),
            }),
            mach_exception: meta
                .mach_exception
                .as_ref()
                .filter(|mach| mach.subcode < NEAR_NULL || images.holds(mach.subcode))
                .map(|mach| MachException {
                    exception: mach.exception,
                    code: mach.code,
                    subcode: mach.subcode,
                    name: mach.name.clone().filter(|n| is_constant(n)),
                }),
        },
        ..Default::default()
    }
}

fn scrub_exception(exception: &Exception, images: &mut Images) -> Exception {
    Exception {
        ty: error_type(&exception.ty),
        value: exception.value.as_deref().map(redact),
        stacktrace: scrub_stack(exception.stacktrace.as_ref(), images),
        thread_id: exception.thread_id.as_ref().and_then(thread_id),
        mechanism: exception
            .mechanism
            .as_ref()
            .map(|mechanism| scrub_mechanism(mechanism, images)),
        ..Default::default()
    }
}

fn scrub_thread(thread: &Thread, images: &mut Images) -> Thread {
    Thread {
        id: thread.id.as_ref().and_then(thread_id),
        name: thread.name.clone().filter(|n| is_thread_name(n)),
        stacktrace: scrub_stack(thread.stacktrace.as_ref(), images),
        crashed: thread.crashed,
        current: thread.current,
        ..Default::default()
    }
}

/// The system: OS name, version and build; CPU, model and family (never the
/// device's name); the Rust compiler. Each only in its own shape.
fn scrub_contexts(contexts: &Map<String, Context>) -> Map<String, Context> {
    let mut kept = Map::new();
    if let Some(Context::Os(os)) = contexts.get("os") {
        let os = OsContext {
            name: os
                .name
                .clone()
                .filter(|n| made_of(n, 32, |b| b.is_ascii_alphabetic())),
            version: os.version.clone().filter(|v| is_version(v)),
            build: os
                .build
                .clone()
                .filter(|b| made_of(b, 16, |c| c.is_ascii_alphanumeric())),
            ..Default::default()
        };
        if os != OsContext::default() {
            kept.insert("os".into(), Context::Os(Box::new(os)));
        }
    }
    if let Some(Context::Device(device)) = contexts.get("device") {
        let device = DeviceContext {
            arch: device.arch.clone().filter(|a| is_arch(a)),
            model: device.model.clone().filter(|m| is_model(m)),
            family: device
                .family
                .clone()
                .filter(|f| made_of(f, 32, |b| b.is_ascii_alphabetic())),
            ..Default::default()
        };
        if device != DeviceContext::default() {
            kept.insert("device".into(), Context::Device(Box::new(device)));
        }
    }
    if let Some(Context::Runtime(rust)) = contexts.get("rust") {
        let mut other = Map::new();
        if let Some(channel) = rust
            .other
            .get("channel")
            .and_then(|c| c.as_str())
            .filter(|c| matches!(*c, "stable" | "beta" | "nightly"))
        {
            other.insert("channel".into(), channel.into());
        }
        let rust = RuntimeContext {
            name: rust
                .name
                .clone()
                .filter(|n| made_of(n, 16, |b| b.is_ascii_lowercase())),
            version: rust.version.clone().filter(|v| is_version(v)),
            other,
        };
        if rust != RuntimeContext::default() {
            kept.insert("rust".into(), Context::Runtime(Box::new(rust)));
        }
    }
    kept
}

/// Builds the event that may leave the device from `event`: codes, error
/// types, code locations, addresses inside the binaries it lists (and
/// those binaries by file name and debug ID), release and system details.
pub fn scrub_event(event: Event<'static>) -> Event<'static> {
    let listed: Vec<Listed> = event
        .debug_meta
        .images
        .iter()
        .filter_map(scrub_image)
        .collect();
    let mut images = Images {
        used: vec![false; listed.len()],
        listed,
    };
    let exception = event
        .exception
        .values
        .iter()
        .map(|exception| scrub_exception(exception, &mut images))
        .collect();
    let threads = event
        .threads
        .values
        .iter()
        .map(|thread| scrub_thread(thread, &mut images))
        .collect();
    let stacktrace = scrub_stack(event.stacktrace.as_ref(), &mut images);
    // Only the binaries a kept address is in.
    let kept_images = images
        .listed
        .into_iter()
        .zip(images.used)
        .filter_map(|(image, used)| used.then_some(image.image))
        .collect();
    let platform = match &*event.platform {
        "javascript" => "javascript",
        "other" => "other",
        _ => "native",
    };
    Event {
        event_id: event.event_id,
        level: event.level,
        timestamp: event.timestamp,
        platform: Cow::Borrowed(platform),
        release: event.release.filter(|r| is_release(r)),
        environment: event
            .environment
            .filter(|e| matches!(&**e, "production" | "development")),
        message: event.message.as_deref().map(redact),
        exception: Values { values: exception },
        threads: Values { values: threads },
        stacktrace,
        debug_meta: Cow::Owned(DebugMeta {
            sdk_info: None,
            images: kept_images,
        }),
        contexts: scrub_contexts(&event.contexts),
        sdk: event
            .sdk
            .as_deref()
            .filter(|sdk| {
                starts_with(&sdk.name, u8::is_ascii_lowercase)
                    && made_of(&sdk.name, 64, |b| {
                        b.is_ascii_lowercase()
                            || b.is_ascii_digit()
                            || matches!(b, b'.' | b'_' | b'-')
                    })
                    && is_version(&sdk.version)
            })
            .map(|sdk| {
                Cow::Owned(ClientSdkInfo {
                    name: sdk.name.clone(),
                    version: sdk.version.clone(),
                    integrations: Vec::new(),
                    packages: Vec::new(),
                })
            }),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sentry::protocol::debugid::{CodeId, DebugId};
    use sentry::protocol::{
        Addr, AppContext, AppleDebugImage, Breadcrumb, CError, ClientSdkInfo, ClientSdkPackage,
        Context, DebugImage, DeviceContext, Event, Exception, Frame, Level, LogEntry,
        MachException, Map, Mechanism, MechanismMeta, OsContext, PosixSignal, ProguardDebugImage,
        RegVal, Request, RuntimeContext, Stacktrace, SymbolicDebugImage, TemplateInfo, Thread,
        ThreadId, User, Values,
    };
    use std::borrow::Cow;

    const NOTE: &str = "buy oat milk";
    const TITLE: &str = "Diary 2026";
    /// A title in a script other than Latin (written as escapes).
    const WIDE_TITLE: &str = "\u{65e5}\u{8a18} 2026";
    const USER: &str = "alice";
    const NOTE_PATH: &str = "/Users/alice/Documents/Diary 2026.md";
    /// The first bytes of a PNG attachment, as base64 and as hex.
    const ATTACHMENT: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const ATTACHMENT_HEX: &str = "89504e470d0a1a0a";
    /// Everything a field could be filled with that must never leave.
    const SECRET: &str = "Grocery list: buy oat milk, Diary 2026 \u{65e5}\u{8a18} 2026 \
        /Users/alice/Documents/Diary 2026.md iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB 89504e470d0a1a0a";
    /// Note text read as an address: what a stack word, a register or a
    /// fault address holds when data is used as a pointer.
    const TEXT_ADDRESS: u64 = u64::from_le_bytes(*b"Diary \0\0");
    const APP_BASE: u64 = 0x1_0000_0000;
    const APP_SIZE: u64 = 0x10_0000;
    const IN_APP: u64 = APP_BASE + 0x200;
    const APP_PATH: &str = "/Users/alice/Applications/Devot.app/Contents/MacOS/devot";
    const DEBUG_ID: &str = "4c4c4436-5555-3144-a1d2-7f8a9b0c1d2e";

    fn secrets() -> Vec<String> {
        vec![
            NOTE.into(),
            TITLE.into(),
            WIDE_TITLE.into(),
            "Grocery list".into(),
            format!("/Users/{USER}"),
            format!("\"{USER}"),
            ATTACHMENT.into(),
            ATTACHMENT_HEX.into(),
            format!("{TEXT_ADDRESS:x}"),
            TEXT_ADDRESS.to_string(),
        ]
    }

    fn assert_none_left(event: &Event<'static>) {
        let json = serde_json::to_string(event).unwrap();
        for secret in secrets() {
            assert!(!json.contains(&secret), "{secret} survived: {json}");
        }
    }

    fn app_image(name: &str) -> DebugImage {
        DebugImage::Symbolic(SymbolicDebugImage {
            name: name.into(),
            arch: Some("arm64".into()),
            image_addr: Addr(APP_BASE),
            image_size: APP_SIZE,
            image_vmaddr: Addr(0),
            id: DEBUG_ID.parse().unwrap(),
            code_id: Some(CodeId::new("4C4C443655553144A1D27F8A9B0C1D2E".into())),
            debug_file: Some("/Users/alice/Diary 2026/devot.dSYM".into()),
        })
    }

    fn secret_map() -> Map<String, sentry::protocol::Value> {
        let mut map = Map::new();
        map.insert(SECRET.into(), SECRET.into());
        map.insert("title".into(), TITLE.into());
        map.insert("bytes".into(), ATTACHMENT.into());
        map
    }

    /// A frame with every field filled, at `address`.
    fn secret_frame(address: u64) -> Frame {
        Frame {
            function: Some(SECRET.into()),
            symbol: Some(SECRET.into()),
            module: Some(SECRET.into()),
            package: Some(NOTE_PATH.into()),
            filename: Some(NOTE_PATH.into()),
            abs_path: Some(SECRET.into()),
            lineno: Some(1),
            colno: Some(2),
            pre_context: vec![SECRET.into()],
            context_line: Some(SECRET.into()),
            post_context: vec![SECRET.into()],
            in_app: Some(true),
            vars: secret_map(),
            image_addr: Some(Addr(TEXT_ADDRESS)),
            instruction_addr: Some(Addr(address)),
            symbol_addr: Some(Addr(TEXT_ADDRESS)),
            addr_mode: Some(SECRET.into()),
        }
    }

    fn secret_stack() -> Stacktrace {
        let mut registers = Map::new();
        registers.insert("x0".into(), RegVal(TEXT_ADDRESS));
        registers.insert(SECRET.into(), RegVal(TEXT_ADDRESS));
        Stacktrace {
            frames: vec![
                secret_frame(TEXT_ADDRESS),
                secret_frame(IN_APP),
                secret_frame(0),
            ],
            frames_omitted: None,
            registers,
        }
    }

    fn secret_mechanism() -> Mechanism {
        Mechanism {
            ty: SECRET.into(),
            description: Some(SECRET.into()),
            help_link: Some("https://example.com/Diary%202026".parse().unwrap()),
            handled: Some(false),
            synthetic: Some(true),
            data: secret_map(),
            meta: MechanismMeta {
                errno: Some(CError {
                    number: 2,
                    name: Some(SECRET.into()),
                }),
                signal: Some(PosixSignal {
                    number: 11,
                    code: Some(1),
                    name: Some(SECRET.into()),
                    code_name: Some(SECRET.into()),
                }),
                mach_exception: Some(MachException {
                    exception: 1,
                    code: 1,
                    subcode: TEXT_ADDRESS,
                    name: Some(SECRET.into()),
                }),
            },
        }
    }

    /// An event with every field the protocol has filled with note text,
    /// titles, paths that name the user, attachment bytes and addresses
    /// made of text.
    fn poisoned_event() -> Event<'static> {
        let mut event = Event {
            level: Level::Fatal,
            fingerprint: Cow::Owned(vec![Cow::Owned(SECRET.into())]),
            culprit: Some(SECRET.into()),
            transaction: Some(SECRET.into()),
            message: Some(SECRET.into()),
            logentry: Some(LogEntry {
                message: SECRET.into(),
                params: vec![SECRET.into()],
            }),
            logger: Some(SECRET.into()),
            platform: Cow::Owned(SECRET.into()),
            server_name: Some(Cow::Owned(SECRET.into())),
            release: Some(Cow::Owned(SECRET.into())),
            dist: Some(Cow::Owned(SECRET.into())),
            environment: Some(Cow::Owned(SECRET.into())),
            user: Some(User {
                id: Some(SECRET.into()),
                email: Some(SECRET.into()),
                ip_address: None,
                username: Some(USER.into()),
                other: secret_map(),
            }),
            request: Some(Request {
                url: Some("https://example.com/?q=Diary%202026".parse().unwrap()),
                method: Some(SECRET.into()),
                data: Some(SECRET.into()),
                query_string: Some(SECRET.into()),
                cookies: Some(SECRET.into()),
                headers: [(SECRET.to_string(), SECRET.to_string())].into(),
                env: [(SECRET.to_string(), SECRET.to_string())].into(),
            }),
            breadcrumbs: Values {
                values: vec![Breadcrumb {
                    ty: SECRET.into(),
                    category: Some(SECRET.into()),
                    message: Some(SECRET.into()),
                    data: secret_map(),
                    ..Default::default()
                }],
            },
            exception: Values {
                values: vec![Exception {
                    ty: SECRET.into(),
                    value: Some(format!("E_NOTE_PUT: {SECRET}")),
                    module: Some(SECRET.into()),
                    stacktrace: Some(secret_stack()),
                    raw_stacktrace: Some(secret_stack()),
                    thread_id: Some(ThreadId::String(SECRET.into())),
                    mechanism: Some(secret_mechanism()),
                }],
            },
            stacktrace: Some(secret_stack()),
            template: Some(TemplateInfo {
                filename: Some(SECRET.into()),
                abs_path: Some(SECRET.into()),
                lineno: Some(1),
                colno: Some(1),
                pre_context: vec![SECRET.into()],
                context_line: Some(SECRET.into()),
                post_context: vec![SECRET.into()],
            }),
            threads: Values {
                values: vec![Thread {
                    id: Some(ThreadId::String(SECRET.into())),
                    name: Some(SECRET.into()),
                    stacktrace: Some(secret_stack()),
                    raw_stacktrace: Some(secret_stack()),
                    crashed: true,
                    current: true,
                }],
            },
            tags: [(SECRET.to_string(), SECRET.to_string())].into(),
            extra: secret_map(),
            modules: [(SECRET.to_string(), SECRET.to_string())].into(),
            sdk: Some(Cow::Owned(ClientSdkInfo {
                name: SECRET.into(),
                version: SECRET.into(),
                integrations: vec![SECRET.into()],
                packages: vec![ClientSdkPackage {
                    name: SECRET.into(),
                    version: SECRET.into(),
                }],
            })),
            ..Default::default()
        };
        event.debug_meta = Cow::Owned(sentry::protocol::DebugMeta {
            sdk_info: None,
            images: vec![
                app_image("/Users/alice/Library/Input Methods/Diary 2026.app/Diary 2026 helper"),
                DebugImage::Apple(AppleDebugImage {
                    name: NOTE_PATH.into(),
                    arch: Some(SECRET.into()),
                    cpu_type: None,
                    cpu_subtype: None,
                    image_addr: Addr(TEXT_ADDRESS),
                    image_size: 0x1000,
                    image_vmaddr: Addr(0),
                    uuid: Default::default(),
                }),
                DebugImage::Proguard(ProguardDebugImage {
                    uuid: Default::default(),
                }),
            ],
        });
        event.contexts.insert(
            "device".into(),
            Context::Device(Box::new(DeviceContext {
                name: Some("Alice's MacBook".into()),
                family: Some(SECRET.into()),
                model: Some(SECRET.into()),
                model_id: Some(SECRET.into()),
                arch: Some(SECRET.into()),
                timezone: Some(SECRET.into()),
                other: secret_map(),
                ..Default::default()
            })),
        );
        event.contexts.insert(
            "os".into(),
            Context::Os(Box::new(OsContext {
                name: Some(SECRET.into()),
                version: Some(SECRET.into()),
                build: Some(SECRET.into()),
                kernel_version: Some(SECRET.into()),
                rooted: None,
                other: secret_map(),
            })),
        );
        event.contexts.insert(
            "rust".into(),
            Context::Runtime(Box::new(RuntimeContext {
                name: Some(SECRET.into()),
                version: Some(SECRET.into()),
                other: secret_map(),
            })),
        );
        event.contexts.insert(
            "app".into(),
            Context::App(Box::new(AppContext {
                app_name: Some(SECRET.into()),
                other: secret_map(),
                ..Default::default()
            })),
        );
        event
            .contexts
            .insert("note".into(), Context::Other(secret_map()));
        event
    }

    #[test]
    fn nothing_of_a_note_leaves_whatever_the_event_holds() {
        let original = serde_json::to_string(&poisoned_event()).unwrap();
        for secret in secrets() {
            assert!(original.contains(&secret), "the fixture lacks {secret}");
        }
        assert_none_left(&scrub_event(poisoned_event()));
    }

    /// A panic or native crash as the SDK and the crash reporter fill it in.
    fn crash_event() -> Event<'static> {
        let frame = |function: &str, address: u64| Frame {
            function: Some(function.into()),
            filename: Some("/Users/alice/Code/devot/src-tauri/src/storage/mod.rs".into()),
            abs_path: Some("/Users/alice/Code/devot/src-tauri/src/storage/mod.rs".into()),
            lineno: Some(42),
            colno: Some(7),
            in_app: Some(true),
            package: Some(APP_PATH.into()),
            image_addr: Some(Addr(APP_BASE)),
            instruction_addr: Some(Addr(address)),
            symbol_addr: Some(Addr(APP_BASE + 0x100)),
            ..Default::default()
        };
        let mut event = Event {
            level: Level::Fatal,
            platform: "native".into(),
            message: Some("E_NOTE_PUT_FAILED: Grocery list".into()),
            release: Some("devot@1.2.3".into()),
            environment: Some("production".into()),
            exception: Values {
                values: vec![Exception {
                    ty: "EXC_SOFTWARE / SIGABRT".into(),
                    value: Some("E_NATIVE_CRASH".into()),
                    stacktrace: Some(Stacktrace {
                        frames: vec![
                            frame("devot_lib::storage::Store::put_note", IN_APP),
                            frame("<unknown>", APP_BASE + 0x300),
                        ],
                        ..Default::default()
                    }),
                    thread_id: Some(ThreadId::Int(7)),
                    mechanism: Some(Mechanism {
                        ty: "minidump".into(),
                        handled: Some(false),
                        meta: MechanismMeta {
                            signal: Some(PosixSignal {
                                number: 6,
                                code: None,
                                name: Some("SIGABRT".into()),
                                code_name: None,
                            }),
                            mach_exception: Some(MachException {
                                exception: 5,
                                code: 0x10003,
                                subcode: 6,
                                name: Some("EXC_SOFTWARE".into()),
                            }),
                            errno: None,
                        },
                        ..Default::default()
                    }),
                    ..Default::default()
                }],
            },
            threads: Values {
                values: vec![Thread {
                    id: Some(ThreadId::Int(9)),
                    name: Some("devot-db".into()),
                    stacktrace: Some(Stacktrace {
                        frames: vec![frame("devot_lib::storage::db", APP_BASE + 0x400)],
                        ..Default::default()
                    }),
                    ..Default::default()
                }],
            },
            sdk: Some(Cow::Owned(ClientSdkInfo {
                name: "sentry.rust".into(),
                version: "0.49.3".into(),
                integrations: vec!["panic".into()],
                packages: vec![],
            })),
            ..Default::default()
        };
        event.debug_meta = Cow::Owned(sentry::protocol::DebugMeta {
            sdk_info: None,
            images: vec![
                app_image(APP_PATH),
                DebugImage::Symbolic(SymbolicDebugImage {
                    name: "/usr/lib/libunused.dylib".into(),
                    arch: None,
                    image_addr: Addr(0x3_0000_0000),
                    image_size: 0x1000,
                    image_vmaddr: Addr(0),
                    id: DebugId::default(),
                    code_id: None,
                    debug_file: None,
                }),
            ],
        });
        event.contexts.insert(
            "os".into(),
            Context::Os(Box::new(OsContext {
                name: Some("macOS".into()),
                version: Some("26.1.0".into()),
                build: Some("25B78".into()),
                ..Default::default()
            })),
        );
        event.contexts.insert(
            "device".into(),
            Context::Device(Box::new(DeviceContext {
                name: Some("Alice's MacBook".into()),
                arch: Some("arm64".into()),
                model: Some("MacBookPro18,3".into()),
                family: Some("MacBookPro".into()),
                ..Default::default()
            })),
        );
        let mut channel = Map::new();
        channel.insert("channel".into(), "stable".into());
        event.contexts.insert(
            "rust".into(),
            Context::Runtime(Box::new(RuntimeContext {
                name: Some("rustc".into()),
                version: Some("1.99.0".into()),
                other: channel,
            })),
        );
        event
    }

    #[test]
    fn keeps_codes_types_code_locations_and_system_details() {
        let event = scrub_event(crash_event());
        assert_eq!(event.level, Level::Fatal);
        assert_eq!(event.platform, "native");
        assert_eq!(event.message.as_deref(), Some("E_NOTE_PUT_FAILED"));
        assert_eq!(event.release.as_deref(), Some("devot@1.2.3"));
        assert_eq!(event.environment.as_deref(), Some("production"));
        let exception = &event.exception.values[0];
        assert_eq!(exception.ty, "EXC_SOFTWARE / SIGABRT");
        assert_eq!(exception.value.as_deref(), Some("E_NATIVE_CRASH"));
        assert_eq!(exception.thread_id, Some(ThreadId::Int(7)));
        let frames = &exception.stacktrace.as_ref().unwrap().frames;
        assert_eq!(frames.len(), 2);
        let frame = &frames[0];
        assert_eq!(
            frame.function.as_deref(),
            Some("devot_lib::storage::Store::put_note")
        );
        assert_eq!(
            frame.abs_path.as_deref(),
            Some("/Users/<user>/Code/devot/src-tauri/src/storage/mod.rs")
        );
        assert_eq!((frame.lineno, frame.colno), (Some(42), Some(7)));
        assert_eq!(frame.package.as_deref(), Some("devot"));
        assert_eq!(frame.in_app, Some(true));
        assert_eq!(frame.instruction_addr, Some(Addr(IN_APP)));
        assert_eq!(frame.image_addr, Some(Addr(APP_BASE)));
        assert_eq!(frame.symbol_addr, Some(Addr(APP_BASE + 0x100)));
        let mechanism = exception.mechanism.as_ref().unwrap();
        assert_eq!(
            (mechanism.ty.as_str(), mechanism.handled),
            ("minidump", Some(false))
        );
        let signal = mechanism.meta.signal.as_ref().unwrap();
        assert_eq!(
            (signal.number, signal.name.as_deref()),
            (6, Some("SIGABRT"))
        );
        let mach = mechanism.meta.mach_exception.as_ref().unwrap();
        assert_eq!((mach.exception, mach.code, mach.subcode), (5, 0x10003, 6));
        let thread = &event.threads.values[0];
        assert_eq!(thread.name.as_deref(), Some("devot-db"));
        assert_eq!(thread.id, Some(ThreadId::Int(9)));
        assert_eq!(thread.stacktrace.as_ref().unwrap().frames.len(), 1);
        // Only the binary the frames are in, by file name.
        let images: Vec<_> = event
            .debug_meta
            .images
            .iter()
            .map(|image| match image {
                DebugImage::Symbolic(i) => (
                    i.name.as_str(),
                    i.debug_file.as_deref(),
                    i.id,
                    i.image_addr,
                    i.image_size,
                ),
                other => panic!("unexpected image {other:?}"),
            })
            .collect();
        assert_eq!(
            images,
            vec![(
                "devot",
                Some("devot.dSYM"),
                DEBUG_ID.parse().unwrap(),
                Addr(APP_BASE),
                APP_SIZE
            )]
        );
        let Some(Context::Os(os)) = event.contexts.get("os") else {
            panic!("the OS context is kept");
        };
        assert_eq!(
            (
                os.name.as_deref(),
                os.version.as_deref(),
                os.build.as_deref()
            ),
            (Some("macOS"), Some("26.1.0"), Some("25B78"))
        );
        let Some(Context::Device(device)) = event.contexts.get("device") else {
            panic!("the device context is kept");
        };
        assert_eq!(device.name, None);
        assert_eq!(device.arch.as_deref(), Some("arm64"));
        assert_eq!(device.model.as_deref(), Some("MacBookPro18,3"));
        let Some(Context::Runtime(rust)) = event.contexts.get("rust") else {
            panic!("the Rust context is kept");
        };
        assert_eq!(rust.version.as_deref(), Some("1.99.0"));
        assert_eq!(rust.other.get("channel"), Some(&"stable".into()));
        let sdk = event.sdk.as_ref().unwrap();
        assert_eq!(
            (sdk.name.as_str(), sdk.version.as_str()),
            ("sentry.rust", "0.49.3")
        );
        assert!(sdk.integrations.is_empty());
        let json = serde_json::to_string(&event).unwrap();
        assert!(!json.contains(USER), "{json}");
    }

    #[test]
    fn addresses_are_kept_only_inside_a_binary_the_event_lists() {
        let mut event = crash_event();
        let frames = &mut event.exception.values[0]
            .stacktrace
            .as_mut()
            .unwrap()
            .frames;
        frames.insert(
            0,
            Frame {
                instruction_addr: Some(Addr(TEXT_ADDRESS)),
                ..Default::default()
            },
        );
        frames.push(Frame {
            function: Some("objc_msgSend".into()),
            instruction_addr: Some(Addr(TEXT_ADDRESS)),
            ..Default::default()
        });
        let event = scrub_event(event);
        let frames = &event.exception.values[0]
            .stacktrace
            .as_ref()
            .unwrap()
            .frames;
        // The frame that was only an address made of text is gone; the one
        // with a function name keeps it, without the address.
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0].instruction_addr, Some(Addr(IN_APP)));
        assert_eq!(frames[2].function.as_deref(), Some("objc_msgSend"));
        assert_eq!(frames[2].instruction_addr, None);
        assert_none_left(&event);
    }

    #[test]
    fn a_fault_address_is_kept_only_near_null_or_inside_a_listed_binary() {
        let with_subcode = |subcode| {
            let mut event = crash_event();
            let mechanism = event.exception.values[0].mechanism.as_mut().unwrap();
            mechanism.meta.mach_exception = Some(MachException {
                exception: 1,
                code: 1,
                subcode,
                name: None,
            });
            scrub_event(event).exception.values[0]
                .mechanism
                .as_ref()
                .unwrap()
                .meta
                .mach_exception
                .clone()
        };
        // A null pointer and an offset; code in the app.
        assert_eq!(with_subcode(0x10).map(|m| m.subcode), Some(0x10));
        assert_eq!(with_subcode(IN_APP).map(|m| m.subcode), Some(IN_APP));
        // Anywhere else it could be data used as a pointer.
        assert_eq!(with_subcode(TEXT_ADDRESS), None);
        assert_eq!(with_subcode(0x6000_0000_1000), None);
    }

    #[test]
    fn error_types_keep_their_leading_names_only() {
        let ty = |ty: &str| {
            let mut event = crash_event();
            event.exception.values[0].ty = ty.into();
            scrub_event(event).exception.values[0].ty.clone()
        };
        assert_eq!(ty("panic"), "panic");
        assert_eq!(
            ty("EXC_BAD_ACCESS / KERN_INVALID_ADDRESS"),
            "EXC_BAD_ACCESS / KERN_INVALID_ADDRESS"
        );
        assert_eq!(ty("std::io::Error"), "std::io::Error");
        // Numbers a crash reason can end with are not names.
        assert_eq!(
            ty("EXC_GUARD / GUARD_TYPE_USER/ namespace: 1 guard identifier: 2318961367093045604"),
            "EXC_GUARD / GUARD_TYPE_USER"
        );
        assert_eq!(
            ty("EXC_RESOURCE / RESOURCE_TYPE_IO / 0x0000000000000400 / 0x207972616944"),
            "EXC_RESOURCE / RESOURCE_TYPE_IO"
        );
        assert_eq!(ty("Grocery list"), "<redacted>");
        assert_eq!(ty(WIDE_TITLE), "<redacted>");
    }

    #[test]
    fn binary_names_lose_their_folders_and_odd_names_go() {
        let mut event = crash_event();
        event.debug_meta.to_mut().images[0] =
            app_image("/Users/alice/Library/Input Methods/Diary 2026.app/Diary 2026");
        event.exception.values[0]
            .stacktrace
            .as_mut()
            .unwrap()
            .frames[0]
            .package = Some("/Users/alice/Library/Input Methods/Diary 2026.app/Diary 2026".into());
        let event = scrub_event(event);
        let DebugImage::Symbolic(image) = &event.debug_meta.images[0] else {
            panic!("the app image is kept");
        };
        // Still matched by its debug ID; its name is not one a binary has.
        assert_eq!(image.name, "<redacted>");
        assert_eq!(image.id, DEBUG_ID.parse().unwrap());
        let frame = &event.exception.values[0]
            .stacktrace
            .as_ref()
            .unwrap()
            .frames[0];
        assert_eq!(frame.package.as_deref(), Some("<redacted>"));
        assert_eq!(frame.instruction_addr, Some(Addr(IN_APP)));
        assert_none_left(&event);
    }

    #[test]
    fn apple_images_are_kept_by_file_name_when_a_frame_is_in_them() {
        let mut event = crash_event();
        event
            .debug_meta
            .to_mut()
            .images
            .push(DebugImage::Apple(AppleDebugImage {
                name: "/Users/alice/Library/Frameworks/Helper.framework/Versions/A/Helper".into(),
                arch: Some("arm64".into()),
                cpu_type: Some(16_777_228),
                cpu_subtype: Some(0),
                image_addr: Addr(0x3_0000_0000),
                image_size: 0x1000,
                image_vmaddr: Addr(0),
                uuid: Default::default(),
            }));
        event.threads.values[0]
            .stacktrace
            .as_mut()
            .unwrap()
            .frames
            .push(Frame {
                instruction_addr: Some(Addr(0x3_0000_0010)),
                package: Some(
                    "/Users/alice/Library/Frameworks/Helper.framework/Versions/A/Helper".into(),
                ),
                ..Default::default()
            });
        let event = scrub_event(event);
        let names: Vec<_> = event
            .debug_meta
            .images
            .iter()
            .map(|image| match image {
                DebugImage::Symbolic(i) => i.name.as_str(),
                DebugImage::Apple(i) => i.name.as_str(),
                other => panic!("unexpected image {other:?}"),
            })
            .collect();
        assert_eq!(names, ["devot", "Helper"]);
        assert_none_left(&event);
    }

    #[test]
    fn plain_thread_names_stay_and_others_go() {
        let name = |name: &str| {
            let mut event = crash_event();
            event.threads.values[0].name = Some(name.into());
            scrub_event(event).threads.values[0].name.clone()
        };
        assert_eq!(
            name("tokio-runtime-worker").as_deref(),
            Some("tokio-runtime-worker")
        );
        assert_eq!(
            name("com.apple.main-thread").as_deref(),
            Some("com.apple.main-thread")
        );
        assert_eq!(name(TITLE), None);
        assert_eq!(name(ATTACHMENT), None);
    }
}
