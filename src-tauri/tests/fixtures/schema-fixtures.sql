-- How schema-v18.sqlite and schema-v19.sqlite were made: migrations 0001-0018 (as released in
-- v1.0.4), then this, with user_version 18; schema-v19 is that with 0019 (v1.0.5-beta) on top, a
-- sync_state row and one note marked synced, with user_version 19.
BEGIN;
INSERT INTO books (id, name, name_hlc, parent_id, parent_hlc, created_at, updated_at, sort_key, sort_key_hlc)
  VALUES ('0192a6f0-0000-7000-8000-00000000b001', 'Work', '0000001790000000000-0000-fixture', NULL, '0000001790000000000-0000-fixture', 1790000000000, 1790000000000, 'a0', '0000001790000000000-0000-fixture');
INSERT INTO books (id, name, name_hlc, parent_id, parent_hlc, created_at, updated_at, sort_key, sort_key_hlc, icon, icon_color, icon_hlc)
  VALUES ('0192a6f0-0000-7000-8000-00000000b002', 'Plans', '0000001790000000001-0000-fixture', '0192a6f0-0000-7000-8000-00000000b001', '0000001790000000001-0000-fixture', 1790000000001, 1790000000001, 'a0', '0000001790000000001-0000-fixture', 'star', 'orange', '0000001790000000001-0000-fixture');
INSERT INTO tags (id, name, name_hlc, created_at, updated_at, color, color_hlc)
  VALUES ('0192a6f0-0000-7000-8000-00000000c001', 'q4', '0000001790000000002-0000-fixture', 1790000000002, 1790000000002, 'blue', '0000001790000000002-0000-fixture');
INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at, book_id, book_hlc, status, status_hlc, pinned, pinned_hlc, body_version, dates_hlc)
  VALUES ('0192a6f0-0000-7000-8000-000000000001', 'Launch', '0000001790000000003-0000-fixture', 'Draft, see [Inbox](devot://note/0192a6f0-0000-7000-8000-000000000002).

![Board](devot://file/0192a6f0-0000-7000-8000-00000000f001)
', x'0000', 1790000000003, 1790000000010, '0192a6f0-0000-7000-8000-00000000b002', '0000001790000000003-0000-fixture', 'active', '0000001790000000003-0000-fixture', 0, '', 4, '0000001790000000010-0000-fixture');
INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at, pinned, pinned_hlc, body_version, dates_hlc)
  VALUES ('0192a6f0-0000-7000-8000-000000000002', 'Inbox', '0000001790000000004-0000-fixture', 'Loose thoughts.
', x'0000', 1790000000004, 1790000000004, 1, '0000001790000000004-0000-fixture', 1, '0000001790000000004-0000-fixture');
INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at, deleted_at, deleted_hlc, book_id, book_hlc, body_version, dates_hlc)
  VALUES ('0192a6f0-0000-7000-8000-000000000003', 'Trashed', '0000001790000000005-0000-fixture', 'In the Trash.
', x'0000', 1790000000005, 1790000000005, 1790000000020, '0000001790000000020-0000-fixture', '0192a6f0-0000-7000-8000-00000000b001', '0000001790000000005-0000-fixture', 1, '0000001790000000005-0000-fixture');
INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at, deleted_at, deleted_hlc, purged_at, body_version, dates_hlc)
  VALUES ('0192a6f0-0000-7000-8000-000000000004', '', '0000001790000000030-0000-fixture', '', x'', 1790000000006, 1790000000006, 1790000000021, '0000001790000000021-0000-fixture', 1790000000030, 1, '0000001790000000006-0000-fixture');
INSERT INTO note_tags (note_id, tag_id, present, hlc)
  VALUES ('0192a6f0-0000-7000-8000-000000000001', '0192a6f0-0000-7000-8000-00000000c001', 1, '0000001790000000007-0000-fixture');
INSERT INTO files (id, note_id, name, mime, size, data, created_at)
  VALUES ('0192a6f0-0000-7000-8000-00000000f001', '0192a6f0-0000-7000-8000-000000000001', 'board.png', 'image/png', 9, x'89504e470d0a1a0a00', 1790000000008);
INSERT INTO links (source_id, target_id)
  VALUES ('0192a6f0-0000-7000-8000-000000000001', '0192a6f0-0000-7000-8000-000000000002');
INSERT INTO revisions (id, note_id, kind, at, ydoc, length, value)
  VALUES ('0192a6f0-0000-7000-8000-00000000a001', '0192a6f0-0000-7000-8000-000000000001', 'body', 1790000000009, x'0000', 6, NULL);
INSERT INTO revisions (id, note_id, kind, at, ydoc, length, value)
  VALUES ('0192a6f0-0000-7000-8000-00000000a002', '0192a6f0-0000-7000-8000-000000000001', 'title', 1790000000009, NULL, NULL, 'Draft');
INSERT INTO compaction (id, swept_at) VALUES (1, 1790000000011);
COMMIT;
