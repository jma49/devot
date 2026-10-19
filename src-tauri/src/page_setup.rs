//! Page setup for Print and Export as PDF: the paper, the margins and the
//! header and footer printed in them. The choices are editor settings
//! (`editor_settings`, the `page*` keys); the header and footer are drawn
//! on the printed PDF's pages (`native::macos::stamp_pdf`), since WebKit's
//! print path draws no CSS page-margin boxes.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Paper {
    A4,
    Letter,
    A4Landscape,
    /// A 16:9 slide, 13.33 by 7.5 inches.
    Slide,
}

impl Paper {
    /// Width and height in points.
    pub fn size(self) -> (f64, f64) {
        match self {
            Self::A4 => (595.0, 842.0),
            Self::Letter => (612.0, 792.0),
            Self::A4Landscape => (842.0, 595.0),
            Self::Slide => (960.0, 540.0),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Margins {
    Narrow,
    Normal,
    Wide,
}

impl Margins {
    /// Each edge's margin in points; the header and footer sit in it.
    pub fn points(self) -> f64 {
        match self {
            Self::Narrow => 36.0,
            Self::Normal => 54.0,
            Self::Wide => 72.0,
        }
    }
}

/// The longest header or footer slot, in characters.
pub const SLOT_MAX_CHARS: usize = 100;

/// A header or footer slot: up to `SLOT_MAX_CHARS` characters, none of
/// them control characters. The same check runs in src/core/editorSettings.ts.
pub fn valid_slot(text: &str) -> bool {
    text.chars().count() <= SLOT_MAX_CHARS && !text.chars().any(char::is_control)
}

/// Left, centre and right.
pub type Slots = [String; 3];

#[derive(Debug, Clone, PartialEq)]
pub struct PageSetup {
    pub paper: Paper,
    pub margins: Margins,
    pub header: Slots,
    pub footer: Slots,
    /// The first page goes without the header, the footer and the rules.
    pub skip_first: bool,
    /// A thin rule under the header and above the footer (where they
    /// have text).
    pub rules: bool,
}

/// What a slot's placeholders stand for on one page.
pub struct Fields<'a> {
    pub title: &'a str,
    pub date: &'a str,
    pub page: usize,
    pub total: usize,
}

/// `template` with `{title}`, `{page}`, `{total}` and `{date}` filled in;
/// any other text, braces included, stays as it is.
pub fn expand(template: &str, fields: &Fields) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(at) = rest.find('{') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let filled = [
            ("{title}", fields.title.to_owned()),
            ("{page}", fields.page.to_string()),
            ("{total}", fields.total.to_string()),
            ("{date}", fields.date.to_owned()),
        ]
        .into_iter()
        .find(|(name, _)| rest.starts_with(name));
        match filled {
            Some((name, value)) => {
                out.push_str(&value);
                rest = &rest[name.len()..];
            }
            None => {
                out.push('{');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// An sRGB colour, each channel from 0 to 1.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Rgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

/// How the header and footer look, from the UI's design tokens.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageLook {
    pub text: Rgba,
    pub rule: Rgba,
    /// In points.
    pub font_size: f64,
}

pub const FONT_SIZE_MIN: f64 = 6.0;
pub const FONT_SIZE_MAX: f64 = 24.0;

impl PageLook {
    pub fn valid(&self) -> bool {
        let unit = |v: f64| (0.0..=1.0).contains(&v);
        let colour = |c: &Rgba| [c.r, c.g, c.b, c.a].into_iter().all(unit);
        colour(&self.text)
            && colour(&self.rule)
            && (FONT_SIZE_MIN..=FONT_SIZE_MAX).contains(&self.font_size)
    }
}

/// A note's page as Print and Export as PDF lay it out: on the paper and
/// with the margins of the page setup, with its header and footer.
#[derive(Debug, Clone, PartialEq)]
pub struct PageLayout {
    pub setup: PageSetup,
    pub look: PageLook,
    /// What `{title}` stands for.
    pub title: String,
}

/// Where a page's header, footer and rules go, in PDF points (origin at the
/// bottom left).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MarkPlaces {
    /// The centre lines of the header's and the footer's text.
    pub header_y: f64,
    pub footer_y: f64,
    /// The rules, between the text and the note.
    pub header_rule_y: f64,
    pub footer_rule_y: f64,
    /// The left and right edges of the text and the rules.
    pub left: f64,
    pub right: f64,
}

impl MarkPlaces {
    /// The header and footer sit halfway into their margins, the rules a
    /// quarter of a margin before the note.
    pub fn new(paper: Paper, margins: Margins) -> Self {
        let (width, height) = paper.size();
        let m = margins.points();
        Self {
            header_y: height - m / 2.0,
            footer_y: m / 2.0,
            header_rule_y: height - m * 0.75,
            footer_rule_y: m * 0.75,
            left: m,
            right: width - m,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields() -> Fields<'static> {
        Fields {
            title: "Plan",
            date: "18 Oct 2026",
            page: 2,
            total: 7,
        }
    }

    #[test]
    fn fills_in_every_placeholder() {
        assert_eq!(
            expand("{title} - {date} - {page} / {total}", &fields()),
            "Plan - 18 Oct 2026 - 2 / 7"
        );
        assert_eq!(expand("{page}{page}", &fields()), "22");
        assert_eq!(expand("", &fields()), "");
    }

    #[test]
    fn keeps_other_braces_as_they_are() {
        assert_eq!(expand("{pages} {", &fields()), "{pages} {");
        assert_eq!(expand("{{page}}", &fields()), "{2}");
        assert_eq!(expand("}{title", &fields()), "}{title");
    }

    #[test]
    fn a_value_is_not_expanded_again() {
        let f = Fields {
            title: "{page}",
            ..fields()
        };
        assert_eq!(expand("{title}", &f), "{page}");
    }

    #[test]
    fn slots_are_short_plain_text() {
        assert!(valid_slot(""));
        assert!(valid_slot("{page} of {total}"));
        assert!(valid_slot(&"\u{4e00}".repeat(SLOT_MAX_CHARS)));
        assert!(!valid_slot(&"a".repeat(SLOT_MAX_CHARS + 1)));
        assert!(!valid_slot("a\nb"));
        assert!(!valid_slot("a\u{7f}"));
    }

    #[test]
    fn papers_and_margins_in_points() {
        assert_eq!(Paper::A4.size(), (595.0, 842.0));
        assert_eq!(Paper::Letter.size(), (612.0, 792.0));
        assert_eq!(Paper::A4Landscape.size(), (842.0, 595.0));
        let (w, h) = Paper::Slide.size();
        assert!((w / h - 16.0 / 9.0).abs() < 1e-9);
        assert!(Margins::Narrow.points() < Margins::Normal.points());
        assert!(Margins::Normal.points() < Margins::Wide.points());
    }

    #[test]
    fn marks_sit_in_the_margins_with_the_rules_nearer_the_note() {
        let p = MarkPlaces::new(Paper::Letter, Margins::Normal);
        assert_eq!((p.left, p.right), (54.0, 558.0));
        assert!(p.header_y > p.header_rule_y && p.header_rule_y > 792.0 - 54.0);
        assert!(p.footer_y < p.footer_rule_y && p.footer_rule_y < 54.0);
    }

    #[test]
    fn a_look_has_unit_channels_and_a_readable_size() {
        let c = Rgba {
            r: 0.4,
            g: 0.4,
            b: 0.4,
            a: 1.0,
        };
        let look = PageLook {
            text: c,
            rule: c,
            font_size: 9.0,
        };
        assert!(look.valid());
        assert!(
            !PageLook {
                font_size: 40.0,
                ..look
            }
            .valid()
        );
        assert!(
            !PageLook {
                text: Rgba { r: 1.5, ..c },
                ..look
            }
            .valid()
        );
        assert!(
            !PageLook {
                rule: Rgba { a: f64::NAN, ..c },
                ..look
            }
            .valid()
        );
    }
}
