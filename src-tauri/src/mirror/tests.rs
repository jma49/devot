use super::folder::{MANIFEST, sha256_hex};
use super::*;
use serde_json::json;
use std::cell::RefCell;
use std::fs;

const NOTE: &str = "0192a6f0-0000-7000-8000-000000000001";

struct Fixture {
    _dir: tempfile::TempDir,
    data: PathBuf,
    mirror: Mirror,
    seen: RefCell<Vec<Status>>,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        // Canonical, as chosen folders are (`/var` is a link on macOS).
        let data = fs::canonicalize(dir.path()).unwrap();
        let mirror = Mirror::new(&data.join(SETTINGS_FILE), Some(data.clone()));
        Self {
            _dir: dir,
            data,
            mirror,
            seen: RefCell::new(Vec::new()),
        }
    }

    fn notify(&self) -> impl Fn(&Status) + '_ {
        |status: &Status| self.seen.borrow_mut().push(status.clone())
    }

    fn folder(&self, name: &str) -> PathBuf {
        let path = self.data.join(name);
        fs::create_dir(&path).unwrap();
        fs::canonicalize(path).unwrap()
    }

    fn get(&self) -> Status {
        self.mirror.get(&self.notify()).unwrap()
    }

    fn choose(&self, folder: &Path) -> Choice {
        self.mirror.choose(folder, &self.notify()).unwrap()
    }

    fn open(&self) -> Result<Opened, &'static str> {
        self.mirror.open(None, &self.notify())
    }

    fn apply(&self, generation: u64, ops: &[Value]) -> Vec<OpResult> {
        self.mirror
            .apply(generation, ops, &mut |_| None, &self.notify())
            .unwrap()
    }
}

fn note_op(path: &str, text: &str) -> Value {
    json!({
        "kind": "note",
        "id": NOTE,
        "path": path,
        "from": null,
        "sha256": sha256_hex(text.as_bytes()),
        "text": text,
        "source": "s",
        "files": [],
    })
}

fn patch(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => panic!("not an object"),
    }
}

#[test]
fn is_off_by_default_and_turns_on_with_an_empty_folder() {
    let f = Fixture::new();
    let status = f.get();
    assert_eq!(status.folder, None);
    assert!(status.include_attachments);
    assert_eq!(f.open(), Err("E_MIRROR_OFF"));

    let folder = f.folder("Notes");
    let Choice::Chosen { status } = f.choose(&folder) else {
        panic!("an empty folder is used at once");
    };
    assert_eq!(status.folder.as_deref(), Some("~/Notes"));
    assert_eq!(f.seen.borrow().last(), Some(&status));
    let again = Mirror::new(&f.data.join(SETTINGS_FILE), None);
    assert_eq!(
        again.get(&|_| {}).unwrap().folder.as_deref(),
        Some(folder.to_str().unwrap())
    );
    let opened = f.open().unwrap();
    let manifest = opened.manifest.unwrap();
    assert_eq!(manifest.size(), 0);
    assert_eq!(
        folder::parse_manifest(&fs::read(folder.join(MANIFEST)).unwrap()),
        Some(manifest)
    );
    let known = f.mirror.open(Some(opened.generation), &f.notify()).unwrap();
    assert_eq!(known.manifest, None);
}

#[test]
fn asks_before_using_a_folder_that_is_not_empty_and_has_no_manifest() {
    let f = Fixture::new();
    let folder = f.folder("Documents");
    fs::write(folder.join("theirs.md"), "theirs").unwrap();
    let Choice::Confirm { token, name } = f.choose(&folder) else {
        panic!("a folder in use needs a confirmation");
    };
    assert_eq!(name, "Documents");
    assert_eq!(f.get().folder, None, "not used before it is confirmed");
    assert_eq!(
        f.mirror.confirm(token + 1, &f.notify()),
        Err("E_MIRROR_CHOICE_UNKNOWN")
    );
    let status = f.mirror.confirm(token, &f.notify()).unwrap();
    assert!(status.folder.is_some());
    assert!(folder.join(MANIFEST).is_file());
    assert_eq!(
        fs::read_to_string(folder.join("theirs.md")).unwrap(),
        "theirs"
    );
    assert_eq!(
        f.mirror.confirm(token, &f.notify()),
        Err("E_MIRROR_CHOICE_UNKNOWN")
    );
    let other = f.folder("Other");
    fs::write(other.join("theirs.md"), "theirs").unwrap();
    fs::copy(folder.join(MANIFEST), other.join(MANIFEST)).unwrap();
    assert!(
        matches!(f.choose(&other), Choice::Chosen { .. }),
        "a manifest this library wrote is used at once"
    );
}

#[test]
fn refuses_a_folder_it_cannot_use() {
    let f = Fixture::new();
    assert_eq!(
        f.mirror.choose(&f.data.join("missing"), &f.notify()),
        Err("E_MIRROR_FOLDER_INVALID")
    );
    let file = f.data.join("file.txt");
    fs::write(&file, "x").unwrap();
    assert_eq!(
        f.mirror.choose(&file, &f.notify()),
        Err("E_MIRROR_FOLDER_INVALID")
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let locked = f.folder("Locked");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
        let result = f.mirror.choose(&locked, &f.notify());
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        // Root ignores permissions.
        if result.is_err() {
            assert_eq!(result, Err("E_MIRROR_FOLDER_READ_ONLY"));
        }
    }
}

#[test]
fn changes_its_setting_and_refuses_anything_else() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let before = f.get();
    let status = f
        .mirror
        .set(&patch(json!({ "includeAttachments": false })), &f.notify())
        .unwrap();
    assert!(!status.include_attachments);
    assert!(
        status.generation > before.generation,
        "a pass planned before starts again"
    );
    assert!(status.revision > before.revision);
    for bad in [
        json!({ "includeAttachments": "no" }),
        json!({ "turnOff": false }),
        json!({ "folder": "/tmp" }),
        json!({ "dismissKept": 1 }),
    ] {
        assert_eq!(
            f.mirror.set(&patch(bad.clone()), &f.notify()),
            Err(INVALID),
            "{bad}"
        );
    }
    let off = f
        .mirror
        .set(&patch(json!({ "turnOff": true })), &f.notify())
        .unwrap();
    assert_eq!(off.folder, None);
    assert!(!off.include_attachments);
    assert!(folder.is_dir());
    let again = Mirror::new(&f.data.join(SETTINGS_FILE), None);
    assert_eq!(again.get(&|_| {}).unwrap().folder, None);
    assert!(!again.get(&|_| {}).unwrap().include_attachments);
}

#[test]
fn reads_a_damaged_setting_as_off_and_keeps_it_beside_before_the_next_change() {
    for damaged in [&b"{ not json"[..], b"[1]"] {
        let f = Fixture::new();
        fs::write(f.data.join(SETTINGS_FILE), damaged).unwrap();
        assert_eq!(f.get().folder, None);
        let folder = f.folder("Notes");
        assert!(matches!(f.choose(&folder), Choice::Chosen { .. }));
        let copy = f.data.join(format!(
            "{SETTINGS_FILE}{}",
            crate::atomic_file::DAMAGED_SUFFIX
        ));
        assert_eq!(fs::read(copy).unwrap(), damaged);
    }
    let g = Fixture::new();
    fs::write(
        g.data.join(SETTINGS_FILE),
        serde_json::to_vec(&json!({ "folder": "relative/path", "includeAttachments": 3 })).unwrap(),
    )
    .unwrap();
    let status = g.get();
    assert_eq!(status.folder, None);
    assert!(status.include_attachments);
}

#[test]
fn never_writes_over_a_setting_it_cannot_read() {
    let f = Fixture::new();
    fs::create_dir(f.data.join(SETTINGS_FILE)).unwrap();
    let status = f.get();
    assert_eq!(status.folder, None);
    assert!(status.include_attachments);
    assert_eq!(
        f.mirror
            .set(&patch(json!({ "includeAttachments": false })), &f.notify()),
        Err(READ_FAILED)
    );
    let empty = f.folder("Notes");
    let theirs = f.folder("Theirs");
    fs::write(theirs.join("a.md"), b"a").unwrap();
    for folder in [&empty, &theirs] {
        assert_eq!(f.mirror.choose(folder, &f.notify()), Err(READ_FAILED));
        assert!(!folder.join(MANIFEST).exists());
    }
    assert!(f.data.join(SETTINGS_FILE).is_dir());
    assert!(f.seen.borrow().is_empty());
}

#[cfg(unix)]
#[test]
fn a_change_after_a_failed_read_keeps_the_folder_and_every_window_is_told() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    f.mirror
        .set(&patch(json!({ "includeAttachments": false })), &f.notify())
        .unwrap();
    let path = f.data.join(SETTINGS_FILE);
    let before = fs::read(&path).unwrap();
    let mode = |bits| fs::set_permissions(&path, fs::Permissions::from_mode(bits));
    mode(0o000).unwrap();
    if fs::read(&path).is_ok() {
        return; // root reads it anyway
    }
    let launched = Mirror::new(&path, Some(f.data.clone()));
    let seen = RefCell::new(Vec::new());
    let notify = |status: &Status| seen.borrow_mut().push(status.clone());
    let shown = launched.get(&notify).unwrap();
    assert_eq!(shown.folder, None);
    assert_eq!(launched.open(None, &notify), Err("E_MIRROR_OFF"));
    assert_eq!(
        launched.set(&patch(json!({ "includeAttachments": false })), &notify),
        Err(READ_FAILED)
    );
    assert_eq!(launched.choose(&folder, &notify), Err(READ_FAILED));
    mode(0o600).unwrap();
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(seen.borrow().is_empty());

    let read = launched.get(&notify).unwrap();
    assert_eq!(read.folder.as_deref(), Some("~/Notes"));
    assert!(!read.include_attachments);
    assert!(read.revision > shown.revision);
    assert!(read.generation > shown.generation);
    assert_eq!(seen.borrow().as_slice(), std::slice::from_ref(&read));
    assert_eq!(launched.get(&notify).unwrap(), read);

    let next = launched
        .set(&patch(json!({ "includeAttachments": true })), &notify)
        .unwrap();
    assert_eq!(next.folder.as_deref(), Some("~/Notes"));
    let stored = Mirror::new(&path, None).get(&|_| {}).unwrap();
    assert_eq!(stored.folder.as_deref(), Some(folder.to_str().unwrap()));
    assert!(stored.include_attachments);
}

#[test]
fn pauses_when_the_folder_goes_and_resumes_with_the_manifest_read_again() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let opened = f.open().unwrap();
    let results = f.apply(opened.generation, &[note_op("Plan.md", "# Plan\n")]);
    assert_eq!(results[0].code, None);
    assert_eq!(f.get().size, Some(7));

    let away = f.data.join("away");
    fs::rename(&folder, &away).unwrap();
    assert_eq!(f.open(), Err("E_MIRROR_FOLDER_MISSING"));
    assert_eq!(f.get().paused, Some("E_MIRROR_FOLDER_MISSING"));
    let paused = f
        .seen
        .borrow()
        .iter()
        .filter(|s| s.paused.is_some())
        .count();
    assert_eq!(f.open(), Err("E_MIRROR_FOLDER_MISSING"));
    assert_eq!(
        f.seen
            .borrow()
            .iter()
            .filter(|s| s.paused.is_some())
            .count(),
        paused
    );
    assert!(!folder.exists(), "the folder is never made");

    fs::rename(&away, &folder).unwrap();
    let resumed = f.open().unwrap();
    assert!(resumed.generation > opened.generation);
    assert_eq!(resumed.manifest.unwrap().notes[NOTE].path, "Plan.md");
    assert_eq!(f.get().paused, None);
}

/// The chosen folder moved aside and a link put in its place between two
/// passes: the folder was resolved when it was chosen, so a link anywhere
/// on its path now is not it. The mirror pauses as for a folder that went
/// away, and nothing is written, read or made through the link.
#[cfg(unix)]
#[test]
fn pauses_when_a_link_takes_the_folder_s_place_and_never_follows_it() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let opened = f.open().unwrap();
    let results = f.apply(opened.generation, &[note_op("Plan.md", "# Plan\n")]);
    assert_eq!(results[0].code, None);
    let outside = f.folder("Outside");
    fs::rename(&folder, f.data.join("Moved")).unwrap();
    std::os::unix::fs::symlink(&outside, &folder).unwrap();
    let written = f.mirror.apply(
        opened.generation,
        &[note_op("Work/Plan.md", "# Plan\n")],
        &mut |_| None,
        &f.notify(),
    );
    assert_eq!(written, Err("E_MIRROR_FOLDER_MISSING"));
    assert_eq!(f.open(), Err("E_MIRROR_FOLDER_MISSING"));
    assert_eq!(
        f.mirror.check(opened.generation, None, &f.notify()),
        Err("E_MIRROR_FOLDER_MISSING")
    );
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    fs::remove_file(&folder).unwrap();
    fs::rename(f.data.join("Moved"), &folder).unwrap();
    assert!(f.open().unwrap().generation > opened.generation);
}

#[test]
fn shows_the_size_of_a_mirror_once_it_reads_its_manifest() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let opened = f.open().unwrap();
    f.apply(opened.generation, &[note_op("Plan.md", "# Plan\n")]);
    assert_eq!(f.get().size, Some(7));
    // Turned off, then that folder chosen again: its size is not known
    // before its manifest is read...
    f.mirror
        .set(&patch(json!({ "turnOff": true })), &f.notify())
        .unwrap();
    let Choice::Chosen { status } = f.choose(&folder) else {
        panic!("a folder with a manifest is used at once");
    };
    assert_eq!(status.size, None);
    // ...and every window hears it once the next pass reads it, even when
    // that pass writes nothing.
    let generation = f.open().unwrap().generation;
    assert_eq!(f.seen.borrow().last().unwrap().size, Some(7));
    let heard = f.seen.borrow().len();
    f.mirror.open(Some(generation), &f.notify()).unwrap();
    assert_eq!(f.seen.borrow().len(), heard, "nothing new to tell");
    let launched = Mirror::new(&f.data.join(SETTINGS_FILE), None);
    assert_eq!(launched.get(&|_| {}).unwrap().size, None);
    let seen = RefCell::new(Vec::new());
    launched
        .open(None, &|status: &Status| seen.borrow_mut().push(status.size))
        .unwrap();
    assert_eq!(seen.borrow().last(), Some(&Some(7)));
}

#[test]
fn pauses_on_a_missing_or_unreadable_manifest() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    fs::write(folder.join(MANIFEST), b"{ damaged").unwrap();
    assert_eq!(f.open(), Err("E_MIRROR_MANIFEST_INVALID"));
    // Files without a manifest: Devot cannot tell which are its own.
    fs::remove_file(folder.join(MANIFEST)).unwrap();
    fs::write(folder.join("Plan.md"), "x").unwrap();
    assert_eq!(f.open(), Err("E_MIRROR_MANIFEST_MISSING"));
    let Choice::Confirm { token, .. } = f.choose(&folder) else {
        panic!("needs a confirmation");
    };
    f.mirror.confirm(token, &f.notify()).unwrap();
    assert_eq!(f.open().unwrap().manifest.unwrap().size(), 0);
}

#[test]
fn applies_operations_of_its_own_generation_and_writes_the_manifest_back() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let opened = f.open().unwrap();
    assert_eq!(
        f.mirror
            .apply(opened.generation + 1, &[], &mut |_| None, &f.notify()),
        Err("E_MIRROR_STALE")
    );
    let results = f.apply(
        opened.generation,
        &[note_op("Plan.md", "one"), json!({ "kind": "unknown" })],
    );
    assert_eq!(results[0].code, None);
    assert_eq!(results[1].code, Some("E_MIRROR_OP_INVALID"));
    let stored = folder::parse_manifest(&fs::read(folder.join(MANIFEST)).unwrap()).unwrap();
    assert_eq!(stored.notes[NOTE].path, "Plan.md");
    assert_eq!(
        f.mirror.apply(
            opened.generation,
            &vec![json!({}); MAX_OPS + 1],
            &mut |_| None,
            &f.notify()
        ),
        Err("E_MIRROR_OPS_INVALID")
    );

    fs::write(folder.join("Plan.md"), "edited").unwrap();
    let keep = json!({ "kind": "keep", "entry": "note", "id": NOTE, "path": "Plan.md" });
    let results = f.apply(opened.generation, &[keep]);
    assert_eq!(
        results[0].kept.as_deref(),
        Some("Plan (edited outside Devot).md")
    );
    let status = f.get();
    assert_eq!(status.kept, ["Plan (edited outside Devot).md"]);
    assert_eq!(status.kept_count, 1);
    assert_eq!(f.seen.borrow().last().unwrap().kept, status.kept);
    let dismissed = f
        .mirror
        .set(&patch(json!({ "dismissKept": true })), &f.notify())
        .unwrap();
    assert!(dismissed.kept.is_empty());
    assert_eq!(dismissed.kept_count, 0);
}

#[test]
fn names_only_the_first_kept_files_and_counts_them_all() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let generation = f.open().unwrap().generation;
    let id = |n: usize| format!("0192a6f0-0000-7000-8000-{n:012}");
    let ops: Vec<Value> = (0..KEPT_NAMED + 5)
        .map(|n| {
            json!({
                "kind": "note", "id": id(n), "path": format!("Note {n}.md"), "from": null,
                "sha256": sha256_hex(b"devot"), "text": "devot", "source": "s", "files": [],
            })
        })
        .collect();
    f.apply(generation, &ops);
    for n in 0..KEPT_NAMED + 5 {
        fs::write(folder.join(format!("Note {n}.md")), "edited").unwrap();
    }
    let keeps: Vec<Value> = (0..KEPT_NAMED + 5)
        .map(|n| json!({ "kind": "keep", "entry": "note", "id": id(n), "path": format!("Note {n}.md") }))
        .collect();
    f.apply(generation, &keeps);
    let status = f.get();
    assert_eq!(status.kept.len(), KEPT_NAMED);
    assert_eq!(status.kept_count, (KEPT_NAMED + 5) as u64);
}

#[test]
fn writes_back_on_resume_a_manifest_it_could_not_write() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let opened = f.open().unwrap();
    f.apply(opened.generation, &[note_op("Plan.md", "one")]);
    // The manifest cannot be replaced (a folder in its place) after a move.
    fs::remove_file(folder.join(MANIFEST)).unwrap();
    fs::create_dir(folder.join(MANIFEST)).unwrap();
    let mut moved = note_op("Moved.md", "one");
    moved["from"] = json!("Plan.md");
    let results = f.apply(opened.generation, &[moved]);
    assert_eq!(results[0].code, None);
    assert_eq!(f.get().paused, Some("E_MIRROR_FOLDER_READ_ONLY"));
    // Resuming writes what memory holds, never the older file.
    fs::remove_dir(folder.join(MANIFEST)).unwrap();
    let resumed = f.open().unwrap();
    assert_eq!(resumed.manifest.unwrap().notes[NOTE].path, "Moved.md");
    let stored = folder::parse_manifest(&fs::read(folder.join(MANIFEST)).unwrap()).unwrap();
    assert_eq!(stored.notes[NOTE].path, "Moved.md");
    assert_eq!(f.get().paused, None);
}

#[test]
fn reports_a_pause_from_its_manifest_save_as_a_last_result_of_its_own() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let generation = f.open().unwrap().generation;
    fs::remove_file(folder.join(MANIFEST)).unwrap();
    fs::create_dir(folder.join(MANIFEST)).unwrap();
    let results = f.apply(generation, &[note_op("Plan.md", "one")]);
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].code, None);
    assert_eq!(results[1].code, Some("E_MIRROR_FOLDER_READ_ONLY"));
}

/// Pauses the mirror on `Notes` with a move to `Moved.md` only in memory, lets the manifest be
/// written again, and returns the folder, its older manifest, which lists `Plan.md`, and the
/// generation.
fn pause_with_a_move_unsaved(f: &Fixture) -> (PathBuf, Vec<u8>, u64) {
    let folder = f.folder("Notes");
    f.choose(&folder);
    let generation = f.open().unwrap().generation;
    f.apply(generation, &[note_op("Plan.md", "one")]);
    let older = fs::read(folder.join(MANIFEST)).unwrap();
    fs::remove_file(folder.join(MANIFEST)).unwrap();
    fs::create_dir(folder.join(MANIFEST)).unwrap();
    let mut moved = note_op("Moved.md", "one");
    moved["from"] = json!("Plan.md");
    f.apply(generation, &[moved]);
    assert_eq!(f.get().paused, Some("E_MIRROR_FOLDER_READ_ONLY"));
    fs::remove_dir(folder.join(MANIFEST)).unwrap();
    (folder, older, generation)
}

fn stored_path(folder: &Path) -> String {
    let stored = folder::parse_manifest(&fs::read(folder.join(MANIFEST)).unwrap()).unwrap();
    stored.notes[NOTE].path.clone()
}

#[test]
fn writes_back_a_manifest_it_could_not_write_when_turned_off_or_its_folder_chosen_again() {
    let f = Fixture::new();
    let (folder, ..) = pause_with_a_move_unsaved(&f);
    f.mirror
        .set(&patch(json!({ "turnOff": true })), &f.notify())
        .unwrap();
    assert_eq!(stored_path(&folder), "Moved.md");
    assert!(matches!(f.choose(&folder), Choice::Chosen { .. }));
    assert_eq!(
        f.open().unwrap().manifest.unwrap().notes[NOTE].path,
        "Moved.md"
    );

    let f = Fixture::new();
    let (folder, older, _) = pause_with_a_move_unsaved(&f);
    fs::write(folder.join(MANIFEST), older).unwrap();
    assert!(matches!(f.choose(&folder), Choice::Chosen { .. }));
    assert_eq!(stored_path(&folder), "Moved.md");
    assert_eq!(
        f.open().unwrap().manifest.unwrap().notes[NOTE].path,
        "Moved.md"
    );
}

#[test]
fn keeps_a_manifest_it_still_cannot_write_for_the_next_use_of_its_folder() {
    let f = Fixture::new();
    let (folder, older, _) = pause_with_a_move_unsaved(&f);
    fs::create_dir(folder.join(MANIFEST)).unwrap();
    f.mirror
        .set(&patch(json!({ "turnOff": true })), &f.notify())
        .unwrap();
    fs::remove_dir(folder.join(MANIFEST)).unwrap();
    fs::write(folder.join(MANIFEST), older).unwrap();
    assert!(matches!(f.choose(&folder), Choice::Chosen { .. }));
    assert_eq!(
        f.open().unwrap().manifest.unwrap().notes[NOTE].path,
        "Moved.md"
    );
    assert_eq!(stored_path(&folder), "Moved.md");
}

#[test]
fn writes_back_at_quit_a_manifest_it_could_not_write() {
    let f = Fixture::new();
    let (folder, ..) = pause_with_a_move_unsaved(&f);
    f.mirror.flush(WAIT);
    assert_eq!(stored_path(&folder), "Moved.md");
}

#[test]
fn writes_back_a_manifest_it_could_not_write_before_using_a_confirmed_folder() {
    let f = Fixture::new();
    let (folder, ..) = pause_with_a_move_unsaved(&f);
    let other = f.folder("Docs");
    fs::write(other.join("theirs.md"), "theirs").unwrap();
    let Choice::Confirm { token, .. } = f.choose(&other) else {
        panic!("a folder in use needs a confirmation");
    };
    f.mirror.confirm(token, &f.notify()).unwrap();
    assert_eq!(stored_path(&folder), "Moved.md");
}

#[cfg(unix)]
#[test]
fn never_writes_its_manifest_through_a_link() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let opened = f.open().unwrap();
    let target = f.folder("Outside").join("target.txt");
    fs::write(&target, "theirs").unwrap();
    // Links planted at the names temporary files take, in the folder and in
    // a notebook's folder (a folder others write to: a shared or synced one,
    // a Git checkout), and where the manifest's temporary copy once went.
    let first = format!(".devot-{}-0.tmp", std::process::id());
    fs::create_dir(folder.join("Work")).unwrap();
    for planted in [
        folder.join(&first),
        folder.join("Work").join(&first),
        folder.join(".devot-mirror.json.partial"),
    ] {
        std::os::unix::fs::symlink(&target, planted).unwrap();
    }
    let results = f.apply(opened.generation, &[note_op("Work/Plan.md", "# Plan\n")]);
    assert_eq!(results[0].code, None);
    assert_eq!(fs::read_to_string(&target).unwrap(), "theirs");
    assert!(
        fs::symlink_metadata(folder.join("Work/Plan.md"))
            .unwrap()
            .is_file()
    );
    assert_eq!(
        fs::read_to_string(folder.join("Work/Plan.md")).unwrap(),
        "# Plan\n"
    );
    let manifest = folder.join(MANIFEST);
    assert!(fs::symlink_metadata(&manifest).unwrap().is_file());
    let stored = folder::parse_manifest(&fs::read(&manifest).unwrap()).unwrap();
    assert_eq!(stored.notes[NOTE].path, "Work/Plan.md");
}

#[cfg(unix)]
#[test]
fn never_writes_its_manifest_or_setting_through_a_link_or_a_dangling_one() {
    for dangling in [false, true] {
        let f = Fixture::new();
        let outside = f.folder("Outside");
        fs::write(outside.join("theirs.txt"), "theirs").unwrap();
        let target = outside.join(if dangling { "new.txt" } else { "theirs.txt" });
        std::os::unix::fs::symlink(&target, f.data.join("mirror-settings.json.partial")).unwrap();
        // A link at the manifest's name: the folder is neither empty nor a
        // mirror, so it is used only once confirmed...
        let folder = f.folder("Notes");
        std::os::unix::fs::symlink(&target, folder.join(MANIFEST)).unwrap();
        let Choice::Confirm { token, .. } = f.choose(&folder) else {
            panic!("a folder with a link at the manifest's name asks first");
        };
        // ...and then the manifest replaces the link itself.
        f.mirror.confirm(token, &f.notify()).unwrap();
        let opened = f.open().unwrap();
        let results = f.apply(opened.generation, &[note_op("Plan.md", "# Plan\n")]);
        assert_eq!(results[0].code, None);
        for written in [folder.join(MANIFEST), f.data.join(SETTINGS_FILE)] {
            assert!(
                fs::symlink_metadata(&written).unwrap().is_file(),
                "{written:?}"
            );
        }
        let stored = folder::parse_manifest(&fs::read(folder.join(MANIFEST)).unwrap()).unwrap();
        assert_eq!(stored.notes[NOTE].path, "Plan.md");
        assert!(
            fs::symlink_metadata(f.data.join("mirror-settings.json.partial"))
                .unwrap()
                .is_symlink()
        );
        let mut names: Vec<_> = fs::read_dir(&outside)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        names.sort();
        assert_eq!(names, ["theirs.txt"]);
        assert_eq!(
            fs::read_to_string(outside.join("theirs.txt")).unwrap(),
            "theirs"
        );
    }
}

#[test]
fn checks_the_disk_at_paths_or_every_manifest_file() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let opened = f.open().unwrap();
    f.apply(opened.generation, &[note_op("Plan.md", "one")]);
    let check = |paths: Option<&[String]>| f.mirror.check(opened.generation, paths, &f.notify());
    let hashed = folder::hashed_files();
    assert_eq!(check(None).unwrap(), HashMap::new());
    assert_eq!(
        folder::hashed_files(),
        hashed,
        "a file it wrote is not read again"
    );
    fs::write(folder.join("Plan.md"), "edited").unwrap();
    assert_eq!(
        check(None).unwrap(),
        HashMap::from([("Plan.md".to_string(), Some(sha256_hex(b"edited")))])
    );
    let paths = ["Plan.md".to_string(), "Missing.md".to_string()];
    assert_eq!(
        check(Some(&paths)).unwrap(),
        HashMap::from([
            ("Plan.md".to_string(), Some(sha256_hex(b"edited"))),
            ("Missing.md".to_string(), None),
        ])
    );
    assert_eq!(
        check(Some(&["../x".to_string()])),
        Err("E_MIRROR_PATHS_INVALID")
    );
    assert_eq!(
        f.mirror.check(opened.generation + 1, None, &f.notify()),
        Err("E_MIRROR_STALE")
    );
}

#[test]
fn hashes_attachments_one_at_a_time_and_leaves_out_missing_ones() {
    let present = "0192a6f0-0000-7000-8000-00000000f001".to_string();
    let missing = "0192a6f0-0000-7000-8000-00000000f002".to_string();
    let mut read = Vec::new();
    let hashes = file_hashes(&[present.clone(), missing.clone()], &mut |id| {
        read.push(id.to_owned());
        (id == present).then(|| b"png bytes".to_vec())
    });
    assert_eq!(
        hashes,
        [FileHash {
            id: present.clone(),
            sha256: sha256_hex(b"png bytes"),
        }]
    );
    assert_eq!(read, [present.clone(), missing]);
    // The IDs are checked before anything is read: few, and UUIDs only.
    assert!(valid_ids(
        std::slice::from_ref(&present),
        MAX_HASH_IDS,
        folder::valid_uuid
    ));
    assert!(!valid_ids(
        &vec![present; MAX_HASH_IDS + 1],
        MAX_HASH_IDS,
        folder::valid_uuid
    ));
    assert!(!valid_ids(
        &["../x".to_string()],
        MAX_HASH_IDS,
        folder::valid_uuid
    ));
    assert_eq!(
        serde_json::to_value(FileHash {
            id: "a".into(),
            sha256: "b".into(),
        })
        .unwrap(),
        json!({ "id": "a", "sha256": "b" })
    );
}

#[test]
fn sends_the_status_with_the_names_the_ui_reads() {
    let f = Fixture::new();
    let status = f.get();
    assert_eq!(
        serde_json::to_value(status).unwrap(),
        json!({
            "revision": 0,
            "generation": 0,
            "folder": null,
            "includeAttachments": true,
            "paused": null,
            "size": null,
            "kept": [],
            "keptCount": 0,
        })
    );
    assert_eq!(
        serde_json::to_value(Choice::Confirm {
            token: 1,
            name: "Docs".into()
        })
        .unwrap(),
        json!({ "kind": "confirm", "token": 1, "name": "Docs" })
    );
}

#[test]
fn shows_folders_under_home_with_a_tilde() {
    let home = Path::new("/Users/someone");
    assert_eq!(
        display(Path::new("/Users/someone/Notes"), Some(home)),
        "~/Notes"
    );
    assert_eq!(display(home, Some(home)), "~");
    assert_eq!(
        display(Path::new("/Volumes/Disk/Notes"), Some(home)),
        "/Volumes/Disk/Notes"
    );
}

/// A folder another library mirrored (app data lost, a second Mac set up on its own) lists
/// notes this library does not have: going on from its manifest would
/// delete them all. It is used only after a confirmation, from an empty
/// manifest, so its files can be taken back but never removed.
#[test]
fn asks_before_using_a_folder_another_library_mirrors_and_removes_none_of_its_files() {
    let theirs = Fixture::new();
    let folder = theirs.folder("Notes");
    theirs.choose(&folder);
    let opened = theirs.open().unwrap();
    theirs.apply(opened.generation, &[note_op("Plan.md", "# Plan\n")]);

    let ours = Fixture::new();
    let Choice::Confirm { token, .. } = ours.choose(&folder) else {
        panic!("another library's manifest needs a confirmation");
    };
    ours.mirror.confirm(token, &ours.notify()).unwrap();
    let manifest = ours.open().unwrap().manifest.unwrap();
    assert!(manifest.notes.is_empty());
    assert_eq!(
        fs::read_to_string(folder.join("Plan.md")).unwrap(),
        "# Plan\n"
    );

    // The library that mirrored it before finds a manifest it did not write.
    let launched = Mirror::new(&theirs.data.join(SETTINGS_FILE), None);
    assert_eq!(
        launched.open(None, &|_| {}),
        Err("E_MIRROR_MANIFEST_FOREIGN")
    );
}

/// A manifest from before manifests named their library: in the folder this
/// mirror already uses it is its own and gets its name; chosen anew it may
/// be anyone's.
#[test]
fn takes_an_unnamed_manifest_as_its_own_only_in_the_folder_it_already_uses() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let mut listed = Manifest::default();
    listed.notes.insert(
        NOTE.into(),
        folder::NoteEntry {
            path: "Plan.md".into(),
            sha256: sha256_hex(b"# Plan\n"),
            size: 7,
            source: "s".into(),
            files: vec![],
        },
    );
    fs::write(folder.join(MANIFEST), folder::manifest_bytes(&listed)).unwrap();
    let opened = f.open().unwrap();
    assert_eq!(opened.manifest.unwrap().notes.len(), 1);
    let stored = folder::parse_manifest(&fs::read(folder.join(MANIFEST)).unwrap()).unwrap();
    assert!(stored.library.is_some());

    let other = f.folder("Other");
    fs::write(other.join(MANIFEST), folder::manifest_bytes(&listed)).unwrap();
    assert!(matches!(f.choose(&other), Choice::Confirm { .. }));
}

#[cfg(unix)]
#[test]
fn writes_back_a_move_whose_rewrite_failed() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let generation = f.open().unwrap().generation;
    f.apply(generation, &[note_op("Work/Plan.md", "# Plan\n")]);
    let home = folder.join("Home");
    fs::create_dir(&home).unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o555)).unwrap();
    let ignored = folder::probe_writable(&folder::Root::open(&home).unwrap()).is_ok();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o755)).unwrap();
    if ignored {
        return; // root ignores permissions
    }
    let locked = home.clone();
    crate::atomic_file::race::at_check(move || {
        crate::atomic_file::race::at_check(move || {
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
        });
    });
    let mut moved = note_op("Home/Spec.md", "# Spec\n");
    moved["from"] = json!("Work/Plan.md");
    let results = f.apply(generation, &[moved]);
    fs::set_permissions(&home, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(results[0].code, Some("E_MIRROR_WRITE_FAILED"));
    let stored = folder::parse_manifest(&fs::read(folder.join(MANIFEST)).unwrap()).unwrap();
    assert_eq!(stored.notes[NOTE].path, "Home/Spec.md");
    assert_eq!(stored.notes[NOTE].sha256, sha256_hex(b"# Plan\n"));
}

#[test]
fn removes_what_a_cut_short_write_left_and_the_folders_it_alone_kept() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let generation = f.open().unwrap().generation;
    f.apply(generation, &[note_op("Work/Plan.md", "# Plan\n")]);
    let hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(60 * 60);
    let left = |rel: &str, modified: std::time::SystemTime| {
        let path = folder.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::File::create(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        path
    };
    let temporary = || crate::atomic_file::temporary_name().into_string().unwrap();
    let stale = [
        left(&format!("Work/{}", temporary()), hour_ago),
        left(&format!("attachments/{}", temporary()), hour_ago),
        left(&format!("Old/Deep/{}", temporary()), hour_ago),
        left(&temporary(), hour_ago),
    ];
    let kept = [
        left(&temporary(), std::time::SystemTime::now()),
        left("Work/.devot-mine.tmp", hour_ago),
    ];
    let user_folder = folder.join("Empty");
    fs::create_dir(&user_folder).unwrap();

    let relaunched = Mirror::new(&f.data.join(SETTINGS_FILE), Some(f.data.clone()));
    relaunched.open(None, &f.notify()).unwrap();

    for path in &stale {
        assert!(!path.exists(), "{}", path.display());
    }
    for path in &kept {
        assert!(path.exists(), "{}", path.display());
    }
    assert!(!folder.join("Old").exists());
    assert!(folder.join("Work/Plan.md").is_file());
    assert!(user_folder.is_dir());
}

const FILE: &str = "0192a6f0-0000-7000-8000-0000000000f1";
const WAIT: std::time::Duration = std::time::Duration::from_secs(10);

fn file_op(name: &str) -> Value {
    json!({ "kind": "file", "id": FILE, "path": format!("attachments/{name}"), "copy": true })
}

/// Starts a batch on another thread and returns once it is inside its first attachment read, where
/// it stays until the sender is dropped.
fn hold<'scope>(
    scope: &'scope std::thread::Scope<'scope, '_>,
    mirror: &'scope Mirror,
    generation: u64,
    ops: &'scope [Value],
) -> (
    std::thread::ScopedJoinHandle<'scope, Result<Vec<OpResult>, &'static str>>,
    std::sync::mpsc::Sender<()>,
) {
    let (started, reading) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel::<()>();
    let batch = scope.spawn(move || {
        let mut load = |_: &str| {
            let _ = started.send(());
            let _ = released.recv();
            Some(b"bytes".to_vec())
        };
        mirror.apply(generation, ops, &mut load, &|_| {})
    });
    reading
        .recv_timeout(WAIT)
        .expect("the batch reads its attachment");
    (batch, release)
}

/// What `call` returns, unless it is still waiting after `WAIT`.
fn soon<'scope, T: Send + 'scope>(
    scope: &'scope std::thread::Scope<'scope, '_>,
    call: impl FnOnce() -> T + Send + 'scope,
) -> Option<T> {
    let (sent, got) = std::sync::mpsc::channel();
    scope.spawn(move || {
        let _ = sent.send(call());
    });
    got.recv_timeout(WAIT).ok()
}

#[test]
fn answers_status_and_setting_calls_while_a_batch_reads_an_attachment() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let generation = f.open().unwrap().generation;
    let mirror = &f.mirror;
    let ops = [file_op("a.png")];
    std::thread::scope(|scope| {
        let (batch, release) = hold(scope, mirror, generation, &ops);
        let status = soon(scope, || mirror.get(&|_| {}));
        let set = soon(scope, || {
            mirror.set(&patch(json!({ "dismissKept": true })), &|_| {})
        });
        drop(release);
        assert!(status.is_some_and(|s| s.is_ok()), "the status waited");
        assert!(set.is_some_and(|s| s.is_ok()), "the setting waited");
        assert_eq!(batch.join().unwrap().unwrap()[0].code, None);
    });
    assert!(folder.join("attachments/a.png").is_file());
    assert!(f.open().unwrap().manifest.unwrap().files.contains_key(FILE));
}

#[test]
fn runs_one_batch_at_a_time() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let generation = f.open().unwrap().generation;
    let mirror = &f.mirror;
    let first_ops = [file_op("a.png")];
    let second_ops = [note_op("Plan.md", "one")];
    std::thread::scope(|scope| {
        let (first, release) = hold(scope, mirror, generation, &first_ops);
        let (finished, done) = std::sync::mpsc::channel();
        let second = scope.spawn(move || {
            let results = mirror.apply(generation, &second_ops, &mut |_| None, &|_| {});
            let _ = finished.send(());
            results
        });
        let waited = done
            .recv_timeout(std::time::Duration::from_millis(300))
            .is_err();
        assert!(!folder.join("Plan.md").exists());
        drop(release);
        assert!(waited, "the second batch ran beside the first");
        assert_eq!(first.join().unwrap().unwrap()[0].code, None);
        assert_eq!(second.join().unwrap().unwrap()[0].code, None);
    });
    // The second batch went on from the manifest the first left.
    let manifest = f.open().unwrap().manifest.unwrap();
    assert!(manifest.files.contains_key(FILE));
    assert!(manifest.notes.contains_key(NOTE));
    let stored = folder::parse_manifest(&fs::read(folder.join(MANIFEST)).unwrap()).unwrap();
    assert_eq!(stored, manifest);
}

#[test]
fn a_batch_the_mirror_is_turned_off_under_stops_and_records_nothing() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let generation = f.open().unwrap().generation;
    let mirror = &f.mirror;
    let ops = [file_op("a.png"), note_op("Plan.md", "one")];
    let result = std::thread::scope(|scope| {
        let (batch, release) = hold(scope, mirror, generation, &ops);
        let off = soon(scope, || {
            mirror.set(&patch(json!({ "turnOff": true })), &|_| {})
        });
        drop(release);
        assert_eq!(off.expect("turning off waited").unwrap().folder, None);
        batch.join().unwrap()
    });
    assert_eq!(result, Err("E_MIRROR_STALE"));
    let status = f.get();
    assert_eq!(status.folder, None);
    assert_eq!(status.size, None);
    assert_eq!(status.paused, None);
    // The operation under way finished, the next never ran, and the folder's
    // own manifest lists what was written there.
    assert!(folder.join("attachments/a.png").is_file());
    assert!(!folder.join("Plan.md").exists());
    let stored = folder::parse_manifest(&fs::read(folder.join(MANIFEST)).unwrap()).unwrap();
    assert!(stored.files.contains_key(FILE));
    assert!(matches!(f.choose(&folder), Choice::Chosen { .. }));
    assert!(f.open().unwrap().manifest.unwrap().files.contains_key(FILE));
}

#[test]
fn a_batch_the_mirror_is_turned_off_under_keeps_a_manifest_it_could_not_write() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let generation = f.open().unwrap().generation;
    let older = fs::read(folder.join(MANIFEST)).unwrap();
    let mirror = &f.mirror;
    let ops = [file_op("a.png")];
    let result = std::thread::scope(|scope| {
        let (batch, release) = hold(scope, mirror, generation, &ops);
        fs::remove_file(folder.join(MANIFEST)).unwrap();
        fs::create_dir(folder.join(MANIFEST)).unwrap();
        let off = soon(scope, || {
            mirror.set(&patch(json!({ "turnOff": true })), &|_| {})
        });
        assert!(off.is_some(), "turning off waited");
        drop(release);
        batch.join().unwrap()
    });
    assert_eq!(result, Err("E_MIRROR_STALE"));
    fs::remove_dir(folder.join(MANIFEST)).unwrap();
    fs::write(folder.join(MANIFEST), older).unwrap();
    assert!(matches!(f.choose(&folder), Choice::Chosen { .. }));
    assert!(f.open().unwrap().manifest.unwrap().files.contains_key(FILE));
    let stored = folder::parse_manifest(&fs::read(folder.join(MANIFEST)).unwrap()).unwrap();
    assert!(stored.files.contains_key(FILE));
}

#[test]
fn at_quit_waits_for_a_batch_to_write_back_its_manifest_first() {
    let f = Fixture::new();
    let (folder, _, generation) = pause_with_a_move_unsaved(&f);
    let mirror = &f.mirror;
    let ops = [file_op("a.png")];
    std::thread::scope(|scope| {
        let (batch, release) = hold(scope, mirror, generation, &ops);
        let (flushed, done) = std::sync::mpsc::channel();
        scope.spawn(move || {
            mirror.flush(WAIT);
            let _ = flushed.send(());
        });
        let waited = done
            .recv_timeout(std::time::Duration::from_millis(300))
            .is_err();
        drop(release);
        assert!(waited, "quit wrote the folder beside a batch");
        assert_eq!(batch.join().unwrap().unwrap()[0].code, None);
        done.recv_timeout(WAIT).expect("quit waited on");
    });
    let stored = folder::parse_manifest(&fs::read(folder.join(MANIFEST)).unwrap()).unwrap();
    assert_eq!(stored.notes[NOTE].path, "Moved.md");
    assert!(stored.files.contains_key(FILE));
}

#[test]
fn at_quit_leaves_a_batch_that_outlasts_the_limit_to_finish_alone() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let generation = f.open().unwrap().generation;
    let mirror = &f.mirror;
    let ops = [file_op("a.png")];
    std::thread::scope(|scope| {
        let (batch, release) = hold(scope, mirror, generation, &ops);
        let flushed = soon(scope, || mirror.flush(std::time::Duration::from_millis(50)));
        drop(release);
        assert!(flushed.is_some(), "quit waited past its limit");
        assert_eq!(batch.join().unwrap().unwrap()[0].code, None);
    });
    let stored = folder::parse_manifest(&fs::read(folder.join(MANIFEST)).unwrap()).unwrap();
    assert!(stored.files.contains_key(FILE));
}

#[test]
fn a_batch_under_a_folder_chosen_since_leaves_the_new_folder_alone() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    let other = f.folder("Other");
    f.choose(&folder);
    let generation = f.open().unwrap().generation;
    f.apply(generation, &[note_op("Plan.md", "one")]);
    fs::write(folder.join("Plan.md"), "edited").unwrap();
    let mirror = &f.mirror;
    let ops = [
        json!({ "kind": "keep", "entry": "note", "id": NOTE, "path": "Plan.md" }),
        file_op("a.png"),
    ];
    let result = std::thread::scope(|scope| {
        let (batch, release) = hold(scope, mirror, generation, &ops);
        let chosen = soon(scope, || mirror.choose(&other, &|_| {}));
        drop(release);
        assert!(matches!(
            chosen.expect("choosing waited"),
            Ok(Choice::Chosen { .. })
        ));
        batch.join().unwrap()
    });
    assert_eq!(result, Err("E_MIRROR_STALE"));
    let status = f.get();
    assert_eq!(status.folder.as_deref(), Some("~/Other"));
    assert_eq!(status.size, None);
    assert_eq!(status.kept_count, 0);
    assert!(status.kept.is_empty());
    assert_eq!(status.paused, None);
    let manifest = f.open().unwrap().manifest.unwrap();
    assert!(manifest.notes.is_empty() && manifest.files.is_empty());
    let names: Vec<_> = fs::read_dir(&other)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, [MANIFEST]);
    assert!(folder.join("Plan (edited outside Devot).md").is_file());
}

#[test]
fn a_batch_keeps_its_results_when_include_attachments_changes_under_it() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let generation = f.open().unwrap().generation;
    let mirror = &f.mirror;
    let ops = [file_op("a.png")];
    let result = std::thread::scope(|scope| {
        let (batch, release) = hold(scope, mirror, generation, &ops);
        let set = soon(scope, || {
            mirror.set(&patch(json!({ "includeAttachments": false })), &|_| {})
        });
        drop(release);
        assert!(set.is_some_and(|s| s.is_ok()), "the setting waited");
        batch.join().unwrap()
    });
    assert_eq!(result.unwrap()[0].code, None);
    let opened = f.open().unwrap();
    assert_ne!(opened.generation, generation);
    assert!(opened.manifest.unwrap().files.contains_key(FILE));
}

#[test]
fn a_batch_that_panics_leaves_the_mirror_working() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let generation = f.open().unwrap().generation;
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        f.mirror.apply(
            generation,
            &[file_op("a.png")],
            &mut |_| panic!("read"),
            &|_| {},
        )
    }));
    assert!(caught.is_err());
    assert_eq!(f.get().paused, None);
    assert_eq!(
        f.apply(generation, &[note_op("Plan.md", "one")])[0].code,
        None
    );
    assert!(folder.join("Plan.md").is_file());
}
