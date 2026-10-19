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
    let status = f.mirror.get().unwrap();
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
        again.get().unwrap().folder.as_deref(),
        Some(folder.to_str().unwrap())
    );
    let opened = f.open().unwrap();
    assert_eq!(opened.manifest, Some(Manifest::default()));
    assert!(folder.join(MANIFEST).is_file());
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
    assert_eq!(
        f.mirror.get().unwrap().folder,
        None,
        "not used before it is confirmed"
    );
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
    fs::write(
        other.join(MANIFEST),
        folder::manifest_bytes(&Manifest::default()),
    )
    .unwrap();
    assert!(matches!(f.choose(&other), Choice::Chosen { .. }));
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
    let before = f.mirror.get().unwrap();
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
    assert_eq!(again.get().unwrap().folder, None);
    assert!(!again.get().unwrap().include_attachments);
}

#[test]
fn reads_a_damaged_setting_as_off() {
    let f = Fixture::new();
    fs::write(f.data.join(SETTINGS_FILE), b"{ not json").unwrap();
    assert_eq!(f.mirror.get().unwrap().folder, None);
    let g = Fixture::new();
    fs::write(
        g.data.join(SETTINGS_FILE),
        serde_json::to_vec(&json!({ "folder": "relative/path", "includeAttachments": 3 })).unwrap(),
    )
    .unwrap();
    let status = g.mirror.get().unwrap();
    assert_eq!(status.folder, None);
    assert!(status.include_attachments);
}

#[test]
fn pauses_when_the_folder_goes_and_resumes_with_the_manifest_read_again() {
    let f = Fixture::new();
    let folder = f.folder("Notes");
    f.choose(&folder);
    let opened = f.open().unwrap();
    let results = f.apply(opened.generation, &[note_op("Plan.md", "# Plan\n")]);
    assert_eq!(results[0].code, None);
    assert_eq!(f.mirror.get().unwrap().size, Some(7));

    let away = f.data.join("away");
    fs::rename(&folder, &away).unwrap();
    assert_eq!(f.open(), Err("E_MIRROR_FOLDER_MISSING"));
    assert_eq!(
        f.mirror.get().unwrap().paused,
        Some("E_MIRROR_FOLDER_MISSING")
    );
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
    assert_eq!(f.mirror.get().unwrap().paused, None);
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
    assert_eq!(f.mirror.get().unwrap().size, Some(7));
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
    assert_eq!(launched.get().unwrap().size, None);
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
    assert_eq!(f.open().unwrap().manifest, Some(Manifest::default()));
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
    let status = f.mirror.get().unwrap();
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
    let status = f.mirror.get().unwrap();
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
    assert_eq!(
        f.mirror.get().unwrap().paused,
        Some("E_MIRROR_FOLDER_READ_ONLY")
    );
    // Resuming writes what memory holds, never the older file.
    fs::remove_dir(folder.join(MANIFEST)).unwrap();
    let resumed = f.open().unwrap();
    assert_eq!(resumed.manifest.unwrap().notes[NOTE].path, "Moved.md");
    let stored = folder::parse_manifest(&fs::read(folder.join(MANIFEST)).unwrap()).unwrap();
    assert_eq!(stored.notes[NOTE].path, "Moved.md");
    assert_eq!(f.mirror.get().unwrap().paused, None);
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
    assert_eq!(check(None).unwrap(), HashMap::new());
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
    let status = f.mirror.get().unwrap();
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
