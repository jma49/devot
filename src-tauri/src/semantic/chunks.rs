//! A note's readable text cut into passages a sentence model takes well: whole sentences, at most
//! `PASSAGE_CHARS` each, the title before each one.

use crate::storage::readable_text;

/// Characters of readable text in one passage (a longer sentence is cut at a space).
pub(crate) const PASSAGE_CHARS: usize = 600;
/// Passages embedded per note; the rest of a long note is found by keyword search alone.
pub(crate) const MAX_PASSAGES: usize = 48;
/// Characters a result shows of its passage.
pub(crate) const EXCERPT_CHARS: usize = 160;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Passage {
    /// What the model reads: the title, then the passage.
    pub embedded: String,
    pub text: String,
}

fn ends_sentence(c: char) -> bool {
    matches!(
        c,
        '.' | '!' | '?' | '\u{3002}' | '\u{ff01}' | '\u{ff1f}' | '\u{ff0e}'
    )
}

/// Full-width enders close a sentence on their own; the others need a space after them.
fn closes_alone(c: char) -> bool {
    matches!(c, '\u{3002}' | '\u{ff01}' | '\u{ff1f}' | '\u{ff0e}')
}

fn sentences(text: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if !ends_sentence(c) {
            continue;
        }
        let end = i + c.len_utf8();
        let next = chars.peek().map(|&(_, n)| n);
        if closes_alone(c) || next.is_none_or(char::is_whitespace) {
            found.push(&text[start..end]);
            start = end;
        }
    }
    found.push(&text[start..]);
    found
        .into_iter()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect()
}

/// `sentence` in pieces of at most `PASSAGE_CHARS` characters, cut at the last space before the
/// limit where there is one.
fn pieces(sentence: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = sentence;
    while rest.chars().count() > PASSAGE_CHARS {
        let limit = rest
            .char_indices()
            .nth(PASSAGE_CHARS)
            .map_or(rest.len(), |(i, _)| i);
        let cut = rest[..limit]
            .rfind(char::is_whitespace)
            .filter(|&at| at > 0)
            .unwrap_or(limit);
        out.push(rest[..cut].trim());
        rest = rest[cut..].trim_start();
    }
    if !rest.is_empty() {
        out.push(rest);
    }
    out
}

pub(crate) fn passages(title: &str, markdown: &str) -> Vec<Passage> {
    let title = title.trim();
    let text = readable_text(markdown);
    let mut texts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut current_chars = 0;
    for piece in sentences(&text).into_iter().flat_map(pieces) {
        let chars = piece.chars().count();
        if current_chars > 0 && current_chars + 1 + chars > PASSAGE_CHARS {
            texts.push(std::mem::take(&mut current));
            current_chars = 0;
        }
        if current_chars > 0 {
            current.push(' ');
            current_chars += 1;
        }
        current.push_str(piece);
        current_chars += chars;
    }
    if current_chars > 0 {
        texts.push(current);
    }
    if texts.is_empty() && !title.is_empty() {
        texts.push(String::new());
    }
    texts
        .into_iter()
        .take(MAX_PASSAGES)
        .map(|text| Passage {
            embedded: match (title.is_empty(), text.is_empty()) {
                (true, _) => text.clone(),
                (false, true) => title.to_owned(),
                (false, false) => format!("{title}. {text}"),
            },
            text,
        })
        .collect()
}

pub(crate) fn excerpt(text: &str) -> String {
    match text.char_indices().nth(EXCERPT_CHARS) {
        None => text.to_owned(),
        Some((at, _)) => {
            let cut = text[..at]
                .rfind(' ')
                .filter(|&i| i > EXCERPT_CHARS / 2)
                .unwrap_or(at);
            format!("{}\u{2026}", text[..cut].trim_end())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentences_split_after_enders_followed_by_space_or_full_width_enders() {
        assert_eq!(
            sentences("One. Two? 3.5 is a number! \u{4f60}\u{597d}\u{3002}\u{518d}\u{89c1}"),
            vec![
                "One.",
                "Two?",
                "3.5 is a number!",
                "\u{4f60}\u{597d}\u{3002}",
                "\u{518d}\u{89c1}"
            ]
        );
    }

    #[test]
    fn passages_hold_whole_sentences_up_to_the_limit_with_the_title_in_front() {
        let sentence = format!("{}.", "word ".repeat(50).trim_end());
        let body = [sentence.as_str(); 5].join(" ");
        let found = passages("Plans", &body);
        assert_eq!(found.len(), 3);
        for passage in &found {
            assert!(passage.text.chars().count() <= PASSAGE_CHARS);
            assert!(passage.text.ends_with('.'));
            assert_eq!(passage.embedded, format!("Plans. {}", passage.text));
        }
    }

    #[test]
    fn markdown_markers_come_out_and_a_long_sentence_is_cut_at_spaces() {
        let found = passages("", &format!("# Heading\n\n**bold** {}", "abc ".repeat(400)));
        assert!(found[0].text.starts_with("Heading bold abc"));
        assert!(
            found
                .iter()
                .all(|p| p.text.chars().count() <= PASSAGE_CHARS)
        );
        assert!(
            found
                .iter()
                .all(|p| !p.text.starts_with(' ') && !p.text.ends_with(' '))
        );
        assert_eq!(found[0].embedded, found[0].text);
    }

    #[test]
    fn a_title_alone_is_one_passage_and_nothing_is_none() {
        assert_eq!(
            passages("Groceries", ""),
            vec![Passage {
                embedded: "Groceries".into(),
                text: String::new()
            }]
        );
        assert!(passages("  ", " \n ").is_empty());
    }

    #[test]
    fn a_long_note_keeps_its_first_passages() {
        let body = "Sentence number one is here. ".repeat(4000);
        assert_eq!(passages("", &body).len(), MAX_PASSAGES);
    }

    #[test]
    fn excerpts_end_at_a_word_with_an_ellipsis() {
        assert_eq!(excerpt("short"), "short");
        let long = "word ".repeat(100);
        let cut = excerpt(&long);
        assert!(cut.ends_with("word\u{2026}"));
        assert!(cut.chars().count() <= EXCERPT_CHARS + 1);
        let cjk = "\u{4f60}".repeat(200);
        assert_eq!(excerpt(&cjk).chars().count(), EXCERPT_CHARS + 1);
    }
}
