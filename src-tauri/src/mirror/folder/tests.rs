use super::*;
use std::fs;

const NOTE: &str = "0192a6f0-0000-7000-8000-000000000001";
const OTHER_NOTE: &str = "0192a6f0-0000-7000-8000-000000000002";
const FILE: &str = "0192a6f0-0000-7000-8000-00000000f001";
const BOOK: &str = "0192a6f0-0000-7000-8000-00000000b001";
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

fn read(root: &Path, rel: &str) -> String {
    fs::read_to_string(root.join(rel)).unwrap()
}

fn write_text(root: &Path, rel: &str, text: &str) {
    if let Some(parent) = root.join(rel).parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(root.join(rel), text).unwrap();
}

fn put(id: &str, path: &str, from: Option<&str>, text: &str) -> Op {
    Op::Note {
        id: id.into(),
        path: path.into(),
        from: from.map(String::from),
        sha256: sha256_hex(text.as_bytes()),
        text: Some(text.into()),
        source: "s1".into(),
        files: vec![],
    }
}

fn no_files() -> impl FnMut(&str) -> Option<Vec<u8>> {
    |_| None
}

fn open(root: &Path) -> Root {
    Root::open(&fs::canonicalize(root).unwrap()).unwrap()
}

fn at<'a>(root: &Root, rel: &'a str) -> At<'a> {
    find(root, rel).unwrap()
}

fn apply(root: &Path, manifest: &mut Manifest, op: &Op) -> OpResult {
    apply_in(&open(root), manifest, op)
}

fn apply_in(root: &Root, manifest: &mut Manifest, op: &Op) -> OpResult {
    run(root, manifest, op, &mut |id| {
        (id == FILE).then(|| PNG.to_vec())
    })
}

fn tree(root: &Path) -> Vec<String> {
    fn walk(root: &Path, rel: &str, out: &mut Vec<String>) {
        let mut names: Vec<_> = fs::read_dir(root.join(rel))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().into_string().unwrap())
            .collect();
        names.sort();
        for name in names {
            let path = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            if root.join(&path).is_dir() {
                out.push(format!("{path}/"));
                walk(root, &path, out);
            } else {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, "", &mut out);
    out
}

#[test]
fn checks_every_path_it_is_given() {
    for good in [
        "Plan.md",
        "Work/Deep/Plan 2.md",
        "Attach/a.md",
        "attachments 2/x.md",
    ] {
        assert!(valid_note_path(good), "{good}");
    }
    for bad in [
        "",
        "Plan.txt",
        "../Plan.md",
        "/Plan.md",
        "a//Plan.md",
        ".hidden.md",
        "Work/.git/x.md",
        "attachments/Plan.md",
        "Attachments/Plan.md",
        "a\\b.md",
        "a:b.md",
        "a\nb.md",
    ] {
        assert!(!valid_note_path(bad), "{bad:?}");
    }
    assert!(valid_file_path("attachments/board.png"));
    assert!(valid_file_path("attachments/noext"));
    for bad in [
        "attachments",
        "attachments/",
        "attachments/a/b.png",
        "Attachments/b.png",
        "board.png",
        "attachments/.hidden",
        "attachments/../x.png",
    ] {
        assert!(!valid_file_path(bad), "{bad:?}");
    }
    assert!(valid_sha256(&sha256_hex(b"x")));
    assert!(!valid_sha256("ABC"));
    assert!(!valid_sha256(&sha256_hex(b"x").to_uppercase()));
}

#[test]
fn hashes_like_the_core() {
    // The same vectors as tests/core/sha256.test.ts.
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn reports_what_is_on_disk_without_following_links() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_text(root, "Work/Plan.md", "plan");
    let disk_state = |rel| disk_state(&open(root), rel);
    assert_eq!(disk_state("Work/Plan.md"), Some(sha256_hex(b"plan")));
    assert_eq!(disk_state("Work"), Some(DIR.into()));
    assert_eq!(disk_state("Work/Missing.md"), None);
    assert_eq!(disk_state("Missing/Plan.md"), None);
    assert_eq!(disk_state("Work/Plan.md/x.md"), Some(OTHER.into()));
    #[cfg(unix)]
    {
        let elsewhere = tempfile::tempdir().unwrap();
        write_text(elsewhere.path(), "Plan.md", "theirs");
        std::os::unix::fs::symlink(elsewhere.path(), root.join("Linked")).unwrap();
        std::os::unix::fs::symlink(elsewhere.path().join("Plan.md"), root.join("Link.md")).unwrap();
        assert_eq!(disk_state("Linked"), Some(OTHER.into()));
        assert_eq!(disk_state("Linked/Plan.md"), Some(OTHER.into()));
        assert_eq!(disk_state("Link.md"), Some(OTHER.into()));
    }
}

#[test]
fn writes_a_new_note_and_records_it() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut manifest = Manifest::default();
    let result = apply(
        root,
        &mut manifest,
        &put(NOTE, "Work/Deep/Plan.md", None, "# Plan\n"),
    );
    assert_eq!(result, OpResult::sized(7));
    assert_eq!(read(root, "Work/Deep/Plan.md"), "# Plan\n");
    let entry = &manifest.notes[NOTE];
    assert_eq!(entry.path, "Work/Deep/Plan.md");
    assert_eq!(entry.sha256, sha256_hex(b"# Plan\n"));
    assert_eq!(entry.size, 7);
    assert_eq!(tree(root), ["Work/", "Work/Deep/", "Work/Deep/Plan.md"]);
}

#[test]
fn never_replaces_a_file_it_did_not_write_unless_it_holds_the_same() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_text(root, "Plan.md", "theirs");
    let mut manifest = Manifest::default();
    let result = apply(root, &mut manifest, &put(NOTE, "Plan.md", None, "mine"));
    assert_eq!(result.code, Some("E_MIRROR_EXISTS"));
    assert_eq!(result.path.as_deref(), Some("Plan.md"));
    assert_eq!(result.state, Some(Some(sha256_hex(b"theirs"))));
    assert_eq!(read(root, "Plan.md"), "theirs");
    assert!(manifest.notes.is_empty());
    let result = apply(root, &mut manifest, &put(NOTE, "Plan.md", None, "theirs"));
    assert_eq!(result.code, None);
    assert_eq!(manifest.notes[NOTE].path, "Plan.md");
    // The plan sends no text for one it knows holds it (a file a batch
    // wrote before its manifest was saved): taken as it is, or refused.
    let unsent = |path: &str, text: &str| match put(OTHER_NOTE, path, None, text) {
        Op::Note {
            id,
            path,
            from,
            sha256,
            source,
            files,
            ..
        } => Op::Note {
            id,
            path,
            from,
            sha256,
            text: None,
            source,
            files,
        },
        _ => unreachable!(),
    };
    write_text(root, "Kept.md", "devot");
    assert_eq!(
        apply(root, &mut manifest, &unsent("Kept.md", "other")).code,
        Some("E_MIRROR_EXISTS")
    );
    assert_eq!(
        apply(root, &mut manifest, &unsent("Kept.md", "devot")).code,
        None
    );
    assert_eq!(manifest.notes[OTHER_NOTE].path, "Kept.md");
    assert_eq!(read(root, "Kept.md"), "devot");
    manifest.notes.remove(OTHER_NOTE);
    write_text(root, "Work", "a file");
    let result = apply(
        root,
        &mut manifest,
        &put(OTHER_NOTE, "Work/Plan.md", None, "x"),
    );
    assert_eq!(result.code, Some("E_MIRROR_EXISTS"));
    assert_eq!(result.path.as_deref(), Some("Work"));
    assert_eq!(read(root, "Work"), "a file");
}

#[test]
fn rewrites_moves_and_removes_only_what_still_holds_what_it_wrote() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut manifest = Manifest::default();
    apply(root, &mut manifest, &put(NOTE, "Work/Plan.md", None, "one"));
    let result = apply(
        root,
        &mut manifest,
        &put(NOTE, "Work/Plan.md", Some("Work/Plan.md"), "two"),
    );
    assert_eq!(result.code, None);
    assert_eq!(read(root, "Work/Plan.md"), "two");
    let result = apply(
        root,
        &mut manifest,
        &put(NOTE, "Home/Plan.md", Some("Work/Plan.md"), "three"),
    );
    assert_eq!(result.code, None);
    assert_eq!(tree(root), ["Home/", "Home/Plan.md"]);
    assert_eq!(read(root, "Home/Plan.md"), "three");
    let same = Op::Note {
        id: NOTE.into(),
        path: "Plan.md".into(),
        from: Some("Home/Plan.md".into()),
        sha256: sha256_hex(b"three"),
        text: None,
        source: "s2".into(),
        files: vec![],
    };
    assert_eq!(apply(root, &mut manifest, &same).code, None);
    assert_eq!(tree(root), ["Plan.md"]);
    assert_eq!(manifest.notes[NOTE].source, "s2");
    write_text(root, "Kept/theirs.txt", "theirs");
    apply(
        root,
        &mut manifest,
        &put(NOTE, "Kept/Plan.md", Some("Plan.md"), "four"),
    );
    let remove = Op::Remove {
        entry: EntryKind::Note,
        id: NOTE.into(),
        path: "Kept/Plan.md".into(),
        sha256: sha256_hex(b"four"),
    };
    assert_eq!(apply(root, &mut manifest, &remove).code, None);
    assert_eq!(tree(root), ["Kept/", "Kept/theirs.txt"]);
    assert!(manifest.notes.is_empty());
}

#[test]
fn refuses_to_touch_a_file_changed_outside_devot_and_keeps_it_aside() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut manifest = Manifest::default();
    apply(root, &mut manifest, &put(NOTE, "Plan.md", None, "devot"));
    write_text(root, "Plan.md", "edited outside");
    let edited = Some(Some(sha256_hex(b"edited outside")));
    for op in [
        put(NOTE, "Plan.md", Some("Plan.md"), "devot 2"),
        put(NOTE, "Moved.md", Some("Plan.md"), "devot 2"),
        Op::Remove {
            entry: EntryKind::Note,
            id: NOTE.into(),
            path: "Plan.md".into(),
            sha256: sha256_hex(b"devot"),
        },
    ] {
        let result = apply(root, &mut manifest, &op);
        assert_eq!(result.code, Some("E_MIRROR_CHANGED"), "{op:?}");
        assert_eq!(result.state, edited);
    }
    assert_eq!(read(root, "Plan.md"), "edited outside");
    let keep = Op::Keep {
        entry: EntryKind::Note,
        id: NOTE.into(),
        path: "Plan.md".into(),
    };
    let result = apply(root, &mut manifest, &keep);
    assert_eq!(
        result.kept.as_deref(),
        Some("Plan (edited outside Devot).md")
    );
    assert!(manifest.notes.is_empty());
    assert_eq!(
        apply(root, &mut manifest, &put(NOTE, "Plan.md", None, "devot 2")).code,
        None
    );
    assert_eq!(
        read(root, "Plan (edited outside Devot).md"),
        "edited outside"
    );
    assert_eq!(read(root, "Plan.md"), "devot 2");
    write_text(root, "Plan.md", "edited again");
    let result = apply(root, &mut manifest, &keep);
    assert_eq!(
        result.kept.as_deref(),
        Some("Plan (edited outside Devot) 2.md")
    );
    assert_eq!(
        read(root, "Plan (edited outside Devot).md"),
        "edited outside"
    );
    assert_eq!(
        read(root, "Plan (edited outside Devot) 2.md"),
        "edited again"
    );
}

#[test]
fn keeps_nothing_that_turns_out_unchanged_and_moves_nothing_it_cannot_finish() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut manifest = Manifest::default();
    apply(root, &mut manifest, &put(NOTE, "Plan.md", None, "devot"));
    // The plan thought it edited; it is Devot's own text: nothing is renamed.
    let keep = Op::Keep {
        entry: EntryKind::Note,
        id: NOTE.into(),
        path: "Plan.md".into(),
    };
    let result = apply(root, &mut manifest, &keep);
    assert_eq!(result.code, Some("E_MIRROR_CHANGED"));
    assert_eq!(result.state, Some(Some(sha256_hex(b"devot"))));
    assert_eq!(tree(root), ["Plan.md"]);
    assert!(manifest.notes.contains_key(NOTE));
    let textless = Op::Note {
        id: NOTE.into(),
        path: "Moved.md".into(),
        from: Some("Plan.md".into()),
        sha256: sha256_hex(b"new"),
        text: None,
        source: "s".into(),
        files: vec![],
    };
    assert_eq!(
        apply(root, &mut manifest, &textless).code,
        Some("E_MIRROR_CHANGED")
    );
    assert_eq!(tree(root), ["Plan.md"]);
    assert_eq!(manifest.notes[NOTE].path, "Plan.md");
}

#[test]
fn a_file_or_folder_it_cannot_write_waits_without_pausing_the_mirror() {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut manifest = Manifest::default();
        apply(root, &mut manifest, &put(NOTE, "Work/Plan.md", None, "one"));
        // A locked folder inside the mirror; the mirror's own folder is fine.
        fs::set_permissions(root.join("Work"), fs::Permissions::from_mode(0o555)).unwrap();
        let result = apply(
            root,
            &mut manifest,
            &put(NOTE, "Work/Plan.md", Some("Work/Plan.md"), "two"),
        );
        fs::set_permissions(root.join("Work"), fs::Permissions::from_mode(0o755)).unwrap();
        // Root ignores permissions: then the write went through.
        if result.code.is_some() {
            assert_eq!(result.code, Some("E_MIRROR_WRITE_FAILED"));
            assert!(!result.pauses());
            assert_eq!(read(root, "Work/Plan.md"), "one");
        }
    }
}

#[cfg(unix)]
#[test]
fn a_move_out_of_a_folder_it_cannot_change_moves_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut manifest = Manifest::default();
    apply(root, &mut manifest, &put(NOTE, "Work/Plan.md", None, "one"));
    // The notebook's folder is locked (in Finder, say); the one the note
    // moves to is not.
    fs::set_permissions(root.join("Work"), fs::Permissions::from_mode(0o555)).unwrap();
    // Root ignores permissions: then there is nothing to see.
    if probe_writable(&open(&root.join("Work"))).is_ok() {
        return;
    }
    let moved = apply(
        root,
        &mut manifest,
        &put(NOTE, "Home/Plan.md", Some("Work/Plan.md"), "one"),
    );
    fs::set_permissions(root.join("Work"), fs::Permissions::from_mode(0o755)).unwrap();
    // Nothing moved: no second file holds the note, the manifest keeps its
    // place, and the plan tries again later.
    assert_eq!(moved.code, Some("E_MIRROR_WRITE_FAILED"));
    assert!(!moved.pauses());
    assert_eq!(read(root, "Work/Plan.md"), "one");
    assert!(fs::symlink_metadata(root.join("Home/Plan.md")).is_err());
    assert_eq!(manifest.notes[NOTE].path, "Work/Plan.md");
}

#[test]
fn a_note_may_link_to_any_uuid() {
    assert!(valid_uuid("123e4567-e89b-42d3-a456-426614174000"));
    assert!(valid_uuid(FILE));
    for bad in [
        "",
        "x",
        "123E4567-E89B-42D3-A456-426614174000",
        "123e4567e89b42d3a456426614174000",
    ] {
        assert!(!valid_uuid(bad), "{bad:?}");
    }
    let dir = tempfile::tempdir().unwrap();
    let mut manifest = Manifest::default();
    let op = Op::Note {
        id: NOTE.into(),
        path: "Plan.md".into(),
        from: None,
        sha256: sha256_hex(b"x"),
        text: Some("x".into()),
        source: "s".into(),
        files: vec!["123e4567-e89b-42d3-a456-426614174000".into()],
    };
    assert_eq!(apply(dir.path(), &mut manifest, &op).code, None);
}

#[test]
fn names_kept_files_after_the_original_in_its_folder() {
    assert_eq!(kept_name("Plan.md", 1), "Plan (edited outside Devot).md");
    assert_eq!(kept_name("Plan.md", 3), "Plan (edited outside Devot) 3.md");
    assert_eq!(
        kept_name("board.png", 2),
        "board (edited outside Devot) 2.png"
    );
    assert_eq!(kept_name("noext", 1), "noext (edited outside Devot)");
}

#[test]
fn a_file_gone_or_replaced_by_a_folder_is_only_forgotten() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut manifest = Manifest::default();
    apply(root, &mut manifest, &put(NOTE, "Plan.md", None, "devot"));
    apply(
        root,
        &mut manifest,
        &put(OTHER_NOTE, "Other.md", None, "devot"),
    );
    fs::remove_file(root.join("Plan.md")).unwrap();
    fs::remove_file(root.join("Other.md")).unwrap();
    fs::create_dir(root.join("Other.md")).unwrap();
    let remove = |id: &str, path: &str| Op::Remove {
        entry: EntryKind::Note,
        id: id.into(),
        path: path.into(),
        sha256: sha256_hex(b"devot"),
    };
    assert_eq!(
        apply(root, &mut manifest, &remove(NOTE, "Plan.md")).code,
        None
    );
    let keep = Op::Keep {
        entry: EntryKind::Note,
        id: OTHER_NOTE.into(),
        path: "Other.md".into(),
    };
    assert_eq!(apply(root, &mut manifest, &keep), OpResult::default());
    assert!(manifest.notes.is_empty());
    assert!(root.join("Other.md").is_dir());
}

#[test]
fn a_note_whose_file_is_gone_is_written_again_and_one_that_reappeared_is_not() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut manifest = Manifest::default();
    apply(root, &mut manifest, &put(NOTE, "Plan.md", None, "devot"));
    fs::remove_file(root.join("Plan.md")).unwrap();
    assert_eq!(
        apply(
            root,
            &mut manifest,
            &put(NOTE, "Plan.md", Some("Plan.md"), "devot 2")
        )
        .code,
        None
    );
    assert_eq!(read(root, "Plan.md"), "devot 2");
    // The plan believes the old file gone, but it is there: nothing happens.
    let result = apply(
        root,
        &mut manifest,
        &put(NOTE, "Elsewhere.md", None, "devot 3"),
    );
    assert_eq!(result.code, Some("E_MIRROR_CHANGED"));
    assert_eq!(result.path.as_deref(), Some("Plan.md"));
    assert!(!root.join("Elsewhere.md").exists());
}

#[test]
fn checks_the_plan_against_the_manifest_and_the_text_against_its_hash() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut manifest = Manifest::default();
    let result = apply(
        root,
        &mut manifest,
        &put(NOTE, "Plan.md", Some("Other.md"), "x"),
    );
    assert_eq!(result.code, Some("E_MIRROR_STALE"));
    let wrong = Op::Note {
        id: NOTE.into(),
        path: "Plan.md".into(),
        from: None,
        sha256: sha256_hex(b"something else"),
        text: Some("x".into()),
        source: "s".into(),
        files: vec![],
    };
    assert_eq!(
        apply(root, &mut manifest, &wrong).code,
        Some("E_MIRROR_HASH_MISMATCH")
    );
    for bad in [
        put("not-an-id", "Plan.md", None, "x"),
        put(NOTE, "../Plan.md", None, "x"),
        put(NOTE, "attachments/Plan.md", None, "x"),
        put(NOTE, "Plan.md", Some(".hidden.md"), "x"),
        Op::File {
            id: FILE.into(),
            path: "Work/board.png".into(),
            copy: true,
        },
        Op::Book {
            id: BOOK.into(),
            path: Some("../x".into()),
        },
        Op::Remove {
            entry: EntryKind::File,
            id: FILE.into(),
            path: "attachments/a.png".into(),
            sha256: "nope".into(),
        },
    ] {
        assert_eq!(
            apply(root, &mut manifest, &bad).code,
            Some("E_MIRROR_OP_INVALID"),
            "{bad:?}"
        );
    }
    assert_eq!(tree(root), Vec::<String>::new());
    let remove = Op::Remove {
        entry: EntryKind::Note,
        id: NOTE.into(),
        path: "Plan.md".into(),
        sha256: sha256_hex(b"x"),
    };
    assert_eq!(
        apply(root, &mut manifest, &remove).code,
        Some("E_MIRROR_STALE")
    );
}

#[test]
fn copies_attachments_once_and_keeps_only_names_when_copies_are_off() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut manifest = Manifest::default();
    let copy = Op::File {
        id: FILE.into(),
        path: "attachments/board.png".into(),
        copy: true,
    };
    let result = apply(root, &mut manifest, &copy);
    assert_eq!(result.sha256, Some(Some(sha256_hex(PNG))));
    assert_eq!(fs::read(root.join("attachments/board.png")).unwrap(), PNG);
    assert_eq!(manifest.size(), PNG.len() as u64);
    assert_eq!(
        apply(root, &mut manifest, &copy).code,
        Some("E_MIRROR_STALE")
    );
    let remove = Op::Remove {
        entry: EntryKind::File,
        id: FILE.into(),
        path: "attachments/board.png".into(),
        sha256: sha256_hex(PNG),
    };
    assert_eq!(apply(root, &mut manifest, &remove).code, None);
    let name = Op::File {
        id: FILE.into(),
        path: "attachments/board.png".into(),
        copy: false,
    };
    assert_eq!(apply(root, &mut manifest, &name).code, None);
    assert_eq!(tree(root), Vec::<String>::new());
    assert_eq!(manifest.files[FILE].sha256, None);
    assert_eq!(manifest.size(), 0);
    write_text(root, "attachments/board.png", "theirs");
    assert_eq!(
        apply(root, &mut manifest, &copy).code,
        Some("E_MIRROR_EXISTS")
    );
    assert_eq!(read(root, "attachments/board.png"), "theirs");
    // A copy the manifest does not list (its batch's manifest was never
    // saved) is taken back as it is.
    fs::write(root.join("attachments/board.png"), PNG).unwrap();
    let mut unlisted = Manifest::default();
    assert_eq!(apply(root, &mut unlisted, &copy).code, None);
    assert_eq!(unlisted.files[FILE].sha256, Some(sha256_hex(PNG)));
    assert_eq!(fs::read(root.join("attachments/board.png")).unwrap(), PNG);
    let gone = Op::File {
        id: OTHER_NOTE.into(),
        path: "attachments/gone.png".into(),
        copy: true,
    };
    assert_eq!(
        run(&open(root), &mut manifest, &gone, &mut no_files()).code,
        Some("E_FILE_NOT_FOUND")
    );
}

#[test]
fn never_writes_through_a_link() {
    #[cfg(unix)]
    {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let elsewhere = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), root.join("Work")).unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), root.join(ATTACHMENTS)).unwrap();
        let mut manifest = Manifest::default();
        let result = apply(root, &mut manifest, &put(NOTE, "Work/Plan.md", None, "x"));
        assert_eq!(result.code, Some("E_MIRROR_EXISTS"));
        assert_eq!(result.path.as_deref(), Some("Work"));
        let copy = Op::File {
            id: FILE.into(),
            path: "attachments/board.png".into(),
            copy: true,
        };
        assert_eq!(
            apply(root, &mut manifest, &copy).code,
            Some("E_MIRROR_EXISTS")
        );
        assert_eq!(fs::read_dir(elsewhere.path()).unwrap().count(), 0);
    }
}

/// A folder outside the mirror holding one file, `theirs.txt`, which links
/// planted in the mirror point at (or, dangling, at `new.txt`, not there):
/// nothing may reach it through them.
#[cfg(unix)]
struct Outside {
    dir: tempfile::TempDir,
}

#[cfg(unix)]
impl Outside {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("theirs.txt"), "theirs").unwrap();
        Self { dir }
    }

    fn plant(&self, root: &Path, rel: &str, dangling: bool) {
        let target = self
            .dir
            .path()
            .join(if dangling { "new.txt" } else { "theirs.txt" });
        std::os::unix::fs::symlink(target, root.join(rel)).unwrap();
    }

    fn untouched(&self) {
        assert_eq!(tree(self.dir.path()), ["theirs.txt"]);
        assert_eq!(read(self.dir.path(), "theirs.txt"), "theirs");
    }
}

#[cfg(unix)]
fn is_link(root: &Path, rel: &str) -> bool {
    fs::symlink_metadata(root.join(rel)).is_ok_and(|m| m.is_symlink())
}

#[cfg(unix)]
#[test]
fn never_follows_a_link_at_any_name_it_may_take() {
    for dangling in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let outside = Outside::new();
        let mut manifest = Manifest::default();
        outside.plant(root, "Plan.md", dangling);
        outside.plant(root, "Work", dangling);
        fs::create_dir(root.join(ATTACHMENTS)).unwrap();
        outside.plant(root, "attachments/board.png", dangling);
        let copy = Op::File {
            id: FILE.into(),
            path: "attachments/board.png".into(),
            copy: true,
        };
        for (op, at) in [
            (put(NOTE, "Plan.md", None, "mine"), "Plan.md"),
            (put(NOTE, "Work/Plan.md", None, "mine"), "Work"),
            (copy, "attachments/board.png"),
        ] {
            let result = apply(root, &mut manifest, &op);
            assert_eq!(result.code, Some("E_MIRROR_EXISTS"), "{op:?}");
            assert_eq!(result.path.as_deref(), Some(at));
            assert_eq!(result.state, Some(Some(OTHER.into())));
        }
        assert!(manifest.notes.is_empty() && manifest.files.is_empty());
        apply(root, &mut manifest, &put(NOTE, "Home.md", None, "mine"));
        outside.plant(root, "Moved.md", dangling);
        let moved = apply(
            root,
            &mut manifest,
            &put(NOTE, "Moved.md", Some("Home.md"), "mine 2"),
        );
        assert_eq!(moved.code, Some("E_MIRROR_EXISTS"));
        assert_eq!(read(root, "Home.md"), "mine");
        assert_eq!(manifest.notes[NOTE].path, "Home.md");
        // Where a file changed outside Devot is kept: a name a link holds is
        // passed over.
        write_text(root, "Home.md", "edited outside");
        outside.plant(root, "Home (edited outside Devot).md", dangling);
        let keep = Op::Keep {
            entry: EntryKind::Note,
            id: NOTE.into(),
            path: "Home.md".into(),
        };
        assert_eq!(
            apply(root, &mut manifest, &keep).kept.as_deref(),
            Some("Home (edited outside Devot) 2.md")
        );
        assert_eq!(
            read(root, "Home (edited outside Devot) 2.md"),
            "edited outside"
        );
        apply(root, &mut manifest, &put(NOTE, "Own.md", None, "own"));
        fs::remove_file(root.join("Own.md")).unwrap();
        outside.plant(root, "Own.md", dangling);
        let own = apply(
            root,
            &mut manifest,
            &put(NOTE, "Own.md", Some("Own.md"), "own 2"),
        );
        assert_eq!(own.code, Some("E_MIRROR_CHANGED"));
        assert_eq!(own.state, Some(Some(OTHER.into())));
        // The manifest's name: a first manifest takes no name a link holds;
        // the manifest written back replaces the link itself.
        outside.plant(root, MANIFEST, dangling);
        assert_eq!(
            create_manifest(&open(root), &manifest).unwrap_err().kind(),
            ErrorKind::AlreadyExists
        );
        assert!(is_link(root, MANIFEST));
        save_manifest(&open(root), &manifest).unwrap();
        assert!(fs::symlink_metadata(root.join(MANIFEST)).unwrap().is_file());
        assert_eq!(
            parse_manifest(&fs::read(root.join(MANIFEST)).unwrap()).as_ref(),
            Some(&manifest)
        );
        // The names temporary files and the probe once took.
        let old = [
            format!(".devot-{}-0.tmp", std::process::id()),
            ".devot-probe.tmp".into(),
        ];
        for name in &old {
            outside.plant(root, name, dangling);
        }
        probe_writable(&open(root)).unwrap();
        let again = apply(
            root,
            &mut manifest,
            &put(OTHER_NOTE, "Again.md", None, "again"),
        );
        assert_eq!(again.code, None);
        assert_eq!(read(root, "Again.md"), "again");
        for rel in [
            "Plan.md",
            "Work",
            "attachments/board.png",
            "Moved.md",
            "Home (edited outside Devot).md",
            "Own.md",
        ]
        .into_iter()
        .chain(old.iter().map(String::as_str))
        {
            assert!(is_link(root, rel), "{rel}");
        }
        outside.untouched();
    }
}

#[cfg(unix)]
#[test]
fn never_follows_or_replaces_a_link_that_appears_after_the_checks() {
    for dangling in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mirror = &open(root);
        let outside = Outside::new();
        // What the operations do once their checks have passed, with a link
        // put in the way just then: a new file and a move take no name it
        // holds (the plan learns what is there), nor does a file kept aside.
        outside.plant(root, "New.md", dangling);
        assert_eq!(
            write_new(mirror, &at(mirror, "New.md"), b"mine"),
            Err(Stop::at("E_MIRROR_EXISTS", "New.md", Some(OTHER.into())))
        );
        write_text(root, "Plan.md", "devot");
        outside.plant(root, "Moved.md", dangling);
        assert_eq!(
            move_file(
                mirror,
                &at(mirror, "Plan.md"),
                &at(mirror, "Moved.md"),
                false
            ),
            Err(Stop::at("E_MIRROR_EXISTS", "Moved.md", Some(OTHER.into())))
        );
        assert_eq!(read(root, "Plan.md"), "devot");
        outside.plant(root, "Plan (edited outside Devot).md", dangling);
        assert_eq!(
            keep_aside(mirror, &at(mirror, "Plan.md")).as_deref(),
            Ok("Plan (edited outside Devot) 2.md")
        );
        // Devot's own file, swapped for a link just before it is rewritten:
        // the link is replaced, never written through.
        outside.plant(root, "Own.md", dangling);
        assert_eq!(rewrite(mirror, &at(mirror, "Own.md"), b"own"), Ok(()));
        assert!(fs::symlink_metadata(root.join("Own.md")).unwrap().is_file());
        assert_eq!(read(root, "Own.md"), "own");
        assert_eq!(
            tree(root),
            [
                "Moved.md",
                "New.md",
                "Own.md",
                "Plan (edited outside Devot) 2.md",
                "Plan (edited outside Devot).md",
            ]
        );
        for rel in ["Moved.md", "New.md", "Plan (edited outside Devot).md"] {
            assert!(is_link(root, rel), "{rel}");
        }
        outside.untouched();
    }
}

/// A folder on the way to an operation's file, swapped for a link to a
/// folder outside between the operation's checks and the step that acts on
/// them (`atomic_file::race`), as a local process that may rename entries
/// in the mirror's folder could: the step still acts in the folder it
/// checked, never through the link. Nothing lands outside, and nothing
/// there is moved, kept aside or deleted, even a file of the same name.
#[cfg(unix)]
#[test]
fn a_folder_swapped_for_a_link_after_the_checks_is_never_followed() {
    use crate::atomic_file::race;
    // A mirror's folder, the folder outside the link goes to (with a file
    // of the name the operations use), and Devot's own file `Work/Plan.md`
    // in the manifest, holding "one", unless `listed` is false.
    let setup = |listed: bool| {
        let dir = tempfile::tempdir().unwrap();
        let outside = Outside::new();
        fs::write(outside.dir.path().join("Plan.md"), "theirs").unwrap();
        let mut manifest = Manifest::default();
        if listed {
            apply(
                dir.path(),
                &mut manifest,
                &put(NOTE, "Work/Plan.md", None, "one"),
            );
        }
        (dir, outside, manifest)
    };
    let swap = |root: &Path, name: &str, outside: &Outside| {
        race::swap_at_check(
            &root.join(name),
            &root.join(format!("{name} (moved)")),
            outside.dir.path(),
        );
    };
    let untouched = |outside: &Outside| {
        assert!(race::ran());
        assert_eq!(tree(outside.dir.path()), ["Plan.md", "theirs.txt"]);
        assert_eq!(read(outside.dir.path(), "Plan.md"), "theirs");
        assert_eq!(read(outside.dir.path(), "theirs.txt"), "theirs");
    };
    let same_text = |path: &str, from: &str| Op::Note {
        id: NOTE.into(),
        path: path.into(),
        from: Some(from.into()),
        sha256: sha256_hex(b"one"),
        text: None,
        source: "s2".into(),
        files: vec![],
    };

    let (dir, outside, mut manifest) = setup(false);
    let root = dir.path();
    swap(root, "Work", &outside);
    let result = apply(root, &mut manifest, &put(NOTE, "Work/New.md", None, "mine"));
    untouched(&outside);
    assert_eq!(result.code, None);
    assert_eq!(read(root, "Work (moved)/New.md"), "mine");

    let (dir, outside, mut manifest) = setup(true);
    let root = dir.path();
    swap(root, "Work", &outside);
    let rewrite = put(NOTE, "Work/Plan.md", Some("Work/Plan.md"), "two");
    assert_eq!(apply(root, &mut manifest, &rewrite).code, None);
    untouched(&outside);
    assert_eq!(read(root, "Work (moved)/Plan.md"), "two");

    let (dir, outside, mut manifest) = setup(true);
    let root = dir.path();
    swap(root, "Home", &outside);
    let moved = same_text("Home/Moved.md", "Work/Plan.md");
    assert_eq!(apply(root, &mut manifest, &moved).code, None);
    untouched(&outside);
    assert_eq!(read(root, "Home (moved)/Moved.md"), "one");
    let (dir, outside, mut manifest) = setup(true);
    let root = dir.path();
    fs::create_dir(root.join("Home")).unwrap();
    swap(root, "Work", &outside);
    let moved = same_text("Home/Plan.md", "Work/Plan.md");
    apply(root, &mut manifest, &moved);
    untouched(&outside);
    assert_eq!(read(root, "Home/Plan.md"), "one");
    assert_eq!(tree(&root.join("Work (moved)")), Vec::<String>::new());

    let (dir, outside, mut manifest) = setup(true);
    let root = dir.path();
    swap(root, "Work", &outside);
    let remove = Op::Remove {
        entry: EntryKind::Note,
        id: NOTE.into(),
        path: "Work/Plan.md".into(),
        sha256: sha256_hex(b"one"),
    };
    assert_eq!(apply(root, &mut manifest, &remove).code, None);
    untouched(&outside);
    assert!(fs::symlink_metadata(root.join("Work (moved)/Plan.md")).is_err());

    let (dir, outside, mut manifest) = setup(true);
    let root = dir.path();
    write_text(root, "Work/Plan.md", "edited outside");
    swap(root, "Work", &outside);
    let keep = Op::Keep {
        entry: EntryKind::Note,
        id: NOTE.into(),
        path: "Work/Plan.md".into(),
    };
    apply(root, &mut manifest, &keep);
    untouched(&outside);
    assert_eq!(
        tree(&root.join("Work (moved)")),
        ["Plan (edited outside Devot).md"]
    );

    let (dir, outside, mut manifest) = setup(false);
    let root = dir.path();
    swap(root, ATTACHMENTS, &outside);
    let copy = Op::File {
        id: FILE.into(),
        path: "attachments/board.png".into(),
        copy: true,
    };
    assert_eq!(apply(root, &mut manifest, &copy).code, None);
    untouched(&outside);
    assert_eq!(
        fs::read(root.join("attachments (moved)/board.png")).unwrap(),
        PNG
    );
}

#[test]
fn a_new_file_or_a_move_never_replaces_a_file_that_appears_after_the_checks() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mirror = &open(root);
    write_text(root, "New.md", "theirs");
    let theirs = Some(sha256_hex(b"theirs"));
    assert_eq!(
        write_new(mirror, &at(mirror, "New.md"), b"mine"),
        Err(Stop::at("E_MIRROR_EXISTS", "New.md", theirs.clone()))
    );
    write_text(root, "Plan.md", "devot");
    assert_eq!(
        move_file(mirror, &at(mirror, "Plan.md"), &at(mirror, "New.md"), false),
        Err(Stop::at("E_MIRROR_EXISTS", "New.md", theirs))
    );
    write_text(root, "Plan (edited outside Devot).md", "kept before");
    assert_eq!(
        keep_aside(mirror, &at(mirror, "Plan.md")).as_deref(),
        Ok("Plan (edited outside Devot) 2.md")
    );
    assert_eq!(read(root, "New.md"), "theirs");
    assert_eq!(read(root, "Plan (edited outside Devot).md"), "kept before");
    assert_eq!(read(root, "Plan (edited outside Devot) 2.md"), "devot");
    assert_eq!(
        tree(root),
        [
            "New.md",
            "Plan (edited outside Devot) 2.md",
            "Plan (edited outside Devot).md",
        ]
    );
}

#[test]
fn a_missing_or_read_only_folder_pauses_the_mirror() {
    let dir = tempfile::tempdir().unwrap();
    let gone = fs::canonicalize(dir.path()).unwrap().join("gone");
    let mut manifest = Manifest::default();
    // Never there: it cannot be opened (the mirror pauses, see `Mirror`).
    assert_eq!(
        Root::open(&gone).map(drop).map_err(|e| e.kind()),
        Err(ErrorKind::NotFound)
    );
    fs::create_dir(&gone).unwrap();
    let opened = open(&gone);
    fs::remove_dir(&gone).unwrap();
    let result = apply_in(&opened, &mut manifest, &put(NOTE, "Plan.md", None, "x"));
    assert_eq!(result.code, Some("E_MIRROR_FOLDER_MISSING"));
    assert!(result.pauses());
    assert!(!gone.exists(), "the folder is never made");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let root = dir.path().join("locked");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o555)).unwrap();
        let result = apply(&root, &mut manifest, &put(NOTE, "Plan.md", None, "x"));
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        // Root ignores permissions: then the write simply went through.
        if result.code.is_some() {
            assert_eq!(result.code, Some("E_MIRROR_FOLDER_READ_ONLY"));
            assert!(result.pauses());
        }
    }
}

#[test]
fn books_are_recorded_and_forgotten() {
    let dir = tempfile::tempdir().unwrap();
    let mut manifest = Manifest::default();
    let set = Op::Book {
        id: BOOK.into(),
        path: Some("Work/Deep".into()),
    };
    assert_eq!(apply(dir.path(), &mut manifest, &set).code, None);
    assert_eq!(manifest.books[BOOK], "Work/Deep");
    let unset = Op::Book {
        id: BOOK.into(),
        path: None,
    };
    assert_eq!(apply(dir.path(), &mut manifest, &unset).code, None);
    assert!(manifest.books.is_empty());
}

#[test]
fn reads_back_the_manifest_it_writes_and_drops_bad_entries() {
    let mut manifest = Manifest::default();
    manifest.notes.insert(
        NOTE.into(),
        NoteEntry {
            path: "Work/Plan.md".into(),
            sha256: sha256_hex(b"x"),
            size: 1,
            source: "abc".into(),
            files: vec![FILE.into()],
        },
    );
    manifest.files.insert(
        FILE.into(),
        FileEntry {
            path: "attachments/a.png".into(),
            sha256: None,
            size: 0,
        },
    );
    manifest.books.insert(BOOK.into(), "Work".into());
    let bytes = manifest_bytes(&manifest);
    assert!(String::from_utf8_lossy(&bytes).starts_with("{\"version\":1,"));
    assert_eq!(parse_manifest(&bytes), Some(manifest.clone()));
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["notes"]["not-an-id"] = value["notes"][NOTE].clone();
    value["notes"][OTHER_NOTE] = serde_json::json!({
        "path": "../escape.md", "sha256": sha256_hex(b"x"), "size": 1, "source": "", "files": []
    });
    assert_eq!(
        parse_manifest(&serde_json::to_vec(&value).unwrap()),
        Some(manifest)
    );
    assert_eq!(parse_manifest(b"{ not json"), None);
    assert_eq!(parse_manifest(b"{\"version\":2}"), None);
}

#[test]
fn tells_an_empty_folder_from_one_in_use() {
    let dir = tempfile::tempdir().unwrap();
    let mirror = &open(dir.path());
    assert!(!has_entries(mirror).unwrap());
    fs::write(dir.path().join(".DS_Store"), b"").unwrap();
    assert!(!has_entries(mirror).unwrap());
    fs::write(dir.path().join("notes.txt"), b"").unwrap();
    assert!(has_entries(mirror).unwrap());
    assert!(probe_writable(mirror).is_ok());
    assert_eq!(tree(dir.path()), [".DS_Store", "notes.txt"]);
    // A file at the name the probe once took is someone else's: untouched.
    fs::write(dir.path().join(".devot-probe.tmp"), b"theirs").unwrap();
    assert!(probe_writable(mirror).is_ok());
    assert_eq!(read(dir.path(), ".devot-probe.tmp"), "theirs");
    assert_eq!(
        tree(dir.path()),
        [".DS_Store", ".devot-probe.tmp", "notes.txt"]
    );
}
