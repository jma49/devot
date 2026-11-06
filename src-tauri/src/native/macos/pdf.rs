//! Drawing a laid-out PDF's pages again with the header and footer, keeping its links.

use std::path::Path;

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSColor, NSFont, NSFontAttributeName, NSForegroundColorAttributeName, NSGraphicsContext,
    NSLineBreakMode, NSMutableParagraphStyle, NSParagraphStyleAttributeName, NSTextAlignment,
};
use objc2_core_foundation::{CFRetained, CFString, CFURL, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGContext, CGPDFContextAddDestinationAtPoint, CGPDFContextClose, CGPDFContextCreateWithURL,
    CGPDFContextSetDestinationForRect, CGPDFContextSetURLForRect,
};
use objc2_foundation::{
    NSDate, NSDateFormatter, NSDateFormatterStyle, NSDictionary, NSPoint, NSRect, NSSize, NSString,
    NSURL,
};
use objc2_pdf_kit::{PDFActionGoTo, PDFActionURL, PDFDisplayBox, PDFDocument};

use crate::page_setup::{Fields, MarkPlaces, PageLayout, Rgba, expand};

use super::print::file_url;

fn today() -> String {
    let formatter = NSDateFormatter::new();
    formatter.setDateStyle(NSDateFormatterStyle::MediumStyle);
    formatter.setTimeStyle(NSDateFormatterStyle::NoStyle);
    formatter.stringFromDate(&NSDate::now()).to_string()
}

/// A link on a laid-out page, to keep on the page drawn again.
enum PageLink {
    Url(NSRect, Retained<NSURL>),
    /// To a point on a page (by index), by the destination's name.
    Page(NSRect, String),
}

type LinkTarget = (String, NSPoint);

/// Each page's links, and the named points on each page they go to.
fn page_links(document: &PDFDocument, pages: usize) -> (Vec<Vec<PageLink>>, Vec<Vec<LinkTarget>>) {
    let mut links: Vec<Vec<PageLink>> = (0..pages).map(|_| Vec::new()).collect();
    let mut targets: Vec<Vec<LinkTarget>> = (0..pages).map(|_| Vec::new()).collect();
    for (index, on_page) in links.iter_mut().enumerate() {
        // SAFETY: `index` is below the document's page count.
        let Some(page) = (unsafe { document.pageAtIndex(index) }) else {
            continue;
        };
        // SAFETY: plain property reads on live PDFKit objects; a GoTo
        // action is checked by class before it is used as one.
        unsafe {
            for annotation in page.annotations().iter() {
                let rect = annotation.bounds();
                let action = annotation.action();
                let url = annotation.URL().or_else(|| {
                    action
                        .as_ref()
                        .and_then(|a| a.downcast_ref::<PDFActionURL>())
                        .and_then(|a| a.URL())
                });
                if let Some(url) = url {
                    on_page.push(PageLink::Url(rect, url));
                    continue;
                }
                let destination = annotation.destination().or_else(|| {
                    action
                        .as_ref()
                        .and_then(|a| a.downcast_ref::<PDFActionGoTo>())
                        .map(|a| a.destination())
                });
                let Some(destination) = destination else {
                    continue;
                };
                let Some(to) = destination.page() else {
                    continue;
                };
                let to_index = document.indexForPage(&to);
                if to_index >= pages {
                    continue;
                }
                let bounds = to.boundsForBox(PDFDisplayBox::MediaBox);
                let point = destination.point();
                // An unspecified coordinate is a huge number: the page's top left.
                let point = NSPoint::new(
                    if point.x <= bounds.size.width {
                        point.x
                    } else {
                        0.0
                    },
                    if point.y <= bounds.size.height {
                        point.y
                    } else {
                        bounds.size.height
                    },
                );
                let name = format!("devot-{index}-{}", on_page.len());
                targets[to_index].push((name.clone(), point));
                on_page.push(PageLink::Page(rect, name));
            }
        }
    }
    (links, targets)
}

fn cf_string(text: &str) -> CFRetained<CFString> {
    CFString::from_str(text)
}

/// Draws the PDF at `source` again into `out` with the header and footer
/// of `layout`, keeping its links. Runs on the main thread (AppKit draws
/// the text).
pub fn stamp_pdf(source: &Path, out: &Path, layout: &PageLayout) -> Result<(), &'static str> {
    MainThreadMarker::new().ok_or("E_NATIVE_NOT_MAIN_THREAD")?;
    let url = file_url(source).ok_or("E_PRINT_PATH_INVALID")?;
    // SAFETY: a fresh allocation initialised from a file URL.
    let document = unsafe { PDFDocument::initWithURL(PDFDocument::alloc(), &url) }
        .ok_or("E_PRINT_STAMP_READ_FAILED")?;
    // SAFETY: a plain property read.
    let pages = unsafe { document.pageCount() };
    if pages == 0 {
        return Err("E_PRINT_STAMP_READ_FAILED");
    }
    let out_url = file_url(out).ok_or("E_PRINT_PATH_INVALID")?;
    // SAFETY: NSURL and CFURL are toll-free bridged: the same object.
    let out_url: &CFURL = unsafe { &*(Retained::as_ptr(&out_url).cast::<CFURL>()) };
    // SAFETY: a valid file URL; no media box (each page gives its own) and
    // no extra info.
    let context = unsafe { CGPDFContextCreateWithURL(Some(out_url), std::ptr::null(), None) }
        .ok_or("E_PRINT_STAMP_WRITE_FAILED")?;
    let (links, targets) = page_links(&document, pages);
    let date = today();
    let places = MarkPlaces::new(layout.setup.paper, layout.setup.margins);
    for index in 0..pages {
        // SAFETY: `index` is below the page count.
        let Some(page) = (unsafe { document.pageAtIndex(index) }) else {
            continue;
        };
        // SAFETY: a plain property read.
        let bounds = unsafe { page.boundsForBox(PDFDisplayBox::MediaBox) };
        let media = CGRect::new(
            CGPoint::new(0.0, 0.0),
            CGSize::new(bounds.size.width, bounds.size.height),
        );
        // SAFETY: `media` lives for the call; the page is drawn into the
        // context it began.
        unsafe {
            CGContext::begin_page(Some(&context), &media);
            page.drawWithBox_toContext(PDFDisplayBox::MediaBox, &context);
        }
        for (name, point) in &targets[index] {
            CGPDFContextAddDestinationAtPoint(Some(&context), &cf_string(name), *point);
        }
        for link in &links[index] {
            match link {
                PageLink::Url(rect, url) => {
                    // SAFETY: as above, toll-free bridged.
                    let url: &CFURL = unsafe { &*(Retained::as_ptr(url).cast::<CFURL>()) };
                    CGPDFContextSetURLForRect(Some(&context), url, *rect);
                }
                PageLink::Page(rect, name) => {
                    CGPDFContextSetDestinationForRect(Some(&context), &cf_string(name), *rect);
                }
            }
        }
        if !(layout.setup.skip_first && index == 0) {
            let fields = Fields {
                title: &layout.title,
                date: &date,
                page: index + 1,
                total: pages,
            };
            draw_marks(&context, layout, &places, &fields);
        }
        CGContext::end_page(Some(&context));
    }
    CGPDFContextClose(Some(&context));
    Ok(())
}

fn ns_color(c: &Rgba) -> Retained<NSColor> {
    NSColor::colorWithSRGBRed_green_blue_alpha(c.r, c.g, c.b, c.a)
}

fn draw_marks(context: &CGContext, layout: &PageLayout, places: &MarkPlaces, fields: &Fields) {
    let setup = &layout.setup;
    let look = &layout.look;
    let graphics = NSGraphicsContext::graphicsContextWithCGContext_flipped(context, false);
    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&graphics));
    let font = NSFont::systemFontOfSize(look.font_size);
    let color = ns_color(&look.text);
    let line = look.font_size * 1.5;
    let third = (places.right - places.left) / 3.0;
    for (slots, centre, rule_y) in [
        (&setup.header, places.header_y, places.header_rule_y),
        (&setup.footer, places.footer_y, places.footer_rule_y),
    ] {
        if slots.iter().all(String::is_empty) {
            continue;
        }
        for (i, (template, alignment)) in slots
            .iter()
            .zip([
                NSTextAlignment::Left,
                NSTextAlignment::Center,
                NSTextAlignment::Right,
            ])
            .enumerate()
        {
            let text = expand(template, fields);
            if text.is_empty() {
                continue;
            }
            let style = NSMutableParagraphStyle::new();
            style.setAlignment(alignment);
            style.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
            // SAFETY: AppKit's attribute name constants, valid for the life
            // of the process.
            let keys = unsafe {
                [
                    NSFontAttributeName,
                    NSForegroundColorAttributeName,
                    NSParagraphStyleAttributeName,
                ]
            };
            let values: [&AnyObject; 3] = [font.as_ref(), color.as_ref(), style.as_ref()];
            let attributes = NSDictionary::<NSString, AnyObject>::from_slices(&keys, &values);
            let rect = NSRect::new(
                NSPoint::new(places.left + third * i as f64, centre - line / 2.0),
                NSSize::new(third, line),
            );
            // SAFETY: `drawInRect:withAttributes:` draws into the current
            // context, set above; the attributes map AppKit's keys to values
            // of their types.
            unsafe {
                let _: () = msg_send![
                    &*NSString::from_str(&text),
                    drawInRect: rect,
                    withAttributes: &*attributes
                ];
            }
        }
        if setup.rules {
            let r = &look.rule;
            CGContext::set_rgb_stroke_color(Some(context), r.r, r.g, r.b, r.a);
            CGContext::set_line_width(Some(context), 0.5);
            CGContext::move_to_point(Some(context), places.left, rule_y);
            CGContext::add_line_to_point(Some(context), places.right, rule_y);
            CGContext::stroke_path(Some(context));
        }
    }
    NSGraphicsContext::restoreGraphicsState_class();
}
