//! Printing an HTML page or a note through the print panel or into a PDF.

use std::cell::{Cell, RefCell};
use std::path::Path;

use objc2::msg_send;
use objc2::rc::{Retained, Weak};
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::sel;
use objc2::{AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class};
use objc2_app_kit::{
    NSApplication, NSBackingStoreType, NSPaperOrientation, NSPrintInfo, NSPrintJobDisposition,
    NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob, NSWindow, NSWindowStyleMask,
};
use objc2_foundation::{
    NSCopying, NSDate, NSError, NSLocale, NSNumber, NSObject, NSObjectProtocol, NSPoint, NSRect,
    NSSize, NSString, NSURL,
};
use objc2_pdf_kit::{PDFDisplayBox, PDFDocument, PDFPrintScalingMode};
use objc2_web_kit::{WKNavigation, WKNavigationDelegate, WKWebView, WKWebViewConfiguration};
use tauri::Manager;

use crate::page_setup::{Margins, PageLayout, PageSetup, Paper};

use super::pdf::stamp_pdf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrintTarget {
    Printer,
    Pdf(std::path::PathBuf),
}

impl PrintTarget {
    /// A print through the panel either printed or was cancelled there; a PDF has no panel to
    /// cancel, so a PDF that was not written failed.
    pub fn outcome(&self, success: bool) -> Result<bool, &'static str> {
        match (self, success) {
            (_, true) => Ok(true),
            (PrintTarget::Printer, false) => Ok(false),
            (PrintTarget::Pdf(_), false) => Err("E_EXPORT_PDF_FAILED"),
        }
    }
}

/// Whether it printed (false when the user cancelled the panel), or an error code.
pub type PrintDone = Box<dyn FnOnce(Result<bool, &'static str>)>;

const PRINT_LOAD_TIMEOUT: f64 = 60.0;

/// So printing, like the preview, never fetches an image from the web: no server learns that a note
/// was printed, and no slow host holds the job up. The UI gives its pages to print the same policy
/// (`PRINT_CSP` in src/core/htmlExport.ts).
pub const PRINT_POLICY: &str = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/// Nothing in the page comes before the policy, so it applies to every load the page asks for, and
/// the page's own policy can only narrow it further (every policy applies).
pub fn with_print_policy(html: &str) -> String {
    const DOCTYPE: &str = "<!doctype html>";
    let page = match html.get(..DOCTYPE.len()) {
        Some(start) if start.eq_ignore_ascii_case(DOCTYPE) => &html[DOCTYPE.len()..],
        _ => html,
    };
    let meta = format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{PRINT_POLICY}\">");
    let mut out = String::with_capacity(DOCTYPE.len() + meta.len() + page.len());
    out.push_str(DOCTYPE);
    out.push_str(&meta);
    out.push_str(page);
    out
}

pub struct PrintJobState {
    target: PrintTarget,
    paper: Paper,
    margins: Margins,
    /// The page is still loading: its load starts printing, and a load
    /// failure ends the job. False once printing has begun (from then on
    /// only the print operation ends the job) or the job is over.
    loading: Cell<bool>,
    title: String,
    window: Weak<NSWindow>,
    done: RefCell<Option<PrintDone>>,
    web_view: RefCell<Option<Retained<WKWebView>>>,
    document: RefCell<Option<Retained<PDFDocument>>>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and `PrintJob`
    // implements no `Drop` (its ivars drop themselves).
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DevotPrintJob"]
    #[ivars = PrintJobState]
    pub struct PrintJob;

    // SAFETY: NSObjectProtocol has no requirements beyond NSObject's.
    unsafe impl NSObjectProtocol for PrintJob {}

    // SAFETY: each method's selector and signature match the protocol's.
    unsafe impl WKNavigationDelegate for PrintJob {
        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish_navigation(&self, web_view: &WKWebView, _navigation: Option<&WKNavigation>) {
            self.print(web_view);
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail_navigation(
            &self,
            _web_view: &WKWebView,
            _navigation: Option<&WKNavigation>,
            _error: &NSError,
        ) {
            self.load_failed("E_PRINT_LOAD_FAILED");
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional_navigation(
            &self,
            _web_view: &WKWebView,
            _navigation: Option<&WKNavigation>,
            _error: &NSError,
        ) {
            self.load_failed("E_PRINT_LOAD_FAILED");
        }

        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn web_content_process_did_terminate(&self, _web_view: &WKWebView) {
            self.load_failed("E_PRINT_LOAD_FAILED");
        }
    }

    impl PrintJob {
        /// AppKit calls it on the thread the operation printed on, which is not the main thread
        /// when the operation ran on a thread of its own (WebKit's print operations may, and a
        /// PDF's does), so it touches nothing of the job's and hands `success` to the main thread,
        /// where the job ends.
        #[unsafe(method(printOperationDidRun:success:contextInfo:))]
        fn print_operation_did_run(
            &self,
            _operation: &NSPrintOperation,
            success: Bool,
            _context: *mut std::ffi::c_void,
        ) {
            let success = NSNumber::numberWithBool(success.as_bool());
            // SAFETY: `printOperationEnded:` takes one object (an NSNumber)
            // and returns nothing; `performSelectorOnMainThread:withObject:
            // waitUntilDone:` retains the job and the number until it has
            // run, and is safe to call from any thread.
            unsafe {
                let _: () = msg_send![
                    self,
                    performSelectorOnMainThread: sel!(printOperationEnded:),
                    withObject: &*success,
                    waitUntilDone: false
                ];
            }
        }

        #[unsafe(method(printOperationEnded:))]
        fn print_operation_ended(&self, success: &NSNumber) {
            self.finish(self.ivars().target.outcome(success.boolValue()));
        }

        #[unsafe(method(loadTimedOut))]
        fn load_timed_out(&self) {
            self.load_failed("E_PRINT_TIMEOUT");
        }

        #[unsafe(method(releaseWebView))]
        fn release_web_view(&self) {
            self.ivars().web_view.take();
            self.ivars().document.take();
        }
    }
);

thread_local! {
    static PRINT_JOBS: RefCell<Vec<Retained<PrintJob>>> = const { RefCell::new(Vec::new()) };
}

impl PrintJob {
    fn print(&self, web_view: &WKWebView) {
        if !self.ivars().loading.replace(false) {
            return;
        }
        let Some(window) = self.ivars().window.load() else {
            self.finish(Err("E_PRINT_NO_WINDOW"));
            return;
        };
        let info = print_info(self.ivars().paper, self.ivars().margins.points());
        info.setHorizontallyCentered(false);
        info.setVerticallyCentered(false);
        let to_pdf = if let PrintTarget::Pdf(path) = &self.ivars().target {
            let Some(path) = path.to_str() else {
                self.finish(Err("E_PRINT_PATH_INVALID"));
                return;
            };
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            // SAFETY: the dictionary is the print info's own, mutable by
            // design; both keys take the values AppKit documents for them
            // (a disposition string and a file URL).
            unsafe {
                let settings = info.dictionary();
                settings.insert(NSPrintJobDisposition, NSPrintSaveJob.as_ref());
                settings.insert(NSPrintJobSavingURL, url.as_ref());
            }
            true
        } else {
            false
        };
        // SAFETY: the web view is live (it called us) and the print info
        // is a fresh copy.
        let operation = unsafe { web_view.printOperationWithPrintInfo(&info) };
        operation.setShowsPrintPanel(!to_pdf);
        operation.setShowsProgressPanel(!to_pdf);
        operation.setJobTitle(Some(&NSString::from_str(&self.ivars().title)));
        // WebKit's print view starts with an empty frame, which prints blank
        // pages; give it the web view's.
        if let Some(view) = operation.view() {
            view.setFrame(web_view.frame());
        }
        // SAFETY: `self` is a live object that implements the selector with
        // the signature AppKit calls (operation, BOOL, void *); it stays
        // alive in PRINT_JOBS until the selector has run (and handed the
        // result to the main thread, which retains it until the job ends).
        unsafe {
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                &window,
                Some(self.as_ref()),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                std::ptr::null_mut(),
            );
        }
    }

    /// When it is printing already, AppKit holds the job as the print operation's delegate (without
    /// retaining it) until `didRunSelector`, which ends it; ending it here would free it under
    /// AppKit.
    fn load_failed(&self, code: &'static str) {
        if self.ivars().loading.get() {
            self.finish(Err(code));
        }
    }

    /// Runs on the main thread, as every path that ends a job does.
    fn finish(&self, result: Result<bool, &'static str>) {
        let Some(done) = self.ivars().done.take() else {
            return;
        };
        self.ivars().loading.set(false);
        // The web view is released on the next turn of the run loop, not
        // inside one of its own callbacks; the delayed call keeps the job
        // alive until then.
        // SAFETY: `releaseWebView` takes no argument and returns nothing;
        // `performSelector:withObject:afterDelay:` retains `self` until it
        // runs, so cancelling the timeout's request (which drops its
        // retain) never frees the job here.
        unsafe {
            let _: () = msg_send![
                self,
                performSelector: sel!(releaseWebView),
                withObject: std::ptr::null::<AnyObject>(),
                afterDelay: 0.0f64
            ];
            let _: () = msg_send![
                objc2::class!(NSObject),
                cancelPreviousPerformRequestsWithTarget: self,
                selector: sel!(loadTimedOut),
                object: std::ptr::null::<AnyObject>()
            ];
        }
        PRINT_JOBS.with(|jobs| {
            jobs.borrow_mut()
                .retain(|job| !std::ptr::eq::<PrintJob>(&**job, self))
        });
        done(result);
    }
}

fn print_info(paper: Paper, margin: f64) -> Retained<NSPrintInfo> {
    let info = NSPrintInfo::sharedPrintInfo().copy();
    let (width, height) = paper.size();
    info.setOrientation(if width > height {
        NSPaperOrientation::Landscape
    } else {
        NSPaperOrientation::Portrait
    });
    info.setPaperSize(NSSize::new(width, height));
    info.setTopMargin(margin);
    info.setBottomMargin(margin);
    info.setLeftMargin(margin);
    info.setRightMargin(margin);
    info
}

fn print_job(mtm: MainThreadMarker, state: PrintJobState) -> Retained<PrintJob> {
    let job = PrintJob::alloc(mtm).set_ivars(state);
    // SAFETY: NSObject's `init` on a freshly allocated subclass instance.
    let job: Retained<PrintJob> = unsafe { msg_send![super(job), init] };
    PRINT_JOBS.with(|jobs| jobs.borrow_mut().push(job.clone()));
    job
}

fn print_busy() -> bool {
    PRINT_JOBS.with(|jobs| !jobs.borrow().is_empty())
}

/// Lays `html` out in an offscreen web view (scripts off, nothing loaded from elsewhere: see
/// `with_print_policy`) on `paper` with `margins` and prints it to the print panel as a sheet on
/// `window`, or to a PDF file without a panel. `done` runs once on the main thread. One job runs
/// at a time.
#[allow(clippy::too_many_arguments)]
pub fn print_html(
    mtm: MainThreadMarker,
    window: &NSWindow,
    html: &str,
    title: &str,
    target: PrintTarget,
    paper: Paper,
    margins: Margins,
    done: PrintDone,
) {
    if print_busy() {
        done(Err("E_PRINT_BUSY"));
        return;
    }
    // SAFETY: a fresh configuration; plain property access on it.
    let config = unsafe {
        let config = WKWebViewConfiguration::new(mtm);
        config
            .defaultWebpagePreferences()
            .setAllowsContentJavaScript(false);
        config
    };
    let (width, height) = paper.size();
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height));
    // SAFETY: a fresh allocation initialised with a valid configuration.
    let web_view =
        unsafe { WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &config) };
    let job = print_job(
        mtm,
        PrintJobState {
            target,
            paper,
            margins,
            loading: Cell::new(true),
            title: title.to_owned(),
            window: Weak::new(window),
            done: RefCell::new(Some(done)),
            web_view: RefCell::new(Some(web_view.clone())),
            document: RefCell::new(None),
        },
    );
    let page = NSString::from_str(&with_print_policy(html));
    // SAFETY: the web view's delegate is weak; the job is kept alive in
    // PRINT_JOBS until `finish`, and then by its pending `releaseWebView`
    // call, which drops the web view; the HTML string is copied by WebKit.
    unsafe {
        web_view.setNavigationDelegate(Some(ProtocolObject::from_ref(&*job)));
        web_view.loadHTMLString_baseURL(&page, None);
    }
    // SAFETY: `loadTimedOut` takes no argument and returns nothing;
    // `performSelector:withObject:afterDelay:` retains the job until it runs.
    unsafe {
        let _: () = msg_send![
            &*job,
            performSelector: sel!(loadTimedOut),
            withObject: std::ptr::null::<AnyObject>(),
            afterDelay: PRINT_LOAD_TIMEOUT
        ];
    }
}

/// Prints the PDF at `path` through the print panel, as a sheet on
/// `window`, each page scaled down to the paper the user picks if it does
/// not fit. `done` runs once on the main thread: true when it printed,
/// false when the user cancelled.
fn print_pdf(
    mtm: MainThreadMarker,
    window: &NSWindow,
    path: &Path,
    title: &str,
    paper: Paper,
    done: PrintDone,
) {
    if print_busy() {
        done(Err("E_PRINT_BUSY"));
        return;
    }
    let Some(url) = file_url(path) else {
        done(Err("E_PRINT_PATH_INVALID"));
        return;
    };
    // SAFETY: a fresh allocation initialised from a file URL.
    let Some(document) = (unsafe { PDFDocument::initWithURL(PDFDocument::alloc(), &url) }) else {
        done(Err("E_PRINT_LOAD_FAILED"));
        return;
    };
    let info = print_info(paper, 0.0);
    // SAFETY: the document and the print info are live; the scaling mode is
    // one of PDFKit's own.
    let operation = unsafe {
        document.printOperationForPrintInfo_scalingMode_autoRotate(
            Some(&info),
            PDFPrintScalingMode::PageScaleDownToFit,
            true,
            mtm,
        )
    };
    let Some(operation) = operation else {
        done(Err("E_PRINT_FAILED"));
        return;
    };
    operation.setShowsPrintPanel(true);
    operation.setShowsProgressPanel(true);
    operation.setJobTitle(Some(&NSString::from_str(title)));
    let job = print_job(
        mtm,
        PrintJobState {
            target: PrintTarget::Printer,
            paper,
            margins: Margins::Normal,
            loading: Cell::new(false),
            title: title.to_owned(),
            window: Weak::new(window),
            done: RefCell::new(Some(done)),
            web_view: RefCell::new(None),
            document: RefCell::new(Some(document)),
        },
    );
    // SAFETY: as in `PrintJob::print`: the job implements the selector and
    // stays in PRINT_JOBS until it has run.
    unsafe {
        operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            window,
            Some(job.as_ref()),
            Some(sel!(printOperationDidRun:success:contextInfo:)),
            std::ptr::null_mut(),
        );
    }
}

pub(super) fn file_url(path: &Path) -> Option<Retained<NSURL>> {
    path.to_str()
        .map(|path| NSURL::fileURLWithPath(&NSString::from_str(path)))
}

/// Prints a note's page with its page setup. WebKit draws no CSS page-margin boxes, so it lays the
/// page out into a PDF in `work`, whose pages `stamp_pdf` draws again with the header and footer:
/// into a PDF target's file, or into one more PDF in `work` that the print panel prints.
pub fn print_note(
    mtm: MainThreadMarker,
    window: &NSWindow,
    html: &str,
    layout: PageLayout,
    target: PrintTarget,
    work: &Path,
    done: PrintDone,
) {
    let laid_out = work.join("layout.pdf");
    let out = match &target {
        PrintTarget::Pdf(path) => path.clone(),
        PrintTarget::Printer => work.join("print.pdf"),
    };
    let window = objc2::Message::retain(window);
    let source = laid_out.clone();
    let PageSetup { paper, margins, .. } = layout.setup;
    let title = layout.title.clone();
    print_html(
        mtm,
        &window.clone(),
        html,
        &title,
        PrintTarget::Pdf(laid_out),
        paper,
        margins,
        Box::new(move |result| {
            if let Err(code) = result.and_then(|_| stamp_pdf(&source, &out, &layout)) {
                return done(Err(code));
            }
            match target {
                PrintTarget::Pdf(_) => done(Ok(true)),
                PrintTarget::Printer => print_pdf(mtm, &window, &out, &layout.title, paper, done),
            }
        }),
    );
}

fn ns_window(app: &tauri::AppHandle, label: &str) -> Option<Retained<NSWindow>> {
    let window = app
        .get_webview_window(label)
        .and_then(|window| window.ns_window().ok())
        .filter(|window| !window.is_null())?;
    // SAFETY: `ns_window()` returns the window's live NSWindow (checked non-null above); retaining
    // it keeps it alive for the caller.
    unsafe { Retained::retain(window.cast::<NSWindow>()) }
}

/// `print_html` on the system's paper, as the command-line export prints. Must run on the main
/// thread.
pub fn print_in_window(
    app: &tauri::AppHandle,
    label: &str,
    html: &str,
    title: &str,
    target: PrintTarget,
    done: PrintDone,
) {
    let Some(mtm) = MainThreadMarker::new() else {
        done(Err("E_NATIVE_NOT_MAIN_THREAD"));
        return;
    };
    let Some(window) = ns_window(app, label) else {
        done(Err("E_PRINT_NO_WINDOW"));
        return;
    };
    print_html(
        mtm,
        &window,
        html,
        title,
        target,
        system_paper(),
        Margins::Narrow,
        done,
    );
}

/// `print_note` in the window `label`. Must run on the main thread.
pub fn print_note_in_window(
    app: &tauri::AppHandle,
    label: &str,
    html: &str,
    layout: PageLayout,
    target: PrintTarget,
    work: &Path,
    done: PrintDone,
) {
    let Some(mtm) = MainThreadMarker::new() else {
        done(Err("E_NATIVE_NOT_MAIN_THREAD"));
        return;
    };
    let Some(window) = ns_window(app, label) else {
        done(Err("E_PRINT_NO_WINDOW"));
        return;
    };
    print_note(mtm, &window, html, layout, target, work, done);
}

/// The paper a page setup starts with: the system's default paper, or the
/// region's (`page_setup::default_paper`).
pub fn system_paper() -> Paper {
    let width = NSPrintInfo::sharedPrintInfo().paperSize().width;
    let region = NSLocale::currentLocale()
        .regionCode()
        .map(|code| code.to_string());
    crate::page_setup::default_paper(Some(width), region.as_deref())
}

#[doc(hidden)]
pub fn self_test_print_to_pdf(html: &str, path: &std::path::Path) -> Result<(), &'static str> {
    self_test_print(|mtm, window, done| {
        print_html(
            mtm,
            window,
            html,
            "Devot",
            PrintTarget::Pdf(path.to_owned()),
            Paper::Letter,
            Margins::Narrow,
            done,
        )
    })
}

/// Prints `html` to a PDF file at `path` as Export as PDF does, through
/// `print_note` with `layout`, its files on the way in `path`'s folder.
/// For the main-thread tests.
#[doc(hidden)]
pub fn self_test_print_note_to_pdf(
    html: &str,
    layout: PageLayout,
    path: &Path,
) -> Result<(), &'static str> {
    let work = path.parent().ok_or("E_PRINT_PATH_INVALID")?;
    self_test_print(|mtm, window, done| {
        print_note(
            mtm,
            window,
            html,
            layout,
            PrintTarget::Pdf(path.to_owned()),
            work,
            done,
        )
    })
}

/// A PDF page as a test checks it: its size, its text and its links (the
/// URLs, and the page each link inside the document goes to).
#[doc(hidden)]
#[derive(Debug)]
pub struct SelfTestPage {
    pub width: f64,
    pub height: f64,
    pub text: String,
    pub urls: Vec<String>,
    pub to_pages: Vec<usize>,
}

/// The pages of the PDF at `path`, read through PDFKit. For the
/// main-thread tests.
#[doc(hidden)]
pub fn self_test_pdf_pages(path: &Path) -> Result<Vec<SelfTestPage>, &'static str> {
    let url = file_url(path).ok_or("E_PRINT_PATH_INVALID")?;
    // SAFETY: a fresh allocation initialised from a file URL.
    let document = unsafe { PDFDocument::initWithURL(PDFDocument::alloc(), &url) }
        .ok_or("E_PRINT_STAMP_READ_FAILED")?;
    // SAFETY: a plain property read.
    let count = unsafe { document.pageCount() };
    let mut pages = Vec::with_capacity(count);
    for index in 0..count {
        // SAFETY: `index` is below the page count; plain property reads.
        unsafe {
            let page = document
                .pageAtIndex(index)
                .ok_or("E_PRINT_STAMP_READ_FAILED")?;
            let bounds = page.boundsForBox(PDFDisplayBox::MediaBox);
            let mut out = SelfTestPage {
                width: bounds.size.width,
                height: bounds.size.height,
                text: page.string().map(|s| s.to_string()).unwrap_or_default(),
                urls: Vec::new(),
                to_pages: Vec::new(),
            };
            for annotation in page.annotations().iter() {
                if let Some(url) = annotation.URL() {
                    out.urls.push(
                        url.absoluteString()
                            .map(|s| s.to_string())
                            .unwrap_or_default(),
                    );
                } else if let Some(to) = annotation.destination().and_then(|d| d.page()) {
                    out.to_pages.push(document.indexForPage(&to));
                }
            }
            pages.push(out);
        }
    }
    Ok(pages)
}

/// Runs a print job that `start` begins, with an offscreen window as the
/// parent, running the run loop until it is done.
fn self_test_print(
    start: impl FnOnce(MainThreadMarker, &NSWindow, PrintDone),
) -> Result<(), &'static str> {
    use objc2_foundation::{NSDefaultRunLoopMode, NSRunLoop};
    let mtm = MainThreadMarker::new().ok_or("E_NATIVE_NOT_MAIN_THREAD")?;
    let _app = NSApplication::sharedApplication(mtm);
    let rect = NSRect::new(
        NSPoint::new(-20_000.0, -20_000.0),
        NSSize::new(400.0, 300.0),
    );
    // SAFETY: a fresh allocation with a valid style, backing and frame.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            rect,
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: the window is owned here; AppKit must not release it on close.
    unsafe { window.setReleasedWhenClosed(false) };
    let result = std::rc::Rc::new(RefCell::new(None));
    let slot = std::rc::Rc::clone(&result);
    start(
        mtm,
        &window,
        Box::new(move |r| *slot.borrow_mut() = Some(r)),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let run_loop = NSRunLoop::currentRunLoop();
    while result.borrow().is_none() && std::time::Instant::now() < deadline {
        // SAFETY: the default mode constant is a valid run loop mode.
        unsafe {
            run_loop.runMode_beforeDate(
                NSDefaultRunLoopMode,
                &NSDate::dateWithTimeIntervalSinceNow(0.05),
            );
        }
    }
    // Let the delayed release run.
    // SAFETY: as above.
    unsafe {
        run_loop.runMode_beforeDate(
            NSDefaultRunLoopMode,
            &NSDate::dateWithTimeIntervalSinceNow(0.1),
        );
    }
    window.close();
    match result.borrow_mut().take() {
        Some(Ok(true)) => Ok(()),
        Some(Ok(false)) => Err("E_PRINT_CANCELLED"),
        Some(Err(code)) => Err(code),
        None => Err("E_PRINT_TIMEOUT"),
    }
}

#[doc(hidden)]
pub fn self_test_print_jobs() -> usize {
    PRINT_JOBS.with(|jobs| jobs.borrow().len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pdf_not_written_failed_while_a_print_not_printed_was_cancelled() {
        // AppKit's `success` flag: a print through the panel that did not
        // print was cancelled there; a PDF has no panel, so it failed.
        let pdf = PrintTarget::Pdf("note.pdf".into());
        assert_eq!(pdf.outcome(true), Ok(true));
        assert_eq!(pdf.outcome(false), Err("E_EXPORT_PDF_FAILED"));
        assert_eq!(PrintTarget::Printer.outcome(true), Ok(true));
        assert_eq!(PrintTarget::Printer.outcome(false), Ok(false));
    }

    #[test]
    fn puts_the_print_policy_before_anything_of_the_page() {
        let meta =
            format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{PRINT_POLICY}\">");
        let start = format!("<!doctype html>{meta}");
        let page = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">";
        assert_eq!(
            with_print_policy(page),
            format!("{start}\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">")
        );
        assert_eq!(
            with_print_policy("<img src=\"http://example.com/a.png\">"),
            format!("{start}<img src=\"http://example.com/a.png\">")
        );
        let legacy = "<!DOCTYPE html PUBLIC \"-//W3C//DTD HTML 4.01//EN\"><p>x</p>";
        assert_eq!(with_print_policy(legacy), format!("{start}{legacy}"));
        assert_eq!(with_print_policy(""), start);
        assert!(PRINT_POLICY.contains("default-src 'none'"));
        assert!(PRINT_POLICY.contains("img-src data:;"));
        assert!(!PRINT_POLICY.contains("http"));
    }
}
