//! Files written whole, and never through a link.
//!
//! Every file Devot writes outside its databases (exported notes and
//! attachments, saved images, PDFs, diagnostics, settings, backups, crash
//! reports, the Markdown mirror's files and manifest) goes to a temporary
//! file in the target's folder first, is flushed to disk (all but the
//! mirror's many files, see `Folder::write_unflushed`), and is then put in
//! place, so the target holds either what was there before or the whole new
//! file. A new file (`Place::New`) and a file moved to a new name
//! (`Folder::rename`) go only where nothing is yet, so neither ever replaces
//! a file or a link that appeared there after the caller looked: in one step
//! where the file system can (a rename that fails on any name there, on APFS
//! and HFS+); elsewhere (FAT, exFAT, many network shares) a new empty file
//! claims the name first, which fails the same way, and the rename goes over
//! that claim, so only something put over the claim in the instant between
//! could be replaced. Either way the move is whole: a file never stays under
//! both names, nor under neither.
//!
//! Every step works in a folder opened once (`Folder`), never by a path.
//! The folder is resolved when it is opened (a folder the user chose may be
//! a link the user picked, which is followed then, once); from then on the
//! temporary file, the rename into place, a removal and every folder below
//! it are named relative to that handle, one plain name at a time, and each
//! folder below is opened from its parent's handle, never through a link
//! (O_NOFOLLOW). So no folder on the way can be swapped for a link, or for
//! another folder, after Devot looked: a local process that may rename
//! entries in a folder Devot writes to (a shared or synced folder, a
//! downloads folder) could otherwise send a write, a move or a removal
//! wherever its link pointed, in the moment between Devot's checks and the
//! step itself. A writer keeps the handle for as long as its checks hold:
//! an export session from the panel to its last file, the Markdown mirror
//! for one call.
//!
//! A temporary file is only ever created new (O_CREAT | O_EXCL), which fails
//! on anything already at its name, a link included: such a name is passed
//! over for another, so nothing is ever written through a link someone
//! planted. Its name is hidden and random (`.devot-<32 hex digits>.tmp`, 122
//! random bits from the system's generator; a crash report's is its own
//! random event ID), so it cannot be guessed ahead either; a name that could
//! be (the note's file name, the process ID and a counter) let a link
//! planted in a shared or downloaded folder send the bytes wherever it
//! pointed.
//!
//! A writer that creates its file by path itself (AppKit printing a PDF,
//! SQLite writing a backup) writes inside a new private folder made the same
//! way (`TempDir`, only its owner may use it), and its file is renamed out
//! of it, or copied to a target in another folder. That folder is made only
//! in the app's data, which nobody else can reach: its mode keeps others out
//! of it, not from swapping it for a link while the writer runs, which
//! anyone who may remove names where it sits could do (in a shared folder,
//! or the owner of the folder the user saves into).

use rustix::fs::{AtFlags, FileType, Mode, OFlags};
use rustix::io::Errno;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

/// Random names tried before giving up. Each is new, so even one clash
/// means something is putting files there.
const TRIES: usize = 16;

/// A hidden random name in a folder: `.devot-<32 hex digits>.tmp`.
fn random_name() -> String {
    format!(".devot-{}.tmp", uuid::Uuid::new_v4().simple())
}

/// Whether `name` is one `random_name` makes: a temporary file or folder,
/// which a process that ended before putting it in place leaves behind.
pub fn is_temporary(name: &str) -> bool {
    name.strip_prefix(".devot-")
        .and_then(|rest| rest.strip_suffix(".tmp"))
        .is_some_and(|hex| {
            hex.len() == 32 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
}

/// The folder a file at `path` is in (`.` for a bare name), and its name.
fn split(path: &Path) -> io::Result<(&Path, &OsStr)> {
    let name = path.file_name().ok_or(io::ErrorKind::InvalidInput)?;
    match path.parent() {
        Some(dir) if dir.as_os_str().is_empty() => Ok((Path::new("."), name)),
        Some(dir) => Ok((dir, name)),
        None => Err(io::ErrorKind::InvalidInput.into()),
    }
}

/// `name` as one name in a folder. A path (a `/` in it), `.`, `..` or
/// nothing is refused (`InvalidInput`): the system would resolve a path
/// folder by folder, following any link on its way.
fn plain(name: &OsStr) -> io::Result<&OsStr> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes == b"." || bytes == b".." || bytes.contains(&b'/') {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(name)
}

/// What tells one file or folder from another, however it is named: its
/// device and inode (none where the system does not say).
fn identity(meta: &fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((meta.dev(), meta.ino()))
}

/// How a finished file goes to its target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place {
    /// Over whatever is there (a save panel asked before replacing a file).
    /// A link there is replaced itself, never written through.
    Replace,
    /// Only where nothing is yet: `AlreadyExists` when the name is taken (by
    /// a file, a folder or a link), and nothing changes.
    New,
}

/// How a folder is opened: for search alone where the system can
/// (`O_SEARCH`: a folder others may drop files into but not list can be
/// written by path, so it can be written this way too), never for writing,
/// and not kept across `exec`.
fn folder_flags() -> OFlags {
    #[cfg(target_os = "macos")]
    let search = OFlags::from_bits_retain(libc::O_SEARCH as u32);
    #[cfg(not(target_os = "macos"))]
    let search = OFlags::RDONLY | OFlags::DIRECTORY;
    search | OFlags::CLOEXEC
}

/// A folder opened once, by a handle (see the module's notes): what it
/// holds is named relative to it, one plain name at a time, and a folder in
/// it is opened from it, never through a link. A clone shares the handle.
#[derive(Debug, Clone)]
pub struct Folder {
    fd: Arc<OwnedFd>,
}

impl Folder {
    /// The folder at `path`, opened now: a folder the user chose, or one of
    /// the app's. A link on its path, even the folder itself, is followed
    /// here, once, as the user picked it; nothing in it is ever looked up by
    /// a path again.
    pub fn open(path: &Path) -> io::Result<Self> {
        let fd = rustix::fs::open(path, folder_flags(), Mode::empty())?;
        Ok(Self { fd: Arc::new(fd) })
    }

    /// The folder at `path`, an absolute path resolved before (with
    /// `fs::canonicalize`, when the user chose it), opened folder by folder
    /// from the top, never through a link: a link anywhere on it now means
    /// something took a folder's place since (`NotADirectory`).
    pub fn open_resolved(path: &Path) -> io::Result<Self> {
        let mut components = path.components();
        if components.next() != Some(Component::RootDir) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        // Every name first: a path with `.` or `..` on it was not resolved.
        let names = components
            .map(|component| match component {
                Component::Normal(name) => Ok(name),
                _ => Err(io::Error::from(io::ErrorKind::InvalidInput)),
            })
            .collect::<io::Result<Vec<_>>>()?;
        let mut folder = Self::open(Path::new("/"))?;
        for name in names {
            folder = folder.folder(name)?;
        }
        Ok(folder)
    }

    /// The folder `name` in this one: a real folder, never a link
    /// (`NotADirectory` for a link, to a folder or not, and for a file).
    pub fn folder(&self, name: impl AsRef<OsStr>) -> io::Result<Self> {
        let name = plain(name.as_ref())?;
        let flags = folder_flags() | OFlags::NOFOLLOW;
        match rustix::fs::openat(&*self.fd, name, flags, Mode::empty()) {
            Ok(fd) => Ok(Self { fd: Arc::new(fd) }),
            // A link is ELOOP on some systems, ENOTDIR (as a file is) on macOS.
            Err(e) if e == Errno::NOTDIR || e == Errno::LOOP => {
                Err(io::ErrorKind::NotADirectory.into())
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Makes the folder `name` here; `AlreadyExists` when anything is at
    /// that name (making a folder never follows a link there).
    pub fn make_folder(&self, name: impl AsRef<OsStr>) -> io::Result<()> {
        let name = plain(name.as_ref())?;
        let mode = Mode::RWXU | Mode::RWXG | Mode::RWXO;
        Ok(rustix::fs::mkdirat(&*self.fd, name, mode)?)
    }

    /// What is at `name` here, a link not followed.
    pub fn entry(&self, name: impl AsRef<OsStr>) -> io::Result<Entry> {
        let name = plain(name.as_ref())?;
        let stat = rustix::fs::statat(&*self.fd, name, AtFlags::SYMLINK_NOFOLLOW)?;
        Ok(Entry::of(&stat))
    }

    /// The plain file at `name` here, opened for reading: anything else (a
    /// link, a folder, a pipe) is refused (`InvalidData`), never opened
    /// through.
    pub fn read_file(&self, name: impl AsRef<OsStr>) -> io::Result<File> {
        let name = plain(name.as_ref())?;
        // Not blocking: a pipe put at the name never holds the reader up.
        let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
        let fd = match rustix::fs::openat(&*self.fd, name, flags, Mode::empty()) {
            Ok(fd) => fd,
            Err(e) if e == Errno::LOOP => return Err(io::ErrorKind::InvalidData.into()),
            Err(e) => return Err(e.into()),
        };
        if Entry::of(&rustix::fs::fstat(&fd)?).kind != Kind::File {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(File::from(fd))
    }

    /// Removes the file at `name` here (a link there goes itself, never
    /// what it points to).
    pub fn remove_file(&self, name: impl AsRef<OsStr>) -> io::Result<()> {
        let name = plain(name.as_ref())?;
        Ok(rustix::fs::unlinkat(&*self.fd, name, AtFlags::empty())?)
    }

    /// Removes the empty folder at `name` here (a link there is no folder:
    /// it stays).
    pub fn remove_folder(&self, name: impl AsRef<OsStr>) -> io::Result<()> {
        let name = plain(name.as_ref())?;
        Ok(rustix::fs::unlinkat(&*self.fd, name, AtFlags::REMOVEDIR)?)
    }

    /// The names in the folder, which must be readable to be listed.
    pub fn names(&self) -> io::Result<Vec<OsString>> {
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC;
        let fd = rustix::fs::openat(&*self.fd, ".", flags, Mode::empty())?;
        let mut names = Vec::new();
        for entry in rustix::fs::Dir::new(fd)? {
            let entry = entry?;
            let name = entry.file_name().to_bytes();
            if name != b"." && name != b".." {
                names.push(OsStr::from_bytes(name).to_owned());
            }
        }
        Ok(names)
    }

    /// Writes `bytes` to `name` here through a new temporary file beside
    /// it, flushed to disk and then put in place (see `Place`).
    pub fn write(&self, name: impl AsRef<OsStr>, bytes: &[u8], place: Place) -> io::Result<()> {
        self.write_with(name.as_ref(), &mut &*bytes, place, true)
    }

    /// As `write`, but the file is not flushed to disk before it goes in
    /// place: for the Markdown mirror's files, many at a time, which the
    /// notes database can always give again (a full flush each, as macOS
    /// makes one, would cost far more than it keeps). A crash may leave such
    /// a file short, which the mirror's next reconcile finds; it never
    /// leaves one at a name it was not meant for, or written through a link.
    pub fn write_unflushed(
        &self,
        name: impl AsRef<OsStr>,
        bytes: &[u8],
        place: Place,
    ) -> io::Result<()> {
        self.write_with(name.as_ref(), &mut &*bytes, place, false)
    }

    /// Writes what `from` reads to `name` here, as `write` does.
    pub fn write_from(
        &self,
        name: impl AsRef<OsStr>,
        from: &mut dyn Read,
        place: Place,
    ) -> io::Result<()> {
        self.write_with(name.as_ref(), from, place, true)
    }

    fn write_with(
        &self,
        name: &OsStr,
        from: &mut dyn Read,
        place: Place,
        flush: bool,
    ) -> io::Result<()> {
        let name = plain(name)?;
        let mut temp = TempFile::in_folder(self.clone())?;
        io::copy(from, &mut temp.file)?;
        temp.finish(self, name, place, flush)
    }

    /// Moves the file at `from` here to `to` in `into` (this folder, or
    /// another on the same volume), whole: the old name goes in the same
    /// step, or nothing changes (a folder `from` cannot leave, say). With
    /// `Place::New` only where nothing is yet (`AlreadyExists` when the name
    /// is taken, by a file, a folder or a link); with `Place::Replace` over
    /// whatever is there (a link there is replaced itself, never written
    /// through). A link at `from` is moved as it is, never followed.
    pub fn rename(
        &self,
        from: impl AsRef<OsStr>,
        into: &Folder,
        to: impl AsRef<OsStr>,
        place: Place,
    ) -> io::Result<()> {
        put(
            self,
            plain(from.as_ref())?,
            into,
            plain(to.as_ref())?,
            place,
        )
    }

    /// Checks that the folder can be written, with a new temporary file of
    /// a random name that goes again at once: never a file someone else has
    /// here, never through a link.
    pub fn check_writable(&self) -> io::Result<()> {
        TempFile::in_folder(self.clone()).map(drop)
    }

    /// What tells this folder from another, however it is reached.
    fn id(&self) -> io::Result<(u64, u64)> {
        Ok(Entry::of(&rustix::fs::fstat(&*self.fd)?).id)
    }
}

/// What a name in a folder holds, a link not followed (`Folder::entry`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    pub kind: Kind,
    /// Its size in bytes.
    pub len: u64,
    /// Its device and inode (see `identity`).
    id: (u64, u64),
}

/// What kind of thing an `Entry` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Folder,
    /// A link, a pipe, a device or a socket.
    Other,
}

impl Entry {
    // `dev_t` and `ino_t` differ in width and sign from system to system.
    #[allow(clippy::unnecessary_cast)]
    fn of(stat: &rustix::fs::Stat) -> Self {
        let kind = match FileType::from_raw_mode(stat.st_mode) {
            FileType::RegularFile => Kind::File,
            FileType::Directory => Kind::Folder,
            _ => Kind::Other,
        };
        Self {
            kind,
            len: u64::try_from(stat.st_size).unwrap_or(0),
            id: (stat.st_dev as u64, stat.st_ino as u64),
        }
    }

    pub fn is_file(&self) -> bool {
        self.kind == Kind::File
    }

    pub fn is_folder(&self) -> bool {
        self.kind == Kind::Folder
    }

    /// Whether this and `other` are one file, however each was named (one
    /// name in another case, on a file system that ignores case).
    pub fn same_file(&self, other: &Entry) -> bool {
        self.id == other.id
    }
}

/// A new file at `name` in `folder`, created now and open for writing:
/// `AlreadyExists` on anything already at that name, a link included
/// (O_CREAT | O_EXCL never follows one).
fn create_new(folder: &Folder, name: &OsStr) -> io::Result<File> {
    let flags = OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    // 0666 before the umask, as files are made by path.
    let mode = Mode::RUSR | Mode::WUSR | Mode::RGRP | Mode::WGRP | Mode::ROTH | Mode::WOTH;
    let fd = rustix::fs::openat(&*folder.fd, plain(name)?, flags, mode)?;
    Ok(File::from(fd))
}

/// Puts the complete file at `from` in `from_dir` at `to` in `to_dir` (see
/// `Place`), in one rename: the old name goes in the same step, or nothing
/// changes.
fn put(
    from_dir: &Folder,
    from: &OsStr,
    to_dir: &Folder,
    to: &OsStr,
    place: Place,
) -> io::Result<()> {
    match place {
        Place::Replace => Ok(rustix::fs::renameat(&*from_dir.fd, from, &*to_dir.fd, to)?),
        Place::New => match rename_exclusive(from_dir, from, to_dir, to) {
            Err(e) if e.kind() == io::ErrorKind::Unsupported => {
                claim_and_rename(from_dir, from, to_dir, to)
            }
            done => done,
        },
    }
}

/// A rename that fails on any name already at `to`, in one step, where the
/// system and the file system have one (`Unsupported` elsewhere): on macOS
/// `renameatx_np` with `RENAME_EXCL`, which APFS and HFS+ can do and FAT,
/// exFAT and many network shares cannot.
fn rename_exclusive(
    from_dir: &Folder,
    from: &OsStr,
    to_dir: &Folder,
    to: &OsStr,
) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let exclusive = rustix::fs::RenameFlags::NOREPLACE;
        match rustix::fs::renameat_with(&*from_dir.fd, from, &*to_dir.fd, to, exclusive) {
            Ok(()) => Ok(()),
            Err(e) if e == Errno::NOTSUP || e == Errno::OPNOTSUPP || e == Errno::NOSYS => {
                Err(io::ErrorKind::Unsupported.into())
            }
            Err(e) => Err(e.into()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (from_dir, from, to_dir, to);
        Err(io::ErrorKind::Unsupported.into())
    }
}

/// Renames `from` to `to` only where nothing is yet, on a file system that
/// cannot refuse a taken name in the rename itself: a new empty file claims
/// the name first, made as a temporary file is (it fails on anything there,
/// a link included), then the rename goes over that claim; when the rename
/// fails, the claim goes again. A file or a link already there is never
/// replaced; only one put over the claim in the instant between could be.
fn claim_and_rename(
    from_dir: &Folder,
    from: &OsStr,
    to_dir: &Folder,
    to: &OsStr,
) -> io::Result<()> {
    let claim = create_new(to_dir, to)?;
    let claimed = rustix::fs::fstat(&claim)
        .ok()
        .map(|stat| Entry::of(&stat).id);
    drop(claim);
    rustix::fs::renameat(&*from_dir.fd, from, &*to_dir.fd, to)
        .map_err(io::Error::from)
        .inspect_err(|_| {
            // Only the claim itself: never what may have replaced it.
            let there = to_dir.entry(to).ok().map(|entry| entry.id);
            if claimed.is_some() && there == claimed {
                let _ = to_dir.remove_file(to);
            }
        })
}

/// A temporary file being written in a folder; it is removed when dropped
/// unless it was put in place.
pub struct TempFile {
    folder: Folder,
    /// The folder's path, for a file made by one (`create`): `persist` puts
    /// the file only there.
    dir: Option<PathBuf>,
    name: OsString,
    file: File,
    placed: bool,
}

impl TempFile {
    /// A new temporary file in `folder`, under a random hidden name.
    fn in_folder(folder: Folder) -> io::Result<Self> {
        let names = std::iter::repeat_with(|| OsString::from(random_name())).take(TRIES);
        Self::create_first(folder, names)
    }

    /// A new temporary file at exactly `path`, which the caller has made
    /// impossible to guess itself (a crash report's random event ID); fails
    /// with `AlreadyExists` when anything is there. Its folder is opened
    /// once, here.
    pub fn create(path: PathBuf) -> io::Result<Self> {
        let (dir, name) = split(&path)?;
        let mut temp = Self::create_first(Folder::open(dir)?, [name.to_owned()])?;
        temp.dir = Some(dir.to_owned());
        Ok(temp)
    }

    /// The first of `names` that nothing holds yet in `folder`, created new;
    /// a file or a link at a name is passed over and left as it is.
    fn create_first(folder: Folder, names: impl IntoIterator<Item = OsString>) -> io::Result<Self> {
        let mut taken = io::Error::from(io::ErrorKind::AlreadyExists);
        for name in names {
            match create_new(&folder, &name) {
                Ok(file) => {
                    return Ok(Self {
                        folder,
                        dir: None,
                        name,
                        file,
                        placed: false,
                    });
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => taken = e,
                Err(e) => return Err(e),
            }
        }
        Err(taken)
    }

    /// Appends `bytes` to the file.
    pub fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.file.write_all(bytes)
    }

    /// Flushes the file to disk and puts it at `target`, a name in the
    /// folder it was made in (see `Place`); the folder is not looked up by
    /// its path again. A target in another folder is refused
    /// (`InvalidInput`).
    pub fn persist(self, target: &Path, place: Place) -> io::Result<()> {
        let (dir, name) = split(target)?;
        if self.dir.as_deref() != Some(dir) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let folder = self.folder.clone();
        self.finish(&folder, name, place, true)
    }

    /// Puts the file at `name` in `into` (its own folder, or another on the
    /// same volume; see `Place`), flushed to disk first when `flush`.
    fn finish(mut self, into: &Folder, name: &OsStr, place: Place, flush: bool) -> io::Result<()> {
        if flush {
            self.file.sync_all()?;
        }
        put(&self.folder, &self.name, into, plain(name)?, place)?;
        self.placed = true;
        Ok(())
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if !self.placed {
            let _ = self.folder.remove_file(&self.name);
        }
    }
}

/// Writes `bytes` to `path` through a temporary file in its folder, flushed
/// to disk and then put in place (see `Place`). The folder is opened once
/// (`Folder::open`), and both steps work in it.
pub fn write(path: &Path, bytes: &[u8], place: Place) -> io::Result<()> {
    let (dir, name) = split(path)?;
    Folder::open(dir)?.write(name, bytes, place)
}

/// Writes `bytes` over the file at `path` (see `write`).
pub fn write_replacing(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write(path, bytes, Place::Replace)
}

/// A new private folder for a writer that creates its file by path itself:
/// made new under a random hidden name, usable by its owner only (0700),
/// and removed with everything in it when dropped.
///
/// Make it only where nobody else can write (the app's data): its mode
/// keeps others out of it, not from swapping it, while the writer runs, for
/// a link or a folder of their own, which anyone who may remove names where
/// it sits could do. The writer would follow such a link. A folder found
/// swapped is refused and left as it is, but that is a check, not a lock.
pub struct TempDir {
    path: PathBuf,
    /// The folder as it was made (see `identity`).
    made: Option<(u64, u64)>,
}

impl TempDir {
    /// A new private folder in `dir`, a folder nobody else can write to.
    pub fn new_in(dir: &Path) -> io::Result<Self> {
        Self::create_first(std::iter::repeat_with(|| dir.join(random_name())).take(TRIES))
    }

    /// The first of `paths` that nothing holds yet, made as a new folder
    /// (making a folder never follows a link at its name: it fails).
    fn create_first(paths: impl IntoIterator<Item = PathBuf>) -> io::Result<Self> {
        let mut taken = io::Error::from(io::ErrorKind::AlreadyExists);
        for path in paths {
            let mut builder = fs::DirBuilder::new();
            std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
            match builder.create(&path) {
                Ok(()) => {
                    return match fs::symlink_metadata(&path) {
                        Ok(meta) => Ok(Self {
                            made: identity(&meta),
                            path,
                        }),
                        Err(e) => {
                            let _ = fs::remove_dir(&path);
                            Err(e)
                        }
                    };
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => taken = e,
                Err(e) => return Err(e),
            }
        }
        Err(taken)
    }

    /// The folder's path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Whether the folder at its path is still the one made: not a link, nor
    /// another folder put in its place.
    fn is_own(&self) -> bool {
        fs::symlink_metadata(&self.path)
            .is_ok_and(|meta| meta.is_dir() && identity(&meta) == self.made)
    }

    /// The folder, opened from its parent, never through a link, and only
    /// while it is still the one made: anything else at its path (a link,
    /// another folder) is refused (`InvalidData`).
    fn open_own(&self) -> io::Result<Folder> {
        let (parent, name) = split(&self.path)?;
        let own = match Folder::open(parent)?.folder(name) {
            Err(e) if e.kind() == io::ErrorKind::NotADirectory => {
                return Err(io::ErrorKind::InvalidData.into());
            }
            opened => opened?,
        };
        if self.made.is_none() || own.id().ok() != self.made {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(own)
    }

    /// Flushes the plain file the writer left at `name` in the folder to
    /// disk and puts it at `target`, in the same folder as this one (see
    /// `Place`). Anything but a plain file there (a link, a folder), or a
    /// folder that is no longer the one made, is refused (`InvalidData`).
    pub fn persist(&self, name: &str, target: &Path, place: Place) -> io::Result<()> {
        let own = self.open_own()?;
        own.read_file(name)?.sync_all()?;
        let (dir, to) = split(target)?;
        put(
            &own,
            OsStr::new(name),
            &Folder::open(dir)?,
            plain(to)?,
            place,
        )
    }

    /// Copies the plain file the writer left at `name` in the folder to `to`
    /// in `into` (a folder opened when the user chose it: on another volume,
    /// one others write to), as every file is written: through a new
    /// temporary file beside it, flushed and put in place (see `Place`).
    /// What `persist` refuses, this refuses too.
    pub fn copy_to(&self, name: &str, into: &Folder, to: &str, place: Place) -> io::Result<()> {
        let mut file = self.open_own()?.read_file(name)?;
        into.write_from(to, &mut file, place)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // Only its own folder goes; whatever was put in its place is not
        // Devot's, and stays (a link would never be followed either way).
        if self.is_own() {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

/// Marks the moment a writer has checked what is on disk and is about to
/// act on it: the window in which a local process that may rename entries
/// in the folder could swap a folder on the way for a link. Tests swap one
/// here (`race::at_check`); outside tests it does nothing.
#[inline]
pub(crate) fn checked() {
    #[cfg(test)]
    race::run();
}

/// The test side of `checked`.
#[cfg(test)]
pub(crate) mod race {
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};

    thread_local! {
        static HOOK: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) };
    }

    /// Runs `step` once, at the next `checked` on this thread.
    pub fn at_check(step: impl FnOnce() + 'static) {
        HOOK.with(|hook| *hook.borrow_mut() = Some(Box::new(step)));
    }

    /// Whether the step set last has run.
    pub fn ran() -> bool {
        HOOK.with(|hook| hook.borrow().is_none())
    }

    pub(super) fn run() {
        if let Some(step) = HOOK.with(|hook| hook.borrow_mut().take()) {
            step();
        }
    }

    /// At the next `checked`, moves the folder at `folder` aside (to
    /// `aside`) and puts a link to `to` in its place.
    pub fn swap_at_check(folder: &Path, aside: &Path, to: &Path) {
        let (folder, aside, to): (PathBuf, PathBuf, PathBuf) =
            (folder.into(), aside.into(), to.into());
        at_check(move || {
            std::fs::rename(&folder, &aside).unwrap();
            std::os::unix::fs::symlink(&to, &folder).unwrap();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The names in `dir`, sorted.
    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn knows_its_temporary_names() {
        for _ in 0..8 {
            assert!(is_temporary(&random_name()));
        }
        assert!(is_temporary(".devot-0123456789abcdef0123456789abcdef.tmp"));
        for name in [
            "devot-0123456789abcdef0123456789abcdef.tmp",
            ".devot-0123456789ABCDEF0123456789abcdef.tmp",
            ".devot-0123456789abcdef0123456789abcde.tmp",
            ".devot-0123456789abcdef0123456789abcdef0.tmp",
            ".devot-0123456789abcdef0123456789abcdef.tmp-journal",
            ".devot-photos.tmp",
            ".devot-.tmp",
        ] {
            assert!(!is_temporary(name), "{name}");
        }
    }

    #[test]
    fn writes_the_whole_file_and_leaves_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.json");
        write_replacing(&path, b"1").unwrap();
        write_replacing(&path, b"2").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"2");
        assert_eq!(names(dir.path()), ["x.json"]);
        // A folder in its place is not replaced; no temporary file stays.
        let folder = dir.path().join("y.json");
        fs::create_dir(&folder).unwrap();
        assert!(write_replacing(&folder, b"3").is_err());
        assert_eq!(names(dir.path()), ["x.json", "y.json"]);
        // A folder that is not there: an error, nothing written.
        assert!(write_replacing(&dir.path().join("gone/z.json"), b"4").is_err());
    }

    #[test]
    fn temporary_names_are_hidden_random_and_new() {
        let dir = tempfile::tempdir().unwrap();
        let folder = Folder::open(dir.path()).unwrap();
        let a = TempFile::in_folder(folder.clone()).unwrap();
        let b = TempFile::in_folder(folder).unwrap();
        for temp in [&a, &b] {
            let name = temp.name.to_str().unwrap();
            assert!(
                name.starts_with(".devot-") && name.ends_with(".tmp"),
                "{name}"
            );
            assert_eq!(name.len(), ".devot-".len() + 32 + ".tmp".len());
        }
        assert_ne!(a.name, b.name);
        // Dropped without being put in place: gone.
        drop((a, b));
        assert!(names(dir.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_a_link_at_a_temporary_name() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs.txt");
        fs::write(&theirs, b"theirs").unwrap();
        // A link and a file at the first names: passed over, left as they are.
        let link = dir.path().join(".devot-link.tmp");
        std::os::unix::fs::symlink(&theirs, &link).unwrap();
        let dangling = dir.path().join(".devot-dangling.tmp");
        std::os::unix::fs::symlink(outside.path().join("new.txt"), &dangling).unwrap();
        let file = dir.path().join(".devot-file.tmp");
        fs::write(&file, b"kept").unwrap();
        let free = dir.path().join(".devot-free.tmp");
        let folder = Folder::open(dir.path()).unwrap();
        let taken =
            [".devot-link.tmp", ".devot-dangling.tmp", ".devot-file.tmp"].map(OsString::from);
        let mut temp = TempFile::create_first(
            folder.clone(),
            taken
                .iter()
                .cloned()
                .chain([OsString::from(".devot-free.tmp")]),
        )
        .unwrap();
        assert_eq!(temp.name, ".devot-free.tmp");
        temp.write_all(b"mine").unwrap();
        let target = dir.path().join("note.md");
        temp.finish(&folder, OsStr::new("note.md"), Place::Replace, true)
            .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"mine");
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
        assert!(!outside.path().join("new.txt").exists());
        assert!(fs::symlink_metadata(&link).unwrap().is_symlink());
        assert_eq!(fs::read(&file).unwrap(), b"kept");
        assert!(!free.exists(), "renamed into place");
        // Every name taken: nothing is created or written at all.
        let refused = TempFile::create_first(folder, taken).err().unwrap();
        assert_eq!(refused.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
        assert!(!outside.path().join("new.txt").exists());
        // An exact name (a crash report's) that is taken is refused too.
        let exact = dir.path().join("x.json.partial");
        std::os::unix::fs::symlink(&theirs, &exact).unwrap();
        assert!(TempFile::create(exact).is_err());
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
        // A file made by its path goes only to a name in that folder: the
        // folder is never looked up again, so a target elsewhere is refused.
        let other = tempfile::tempdir().unwrap();
        let partial = TempFile::create(dir.path().join("y.json.partial")).unwrap();
        let elsewhere = partial.persist(&other.path().join("y.json"), Place::Replace);
        assert_eq!(
            elsewhere.map_err(|e| e.kind()),
            Err(io::ErrorKind::InvalidInput)
        );
        assert!(names(other.path()).is_empty());
        assert!(!dir.path().join("y.json.partial").exists());
        let mut partial = TempFile::create(dir.path().join("y.json.partial")).unwrap();
        partial.write_all(b"{}").unwrap();
        partial
            .persist(&dir.path().join("y.json"), Place::Replace)
            .unwrap();
        assert_eq!(fs::read(dir.path().join("y.json")).unwrap(), b"{}");
    }

    #[cfg(unix)]
    #[test]
    fn a_new_file_takes_no_name_already_there() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs.txt");
        fs::write(&theirs, b"theirs").unwrap();
        let taken = dir.path().join("taken.md");
        fs::write(&taken, b"old").unwrap();
        let link = dir.path().join("link.md");
        std::os::unix::fs::symlink(&theirs, &link).unwrap();
        let dangling = dir.path().join("dangling.md");
        std::os::unix::fs::symlink(outside.path().join("new.txt"), &dangling).unwrap();
        for path in [&taken, &link, &dangling] {
            let refused = write(path, b"mine", Place::New).unwrap_err();
            assert_eq!(refused.kind(), io::ErrorKind::AlreadyExists, "{path:?}");
        }
        assert_eq!(fs::read(&taken).unwrap(), b"old");
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
        assert!(!outside.path().join("new.txt").exists());
        assert_eq!(names(dir.path()), ["dangling.md", "link.md", "taken.md"]);
        let free = dir.path().join("free.md");
        write(&free, b"mine", Place::New).unwrap();
        assert_eq!(fs::read(&free).unwrap(), b"mine");
        assert_eq!(
            names(dir.path()),
            ["dangling.md", "free.md", "link.md", "taken.md"]
        );
        // Replacing a link puts the file in its place; its target stays.
        write(&link, b"replaced", Place::Replace).unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().is_file());
        assert_eq!(fs::read(&link).unwrap(), b"replaced");
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
    }

    #[cfg(unix)]
    #[test]
    fn an_unflushed_file_goes_in_place_the_same_way() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs.txt");
        fs::write(&theirs, b"theirs").unwrap();
        let folder = Folder::open(dir.path()).unwrap();
        let path = dir.path().join("Plan.md");
        folder
            .write_unflushed("Plan.md", b"one", Place::New)
            .unwrap();
        folder
            .write_unflushed("Plan.md", b"two", Place::Replace)
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        let link = dir.path().join("Link.md");
        std::os::unix::fs::symlink(&theirs, &link).unwrap();
        let dangling = dir.path().join("Dangling.md");
        std::os::unix::fs::symlink(outside.path().join("new.txt"), &dangling).unwrap();
        for taken in ["Plan.md", "Link.md", "Dangling.md"] {
            let refused = folder
                .write_unflushed(taken, b"mine", Place::New)
                .unwrap_err();
            assert_eq!(refused.kind(), io::ErrorKind::AlreadyExists, "{taken}");
        }
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
        assert!(!outside.path().join("new.txt").exists());
        assert_eq!(names(dir.path()), ["Dangling.md", "Link.md", "Plan.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_move_to_a_new_name_takes_none_already_there() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs.txt");
        fs::write(&theirs, b"theirs").unwrap();
        let from = dir.path().join("Plan.md");
        fs::write(&from, b"mine").unwrap();
        let taken = dir.path().join("Taken.md");
        fs::write(&taken, b"taken").unwrap();
        let link = dir.path().join("Link.md");
        std::os::unix::fs::symlink(&theirs, &link).unwrap();
        let dangling = dir.path().join("Dangling.md");
        std::os::unix::fs::symlink(outside.path().join("new.txt"), &dangling).unwrap();
        let folder = dir.path().join("Folder.md");
        fs::create_dir(&folder).unwrap();
        let here = Folder::open(dir.path()).unwrap();
        for to in ["Taken.md", "Link.md", "Dangling.md", "Folder.md"] {
            let refused = here.rename("Plan.md", &here, to, Place::New).unwrap_err();
            assert_eq!(refused.kind(), io::ErrorKind::AlreadyExists, "{to}");
        }
        assert_eq!(fs::read(&from).unwrap(), b"mine");
        assert_eq!(fs::read(&taken).unwrap(), b"taken");
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
        assert!(!outside.path().join("new.txt").exists());
        assert!(fs::symlink_metadata(&link).unwrap().is_symlink());
        // To a free name: moved, the old name gone.
        let moved = dir.path().join("Moved.md");
        here.rename("Plan.md", &here, "Moved.md", Place::New)
            .unwrap();
        assert_eq!(fs::read(&moved).unwrap(), b"mine");
        assert!(fs::symlink_metadata(&from).is_err());
        // A link is moved as it is, never followed.
        let relinked = dir.path().join("Relinked.md");
        here.rename("Link.md", &here, "Relinked.md", Place::New)
            .unwrap();
        assert!(fs::symlink_metadata(&relinked).unwrap().is_symlink());
        assert!(fs::symlink_metadata(&link).is_err());
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
        // Over a file only when asked to replace it.
        here.rename("Moved.md", &here, "Taken.md", Place::Replace)
            .unwrap();
        assert_eq!(fs::read(&taken).unwrap(), b"mine");
        assert_eq!(
            names(dir.path()),
            ["Dangling.md", "Folder.md", "Relinked.md", "Taken.md"]
        );
    }

    /// Keeps a folder read-only while it lives (then writable again, so the
    /// test's folder can go).
    #[cfg(unix)]
    struct ReadOnly<'a>(&'a Path);

    #[cfg(unix)]
    impl<'a> ReadOnly<'a> {
        fn new(dir: &'a Path) -> Self {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o555)).unwrap();
            Self(dir)
        }

        /// Whether permissions hold here (root ignores them).
        fn holds(&self) -> bool {
            Folder::open(self.0)
                .and_then(|folder| folder.check_writable())
                .is_err()
        }
    }

    #[cfg(unix)]
    impl Drop for ReadOnly<'_> {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(self.0, fs::Permissions::from_mode(0o755));
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_move_out_of_a_folder_it_cannot_change_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("Locked");
        let open = dir.path().join("Open");
        fs::create_dir(&locked).unwrap();
        fs::create_dir(&open).unwrap();
        let from = locked.join("Plan.md");
        fs::write(&from, b"mine").unwrap();
        let to = open.join("Plan.md");
        let read_only = ReadOnly::new(&locked);
        if !read_only.holds() {
            return;
        }
        // The new name cannot be made without the old one going too: the
        // file is never left under both names. Both ways a file goes where
        // nothing is yet (`rename` takes the first the file system has).
        let (from_dir, to_dir) = (Folder::open(&locked).unwrap(), Folder::open(&open).unwrap());
        let name = OsStr::new("Plan.md");
        for (way, moved) in [
            ("rename", from_dir.rename(name, &to_dir, name, Place::New)),
            ("claim", claim_and_rename(&from_dir, name, &to_dir, name)),
        ] {
            assert_eq!(
                moved.map_err(|e| e.kind()),
                Err(io::ErrorKind::PermissionDenied),
                "{way}"
            );
            assert!(fs::symlink_metadata(&to).is_err(), "{way}");
            assert_eq!(fs::read(&from).unwrap(), b"mine", "{way}");
        }
        drop(read_only);
        assert!(names(&open).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_claimed_name_takes_none_already_there() {
        // Where a rename cannot refuse a taken name itself (FAT, exFAT, many
        // network shares): a new empty file claims it first.
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs.txt");
        fs::write(&theirs, b"theirs").unwrap();
        let from = dir.path().join("Plan.md");
        fs::write(&from, b"mine").unwrap();
        let taken = dir.path().join("Taken.md");
        fs::write(&taken, b"taken").unwrap();
        let link = dir.path().join("Link.md");
        std::os::unix::fs::symlink(&theirs, &link).unwrap();
        let dangling = dir.path().join("Dangling.md");
        std::os::unix::fs::symlink(outside.path().join("new.txt"), &dangling).unwrap();
        let folder = dir.path().join("Folder.md");
        fs::create_dir(&folder).unwrap();
        let here = Folder::open(dir.path()).unwrap();
        let claim =
            |from: &str, to: &str| claim_and_rename(&here, OsStr::new(from), &here, OsStr::new(to));
        for to in ["Taken.md", "Link.md", "Dangling.md", "Folder.md"] {
            let refused = claim("Plan.md", to).unwrap_err();
            assert_eq!(refused.kind(), io::ErrorKind::AlreadyExists, "{to}");
        }
        assert_eq!(fs::read(&from).unwrap(), b"mine");
        assert_eq!(fs::read(&taken).unwrap(), b"taken");
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
        assert!(!outside.path().join("new.txt").exists());
        assert!(fs::symlink_metadata(&link).unwrap().is_symlink());
        assert!(fs::symlink_metadata(&dangling).unwrap().is_symlink());
        assert!(folder.is_dir());
        // A rename that fails takes its claim back.
        let failed = claim("Missing.md", "Claimed.md").unwrap_err();
        assert_eq!(failed.kind(), io::ErrorKind::NotFound);
        assert!(fs::symlink_metadata(dir.path().join("Claimed.md")).is_err());
        // To a free name: moved over the claim, the old name gone; a link is
        // moved as it is.
        let moved = dir.path().join("Moved.md");
        claim("Plan.md", "Moved.md").unwrap();
        assert_eq!(fs::read(&moved).unwrap(), b"mine");
        assert!(fs::symlink_metadata(&from).is_err());
        let relinked = dir.path().join("Relinked.md");
        claim("Link.md", "Relinked.md").unwrap();
        assert!(fs::symlink_metadata(&relinked).unwrap().is_symlink());
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
        assert_eq!(
            names(dir.path()),
            [
                "Dangling.md",
                "Folder.md",
                "Moved.md",
                "Relinked.md",
                "Taken.md"
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_private_folder_swapped_for_another_is_never_used() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("page.pdf");
        fs::write(&theirs, b"theirs").unwrap();
        // Its mode keeps others out of the folder, not from swapping it for
        // a link or a folder of their own while the writer runs: anyone who
        // may remove names where it sits could.
        let linked = TempDir::new_in(dir.path()).unwrap();
        fs::remove_dir(linked.path()).unwrap();
        std::os::unix::fs::symlink(outside.path(), linked.path()).unwrap();
        // A folder of theirs, made while the private one still stands (so it
        // is another folder on any file system), moved into its place.
        let swapped = TempDir::new_in(dir.path()).unwrap();
        let planted = dir.path().join("planted");
        fs::create_dir(&planted).unwrap();
        fs::write(planted.join("page.pdf"), b"planted").unwrap();
        fs::remove_dir(swapped.path()).unwrap();
        fs::rename(&planted, swapped.path()).unwrap();
        let target = dir.path().join("Plan.pdf");
        for temp in [&linked, &swapped] {
            let refused = temp.persist("page.pdf", &target, Place::Replace);
            assert_eq!(
                refused.map_err(|e| e.kind()),
                Err(io::ErrorKind::InvalidData)
            );
        }
        assert!(fs::symlink_metadata(&target).is_err());
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
        // Dropped, neither removes what is at its name now: not its own.
        let (link, folder) = (linked.path().to_owned(), swapped.path().to_owned());
        drop((linked, swapped));
        assert!(fs::symlink_metadata(&link).unwrap().is_symlink());
        assert_eq!(fs::read(folder.join("page.pdf")).unwrap(), b"planted");
        assert_eq!(names(outside.path()), ["page.pdf"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_private_folder_holds_a_file_written_by_path() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs.pdf");
        fs::write(&theirs, b"theirs").unwrap();
        // A link at the first name is passed over: a folder is never made
        // through one.
        let link = dir.path().join(".devot-link.tmp");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        let free = dir.path().join(".devot-free.tmp");
        let temp = TempDir::create_first([link.clone(), free.clone()]).unwrap();
        assert_eq!(temp.path(), free);
        let mode = fs::metadata(temp.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        // A writer that names its file by path (as AppKit does).
        fs::write(temp.path().join("page.pdf"), b"%PDF-1.7").unwrap();
        let target = dir.path().join("Plan.pdf");
        temp.persist("page.pdf", &target, Place::Replace).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"%PDF-1.7");
        // A link left in the folder is never put in place.
        std::os::unix::fs::symlink(&theirs, temp.path().join("other.pdf")).unwrap();
        let other = dir.path().join("Other.pdf");
        assert!(temp.persist("other.pdf", &other, Place::Replace).is_err());
        assert!(fs::symlink_metadata(&other).is_err());
        assert!(temp.persist("missing.pdf", &other, Place::Replace).is_err());
        drop(temp);
        assert_eq!(names(dir.path()), [".devot-link.tmp", "Plan.pdf"]);
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
        assert_eq!(names(outside.path()), ["theirs.pdf"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_written_by_path_is_copied_out_through_a_temporary_file() {
        let private = tempfile::tempdir().unwrap();
        let chosen = tempfile::tempdir().unwrap();
        let into = Folder::open(chosen.path()).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs.pdf");
        fs::write(&theirs, b"theirs").unwrap();
        let temp = TempDir::new_in(private.path()).unwrap();
        fs::write(temp.path().join("page.pdf"), b"%PDF-1.7").unwrap();
        // Over a file the user chose to replace, and over a link there (the
        // link itself is replaced, never written through).
        let target = chosen.path().join("Plan.pdf");
        fs::write(&target, b"old").unwrap();
        let link = chosen.path().join("Link.pdf");
        std::os::unix::fs::symlink(&theirs, &link).unwrap();
        for (to, name) in [(&target, "Plan.pdf"), (&link, "Link.pdf")] {
            temp.copy_to("page.pdf", &into, name, Place::Replace)
                .unwrap();
            assert!(fs::symlink_metadata(to).unwrap().is_file());
            assert_eq!(fs::read(to).unwrap(), b"%PDF-1.7");
        }
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
        // Only where nothing is, when asked so.
        let refused = temp.copy_to("page.pdf", &into, "Plan.pdf", Place::New);
        assert_eq!(
            refused.map_err(|e| e.kind()),
            Err(io::ErrorKind::AlreadyExists)
        );
        // Anything but a plain file in the folder is refused.
        std::os::unix::fs::symlink(&theirs, temp.path().join("other.pdf")).unwrap();
        for name in ["other.pdf", "missing.pdf"] {
            let refused = temp.copy_to(name, &into, "Other.pdf", Place::Replace);
            assert!(refused.is_err(), "{name}");
        }
        // Copied, not moved: the folder goes with it when dropped; nothing but
        // the targets is left where they went.
        drop(temp);
        assert!(names(private.path()).is_empty());
        assert_eq!(names(chosen.path()), ["Link.pdf", "Plan.pdf"]);
        assert_eq!(names(outside.path()), ["theirs.pdf"]);
    }

    #[test]
    fn a_private_folder_goes_with_what_is_left_in_it() {
        let dir = tempfile::tempdir().unwrap();
        let temp = TempDir::new_in(dir.path()).unwrap();
        let name = temp
            .path()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert!(
            name.starts_with(".devot-") && name.ends_with(".tmp"),
            "{name}"
        );
        fs::write(temp.path().join("backup.sqlite-journal"), b"x").unwrap();
        drop(temp);
        assert!(names(dir.path()).is_empty());
    }

    fn kind_of<T>(result: io::Result<T>) -> Result<(), io::ErrorKind> {
        result.map(drop).map_err(|e| e.kind())
    }

    #[test]
    fn opens_a_folder_below_only_as_a_real_folder_and_by_one_name() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = Folder::open(dir.path()).unwrap();
        fs::create_dir(dir.path().join("Real")).unwrap();
        fs::write(dir.path().join("File"), b"x").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("Link")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("gone"), dir.path().join("Dangling"))
            .unwrap();
        assert!(root.folder("Real").is_ok());
        for name in ["File", "Link", "Dangling"] {
            assert_eq!(
                kind_of(root.folder(name)),
                Err(io::ErrorKind::NotADirectory),
                "{name}"
            );
        }
        assert_eq!(
            kind_of(root.folder("Missing")),
            Err(io::ErrorKind::NotFound)
        );
        // A folder is never made where a link is.
        for name in ["Link", "Dangling"] {
            assert_eq!(
                kind_of(root.make_folder(name)),
                Err(io::ErrorKind::AlreadyExists)
            );
        }
        // One name at a time: the system would resolve a path, `.` or `..`
        // itself, following any link on its way.
        for name in ["Link/x", "Real/../Link", "..", ".", ""] {
            let refused = [
                kind_of(root.folder(name)),
                kind_of(root.make_folder(name)),
                kind_of(root.entry(name)),
                kind_of(root.read_file(name)),
                kind_of(root.write(name, b"x", Place::New)),
                kind_of(root.remove_file(name)),
                kind_of(root.remove_folder(name)),
                kind_of(root.rename("File", &root, name, Place::New)),
            ];
            assert_eq!(refused, [Err(io::ErrorKind::InvalidInput); 8], "{name:?}");
        }
        assert!(names(outside.path()).is_empty());
        assert_eq!(fs::read(dir.path().join("File")).unwrap(), b"x");
    }

    #[test]
    fn a_folder_opened_once_is_never_looked_up_by_its_path_again() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let chosen = dir.path().join("Chosen");
        fs::create_dir(&chosen).unwrap();
        let folder = Folder::open(&chosen).unwrap();
        folder.make_folder("Deep").unwrap();
        let deep = folder.folder("Deep").unwrap();
        fs::write(chosen.join("Deep/Old.md"), b"old").unwrap();
        // The folder moved aside, and a link put in its place.
        let moved = dir.path().join("Moved");
        fs::rename(&chosen, &moved).unwrap();
        std::os::unix::fs::symlink(outside.path(), &chosen).unwrap();
        // Every step still works in the folder that was opened.
        folder.write("Plan.md", b"plan", Place::New).unwrap();
        deep.write("Spec.md", b"spec", Place::Replace).unwrap();
        deep.rename("Old.md", &folder, "Old.md", Place::New)
            .unwrap();
        folder.make_folder("New").unwrap();
        folder.check_writable().unwrap();
        folder.remove_folder("New").unwrap();
        assert!(names(outside.path()).is_empty());
        assert_eq!(names(&moved), ["Deep", "Old.md", "Plan.md"]);
        assert_eq!(names(&moved.join("Deep")), ["Spec.md"]);
        assert_eq!(fs::read(moved.join("Old.md")).unwrap(), b"old");
    }

    #[test]
    fn a_resolved_folder_is_refused_with_a_link_anywhere_on_its_path() {
        let dir = tempfile::tempdir().unwrap();
        let top = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir_all(top.join("a/b")).unwrap();
        Folder::open_resolved(&top.join("a/b"))
            .unwrap()
            .write("x", b"x", Place::New)
            .unwrap();
        assert_eq!(fs::read(top.join("a/b/x")).unwrap(), b"x");
        std::os::unix::fs::symlink(top.join("a"), top.join("link")).unwrap();
        for linked in [top.join("link"), top.join("link/b")] {
            assert_eq!(
                kind_of(Folder::open_resolved(&linked)),
                Err(io::ErrorKind::NotADirectory),
                "{linked:?}"
            );
        }
        // A folder the user picks through a link is opened through it, once.
        assert!(Folder::open(&top.join("link/b")).is_ok());
        for unresolved in [Path::new("a/b"), Path::new("/a/../b"), Path::new("")] {
            assert_eq!(
                kind_of(Folder::open_resolved(unresolved)),
                Err(io::ErrorKind::InvalidInput),
                "{unresolved:?}"
            );
        }
    }

    #[test]
    fn a_folder_the_user_picked_through_a_link_stays_the_one_picked() {
        let dir = tempfile::tempdir().unwrap();
        let (picked, other) = (dir.path().join("Picked"), dir.path().join("Other"));
        fs::create_dir(&picked).unwrap();
        fs::create_dir(&other).unwrap();
        let link = dir.path().join("Link");
        std::os::unix::fs::symlink(&picked, &link).unwrap();
        let folder = Folder::open(&link).unwrap();
        // The link now points elsewhere: the folder opened is the one picked.
        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&other, &link).unwrap();
        folder.write("Plan.md", b"plan", Place::New).unwrap();
        assert_eq!(names(&picked), ["Plan.md"]);
        assert!(names(&other).is_empty());
    }

    /// A folder others may drop files into but not list (a Drop Box) is
    /// written as it is by path: opened for search alone (`O_SEARCH`).
    #[cfg(target_os = "macos")]
    #[test]
    fn writes_into_a_folder_it_may_not_list() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let drop_box = dir.path().join("Drop Box");
        fs::create_dir(&drop_box).unwrap();
        fs::set_permissions(&drop_box, fs::Permissions::from_mode(0o300)).unwrap();
        let written = write(&drop_box.join("Plan.md"), b"plan", Place::New);
        fs::set_permissions(&drop_box, fs::Permissions::from_mode(0o755)).unwrap();
        written.unwrap();
        assert_eq!(fs::read(drop_box.join("Plan.md")).unwrap(), b"plan");
        assert_eq!(names(&drop_box), ["Plan.md"]);
    }

    #[test]
    fn tells_what_a_name_holds_without_following_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let folder = Folder::open(dir.path()).unwrap();
        fs::write(dir.path().join("File.md"), b"abc").unwrap();
        fs::create_dir(dir.path().join("Folder")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("File.md"), dir.path().join("Link.md")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("Folder"), dir.path().join("Linked")).unwrap();
        let file = folder.entry("File.md").unwrap();
        assert_eq!((file.kind, file.len), (Kind::File, 3));
        assert!(file.is_file() && !file.is_folder());
        assert!(folder.entry("Folder").unwrap().is_folder());
        for link in ["Link.md", "Linked"] {
            assert_eq!(folder.entry(link).unwrap().kind, Kind::Other, "{link}");
        }
        assert_eq!(
            kind_of(folder.entry("Missing")),
            Err(io::ErrorKind::NotFound)
        );
        // One file under two names is one; a folder is another.
        fs::hard_link(dir.path().join("File.md"), dir.path().join("Hard.md")).unwrap();
        assert!(file.same_file(&folder.entry("Hard.md").unwrap()));
        assert!(!file.same_file(&folder.entry("Folder").unwrap()));
        // Read only as a plain file, never through a link.
        let mut text = String::new();
        folder
            .read_file("File.md")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "abc");
        for other in ["Link.md", "Linked", "Folder"] {
            assert_eq!(
                kind_of(folder.read_file(other)),
                Err(io::ErrorKind::InvalidData),
                "{other}"
            );
        }
        let mut listed: Vec<String> = folder
            .names()
            .unwrap()
            .into_iter()
            .map(|name| name.into_string().unwrap())
            .collect();
        listed.sort();
        assert_eq!(listed, names(dir.path()));
        // A link goes itself, never what it points to; a folder only when
        // it is a real one, and empty.
        folder.remove_file("Link.md").unwrap();
        assert_eq!(fs::read(dir.path().join("File.md")).unwrap(), b"abc");
        assert!(folder.remove_folder("Linked").is_err());
        assert!(
            fs::symlink_metadata(dir.path().join("Linked"))
                .unwrap()
                .is_symlink()
        );
        folder.remove_folder("Folder").unwrap();
        assert_eq!(names(dir.path()), ["File.md", "Hard.md", "Linked"]);
    }

    /// The move a new name gets on APFS: one step that fails on any name
    /// there, a dangling link included.
    #[cfg(target_os = "macos")]
    #[test]
    fn renames_in_one_step_only_where_nothing_is() {
        let dir = tempfile::tempdir().unwrap();
        let here = Folder::open(dir.path()).unwrap();
        fs::write(dir.path().join("Plan.md"), b"mine").unwrap();
        fs::write(dir.path().join("Taken.md"), b"theirs").unwrap();
        std::os::unix::fs::symlink(dir.path().join("nowhere"), dir.path().join("Dangling.md"))
            .unwrap();
        let rename =
            |from: &str, to: &str| rename_exclusive(&here, OsStr::new(from), &here, OsStr::new(to));
        for to in ["Taken.md", "Dangling.md"] {
            assert_eq!(
                kind_of(rename("Plan.md", to)),
                Err(io::ErrorKind::AlreadyExists)
            );
        }
        assert_eq!(fs::read(dir.path().join("Taken.md")).unwrap(), b"theirs");
        assert!(!dir.path().join("nowhere").exists());
        rename("Plan.md", "Moved.md").unwrap();
        assert_eq!(fs::read(dir.path().join("Moved.md")).unwrap(), b"mine");
        assert!(fs::symlink_metadata(dir.path().join("Plan.md")).is_err());
        // A name no C string can hold is refused before the call.
        assert_eq!(
            kind_of(rename("Moved.md", "a\0b")),
            Err(io::ErrorKind::InvalidInput)
        );
    }
}
