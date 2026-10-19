//! Native checks that must run on the main thread (WebKit kills the process
//! when called from libtest's worker threads), so this test has no harness
//! (`harness = false` in Cargo.toml).

fn main() {
    #[cfg(target_os = "macos")]
    {
        use devot_lib::native::macos;

        macos::self_test_private_api_guards()
            .expect("objects without a private method give a fallback, not a crash");
        println!("main_thread: private API guards fall back instead of crashing");

        macos::self_test_sixty_fps_toggle().expect("the 60 fps WebKit preference can be toggled");
        println!("main_thread: 60 fps preference toggles off and on");

        macos::self_test_format_menu_keys().expect("the Format menu takes its own keys");
        println!(
            "main_thread: the Format menu takes its keys and no others; menu items lose keys by title"
        );

        macos::self_test_marked_text().expect("the key monitor sees an input method's marked text");
        println!(
            "main_thread: marked text in the first responder is seen until it is committed; a web view can say"
        );

        macos::self_test_look_up_speech()
            .expect("a web view answers to Look Up and Speech, and a missing selector is refused");
        println!("main_thread: Look Up and Speech selectors answer on a web view; guards refuse");

        macos::self_test_look_up_fonts()
            .expect("Look Up draws its word in the font the page names, or the system font");
        println!(
            "main_thread: Look Up fonts resolve: system, monospaced, installed with traits, file, fallback"
        );

        macos::self_test_editor_menu()
            .expect("the editor's menu offers guesses, the page's and the system's items");
        println!(
            "main_thread: the editor's menu has guesses, keys and system items; a pick arrives"
        );

        // A 1x1 PNG; written to a private pasteboard, never the user's.
        const PNG: &[u8] = &[
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00,
            0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78,
            0xda, 0x63, 0x64, 0x60, 0x00, 0x00, 0x00, 0x06, 0x00, 0x02, 0x30, 0x81, 0xd0, 0x2f,
            0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ];
        macos::self_test_image_pasteboard(PNG)
            .expect("an image goes on a pasteboard as PNG and TIFF");
        println!("main_thread: images go on the pasteboard as PNG and TIFF");
        image_decode_frees_its_memory();
        print_to_pdf();
        print_jobs_end();
        print_loads_nothing_remote();

        let accent = macos::system_accent();
        let is_hex = |s: &Option<String>| {
            s.as_deref().is_some_and(|h| {
                h.len() == 7 && h.starts_with('#') && h[1..].chars().all(|c| c.is_ascii_hexdigit())
            })
        };
        if accent.multicolor {
            assert!(accent.light.is_none() && accent.dark.is_none());
        } else {
            assert!(
                is_hex(&accent.light) && is_hex(&accent.dark),
                "accent: {accent:?}"
            );
        }
        println!(
            "main_thread: system accent reads (multicolor: {})",
            accent.multicolor
        );
    }
}

/// Copy Image frees what it decoded once it returns, not when its thread ends. Two copies of a
/// large image are decoded on a thread that then stays alive (as a blocking-pool thread does):
/// AppKit's temporaries used to stay until that thread exited, hundreds of MB for a large photo.
/// The footprint does not fall back to where it was before the copies: the allocator keeps freed
/// pages for reuse, which `heap` shows as free.
#[cfg(target_os = "macos")]
fn image_decode_frees_its_memory() {
    use devot_lib::native::macos;
    use std::sync::{Arc, mpsc};

    const SIDE: u32 = 4096;
    let decoded = 4 * u64::from(SIDE) * u64::from(SIDE);
    // Shared, so the thread's exit frees none of the image's own bytes.
    let image: Arc<[u8]> = bmp(SIDE, SIDE).into();
    let (copied, done) = mpsc::channel();
    let (measured, wait) = mpsc::channel::<()>();
    let worker = std::thread::spawn({
        let image = Arc::clone(&image);
        move || {
            for _ in 0..2 {
                let copy = macos::pasteboard_image(&image, u64::MAX).expect("the image decodes");
                assert!(copy.png.is_some() && !copy.tiff.is_empty());
            }
            copied.send(()).unwrap();
            // Alive until measured, as a blocking-pool thread stays.
            let _ = wait.recv();
        }
    });
    done.recv().expect("the copies finish");
    let alive = macos::memory_footprint().expect("the footprint reads");
    measured.send(()).unwrap();
    worker.join().unwrap();
    let ended = macos::memory_footprint().expect("the footprint reads");
    let freed_at_exit = alive.saturating_sub(ended);
    assert!(
        freed_at_exit < decoded,
        "the decoding thread held {} MB until it exited (one decoded copy is {} MB)",
        freed_at_exit >> 20,
        decoded >> 20
    );
    println!(
        "main_thread: copies of a {SIDE}x{SIDE} image free their memory before the thread ends ({} MB held to its exit)",
        freed_at_exit >> 20
    );
}

#[cfg(target_os = "macos")]
fn bmp(width: u32, height: u32) -> Vec<u8> {
    let row = (width * 3).next_multiple_of(4);
    let size = row * height;
    let mut out = Vec::with_capacity(54 + size as usize);
    out.extend_from_slice(b"BM");
    for value in [54 + size, 0, 54, 40, width, height] {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out.extend_from_slice(&[1, 0, 24, 0]);
    for value in [0, size, 2835, 2835, 0, 0] {
        out.extend_from_slice(&value.to_le_bytes());
    }
    for y in 0..height {
        let line: Vec<u8> = (0..row)
            .map(|i| if i < width * 3 { (i ^ y) as u8 } else { 0 })
            .collect();
        out.extend_from_slice(&line);
    }
    out
}

#[cfg(target_os = "macos")]
fn print_to_pdf() {
    use devot_lib::native::macos;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.pdf");
    let paragraphs: String = (0..200)
        .map(|i| format!("<p>Paragraph {i} of a long printed note.</p>"))
        .collect();
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Printed</title></head>\
         <body><h1>Printed note</h1>{paragraphs}<script>document.body.remove()</script></body></html>"
    );
    macos::self_test_print_to_pdf(&html, &path).expect("a page prints to a PDF file");
    let pdf = std::fs::read(&path).expect("the PDF file exists");
    assert!(pdf.starts_with(b"%PDF-"), "not a PDF");
    let text = String::from_utf8_lossy(&pdf);
    let pages = text.matches("/Type /Page").count() - text.matches("/Type /Pages").count();
    assert!(pages >= 2, "a long note takes several pages, got {pages}");
    assert!(text.contains("/FontDescriptor"), "the pages hold text");
    assert_eq!(macos::self_test_print_jobs(), 0, "the job is over");
    println!("main_thread: a long page prints to a {pages}-page PDF");
}

#[cfg(target_os = "macos")]
fn print_jobs_end() {
    use devot_lib::native::macos;

    let dir = tempfile::tempdir().unwrap();
    for n in 1..=3 {
        let path = dir.path().join(format!("note {n}.pdf"));
        let html = format!("<!doctype html><title>Note {n}</title><p>Printed note {n}.</p>");
        macos::self_test_print_to_pdf(&html, &path)
            .unwrap_or_else(|code| panic!("print {n} of 3 failed: {code}"));
        let pdf = std::fs::read(&path).expect("the PDF file exists");
        assert!(pdf.starts_with(b"%PDF-"), "print {n} is not a PDF");
        assert_eq!(
            macos::self_test_print_jobs(),
            0,
            "print {n} left its job behind"
        );
    }
    println!("main_thread: three PDF prints in a row each end and free the print slot");
}

/// Printing loads nothing from elsewhere, whatever the page allows itself:
/// a page whose own policy allows web images, with an image, a
/// stylesheet and a background from a local listener, prints without one
/// connection to it. Its `data:` image (as an attachment is) still prints.
#[cfg(target_os = "macos")]
fn print_loads_nothing_remote() {
    use base64::Engine;
    use devot_lib::native::macos;
    use std::io::{Read, Write};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let connections = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    // Counts connections and answers each with 404, so a page that did
    // load from it would not wait for an answer.
    let server = {
        let (connections, stop) = (Arc::clone(&connections), Arc::clone(&stop));
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        connections.fetch_add(1, Ordering::SeqCst);
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.read(&mut [0; 4096]);
                        let _ = stream.write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                    }
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(10)),
                }
            }
        })
    };

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.pdf");
    let origin = format!("http://127.0.0.1:{port}");
    // A 2x2 image of four colours (WebKit fills a one-colour image as a
    // plain rectangle, which leaves no image in the PDF to find).
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x08, 0x02, 0x00, 0x00, 0x00, 0xfd,
        0xd4, 0x9a, 0x73, 0x00, 0x00, 0x00, 0x16, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xb8,
        0xe0, 0xa0, 0xa0, 0x90, 0x70, 0x81, 0x41, 0x61, 0x81, 0xc3, 0x87, 0x0f, 0x0a, 0x00, 0x23,
        0xce, 0x05, 0x81, 0x7b, 0xc8, 0xad, 0x30, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
        0xae, 0x42, 0x60, 0x82,
    ];
    let data = base64::engine::general_purpose::STANDARD.encode(PNG);
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
         <meta http-equiv=\"Content-Security-Policy\" \
         content=\"default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline' http:\">\
         <link rel=\"stylesheet\" href=\"{origin}/page.css\">\
         <style>body {{ background: url({origin}/background.png) }}</style>\
         <title>Remote</title></head><body><p>Remote images stay out of print.</p>\
         <img src=\"{origin}/tracker.png\" alt=\"Tracker\">\
         <img src=\"data:image/png;base64,{data}\" alt=\"Attachment\" width=\"40\" height=\"40\">\
         </body></html>"
    );
    let printed = macos::self_test_print_to_pdf(&html, &path);
    stop.store(true, Ordering::SeqCst);
    server.join().unwrap();
    printed.expect("the page prints");
    assert_eq!(
        connections.load(Ordering::SeqCst),
        0,
        "printing connected to the listener"
    );
    let pdf = std::fs::read(&path).expect("the PDF file exists");
    assert!(
        String::from_utf8_lossy(&pdf).contains("/Subtype /Image"),
        "the data: image prints"
    );
    assert_eq!(macos::self_test_print_jobs(), 0, "the job is over");
    println!("main_thread: printing loads nothing from elsewhere; data: images print");
}
