//! Per-dialect tokenizers.
//!
//! KalCode does not know which shell a provider hands a command to, and the three shells a
//! Windows or POSIX host commonly uses disagree about quoting, escaping and separators:
//!
//! | text                     | POSIX sh            | cmd.exe                 | PowerShell            |
//! |--------------------------|---------------------|-------------------------|-----------------------|
//! | `echo ^& rm -rf x`       | `echo ^` **and** rm | `echo &` (one command)  | `echo ^` **and** rm   |
//! | `echo 'a & rd /s /q x'`  | one command         | `echo 'a` **and** rd    | one command           |
//! | `echo “it's” ; rm -r x`  | one command         | one command (`;` ≠ sep) | `echo` **and** rm     |
//! | `@rd /s /q x`            | program `@rd`       | `rd /s /q x`            | splat `@rd`           |
//! | `{rm,-rf,x}`             | `rm -rf x`          | program `{rm,-rf,x}`    | script block          |
//!
//! The classifier therefore reads every command text under **each** dialect (plus the legacy
//! union reading in `command.rs`) and combines the results: the scopes of every reading are
//! added together and any reading that cannot be interpreted makes the command opaque, so the
//! most authority-requiring interpretation always wins.

use super::{Redirect, Tokenizer, extract_balanced, find_char};

/// Tokenizes `input` the way POSIX `sh`/bash does.
pub(super) fn tokenize_posix(input: &str) -> Tokenizer {
    let chars: Vec<char> = input.chars().collect();
    let n = chars.len();
    let mut t = Tokenizer::default();
    // Brace expansion (`{rm,-rf,x}`, `a{1..3}`) turns one word into several.
    let mut brace_open = false;
    let mut brace_list = false;
    let mut i = 0;
    while i < n {
        if t.word.is_none() {
            brace_open = false;
            brace_list = false;
        }
        let c = chars[i];
        match c {
            ' ' | '\t' => t.finish_word(),
            '\n' | ';' => t.finish_segment(false),
            '&' => {
                if chars.get(i + 1) == Some(&'&') {
                    i += 1;
                    t.finish_segment(false);
                } else if chars.get(i + 1) == Some(&'>') {
                    t.finish_word();
                    i += 1;
                    if chars.get(i + 1) == Some(&'>') {
                        i += 1;
                    }
                    t.redirect = Some(Redirect::Write);
                } else {
                    t.finish_segment(false);
                }
            }
            '|' => {
                if chars.get(i + 1) == Some(&'|') {
                    i += 1;
                    t.finish_segment(false);
                } else {
                    if chars.get(i + 1) == Some(&'&') {
                        i += 1;
                    }
                    t.finish_segment(true);
                }
            }
            '(' | ')' => {
                if c == '(' && chars.get(i + 1) == Some(&')') && t.word.is_some() {
                    t.problems.push("defines a shell function");
                }
                t.finish_segment(false);
            }
            '{' if t.word.is_none()
                && chars
                    .get(i + 1)
                    .is_none_or(|next| next.is_whitespace() || *next == ';') =>
            {
                t.finish_segment(false);
            }
            '}' if t.word.is_none() => t.finish_segment(false),
            '{' => {
                brace_open = true;
                t.word().text.push('{');
            }
            ',' if brace_open => {
                brace_list = true;
                t.word().text.push(',');
            }
            '.' if brace_open && chars.get(i + 1) == Some(&'.') => {
                brace_list = true;
                t.word().text.push('.');
            }
            '}' => {
                if brace_open && brace_list {
                    t.word().expansion = true;
                }
                t.word().text.push('}');
            }
            '#' if t.word.is_none() => {
                // A comment runs to the end of the line.
                i = find_char(&chars, i, '\n').map_or(n, |p| p - 1);
            }
            '<' | '>' => i = redirect_posix(&mut t, &chars, i),
            '\'' => match find_char(&chars, i + 1, '\'') {
                Some(end) => {
                    let word = t.word();
                    word.quoted = true;
                    word.text.extend(&chars[i + 1..end]);
                    i = end;
                }
                None => {
                    t.problems.push("has an unterminated quote");
                    i = n;
                }
            },
            '"' => i = double_quoted_posix(&mut t, &chars, i + 1),
            '`' => match closing_backtick(&chars, i + 1) {
                Some(end) => {
                    t.word().expansion = true;
                    t.word().text.push_str("`…`");
                    t.substitutions.push(chars[i + 1..end].iter().collect());
                    i = end;
                }
                None => {
                    t.problems.push("has an unterminated command substitution");
                    i = n;
                }
            },
            '$' if chars.get(i + 1) == Some(&'\'') => {
                // ANSI-C quoting: `$'\x72\x6d'` is `rm`.
                match ansi_c_quoted(&chars, i + 2) {
                    Some((text, end)) => {
                        let word = t.word();
                        word.quoted = true;
                        word.text.push_str(&text);
                        i = end;
                    }
                    None => {
                        t.problems.push("has an unterminated quote");
                        i = n;
                    }
                }
            }
            '$' if chars.get(i + 1) == Some(&'"') => {
                // Locale-translated string: a double-quoted string.
                i = double_quoted_posix(&mut t, &chars, i + 2);
            }
            '$' => {
                i = t.dollar(&chars, i);
                continue;
            }
            '\\' => match chars.get(i + 1) {
                Some('\n') => i += 1,
                Some(&next) => {
                    t.word().text.push(next);
                    i += 1;
                }
                None => t.word().text.push('\\'),
            },
            '*' | '?' | '[' => {
                let word = t.word();
                word.glob = true;
                word.text.push(c);
            }
            '~' if t.word.is_none() => {
                let word = t.word();
                word.expansion = true;
                word.text.push('~');
            }
            _ => t.word().text.push(c),
        }
        i += 1;
    }
    t.finish_segment(false);
    t
}

/// Redirections shared by POSIX shells. Returns the index of the last character consumed.
fn redirect_posix(t: &mut Tokenizer, chars: &[char], i: usize) -> usize {
    let c = chars[i];
    if let Some(word) = &t.word
        && !word.quoted
        && !word.text.is_empty()
        && word.text.chars().all(|d| d.is_ascii_digit())
    {
        t.word = None; // a file-descriptor number
    }
    t.finish_word();
    if chars.get(i + 1) == Some(&'(') {
        return match extract_balanced(chars, i + 2) {
            Some((inner, end)) => {
                t.substitutions.push(inner);
                t.word().expansion = true;
                t.word().text.push_str("<(…)");
                end
            }
            None => {
                t.problems.push("has an unbalanced process substitution");
                chars.len()
            }
        };
    }
    if c == '<' {
        return match chars.get(i + 1) {
            Some('<') => {
                t.redirect = Some(Redirect::Data);
                if chars.get(i + 2) == Some(&'<') {
                    i + 2
                } else {
                    t.problems.push("uses a here-document");
                    i + 1
                }
            }
            Some('>') => {
                t.redirect = Some(Redirect::Write);
                i + 1
            }
            Some('&') => {
                let mut j = i + 1;
                while chars
                    .get(j + 1)
                    .is_some_and(|d| d.is_ascii_digit() || *d == '-')
                {
                    j += 1;
                }
                j
            }
            _ => {
                t.redirect = Some(Redirect::Read);
                i
            }
        };
    }
    let mut j = i + 1;
    if matches!(chars.get(j), Some('>' | '|')) {
        j += 1;
    }
    if chars.get(j) == Some(&'&') {
        if chars
            .get(j + 1)
            .is_some_and(|d| d.is_ascii_digit() || *d == '-')
        {
            j += 1;
            while chars
                .get(j)
                .is_some_and(|d| d.is_ascii_digit() || *d == '-')
            {
                j += 1;
            }
            return j - 1;
        }
        t.redirect = Some(Redirect::Write);
        return j;
    }
    t.redirect = Some(Redirect::Write);
    j - 1
}

/// Reads a POSIX double-quoted string starting just after the opening quote. Returns the index
/// of the closing quote (or the end of the input, with a problem recorded).
fn double_quoted_posix(t: &mut Tokenizer, chars: &[char], start: usize) -> usize {
    let n = chars.len();
    t.word().quoted = true;
    let mut j = start;
    while j < n {
        let d = chars[j];
        if d == '"' {
            return j;
        }
        if d == '\\' && j + 1 < n {
            match chars[j + 1] {
                '"' | '\\' | '$' | '`' => {
                    t.word().text.push(chars[j + 1]);
                    j += 2;
                    continue;
                }
                '\n' => {
                    j += 2;
                    continue;
                }
                _ => {}
            }
        }
        if d == '`' {
            match closing_backtick(chars, j + 1) {
                Some(end) => {
                    t.word().expansion = true;
                    t.substitutions.push(chars[j + 1..end].iter().collect());
                    j = end + 1;
                }
                None => {
                    t.problems.push("has an unterminated command substitution");
                    return n;
                }
            }
            continue;
        }
        if d == '$' {
            j = t.dollar(chars, j);
            continue;
        }
        t.word().text.push(d);
        j += 1;
    }
    t.problems.push("has an unterminated quote");
    n
}

/// Finds the backtick closing a command substitution, honouring `` \` `` escapes.
fn closing_backtick(chars: &[char], from: usize) -> Option<usize> {
    let mut j = from;
    while j < chars.len() {
        match chars[j] {
            '\\' => j += 2,
            '`' => return Some(j),
            _ => j += 1,
        }
    }
    None
}

/// Decodes a bash `$'…'` string starting just after the quote. Returns the text and the index of
/// the closing quote.
fn ansi_c_quoted(chars: &[char], start: usize) -> Option<(String, usize)> {
    let mut out = String::new();
    let mut j = start;
    while j < chars.len() {
        let c = chars[j];
        if c == '\'' {
            return Some((out, j));
        }
        if c != '\\' {
            out.push(c);
            j += 1;
            continue;
        }
        let &e = chars.get(j + 1)?;
        j += 2;
        let simple = match e {
            'a' => Some('\u{7}'),
            'b' => Some('\u{8}'),
            'e' | 'E' => Some('\u{1b}'),
            'f' => Some('\u{c}'),
            'n' => Some('\n'),
            'r' => Some('\r'),
            't' => Some('\t'),
            'v' => Some('\u{b}'),
            '\\' | '\'' | '"' | '?' => Some(e),
            _ => None,
        };
        if let Some(ch) = simple {
            out.push(ch);
            continue;
        }
        let (radix, max) = match e {
            'x' => (16, 2),
            'u' => (16, 4),
            'U' => (16, 8),
            '0'..='7' => {
                j -= 1; // the first digit is part of the number
                (8, 3)
            }
            'c' => {
                if let Some(&ctl) = chars.get(j) {
                    out.push(char::from((ctl as u32 & 0x1f) as u8));
                    j += 1;
                }
                continue;
            }
            _ => {
                out.push('\\');
                out.push(e);
                continue;
            }
        };
        let mut value = 0u32;
        let mut digits = 0;
        while digits < max
            && let Some(d) = chars.get(j).and_then(|d| d.to_digit(radix))
        {
            value = value.saturating_mul(radix).saturating_add(d);
            digits += 1;
            j += 1;
        }
        if digits == 0 {
            out.push('\\');
            out.push(e);
        } else {
            out.push(char::from_u32(value).unwrap_or('\u{FFFD}'));
        }
    }
    None
}

/// Tokenizes `input` the way cmd.exe does.
///
/// * `%VAR%` is expanded **before** the line is parsed, so its value can add `&`, `|` or
///   redirections: any `%VAR%` reference makes the command opaque.
/// * `^` escapes the next character outside double quotes; inside them it is literal.
/// * `'`, `` ` ``, `$` and `\` are ordinary characters; `,` and `;` separate arguments.
/// * `@` before a command only hides its echo, and a command name ends at `/`.
pub(super) fn tokenize_cmd(input: &str) -> Tokenizer {
    let chars: Vec<char> = input.chars().collect();
    let n = chars.len();
    let mut t = Tokenizer::default();
    if !percent_references(input).is_empty() {
        t.problems
            .push("expands %VARIABLES% before cmd.exe parses the line");
    }
    let mut quoted = false;
    let mut i = 0;
    while i < n {
        let c = chars[i];
        if quoted {
            match c {
                '"' => quoted = false,
                '\n' => {
                    quoted = false;
                    t.finish_segment(false);
                }
                _ => push_cmd_char(&mut t, c),
            }
            i += 1;
            continue;
        }
        match c {
            ' ' | '\t' | '\r' | ',' | ';' | '\u{b}' | '\u{c}' => t.finish_word(),
            '\n' => t.finish_segment(false),
            '"' => {
                quoted = true;
                t.word().quoted = true;
            }
            '^' => match chars.get(i + 1) {
                Some('\r') if chars.get(i + 2) == Some(&'\n') => {
                    // Line continuation: the first character of the next line is escaped.
                    i += 2;
                    if let Some(&next) = chars.get(i + 1) {
                        t.word().text.push(next);
                        i += 1;
                    }
                }
                Some('\n') => {
                    i += 1;
                    if let Some(&next) = chars.get(i + 1) {
                        t.word().text.push(next);
                        i += 1;
                    }
                }
                Some(&next) => {
                    t.word().text.push(next);
                    i += 1;
                }
                None => {}
            },
            '&' => {
                if chars.get(i + 1) == Some(&'&') {
                    i += 1;
                }
                t.finish_segment(false);
            }
            '|' => {
                if chars.get(i + 1) == Some(&'|') {
                    i += 1;
                    t.finish_segment(false);
                } else {
                    t.finish_segment(true);
                }
            }
            '(' | ')' => t.finish_segment(false),
            '<' | '>' => {
                if let Some(word) = &t.word
                    && !word.quoted
                    && word.text.len() == 1
                    && word.text.chars().all(|d| d.is_ascii_digit())
                {
                    t.word = None; // `2>` names a stream
                }
                t.finish_word();
                if c == '<' {
                    t.redirect = Some(Redirect::Read);
                } else {
                    if chars.get(i + 1) == Some(&'>') {
                        i += 1;
                    }
                    if chars.get(i + 1) == Some(&'&')
                        && chars.get(i + 2).is_some_and(char::is_ascii_digit)
                    {
                        i += 2; // `2>&1`
                    } else {
                        t.redirect = Some(Redirect::Write);
                    }
                }
            }
            '*' | '?' => {
                let word = t.word();
                word.glob = true;
                word.text.push(c);
            }
            _ => push_cmd_char(&mut t, c),
        }
        i += 1;
    }
    t.finish_segment(false);
    for segment in &mut t.segments {
        normalize_cmd_segment(segment);
    }
    t
}

fn push_cmd_char(t: &mut Tokenizer, c: char) {
    let word = t.word();
    word.text.push(c);
    if (c == '%' && !percent_references(&word.text).is_empty())
        || (c == '!' && !delayed_references(&word.text).is_empty())
    {
        word.expansion = true;
    }
}

/// `@rd/s/q x` → `rd /s /q x`.
fn normalize_cmd_segment(segment: &mut super::Segment) {
    let Some(first) = segment.words.first_mut() else {
        return;
    };
    if !first.quoted {
        let stripped = first.text.trim_start_matches('@').to_owned();
        if stripped.is_empty() {
            segment.words.remove(0);
            normalize_cmd_segment(segment);
            return;
        }
        first.text = stripped;
    }
    let mut words = std::mem::take(&mut segment.words);
    let mut out = Vec::with_capacity(words.len() + 2);
    for (index, word) in words.drain(..).enumerate() {
        let text = word.text.clone();
        if index == 0
            && !word.quoted
            && let Some(slash) = text.find('/')
            && slash > 0
            && !text[..slash].contains([':', '\\', '%', '!'])
        {
            let mut head = word.clone();
            head.text = text[..slash].to_owned();
            out.push(head);
            for switch in split_switches(&text[slash..]) {
                let mut part = word.clone();
                part.text = switch;
                out.push(part);
            }
            continue;
        }
        if index > 0 && !word.quoted && is_switch_cluster(&text) {
            for switch in split_switches(&text) {
                let mut part = word.clone();
                part.text = switch;
                out.push(part);
            }
            continue;
        }
        out.push(word);
    }
    segment.words = out;
}

/// `/s/q` or `/f/s/q/a:h` — several cmd.exe switches written together.
fn is_switch_cluster(text: &str) -> bool {
    text.starts_with('/')
        && text.matches('/').count() > 1
        && text[1..].split('/').all(|part| {
            let name = part.split(':').next().unwrap_or_default();
            !name.is_empty() && name.len() <= 2 && name.chars().all(|c| c.is_ascii_alphabetic())
        })
}

fn split_switches(text: &str) -> Vec<String> {
    if !is_switch_cluster(text) {
        return vec![text.to_owned()];
    }
    text.split('/')
        .filter(|part| !part.is_empty())
        .map(|part| format!("/{part}"))
        .collect()
}

/// Maps the characters PowerShell treats as quotes and dashes to their ASCII forms.
pub(super) fn powershell_normalize(input: &str) -> String {
    input
        .chars()
        .map(|c| match c {
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            '\u{201C}' | '\u{201D}' | '\u{201E}' => '"',
            // En dash, em dash and horizontal bar are PowerShell dashes; the figure dash is
            // included too so a look-alike can never hide a parameter.
            '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}' => '-',
            _ => c,
        })
        .collect()
}

/// Tokenizes `input` the way PowerShell does.
///
/// * Smart quotes are quotes and en/em dashes are dashes (`–Recurse` is `-Recurse`).
/// * `` ` `` escapes the next character; `''` and `""` are escaped quotes.
/// * `&` at the start of a command is the call operator; `{ … }` script blocks and `( … )`
///   groups contain commands that run.
/// * `#` starts a comment and `<# … #>` is a block comment.
pub(super) fn tokenize_powershell(input: &str) -> Tokenizer {
    let normalized = powershell_normalize(input);
    let chars: Vec<char> = normalized.chars().collect();
    let n = chars.len();
    let mut t = Tokenizer::default();
    let mut i = 0;
    while i < n {
        let c = chars[i];
        match c {
            '\n' | ';' => t.finish_segment(false),
            _ if c.is_whitespace() => t.finish_word(),
            '&' => {
                if chars.get(i + 1) == Some(&'&') {
                    i += 1;
                    t.finish_segment(false);
                } else if t.word.is_none() && t.seg.words.is_empty() && t.seg.redirects.is_empty() {
                    // Call operator: the next word is the command.
                } else {
                    t.finish_segment(false);
                }
            }
            '|' => {
                if chars.get(i + 1) == Some(&'|') {
                    i += 1;
                    t.finish_segment(false);
                } else {
                    t.finish_segment(true);
                }
            }
            '(' | ')' | '{' | '}' => t.finish_segment(false),
            '#' if t.word.is_none() => {
                i = find_char(&chars, i, '\n').map_or(n, |p| p - 1);
            }
            '<' if chars.get(i + 1) == Some(&'#') => {
                t.finish_word();
                match find_block_comment_end(&chars, i + 2) {
                    Some(end) => i = end,
                    None => {
                        t.problems.push("has an unterminated comment");
                        i = n;
                    }
                }
            }
            '<' | '>' => {
                if let Some(word) = &t.word
                    && !word.quoted
                    && (word.text == "*" || word.text.chars().all(|d| d.is_ascii_digit()))
                {
                    t.word = None; // `2>` / `*>` name streams
                }
                t.finish_word();
                if c == '<' {
                    t.redirect = Some(Redirect::Read);
                } else {
                    if chars.get(i + 1) == Some(&'>') {
                        i += 1;
                    }
                    if chars.get(i + 1) == Some(&'&')
                        && chars.get(i + 2).is_some_and(char::is_ascii_digit)
                    {
                        i += 2;
                    } else {
                        t.redirect = Some(Redirect::Write);
                    }
                }
            }
            '@' if t.word.is_none()
                && matches!(chars.get(i + 1), Some('\'' | '"'))
                && chars.get(i + 2).is_some_and(|d| *d == '\n' || *d == '\r') =>
            {
                i = here_string(&mut t, &chars, i);
            }
            '\'' => {
                t.word().quoted = true;
                let mut j = i + 1;
                let mut closed = false;
                while j < n {
                    if chars[j] == '\'' {
                        if chars.get(j + 1) == Some(&'\'') {
                            t.word().text.push('\'');
                            j += 2;
                            continue;
                        }
                        closed = true;
                        break;
                    }
                    t.word().text.push(chars[j]);
                    j += 1;
                }
                if closed {
                    i = j;
                } else {
                    t.problems.push("has an unterminated quote");
                    i = n;
                }
            }
            '"' => i = double_quoted_powershell(&mut t, &chars, i + 1),
            '`' => match chars.get(i + 1) {
                Some('\n') => i += 1,
                Some('\r') if chars.get(i + 2) == Some(&'\n') => i += 2,
                Some(&next) => {
                    t.word().text.push(powershell_escape(next));
                    i += 1;
                }
                None => {}
            },
            '$' => {
                i = t.dollar(&chars, i);
                continue;
            }
            '*' | '?' | '[' => {
                let word = t.word();
                word.glob = true;
                word.text.push(c);
            }
            _ => t.word().text.push(c),
        }
        i += 1;
    }
    t.finish_segment(false);
    if t.segments
        .iter()
        .flat_map(|s| s.words.iter())
        .any(|w| !w.quoted && w.text == "--%")
    {
        t.problems.push("uses PowerShell's stop-parsing token");
    }
    t
}

fn powershell_escape(c: char) -> char {
    match c {
        '0' => '\0',
        'a' => '\u{7}',
        'b' => '\u{8}',
        'e' => '\u{1b}',
        'f' => '\u{c}',
        'n' => '\n',
        'r' => '\r',
        't' => '\t',
        'v' => '\u{b}',
        other => other,
    }
}

fn find_block_comment_end(chars: &[char], from: usize) -> Option<usize> {
    let mut j = from;
    while j + 1 < chars.len() {
        if chars[j] == '#' && chars[j + 1] == '>' {
            return Some(j + 1);
        }
        j += 1;
    }
    None
}

/// Reads a PowerShell double-quoted string starting just after the opening quote.
fn double_quoted_powershell(t: &mut Tokenizer, chars: &[char], start: usize) -> usize {
    let n = chars.len();
    t.word().quoted = true;
    let mut j = start;
    while j < n {
        let d = chars[j];
        match d {
            '"' if chars.get(j + 1) == Some(&'"') => {
                t.word().text.push('"');
                j += 2;
            }
            '"' => return j,
            '`' => {
                match chars.get(j + 1) {
                    Some('u') if chars.get(j + 2) == Some(&'{') => {
                        t.problems.push("uses a Unicode escape");
                        t.word().text.push('u');
                    }
                    Some(&next) => t.word().text.push(powershell_escape(next)),
                    None => {}
                }
                j += 2;
            }
            '$' => j = t.dollar(chars, j),
            _ => {
                t.word().text.push(d);
                j += 1;
            }
        }
    }
    t.problems.push("has an unterminated quote");
    n
}

/// `@'…'@` / `@"…"@` here-strings. Returns the index of the closing `@`.
fn here_string(t: &mut Tokenizer, chars: &[char], at: usize) -> usize {
    let quote = chars[at + 1];
    let mut j = at + 2;
    let body_start = j;
    while j < chars.len() {
        if chars[j] == '\n' && chars.get(j + 1) == Some(&quote) && chars.get(j + 2) == Some(&'@') {
            let body: String = chars[body_start..j].iter().collect();
            let word = t.word();
            word.quoted = true;
            if quote == '"' && (body.contains("$(") || body.contains('`')) {
                word.expansion = true;
                t.problems.push("uses a here-string with subexpressions");
                t.substitutions.push(body.clone());
            }
            t.word().text.push_str(body.trim());
            return j + 2;
        }
        j += 1;
    }
    t.problems.push("has an unterminated here-string");
    chars.len()
}

/// `%NAME%` references in cmd.exe text (not `%%`, `%1` or `%*`).
pub(super) fn percent_references(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut names = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '%' {
            i += 1;
            continue;
        }
        let start = i + 1;
        let mut j = start;
        while j < chars.len() && chars[j] != '%' && chars[j] != '\n' && chars[j] != '"' {
            j += 1;
        }
        if j < chars.len()
            && chars[j] == '%'
            && j > start
            && !chars[start].is_ascii_digit()
            && !matches!(chars[start], '*' | '~' | ' ')
        {
            let inner: String = chars[start..j].iter().collect();
            let name = inner
                .split(':')
                .next()
                .unwrap_or_default()
                .trim()
                .to_owned();
            if !name.is_empty() {
                names.push(name);
            }
            i = j + 1;
        } else {
            i = start;
        }
    }
    names
}

/// `!NAME!` delayed-expansion references (cmd.exe with `/v:on`).
pub(super) fn delayed_references(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find('!') {
        let after = &rest[start + 1..];
        match after.find('!') {
            Some(end)
                if end > 0
                    && after[..end].chars().all(|c| {
                        c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '~' | ',')
                    }) =>
            {
                let name = after[..end].split(':').next().unwrap_or_default();
                if !name.is_empty() {
                    names.push(name.to_owned());
                }
                rest = &after[end + 1..];
            }
            _ => rest = after,
        }
    }
    names
}

/// `$NAME`, `${NAME}`, `$env:NAME`, `${env:NAME}` references.
pub(super) fn dollar_references(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut names = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '$' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        if chars.get(j) == Some(&'{') {
            j += 1;
        }
        let start = j;
        while j < chars.len()
            && (chars[j].is_ascii_alphanumeric() || chars[j] == '_' || chars[j] == ':')
        {
            j += 1;
        }
        let raw: String = chars[start..j].iter().collect();
        // `$env:NAME`, `$script:NAME`: the part after the drive/scope.
        let name = raw.rsplit(':').next().unwrap_or_default();
        if !name.is_empty() && !name.starts_with(|c: char| c.is_ascii_digit()) {
            names.push(name.to_owned());
        }
        i = j.max(i + 1);
    }
    names
}

/// Environment variable names that commonly hold secrets.
pub(super) fn secret_like_variable(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if matches!(upper.as_str(), "PWD" | "OLDPWD") {
        return false;
    }
    const MARKERS: &[&str] = &[
        "KEY",
        "TOKEN",
        "SECRET",
        "PASS",
        "PWD",
        "CRED",
        "AUTH",
        "SESSION",
        "COOKIE",
        "PRIVATE",
        "DSN",
        "CONNECTION",
        "DATABASE_URL",
        "WEBHOOK",
        "SALT",
        "BEARER",
        "JWT",
        "API",
        "SIGNING",
        "CERT",
    ];
    MARKERS.iter().any(|m| upper.contains(m))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn programs(t: &Tokenizer) -> Vec<String> {
        t.segments
            .iter()
            .filter_map(|s| s.words.first().map(|w| w.text.clone()))
            .collect()
    }

    #[test]
    fn posix_treats_caret_as_literal() {
        let t = tokenize_posix("echo ^& rm -rf src");
        assert_eq!(programs(&t), vec!["echo", "rm"]);
        let t = tokenize_posix("echo ^; rm -rf src");
        assert_eq!(programs(&t), vec!["echo", "rm"]);
    }

    #[test]
    fn posix_decodes_ansi_c_quotes_and_comments() {
        let t = tokenize_posix(r"$'\x72\x6d' -rf src");
        assert_eq!(programs(&t), vec!["rm"]);
        let t = tokenize_posix(r"echo $'\'' ; rm -rf src #'");
        assert_eq!(programs(&t), vec!["echo", "rm"]);
        let t = tokenize_posix("echo x #'\nrm -rf src\necho '");
        assert_eq!(programs(&t), vec!["echo", "rm", "echo"]);
    }

    #[test]
    fn posix_marks_brace_expansion() {
        let t = tokenize_posix("{rm,-rf,src}");
        assert!(t.segments[0].words[0].expansion);
        let t = tokenize_posix("{ rm -rf src; }");
        assert_eq!(programs(&t), vec!["rm"]);
    }

    #[test]
    fn cmd_treats_single_quotes_as_literal_and_caret_as_escape() {
        let t = tokenize_cmd("echo 'a & rd /s /q src'");
        assert_eq!(programs(&t), vec!["echo", "rd"]);
        let t = tokenize_cmd("echo ^& rd /s /q src");
        assert_eq!(programs(&t), vec!["echo"]);
        let t = tokenize_cmd("echo \"a ^& b\" & rd /s /q src");
        assert_eq!(programs(&t), vec!["echo", "rd"]);
        let t = tokenize_cmd("echo a ; rd /s /q src");
        assert_eq!(programs(&t), vec!["echo"]);
    }

    #[test]
    fn cmd_splits_command_names_at_slash_and_strips_at() {
        let t = tokenize_cmd("@rd/s/q src");
        let words: Vec<&str> = t.segments[0]
            .words
            .iter()
            .map(|w| w.text.as_str())
            .collect();
        assert_eq!(words, vec!["rd", "/s", "/q", "src"]);
        let t = tokenize_cmd("rd /s/q src");
        let words: Vec<&str> = t.segments[0]
            .words
            .iter()
            .map(|w| w.text.as_str())
            .collect();
        assert_eq!(words, vec!["rd", "/s", "/q", "src"]);
    }

    #[test]
    fn cmd_percent_variables_are_problems() {
        assert!(!tokenize_cmd("echo %API_KEY%").problems.is_empty());
        assert!(tokenize_cmd("echo 100% done").problems.is_empty());
        assert_eq!(percent_references("a %PATH:~0,3% b"), vec!["PATH"]);
        assert_eq!(delayed_references("!X! and !Y_2!"), vec!["X", "Y_2"]);
    }

    #[test]
    fn powershell_normalizes_smart_quotes_and_dashes() {
        let t = tokenize_powershell("echo \u{201C}it's\u{201D} ; Remove-Item \u{2013}Recurse src");
        assert_eq!(programs(&t), vec!["echo", "Remove-Item"]);
        assert_eq!(t.segments[1].words[1].text, "-Recurse");
        let t = tokenize_powershell("& \u{2018}Remove-Item\u{2019} -Recurse src");
        assert_eq!(programs(&t), vec!["Remove-Item"]);
    }

    #[test]
    fn powershell_script_blocks_and_escapes() {
        let t = tokenize_powershell("gci | ForEach-Object{Remove-Item $_ -Recurse}");
        assert_eq!(programs(&t), vec!["gci", "ForEach-Object", "Remove-Item"]);
        let t = tokenize_powershell("echo a`; rm -r src");
        assert_eq!(programs(&t), vec!["echo"]);
        let t = tokenize_powershell("Re`move-Item -r src");
        assert_eq!(programs(&t), vec!["Remove-Item"]);
        let t = tokenize_powershell("echo 'it''s' <# ; rm -r src #> ; ls # ; rm");
        assert_eq!(programs(&t), vec!["echo", "ls"]);
        assert!(
            !tokenize_powershell("cmd --% /c rd /s /q x")
                .problems
                .is_empty()
        );
    }

    #[test]
    fn variable_references_and_secret_names() {
        assert_eq!(
            dollar_references("x $env:DEPLOY_API_KEY ${GH_TOKEN} $HOME"),
            vec!["DEPLOY_API_KEY", "GH_TOKEN", "HOME"]
        );
        assert!(secret_like_variable("SERVICE_API_KEY"));
        assert!(secret_like_variable("github_token"));
        assert!(!secret_like_variable("HOME"));
        assert!(!secret_like_variable("PWD"));
    }
}
