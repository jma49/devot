//! The readable text of a note body, as a search result's excerpt shows it: front matter skipped,
//! Markdown markers out, text that only looks like syntax kept, each run of whitespace one space.
//! It never panics and runs in linear time.
//! Same rules, step for step, as `readableText` in src/core/readable.ts (which documents them);
//! tests/support/readable-text.json holds cases both sides must agree on. Positions are counted in
//! chars (code points).

use std::collections::{HashMap, HashSet};

const MAX_LABEL_CHARS: usize = 999;
const ALERTS: [&str; 5] = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"];

fn is_space(c: Option<char>) -> bool {
    matches!(c, Some(' ' | '\t'))
}

fn is_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric())
}

fn is_letter(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphabetic())
}

fn is_digit(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_digit())
}

fn is_white(c: Option<char>) -> bool {
    c.is_none_or(char::is_whitespace)
}

fn is_alnum(c: Option<char>) -> bool {
    c.is_some_and(char::is_alphanumeric)
}

fn is_mark(c: Option<char>) -> bool {
    !is_white(c) && !is_alnum(c)
}

fn is_blank(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{c}' | '\u{b}')
}

pub(crate) fn is_fence(line: &str) -> bool {
    line.strip_prefix("---")
        .is_some_and(|rest| rest.chars().all(|c| c == ' ' || c == '\t'))
}

struct Delimiter {
    mark: char,
    open: bool,
    close: bool,
    left: usize,
}

enum Piece {
    Text(String),
    Delimiter(Delimiter),
}

enum Op {
    Text {
        line: Vec<char>,
        table: bool,
        start: bool,
    },
    Code(String),
    End,
}

fn fold_blanks(text: &str) -> String {
    let mut folded = String::new();
    let mut blank = false;
    for c in text.chars() {
        if is_blank(c) {
            blank = true;
        } else {
            if blank && !folded.is_empty() {
                folded.push(' ');
            }
            blank = false;
            folded.push(c);
        }
    }
    folded
}

pub(crate) fn readable_text(markdown: &str) -> String {
    let lines: Vec<&str> = markdown
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    let mut first = 0;
    if is_fence(lines[0])
        && let Some(close) = lines.iter().skip(1).position(|l| is_fence(l))
    {
        first = close + 2;
    }
    let (ops, labels) = blocks(&lines[first..]);

    let mut out: Vec<String> = Vec::new();
    let mut paragraph: Vec<Piece> = Vec::new();
    for op in ops {
        match op {
            Op::End => {
                if !paragraph.is_empty() {
                    out.push(render(&mut paragraph));
                }
                paragraph.clear();
            }
            Op::Code(text) => out.push(text),
            Op::Text { line, table, start } => {
                if !paragraph.is_empty() {
                    paragraph.push(Piece::Text("\n".into()));
                }
                paragraph.extend(inline(&line, &labels, table, start));
            }
        }
    }
    if !paragraph.is_empty() {
        out.push(render(&mut paragraph));
    }
    fold_blanks(&out.join("\n"))
}

fn blocks(body: &[&str]) -> (Vec<Op>, HashSet<String>) {
    let mut ops: Vec<Op> = Vec::new();
    let mut labels = HashSet::new();
    let mut open = false;
    let mut list_paragraph = false;
    let end = |ops: &mut Vec<Op>, open: &mut bool| {
        if *open {
            ops.push(Op::End);
        }
        *open = false;
    };
    let mut fence: Option<(char, usize, usize)> = None;
    let mut comment = false;
    let mut table = false;
    for (l, raw) in body.iter().enumerate() {
        if comment {
            let Some(close) = raw.find("-->") else {
                continue;
            };
            comment = false;
            ops.push(Op::Text {
                line: raw[close + 3..].chars().collect(),
                table: false,
                start: false,
            });
            open = true;
            end(&mut ops, &mut open);
            continue;
        }
        let chars: Vec<char> = raw.chars().collect();
        if let Some((mark, length, quotes)) = fence {
            let (line, found) = strip_quotes(&chars, quotes);
            if found == quotes {
                let run = run_of(line, 0, mark);
                if run >= length && line[run..].iter().all(|&c| is_space(Some(c))) {
                    fence = None;
                } else {
                    ops.push(Op::Code(line.iter().collect()));
                }
                continue;
            }
            fence = None;
        }
        let (mut line, quotes, list) = block_markers(&chars, open && !list_paragraph);
        let head = line.first().copied();
        let run = match head {
            Some(mark @ ('`' | '~')) => run_of(line, 0, mark),
            _ => 0,
        };
        // A backtick fence's info string holds no backtick (else it is code inline).
        if run >= 3 && (head == Some('~') || !line[run..].contains(&'`')) {
            end(&mut ops, &mut open);
            fence = head.map(|mark| (mark, run, quotes));
            table = false;
            continue;
        }
        if line.is_empty() {
            end(&mut ops, &mut open);
            table = false;
            continue;
        }
        if !table && line.contains(&'|') {
            table = body.get(l + 1).is_some_and(|next| {
                let next: Vec<char> = next.chars().collect();
                is_delimiter_row(block_markers(&next, false).0)
            });
        }
        if is_break(line, open) || is_delimiter_row(line) || (quotes > 0 && is_alert(line)) {
            end(&mut ops, &mut open);
            continue;
        }
        // A definition never continues a paragraph. A footnote definition
        // keeps its text; a link reference definition is all syntax.
        let label = if open { None } else { definition(line) };
        let footnote = match label {
            Some(Definition::Link(label)) => {
                labels.insert(label);
                continue;
            }
            Some(Definition::Footnote(text)) => {
                line = &line[text..];
                true
            }
            None => false,
        };
        let heading = strip_heading(line);
        let own = heading.is_some() || table || footnote;
        if own || list {
            end(&mut ops, &mut open);
        }
        if !open {
            list_paragraph = list;
        }
        let start = raw.trim_start_matches([' ', '\t']).starts_with("<!--");
        ops.push(Op::Text {
            line: heading.unwrap_or(line).to_vec(),
            table,
            start,
        });
        open = true;
        comment = start
            && raw
                .find("<!--")
                .is_some_and(|at| !raw[at + 4..].contains("-->"));
        if own || comment {
            end(&mut ops, &mut open);
        }
    }
    end(&mut ops, &mut open);
    (ops, labels)
}

/// The text of a paragraph's pieces: delimiters that pair come out, two
/// characters at a time while both runs have two, else one; what is left
/// of a run shows.
fn render(pieces: &mut [Piece]) -> String {
    let mut open: [Vec<usize>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    let slot = |mark: char| match mark {
        '*' => 0,
        '_' => 1,
        _ => 2,
    };
    for k in 0..pieces.len() {
        let Piece::Delimiter(piece) = &pieces[k] else {
            continue;
        };
        let (s, close) = (slot(piece.mark), piece.close);
        if close {
            while let Some(&at) = open[s].last() {
                let mut closer_left = 0;
                if let Piece::Delimiter(p) = &pieces[k] {
                    closer_left = p.left;
                }
                if closer_left == 0 {
                    break;
                }
                let mut opener_left = 0;
                if let Piece::Delimiter(o) = &pieces[at] {
                    opener_left = o.left;
                }
                let used = if opener_left >= 2 && closer_left >= 2 {
                    2
                } else {
                    1
                };
                if let Piece::Delimiter(o) = &mut pieces[at] {
                    o.left -= used;
                }
                if let Piece::Delimiter(p) = &mut pieces[k] {
                    p.left -= used;
                }
                if opener_left == used {
                    open[s].pop();
                }
                // Openers inside the pair can no longer close past it.
                for (other, waiting) in open.iter_mut().enumerate() {
                    if other == s {
                        continue;
                    }
                    while waiting.last().is_some_and(|&o| o > at) {
                        waiting.pop();
                    }
                }
            }
        }
        if let Piece::Delimiter(p) = &pieces[k]
            && p.open
            && p.left > 0
        {
            open[s].push(k);
        }
    }
    let mut text = String::new();
    for piece in pieces.iter() {
        match piece {
            Piece::Text(t) => text.push_str(t),
            Piece::Delimiter(d) => text.extend(std::iter::repeat_n(d.mark, d.left)),
        }
    }
    text
}

/// None when it is blank or too long to be one.
fn normalize_label(label: &[char]) -> Option<String> {
    if label.len() > MAX_LABEL_CHARS {
        return None;
    }
    let key = fold_blanks(&label.iter().collect::<String>()).to_lowercase();
    (!key.is_empty()).then_some(key)
}

fn run_of(chars: &[char], at: usize, mark: char) -> usize {
    chars
        .get(at..)
        .map_or(0, |rest| rest.iter().take_while(|&&c| c == mark).count())
}

fn strip_quotes(line: &[char], quotes: usize) -> (&[char], usize) {
    let mut at = 0;
    let mut found = 0;
    loop {
        while is_space(line.get(at).copied()) {
            at += 1;
        }
        if found == quotes || line.get(at) != Some(&'>') {
            return (&line[at..], found);
        }
        at += 1;
        found += 1;
    }
}

/// Leading whitespace, quote markers, list markers and task boxes, nested in
/// any order; also how many quote markers there were and whether a list
/// marker was among them. In a paragraph, only an ordered list starting at
/// 1 begins a list.
fn block_markers(line: &[char], paragraph: bool) -> (&[char], usize, bool) {
    let get = |i: usize| line.get(i).copied();
    let mut at = 0;
    let mut quotes = 0;
    let mut list = false;
    loop {
        while is_space(get(at)) {
            at += 1;
        }
        let c = get(at);
        if c == Some('>') {
            at += 1;
            quotes += 1;
            continue;
        }
        let mut marker = 0;
        if matches!(c, Some('-' | '*' | '+')) {
            marker = 1;
        } else if is_digit(c) {
            let mut digits = 0;
            while is_digit(get(at + digits)) {
                digits += 1;
            }
            let number: String = line[at..at + digits].iter().collect();
            let one = number.trim_start_matches('0') == "1";
            let interrupts = !paragraph || list || one;
            if digits <= 9 && matches!(get(at + digits), Some('.' | ')')) && interrupts {
                marker = digits + 1;
            }
        }
        let next = get(at + marker);
        if marker == 0 || (next.is_some() && !is_space(next)) {
            return (&line[at..], quotes, list);
        }
        at += marker;
        list = true;
        while is_space(get(at)) {
            at += 1;
        }
        if get(at) == Some('[')
            && matches!(get(at + 1), Some(' ' | 'x' | 'X'))
            && get(at + 2) == Some(']')
            && (get(at + 3).is_none() || is_space(get(at + 3)))
        {
            at += 3;
        }
    }
}

fn is_break(line: &[char], paragraph: bool) -> bool {
    let Some(&mark @ ('=' | '-' | '*' | '_')) = line.first() else {
        return false;
    };
    if !line.iter().all(|&c| c == mark || is_space(Some(c))) {
        return false;
    }
    if paragraph && (mark == '=' || mark == '-') {
        return true;
    }
    mark != '=' && line.iter().filter(|&&c| c == mark).count() >= 3
}

fn is_delimiter_row(line: &[char]) -> bool {
    line.contains(&'|')
        && line.contains(&'-')
        && line
            .iter()
            .all(|&c| matches!(c, '|' | ':' | '-' | ' ' | '\t'))
}

fn is_alert(line: &[char]) -> bool {
    if line.first() != Some(&'[') || line.get(1) != Some(&'!') {
        return false;
    }
    let Some(close) = line.iter().position(|&c| c == ']') else {
        return false;
    };
    let kind: String = line[2..close].iter().collect();
    ALERTS.iter().any(|a| a.eq_ignore_ascii_case(&kind))
        && line[close + 1..].iter().all(|&c| is_space(Some(c)))
}

enum Definition {
    Link(String),
    Footnote(usize),
}

fn definition(line: &[char]) -> Option<Definition> {
    let get = |i: usize| line.get(i).copied();
    if get(0) != Some('[') {
        return None;
    }
    let close = line.iter().position(|&c| c == ']')?;
    if close < 2 || get(close + 1) != Some(':') {
        return None;
    }
    let label = normalize_label(&line[1..close])?;
    let mut at = close + 2;
    while is_space(get(at)) {
        at += 1;
    }
    if get(1) == Some('^') {
        return Some(Definition::Footnote(at));
    }
    let start = at;
    if get(at) == Some('<') {
        while at < line.len() && line[at] != '>' {
            at += 1;
        }
        if get(at) != Some('>') {
            return None;
        }
        at += 1;
    } else {
        while at < line.len() && !is_space(get(at)) {
            at += 1;
        }
    }
    if at == start {
        return None;
    }
    while is_space(get(at)) {
        at += 1;
    }
    (at == line.len() || is_title(line, at, line.len())).then_some(Definition::Link(label))
}

fn is_title(c: &[char], from: usize, to: usize) -> bool {
    let mut end = to;
    while end > from && is_space(c.get(end - 1).copied()) {
        end -= 1;
    }
    let closer = match c.get(from) {
        Some('"') => '"',
        Some('\'') => '\'',
        Some('(') => ')',
        _ => return false,
    };
    end - from >= 2 && c[end - 1] == closer
}

/// From each position of a line (and its end): the next space or tab, the
/// next character that is neither, and the next unescaped `<` or `>`; the
/// line's length when there is none. With these a destination is checked in
/// constant time, however many links share a long run of text.
struct Ahead {
    space: Vec<usize>,
    solid: Vec<usize>,
    angle: Vec<usize>,
}

impl Ahead {
    fn of(c: &[char]) -> Self {
        let n = c.len();
        // A character after an odd run of backslashes is escaped.
        let mut escaped = vec![false; n];
        let mut slashes = 0usize;
        for (i, &ch) in c.iter().enumerate() {
            escaped[i] = slashes % 2 == 1;
            slashes = if ch == '\\' { slashes + 1 } else { 0 };
        }
        let mut space = vec![n; n + 1];
        let mut solid = vec![n; n + 1];
        let mut angle = vec![n; n + 1];
        for i in (0..n).rev() {
            let blank = is_space(Some(c[i]));
            space[i] = if blank { i } else { space[i + 1] };
            solid[i] = if blank { solid[i + 1] } else { i };
            angle[i] = if matches!(c[i], '<' | '>') && !escaped[i] {
                i
            } else {
                angle[i + 1]
            };
        }
        Self {
            space,
            solid,
            angle,
        }
    }
}

fn is_destination(c: &[char], ahead: &Ahead, from: usize, to: usize) -> bool {
    let mut at = ahead.solid[from].min(to);
    if at < to && c[at] == '<' {
        // <...> holds no unescaped `<`, as in CommonMark.
        let end = ahead.angle[at + 1];
        if end >= to || c[end] != '>' {
            return false;
        }
        at = end + 1;
    } else {
        at = ahead.space[at].min(to);
    }
    at = ahead.solid[at].min(to);
    at == to || is_title(c, at, to)
}

fn strip_heading(line: &[char]) -> Option<&[char]> {
    let get = |i: usize| line.get(i).copied();
    let level = run_of(line, 0, '#');
    if level == 0 || level > 6 || (get(level).is_some() && !is_space(get(level))) {
        return None;
    }
    let mut start = level;
    while is_space(get(start)) {
        start += 1;
    }
    let mut end = line.len();
    while end > start && is_space(get(end - 1)) {
        end -= 1;
    }
    let mut hashes = end;
    while hashes > start && get(hashes - 1) == Some('#') {
        hashes -= 1;
    }
    if hashes == start || is_space(get(hashes - 1)) {
        end = hashes;
    }
    Some(&line[start..end])
}

/// Positions in a line mapped to positions: a link text's closing bracket,
/// a code span's closing run, where to go on from. Empty (all unset) when the
/// line has nothing to map.
struct Marks(Vec<usize>);

impl Marks {
    const UNSET: usize = usize::MAX;

    fn new(n: usize, needed: bool) -> Self {
        Self(if needed {
            vec![Self::UNSET; n]
        } else {
            Vec::new()
        })
    }

    fn get(&self, i: usize) -> Option<usize> {
        self.0.get(i).copied().filter(|&v| v != Self::UNSET)
    }

    fn set(&mut self, i: usize, value: usize) {
        self.0[i] = value;
    }
}

/// `labels` are the defined link references; `table` turns pipes into spaces. `start`: the line
/// opens a comment block, so its text ends at the unclosed `<!--`; elsewhere an unclosed `<!--` is
/// text.
fn inline(c: &[char], labels: &HashSet<String>, table: bool, start: bool) -> Vec<Piece> {
    let n = c.len();
    if !c
        .iter()
        .any(|&ch| matches!(ch, '\\' | '`' | '*' | '_' | '~' | '[' | '<') || (table && ch == '|'))
    {
        return vec![Piece::Text(c.iter().collect())];
    }
    let has_code = c.contains(&'`');
    let has_links = c.contains(&'[');
    let get = |i: usize| c.get(i).copied();
    let escaped =
        |i: usize| get(i) == Some('\\') && get(i + 1).is_some_and(|p| p.is_ascii_punctuation());

    // Code spans: a backtick run closes at the next run of the same length.
    // Backslashes are text inside code, but one before a run keeps it from opening.
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut i = if has_code { 0 } else { n };
    while i < n {
        if c[i] == '`' {
            let length = run_of(c, i, '`');
            runs.push((i, length));
            i += length;
        } else {
            i += 1;
        }
    }
    let mut next_same: Vec<Option<usize>> = vec![None; runs.len()];
    let mut last_of: HashMap<usize, usize> = HashMap::new();
    for r in (0..runs.len()).rev() {
        next_same[r] = last_of.get(&runs[r].1).copied();
        last_of.insert(runs[r].1, r);
    }
    let mut spans = Marks::new(n, has_code);
    let mut r = 0;
    while r < runs.len() {
        match next_same[r] {
            Some(close) if runs[r].0 == 0 || c[runs[r].0 - 1] != '\\' => {
                spans.set(runs[r].0, runs[close].0);
                r = close + 1;
            }
            _ => r += 1,
        }
    }
    let span = |i: usize| spans.get(i).map(|close| (close, run_of(c, i, '`')));

    let mut bracket = Marks::new(n, has_links);
    let mut paren = Marks::new(n, has_links);
    let mut brackets: Vec<usize> = Vec::new();
    let mut parens: Vec<usize> = Vec::new();
    let mut i = if has_links { 0 } else { n };
    while i < n {
        if let Some((close, length)) = span(i) {
            i = close + length;
            continue;
        }
        if escaped(i) {
            i += 2;
            continue;
        }
        match c[i] {
            '[' => brackets.push(i),
            ']' => {
                if let Some(open) = brackets.pop() {
                    bracket.set(open, i);
                }
            }
            '(' => parens.push(i),
            ')' => {
                if let Some(open) = parens.pop() {
                    paren.set(open, i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    let defined = |from: usize, to: usize| {
        !labels.is_empty()
            && to - from <= MAX_LABEL_CHARS
            && normalize_label(&c[from..to]).is_some_and(|key| labels.contains(&key))
    };
    // The end of a link's destination or reference, when `[` at `open` starts
    // one: `(destination "title")`, `[label]` naming a definition, `[]` after
    // a text that names one, or the text alone naming one.
    let tables: std::cell::OnceCell<Ahead> = std::cell::OnceCell::new();
    let link_end = |open: usize| -> Option<usize> {
        let close = bracket.get(open)?;
        match get(close + 1) {
            Some('(') => {
                if let Some(end) = paren.get(close + 1)
                    && is_destination(c, tables.get_or_init(|| Ahead::of(c)), close + 2, end)
                {
                    return Some(end);
                }
            }
            Some('[') => {
                let end = bracket.get(close + 1);
                if end == Some(close + 2) && defined(open + 1, close) {
                    return end;
                }
                if let Some(end) = end
                    && end > close + 2
                {
                    return defined(close + 2, end).then_some(end);
                }
            }
            _ => {}
        }
        defined(open + 1, close).then_some(close)
    };

    let mut comment_ends: Vec<usize> = Vec::new();
    if c.contains(&'<') {
        for k in 0..n.saturating_sub(2) {
            if c[k] == '-' && c[k + 1] == '-' && c[k + 2] == '>' {
                comment_ends.push(k);
            }
        }
    }
    let mut next_end = 0;

    let mut pieces: Vec<Piece> = Vec::new();
    let mut text = String::new();
    // Where to go on from a link text's closing bracket: past its
    // destination; and those closing brackets still ahead, innermost last.
    let mut resume = Marks::new(n, has_links);
    let mut ahead: Vec<usize> = Vec::new();
    let mut i = 0;
    while i < n {
        if let Some(jump) = resume.get(i) {
            ahead.pop();
            i = jump;
            continue;
        }
        let ch = c[i];
        if let Some((close, length)) = span(i) {
            let mut from = i + length;
            let mut to = close;
            // One space on each side is padding, unless the code is only spaces.
            if get(from) == Some(' ')
                && get(to - 1) == Some(' ')
                && to - from > 1
                && c[from..to].iter().any(|&x| x != ' ')
            {
                from += 1;
                to -= 1;
            }
            text.extend(&c[from..to]);
            i = close + length;
            continue;
        }
        if ch == '\\' {
            if escaped(i) {
                text.push(c[i + 1]);
                i += 2;
            } else {
                if i + 1 < n {
                    text.push(ch);
                }
                i += 1;
            }
            continue;
        }
        if ch == '<' {
            let mut comment_end = |from: usize| {
                while next_end < comment_ends.len() && comment_ends[next_end] < from {
                    next_end += 1;
                }
                comment_ends.get(next_end).copied()
            };
            match html_end(c, i, &mut comment_end) {
                Html::Comment if start && i == 0 => break,
                // A tag never runs past the end of the link it starts in.
                Html::Skip { end, keep } if ahead.last().is_none_or(|&a| end < a) => {
                    if keep {
                        text.extend(&c[i + 1..end]);
                    }
                    i = end + 1;
                }
                _ => {
                    text.push(ch);
                    i += 1;
                }
            }
            continue;
        }
        if ch == '!'
            && get(i + 1) == Some('[')
            && let Some(close) = bracket.get(i + 1)
            && let Some(end) = link_end(i + 1)
        {
            resume.set(close, end + 1);
            ahead.push(close);
            i += 2;
            continue;
        }
        if ch == '[' {
            let close = bracket.get(i);
            let inner = bracket.get(i + 1);
            // Not right after a letter or digit: x[[1]] is an index.
            let wiki = match (close, inner) {
                (Some(close), Some(inner))
                    if get(i + 1) == Some('[')
                        && close == inner + 1
                        && !(i > 0 && is_alnum(get(i - 1))) =>
                {
                    wiki_text(c, i + 2, inner).map(|from| (from, inner, close))
                }
                _ => None,
            };
            if let Some((from, inner, close)) = wiki {
                resume.set(inner, close + 1);
                ahead.push(inner);
                i = from;
                continue;
            }
            if let Some(close) = close {
                if get(i + 1) == Some('^') && footnote(c, i + 2, close) {
                    i = close + 1;
                    continue;
                }
                if let Some(end) = link_end(i) {
                    resume.set(close, end + 1);
                    ahead.push(close);
                    i += 1;
                    continue;
                }
            }
            text.push(ch);
            i += 1;
            continue;
        }
        if matches!(ch, '*' | '_' | '~') {
            let length = run_of(c, i, ch);
            // A single tilde is text (about 5); two or more strike through.
            if ch == '~' && length < 2 {
                text.push(ch);
                i += 1;
                continue;
            }
            let before = if i > 0 { get(i - 1) } else { None };
            let after = get(i + length);
            let left = !is_white(after) && (!is_mark(after) || is_white(before) || is_mark(before));
            let right =
                !is_white(before) && (!is_mark(before) || is_white(after) || is_mark(after));
            let underscore = ch == '_';
            pieces.push(Piece::Text(std::mem::take(&mut text)));
            pieces.push(Piece::Delimiter(Delimiter {
                mark: ch,
                open: left && (!underscore || !right || is_mark(before)),
                close: right && (!underscore || !left || is_mark(after)),
                left: length,
            }));
            i += length;
            continue;
        }
        text.push(if table && ch == '|' { ' ' } else { ch });
        i += 1;
    }
    pieces.push(Piece::Text(text));
    pieces
}

fn wiki_text(c: &[char], from: usize, to: usize) -> Option<usize> {
    let mut label = None;
    for (k, &ch) in c.iter().enumerate().take(to).skip(from) {
        if ch == '[' || ch == ']' {
            return None;
        }
        if ch == '|' && label.is_none() {
            label = Some(k + 1);
        }
    }
    Some(label.unwrap_or(from))
}

fn footnote(c: &[char], from: usize, to: usize) -> bool {
    from < to
        && c[from..to]
            .iter()
            .all(|&ch| !matches!(ch, ' ' | '\t' | '[' | ']'))
}

enum Html {
    Comment,
    Skip { end: usize, keep: bool },
    None,
}

fn html_end(c: &[char], at: usize, comment_end: &mut impl FnMut(usize) -> Option<usize>) -> Html {
    let get = |i: usize| c.get(i).copied();
    if get(at + 1) == Some('!') && get(at + 2) == Some('-') && get(at + 3) == Some('-') {
        return match comment_end(at + 4) {
            Some(close) => Html::Skip {
                end: close + 2,
                keep: false,
            },
            None => Html::Comment,
        };
    }
    let mut k = at + 1;
    if is_letter(get(k)) {
        k += 1;
        while k - at <= 32 && (is_word(get(k)) || matches!(get(k), Some('+' | '.' | '-'))) {
            k += 1;
        }
        if get(k) == Some(':') {
            k += 1;
            while k < c.len() && !matches!(c[k], ' ' | '\t' | '<' | '>') {
                k += 1;
            }
            if get(k) == Some('>') {
                return Html::Skip { end: k, keep: true };
            }
        }
    }
    k = at + 1;
    let closing = get(k) == Some('/');
    if closing {
        k += 1;
    }
    if !is_letter(get(k)) {
        return Html::None;
    }
    while is_word(get(k)) || get(k) == Some('-') {
        k += 1;
    }
    if is_space(get(k)) && !closing {
        while k < c.len() && c[k] != '>' && c[k] != '<' {
            k += 1;
        }
    } else {
        while is_space(get(k)) {
            k += 1;
        }
        if get(k) == Some('/') && !closing {
            k += 1;
        }
    }
    if get(k) == Some('>') {
        Html::Skip {
            end: k,
            keep: false,
        }
    } else {
        Html::None
    }
}

#[cfg(test)]
mod tests {
    use super::readable_text;

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        markdown: String,
        text: String,
    }

    #[test]
    fn agrees_with_the_shared_cases() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../../tests/support/readable-text.json"))
                .unwrap();
        assert!(cases.len() > 30);
        for case in cases {
            assert_eq!(readable_text(&case.markdown), case.text, "{}", case.name);
        }
    }

    struct Rng(u64);
    impl Rng {
        fn below(&mut self, n: usize) -> usize {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 % n as u64) as usize
        }
    }

    use std::time::{Duration, Instant};

    fn best_of_five(work: &impl Fn(&str), input: &str) -> Duration {
        (0..5)
            .map(|_| {
                let started = Instant::now();
                work(input);
                started.elapsed()
            })
            .min()
            .unwrap_or_default()
    }

    const HANG_CEILING: Duration = Duration::from_secs(120);

    /// Four times the size takes about four times as long (sixteen times for quadratic work; the
    /// limit is in between), whatever the machine's speed or load. Then runs the full `size` once,
    /// under a ceiling that only a hang reaches.
    fn assert_linear(work: impl Fn(&str), make: impl Fn(usize) -> String, size: usize) {
        let (small_input, large_input) = (make(size / 16), make(size / 4));
        // A load spike on a shared runner can slow one size more than the other:
        // keep each size's fastest run over three interleaved rounds, so a spike
        // has to hit every round to skew the ratio. (The best ratio of separate
        // tries would let one lucky try pass quadratic work.)
        let (mut small, mut large) = (Duration::MAX, Duration::MAX);
        for _ in 0..3 {
            small = small.min(best_of_five(&work, &small_input));
            large = large.min(best_of_five(&work, &large_input));
        }
        // Timer noise below a millisecond says nothing about growth.
        let growth = large.as_secs_f64() / small.max(Duration::from_millis(1)).as_secs_f64();
        assert!(
            growth < 11.0,
            "four times the input took {growth:.1} times as long ({small:?} to {large:?})"
        );
        let started = Instant::now();
        work(&make(size));
        assert!(
            started.elapsed() < HANG_CEILING,
            "took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn the_growth_check_tells_quadratic_from_linear() {
        let make = |n: usize| "a".repeat(n);
        let linear = |text: &str| {
            std::hint::black_box(text.bytes().filter(|b| *b == b'a').count());
        };
        assert_linear(linear, make, 4_000_000);
        let quadratic = |text: &str| {
            let bytes = text.as_bytes();
            let mut same = 0usize;
            for a in bytes {
                for b in bytes {
                    same += usize::from(a == b);
                }
            }
            std::hint::black_box(same);
        };
        let failed = std::panic::catch_unwind(|| assert_linear(quadratic, make, 40_000));
        assert!(failed.is_err(), "quadratic work passed the check");
    }

    #[test]
    fn stays_linear_on_input_made_to_be_slow() {
        let makers: [fn(usize) -> String; 10] = [
            |n| "[".repeat(n),
            |n| "[[".repeat(n / 2) + &"]]".repeat(n / 2),
            |n| "[^".repeat(n / 2) + &"]".repeat(n / 2),
            |n| "<!--".repeat(n / 4),
            |n| format!("[a <!--{}](u) -->", "<!--".repeat(n / 4)),
            |n| "<a:b".repeat(n / 4),
            |n| "`".repeat(n),
            |n| "*_~~".repeat(n / 4),
            |n| "[".repeat(n / 2) + &"][]".repeat(n / 2),
            |n| "[x](".repeat(n / 4) + &")".repeat(n / 4),
        ];
        for make in makers {
            assert_linear(
                |text| {
                    readable_text(text);
                },
                |n| format!("x{0}\n{0}", make(n)),
                200_000,
            );
        }
    }

    #[test]
    fn checks_nested_link_destinations_in_linear_time() {
        let makers: [fn(usize) -> String; 2] = [
            |k| "[a](".repeat(k) + " x" + &")".repeat(k),
            |k| "[a](<".repeat(k) + &">)".repeat(k),
        ];
        for make in makers {
            assert_linear(
                |text| {
                    readable_text(text);
                },
                make,
                50_000,
            );
        }
    }

    #[test]
    fn never_panics_and_folds_whitespace() {
        const PIECES: &[&str] = &[
            "*",
            "_",
            "~",
            "`",
            "[",
            "]",
            "(",
            ")",
            "!",
            "<",
            ">",
            "#",
            "-",
            "=",
            "|",
            ":",
            "\\",
            "^",
            "\"",
            "/",
            " ",
            "\n",
            "\t",
            "\r",
            "---\n",
            "```",
            "<!--",
            "-->",
            "[[",
            "]]",
            "](",
            "<a>",
            "<https:",
            "a",
            "Z",
            "7",
            ".",
            "\u{4f1a}",
            "\u{1f680}",
            "\u{3000}",
        ];
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for _ in 0..5000 {
            let len = rng.below(60);
            let markdown: String = (0..len).map(|_| PIECES[rng.below(PIECES.len())]).collect();
            let text = readable_text(&markdown);
            assert!(
                !text.starts_with(' ') && !text.ends_with(' '),
                "{markdown:?}"
            );
            assert!(!text.contains("  "), "{markdown:?}");
            assert!(
                !text.contains(['\t', '\n', '\r', '\u{b}', '\u{c}']),
                "{markdown:?}"
            );
        }
    }

    #[test]
    fn takes_the_markers_out_and_keeps_the_words() {
        let inline: &[fn(&str) -> String] = &[
            |w| format!("*{w}*"),
            |w| format!("**{w}**"),
            |w| format!("_{w}_"),
            |w| format!("__{w}__"),
            |w| format!("~~{w}~~"),
            |w| format!("[{w}](https://devot.app/a_(b))"),
            |w| format!("![{w}](image.png \"Title\")"),
            |w| format!("[{w}][ref]"),
            |w| format!("<span class=\"x\">{w}</span>"),
        ];
        let block: &[fn(&str) -> String] = &[
            |l| l.to_string(),
            |l| format!("# {l}"),
            |l| format!("### {l} ###"),
            |l| format!("> > {l}"),
            |l| format!("12. {l}"),
            |l| format!("> - [ ] {l}"),
            |l| format!("{l}\n==="),
            |l| format!("| {l} |\n| --- |"),
            |l| format!("---\ntitle: Front\n---\n{l}"),
        ];
        let letters = ['a', 'Z', '7', '\u{4f1a}', '\u{8ba1}', '\u{1f680}'];
        let mut rng = Rng(42);
        for _ in 0..3000 {
            let count = 1 + rng.below(5);
            let mut words = Vec::new();
            let mut parts = Vec::new();
            for _ in 0..count {
                let word: String = (0..1 + rng.below(5))
                    .map(|_| letters[rng.below(letters.len())])
                    .collect();
                let mut part = match rng.below(3) {
                    0 => word.clone(),
                    1 => format!("[[{word}]]"),
                    _ => format!("[[Target|{word}]]"),
                };
                let mut used = [false; 3];
                for _ in 0..rng.below(4) {
                    let k = rng.below(inline.len());
                    let family = match k {
                        0 | 1 => Some(0),
                        2 | 3 => Some(1),
                        4 => Some(2),
                        _ => None,
                    };
                    if let Some(f) = family
                        && std::mem::replace(&mut used[f], true)
                    {
                        continue;
                    }
                    part = inline[k](&part);
                }
                words.push(word);
                parts.push(part);
            }
            let markdown = format!(
                "{}\n\n[ref]: https://devot.app",
                block[rng.below(block.len())](&parts.join(" "))
            );
            assert_eq!(readable_text(&markdown), words.join(" "), "{markdown:?}");
        }
    }
}
