//! Shell command classification.
//!
//! Providers report commands as display text (`command`) and, when they can, as an argument
//! vector (`argv`). KalCode does not know which shell will run the text — bash, cmd.exe or
//! PowerShell — so the text is read **under every dialect** (`dialects`: POSIX sh, cmd.exe
//! and PowerShell, each with its own quoting, escaping, separators and expansions) and also
//! under a union reading that accepts all of their syntax at once. Every reading is classified
//! and the results are combined: scopes add up, and any reading that can't be interpreted makes
//! the command opaque, so the most authority-requiring interpretation always wins. The union
//! reading's rules:
//!
//! * `;`, `&&`, `||`, `|`, `&`, newlines, `(`/`)` and `{`/`}` split commands; every part is
//!   classified and the scopes are combined.
//! * `$(…)`, backticks, `<(…)` are classified recursively **and** mark the command opaque.
//! * `bash -c`, `cmd /c`, `powershell -Command` and `-EncodedCommand` (decoded) are classified
//!   recursively; encoded commands are always opaque.
//! * Quotes, `\` and `^` escapes are removed before the program is identified, so `r"m"`,
//!   `r^m` and `\rm` are all `rm`.
//! * `#` is not treated as a comment (cmd.exe would run what follows).
//!
//! **Opaque** means KalCode could not see everything the command will do. Opaque commands are
//! never allowed automatically — not by a mode, a rule or a grant — in any mode, including
//! Bypass (see `policy.rs`).
//!
//! Scripts run by a command (`npm test`, `make`, `./build.sh`) are classified as executing code;
//! KalCode does not look inside them.

mod dialects;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use kalcode_contracts::permissions::PermissionScope as S;

use crate::network;
use crate::paths::{self, PathInfo, Workspace};

/// Longest command text KalCode will parse. Longer input is opaque.
pub const MAX_COMMAND_LEN: usize = 16 * 1024;
/// Maximum nesting of `bash -c "cmd /c \"…\""` style wrappers before giving up (opaque).
const MAX_DEPTH: u8 = 4;

/// Everything the classifier learned about a command.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommandFacts {
    pub scopes: Vec<S>,
    pub opaque: bool,
    pub notes: Vec<String>,
    pub paths: Vec<PathInfo>,
    pub hosts: Vec<String>,
    /// The normalized words of a single simple command (`npm test -- --watch=false`), used for
    /// command-prefix rules. `None` for compound, redirected or opaque commands.
    pub simple: Option<String>,
}

/// Classifies a command. `cwd` may be empty (the workspace root), relative to the root, or
/// absolute.
pub fn classify_command(
    command: &str,
    argv: &[String],
    cwd: &str,
    workspace: &Workspace,
) -> CommandFacts {
    let mut cx = Cx::new(workspace, cwd);
    let initial = cx.base.clone();
    let mut simple = Vec::new();
    if !command.trim().is_empty() {
        simple.push(cx.script(command, 0));
    }
    if !argv.is_empty() {
        cx.base = initial;
        simple.push(cx.argv(argv, 0));
    }
    if simple.is_empty() {
        cx.opaque("the command is empty");
        cx.add(S::TerminalExecute);
    }
    let simple = match simple.as_slice() {
        [Some(one)] => Some(one.clone()),
        [Some(a), Some(b)] if a == b => Some(a.clone()),
        _ => None,
    };
    cx.finish(simple)
}

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
struct Word {
    text: String,
    expansion: bool,
    glob: bool,
    quoted: bool,
}

impl Word {
    fn plain(text: &str) -> Self {
        Self {
            text: text.to_owned(),
            expansion: paths::has_expansion(text),
            glob: text.contains(['*', '?', '[']),
            quoted: false,
        }
    }

    fn lower(&self) -> String {
        self.text.to_ascii_lowercase()
    }

    fn is_flag(&self) -> bool {
        self.text.starts_with('-') && self.text.len() > 1
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Redirect {
    Read,
    Write,
    /// Here-document delimiter or here-string: data, not a path.
    Data,
}

#[derive(Debug, Default)]
struct Segment {
    words: Vec<Word>,
    redirects: Vec<(Redirect, Word)>,
    piped_in: bool,
}

#[derive(Default)]
struct Tokenizer {
    segments: Vec<Segment>,
    seg: Segment,
    word: Option<Word>,
    redirect: Option<Redirect>,
    substitutions: Vec<String>,
    problems: Vec<&'static str>,
}

impl Tokenizer {
    fn word(&mut self) -> &mut Word {
        self.word.get_or_insert_with(Word::default)
    }

    fn finish_word(&mut self) {
        if let Some(word) = self.word.take() {
            match self.redirect.take() {
                Some(kind) => self.seg.redirects.push((kind, word)),
                None => self.seg.words.push(word),
            }
        }
    }

    fn finish_segment(&mut self, piped_next: bool) {
        self.finish_word();
        if self.redirect.take().is_some() {
            self.problems.push("has a redirection without a target");
        }
        let seg = std::mem::take(&mut self.seg);
        if !seg.words.is_empty() || !seg.redirects.is_empty() {
            self.segments.push(seg);
        }
        self.seg.piped_in = piped_next;
    }

    /// Handles `$…` starting at `j` (which is the `$`); returns the next index to read.
    fn dollar(&mut self, chars: &[char], j: usize) -> usize {
        match chars.get(j + 1) {
            Some('(') => {
                let arithmetic = chars.get(j + 2) == Some(&'(');
                self.word().expansion = true;
                self.word().text.push_str("$(…)");
                match extract_balanced(chars, j + 2) {
                    Some((inner, end)) => {
                        if arithmetic {
                            self.problems.push("uses arithmetic expansion");
                        } else {
                            self.substitutions.push(inner);
                        }
                        end + 1
                    }
                    None => {
                        self.problems.push("has an unbalanced command substitution");
                        chars.len()
                    }
                }
            }
            Some('{') => {
                self.word().expansion = true;
                match closing_brace(chars, j + 2) {
                    Some(end) => {
                        let text: String = chars[j..=end].iter().collect();
                        let inner: String = chars[j + 2..end].iter().collect();
                        // `${X:-$(cmd)}` runs `cmd` when X is unset.
                        if inner.contains("$(") || inner.contains('`') || inner.contains("<(") {
                            self.substitutions.push(inner);
                        }
                        self.word().text.push_str(&text);
                        end + 1
                    }
                    None => {
                        self.problems.push("has an unterminated variable expansion");
                        chars.len()
                    }
                }
            }
            Some(c) if c.is_ascii_alphanumeric() || *c == '_' || "@*#?$!-".contains(*c) => {
                self.word().expansion = true;
                self.word().text.push('$');
                let mut k = j + 1;
                if "@*#?$!-".contains(chars[k]) {
                    self.word().text.push(chars[k]);
                    return k + 1;
                }
                while k < chars.len()
                    && (chars[k].is_ascii_alphanumeric() || chars[k] == '_' || chars[k] == ':')
                {
                    self.word().text.push(chars[k]);
                    k += 1;
                }
                k
            }
            _ => {
                self.word().text.push('$');
                j + 1
            }
        }
    }
}

/// From `start` (just after `${`), finds the `}` that closes the expansion, honouring nested
/// `${…}` and quotes.
fn closing_brace(chars: &[char], start: usize) -> Option<usize> {
    let mut depth = 1usize;
    let mut i = start;
    let mut quote: Option<char> = None;
    while i < chars.len() {
        let c = chars[i];
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None => match c {
                '\'' | '"' => quote = Some(c),
                '\\' => i += 1,
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            },
        }
        i += 1;
    }
    None
}

fn find_char(chars: &[char], from: usize, target: char) -> Option<usize> {
    chars
        .get(from..)?
        .iter()
        .position(|c| *c == target)
        .map(|p| from + p)
}

/// From `start` (just after an opening `(`), finds the matching `)`, honouring quotes and
/// nesting. Returns the inner text and the index of the closing parenthesis.
fn extract_balanced(chars: &[char], start: usize) -> Option<(String, usize)> {
    let mut depth = 1usize;
    let mut i = start;
    let mut quote: Option<char> = None;
    while i < chars.len() {
        let c = chars[i];
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else if c == '\\' && q == '"' {
                    i += 1;
                }
            }
            None => match c {
                '\'' | '"' => quote = Some(c),
                '\\' => i += 1,
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some((chars[start..i].iter().collect(), i));
                    }
                }
                _ => {}
            },
        }
        i += 1;
    }
    None
}

/// Splits `input` into commands and words. `windows` applies cmd.exe/PowerShell rules to
/// backslashes (always literal); otherwise POSIX rules apply (`\` escapes metacharacters).
fn tokenize(input: &str, windows: bool) -> Tokenizer {
    let chars: Vec<char> = input.chars().collect();
    let n = chars.len();
    let mut t = Tokenizer::default();
    let mut i = 0;
    while i < n {
        let c = chars[i];
        match c {
            ' ' | '\t' | '\r' => t.finish_word(),
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
                    // Background job, cmd.exe separator, or PowerShell call operator.
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
            '{' | '}'
                if t.word.is_none()
                    && chars
                        .get(i + 1)
                        .is_none_or(|next| next.is_whitespace() || *next == ';') =>
            {
                t.finish_segment(false);
            }
            '<' | '>' => {
                if let Some(word) = &t.word
                    && !word.quoted
                    && !word.text.is_empty()
                    && word.text.chars().all(|d| d.is_ascii_digit())
                {
                    t.word = None; // a file-descriptor number, not an argument
                }
                t.finish_word();
                if chars.get(i + 1) == Some(&'(') {
                    match extract_balanced(&chars, i + 2) {
                        Some((inner, end)) => {
                            t.substitutions.push(inner);
                            t.word().expansion = true;
                            t.word().text.push_str("<(…)");
                            i = end;
                        }
                        None => {
                            t.problems.push("has an unbalanced process substitution");
                            i = n;
                        }
                    }
                } else if c == '<' {
                    match chars.get(i + 1) {
                        Some('<') => {
                            if chars.get(i + 2) == Some(&'<') {
                                i += 2;
                            } else {
                                t.problems.push("uses a here-document");
                                i += 1;
                            }
                            t.redirect = Some(Redirect::Data);
                        }
                        Some('>') => {
                            i += 1;
                            t.redirect = Some(Redirect::Write);
                        }
                        Some('&') => {
                            i += 1;
                            while chars
                                .get(i + 1)
                                .is_some_and(|d| d.is_ascii_digit() || *d == '-')
                            {
                                i += 1;
                            }
                        }
                        _ => t.redirect = Some(Redirect::Read),
                    }
                } else {
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
                            i = j - 1;
                        } else {
                            i = j;
                            t.redirect = Some(Redirect::Write);
                        }
                    } else {
                        i = j - 1;
                        t.redirect = Some(Redirect::Write);
                    }
                }
            }
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
            '"' => {
                t.word().quoted = true;
                let mut j = i + 1;
                let mut closed = false;
                while j < n {
                    let d = chars[j];
                    if d == '"' {
                        closed = true;
                        break;
                    }
                    if !windows
                        && d == '\\'
                        && j + 1 < n
                        && matches!(chars[j + 1], '"' | '\\' | '$' | '`')
                    {
                        t.word().text.push(chars[j + 1]);
                        j += 2;
                        continue;
                    }
                    if d == '`' {
                        t.problems.push("uses backticks");
                        t.word().expansion = true;
                        match find_char(&chars, j + 1, '`') {
                            Some(end)
                                if end
                                    < chars[j..]
                                        .iter()
                                        .position(|c| *c == '"')
                                        .map_or(n, |p| j + p) =>
                            {
                                t.substitutions.push(chars[j + 1..end].iter().collect());
                                j = end + 1;
                            }
                            _ => j += 1,
                        }
                        continue;
                    }
                    if d == '$' {
                        j = t.dollar(&chars, j);
                        continue;
                    }
                    t.word().text.push(d);
                    j += 1;
                }
                if closed {
                    i = j;
                } else {
                    t.problems.push("has an unterminated quote");
                    i = n;
                }
            }
            '`' => {
                t.problems.push("uses backticks");
                t.word().expansion = true;
                if let Some(end) = find_char(&chars, i + 1, '`') {
                    t.substitutions.push(chars[i + 1..end].iter().collect());
                    i = end;
                }
            }
            '$' => {
                i = t.dollar(&chars, i);
                continue;
            }
            '^' => match chars.get(i + 1) {
                // cmd.exe escape: `r^m` is `rm`.
                Some(&next) if !next.is_whitespace() => {
                    t.word().text.push(next);
                    i += 1;
                }
                _ => t.word().text.push('^'),
            },
            '\\' if !windows => match chars.get(i + 1) {
                Some('\n') => i += 1,
                Some(&next) if "\"' ;&|$`()<>*?#!{}".contains(next) => {
                    t.word().text.push(next);
                    i += 1;
                }
                _ => t.word().text.push('\\'),
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
            _ => {
                let word = t.word();
                word.text.push(c);
                if c == '%' && paths::has_expansion(&word.text) {
                    word.expansion = true;
                }
            }
        }
        i += 1;
    }
    t.finish_segment(false);
    t
}

// ---------------------------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------------------------

/// Where relative paths resolve from.
#[derive(Debug, Clone)]
enum Base {
    Root,
    Dir(PathBuf),
    /// A directory KalCode cannot determine (`cd ~`, `cd $X`): every relative path is outside.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Access {
    Read,
    Write,
    Execute,
}

struct Cx<'a> {
    workspace: &'a Workspace,
    base: Base,
    facts: CommandFacts,
    /// Nested scripts already classified from a given folder: every dialect finds the same
    /// `bash -c …` / `$(…)` text, and classifying it again adds nothing.
    seen: HashSet<(String, String)>,
    /// The current program only lists names (`ls`, `dir`); a glob argument is not a read of
    /// every file it matches.
    names_only: bool,
    resolved: RefCell<HashMap<(String, String), PathInfo>>,
}

/// The readings every command text gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reading {
    /// The union of every shell's syntax, with POSIX backslash escapes.
    Union,
    /// The union with backslashes taken literally (cmd.exe/PowerShell paths).
    UnionWindows,
    Posix,
    Cmd,
    PowerShell,
}

/// Environment variables that change what a command executes or loads.
const DANGEROUS_ENV: &[&str] = &[
    "path",
    "ld_preload",
    "ld_library_path",
    "ld_audit",
    "dyld_insert_libraries",
    "dyld_library_path",
    "node_options",
    "node_path",
    "pythonpath",
    "pythonstartup",
    "pythonhome",
    "perl5opt",
    "perl5lib",
    "rubyopt",
    "rubylib",
    "bash_env",
    "env",
    "prompt_command",
    "ifs",
    "shellopts",
    "ps4",
    "git_ssh",
    "git_ssh_command",
    "git_exec_path",
    "git_external_diff",
    "git_editor",
    "git_pager",
    "git_askpass",
    "git_dir",
    "git_work_tree",
    "git_config",
    "git_config_global",
    "git_config_parameters",
    "editor",
    "visual",
    "pager",
    "rustc_wrapper",
    "rustc",
    "cargo_home",
    "cargo_target_dir",
    "npm_config_script_shell",
    "npm_config_prefix",
    "java_tool_options",
    "_java_options",
    "comspec",
    "pathext",
    "psmodulepath",
    "home",
    "userprofile",
];

impl<'a> Cx<'a> {
    fn new(workspace: &'a Workspace, cwd: &str) -> Self {
        let mut cx = Self {
            workspace,
            base: Base::Root,
            facts: CommandFacts::default(),
            seen: HashSet::new(),
            names_only: false,
            resolved: RefCell::new(HashMap::new()),
        };
        if !cwd.trim().is_empty() {
            let info = paths::resolve(workspace, None, cwd);
            cx.base = cx.base_for(cwd, &info);
            if info.outside {
                cx.add(S::FilesystemOutsideWorkspace);
                cx.note("The command runs in a folder outside the workspace.");
            }
            if info.opaque {
                cx.opaque("its working folder can't be interpreted safely");
            }
        }
        cx
    }

    fn base_for(&self, raw: &str, info: &PathInfo) -> Base {
        match (&info.relative, self.workspace.root()) {
            (Some(relative), Some(root)) if !info.outside => Base::Dir(if relative.is_empty() {
                root.to_path_buf()
            } else {
                root.join(relative)
            }),
            _ if is_absolute_like(raw) && !paths::has_expansion(raw) => {
                Base::Dir(PathBuf::from(raw.trim()))
            }
            _ => Base::Unknown,
        }
    }

    fn finish(mut self, simple: Option<String>) -> CommandFacts {
        if self.facts.scopes.contains(&S::TerminalExecute) {
            self.facts.scopes.retain(|s| *s != S::TerminalReadOnly);
        }
        if self.facts.scopes.is_empty() {
            self.facts.scopes.push(S::TerminalReadOnly);
        }
        crate::scopes::normalize(&mut self.facts.scopes);
        self.facts.notes.dedup();
        self.facts.simple = if self.facts.opaque { None } else { simple };
        self.facts
    }

    fn add(&mut self, scope: S) {
        if !self.facts.scopes.contains(&scope) {
            self.facts.scopes.push(scope);
        }
    }

    fn note(&mut self, note: impl Into<String>) {
        let note = note.into();
        if !self.facts.notes.contains(&note) {
            self.facts.notes.push(note);
        }
    }

    fn opaque(&mut self, why: &str) {
        self.facts.opaque = true;
        self.note(format!(
            "The command {why}, so KalCode can't see everything it will do."
        ));
    }

    fn resolve(&self, raw: &str) -> PathInfo {
        // Every reading of the text resolves the same paths; the file system is asked once.
        let key = (format!("{:?}", self.base), raw.to_owned());
        if let Some(info) = self.resolved.borrow().get(&key) {
            return info.clone();
        }
        let info = self.resolve_uncached(raw);
        self.resolved.borrow_mut().insert(key, info.clone());
        info
    }

    fn resolve_uncached(&self, raw: &str) -> PathInfo {
        match &self.base {
            Base::Root => paths::resolve(self.workspace, None, raw),
            Base::Dir(dir) => paths::resolve(self.workspace, Some(dir), raw),
            Base::Unknown if is_absolute_like(raw) => paths::resolve(self.workspace, None, raw),
            Base::Unknown => {
                let mut info = paths::resolve(&Workspace::none(), None, raw);
                info.note =
                    Some("The path is relative to a folder KalCode can't determine.".to_owned());
                info
            }
        }
    }

    // ---- entry points ----

    fn script(&mut self, text: &str, depth: u8) -> Option<String> {
        if depth > MAX_DEPTH {
            self.opaque("nests shells too deeply");
            self.add(S::TerminalExecute);
            return None;
        }
        if text.len() > MAX_COMMAND_LEN {
            self.opaque("is too long to check");
            self.add(S::TerminalExecute);
            return None;
        }
        if text
            .chars()
            .any(|c| (c.is_control() && !matches!(c, '\t' | '\n' | '\r')) || is_invisible(c))
        {
            self.opaque("contains control or invisible characters");
        }
        if depth > 0
            && !self
                .seen
                .insert((text.to_owned(), format!("{:?}", self.base)))
        {
            // Already classified from this folder by another reading.
            return None;
        }
        // Every shell reads the text differently (quotes, escapes, separators, expansions), so
        // it is classified under each reading and the results are combined: the most
        // authority-requiring interpretation wins.
        let mut variants = vec![(Reading::Union, tokenize(text, false))];
        if text.contains('\\') {
            variants.push((Reading::UnionWindows, tokenize(text, true)));
        }
        variants.push((Reading::Posix, dialects::tokenize_posix(text)));
        variants.push((Reading::Cmd, dialects::tokenize_cmd(text)));
        variants.push((Reading::PowerShell, dialects::tokenize_powershell(text)));
        let start = self.base.clone();
        let mut simple_words: Option<Option<Vec<String>>> = None;
        let mut end_base: Option<Option<(String, Base)>> = None;
        let mut substitutions: Vec<String> = Vec::new();
        for (reading, parsed) in &variants {
            self.base = start.clone();
            for problem in &parsed.problems {
                // cmd.exe treats an unterminated quote as data to the end of the line; the
                // commands before it were still parsed and classified.
                if matches!(reading, Reading::UnionWindows | Reading::Cmd)
                    && *problem == "has an unterminated quote"
                {
                    continue;
                }
                self.opaque(problem);
            }
            if !parsed.substitutions.is_empty() {
                self.opaque("uses command substitution");
                self.add(S::TerminalExecute);
            }
            for inner in &parsed.substitutions {
                if !substitutions.contains(inner) {
                    substitutions.push(inner.clone());
                }
            }
            let mut simple = parsed.segments.len() == 1
                && parsed.substitutions.is_empty()
                && parsed.problems.is_empty();
            for segment in &parsed.segments {
                simple &= self.segment(segment, depth);
            }
            if parsed.segments.is_empty() {
                self.add(S::TerminalReadOnly);
            }
            let words = simple.then(|| {
                parsed.segments[0]
                    .words
                    .iter()
                    .map(|w| w.text.clone())
                    .collect::<Vec<_>>()
            });
            simple_words = match simple_words {
                None => Some(words),
                Some(previous) if previous == words => Some(previous),
                Some(_) => Some(None),
            };
            let end = format!("{:?}", self.base);
            end_base = match end_base {
                None => Some(Some((end, self.base.clone()))),
                Some(Some((previous, base))) if previous == end => Some(Some((previous, base))),
                Some(_) => Some(None),
            };
        }
        for inner in &substitutions {
            self.base = start.clone();
            self.script(inner, depth + 1);
        }
        // Readings that disagree about the folder the text ends in leave it unknown.
        self.base = match end_base.flatten() {
            Some((_, base)) => base,
            None => Base::Unknown,
        };
        simple_words.flatten().map(|words| words.join(" "))
    }

    fn argv(&mut self, argv: &[String], depth: u8) -> Option<String> {
        let words: Vec<Word> = argv.iter().map(|a| Word::plain(a)).collect();
        if argv
            .iter()
            .any(|a| a.chars().any(|c| c.is_control() || is_invisible(c)))
        {
            self.opaque("contains control or invisible characters");
        }
        let segment = Segment {
            words,
            redirects: vec![],
            piped_in: false,
        };
        let simple = self.segment(&segment, depth);
        simple.then(|| argv.join(" "))
    }

    /// Classifies one simple command. Returns false when it is not eligible for prefix rules.
    fn segment(&mut self, segment: &Segment, depth: u8) -> bool {
        for word in segment
            .words
            .iter()
            .chain(segment.redirects.iter().map(|(_, w)| w))
        {
            self.variable_reads(word);
        }
        let mut simple = segment.redirects.is_empty();
        for (kind, target) in &segment.redirects {
            self.redirect(*kind, target);
        }
        let mut words: &[Word] = &segment.words;
        while let Some(first) = words.first()
            && is_assignment(first)
        {
            self.assignment(first);
            simple = false;
            words = &words[1..];
        }
        if words.is_empty() {
            self.add(S::TerminalReadOnly);
            return false;
        }
        if !simple && !segment.redirects.is_empty() {
            // Redirected output: fine, but not a simple command.
        }
        self.program(words, segment.piped_in, depth);
        simple && !words.iter().any(|w| w.expansion)
    }

    fn redirect(&mut self, kind: Redirect, target: &Word) {
        let lower = target.lower();
        match kind {
            Redirect::Data => {}
            Redirect::Read => self.path(target, Access::Read),
            Redirect::Write => {
                if matches!(
                    lower.as_str(),
                    "/dev/null" | "nul" | "$null" | "/dev/stdout" | "/dev/stderr" | "nul:"
                ) {
                    return;
                }
                if is_raw_device(&lower) {
                    self.add(S::Destructive);
                    self.add(S::FilesystemOutsideWorkspace);
                    self.note("The command writes directly to a disk device.");
                    return;
                }
                self.path(target, Access::Write);
            }
        }
    }

    /// A word that expands an environment variable whose name suggests a secret
    /// (`$DEPLOY_API_KEY`, `$env:GH_TOKEN`, `%AWS_SECRET_ACCESS_KEY%`) reads that secret: the
    /// command can print it or send it somewhere.
    fn variable_reads(&mut self, word: &Word) {
        let lower = word.lower();
        if lower.contains("environmentvariable") || lower == "win32_environment" {
            self.add(S::CredentialsAccess);
            self.note("The command reads environment variables, which can hold secrets.");
        }
        if !word.expansion {
            return;
        }
        let mut names = dialects::dollar_references(&word.text);
        names.extend(dialects::percent_references(&word.text));
        names.extend(dialects::delayed_references(&word.text));
        for name in names {
            if dialects::secret_like_variable(&name) {
                self.add(S::CredentialsAccess);
                self.note(format!(
                    "The command reads the environment variable {}, which may hold a secret.",
                    name.to_ascii_uppercase()
                ));
            }
        }
    }

    fn assignment(&mut self, word: &Word) {
        let (name, value) = word.text.split_once('=').unwrap_or((&word.text, ""));
        let name = name.to_ascii_lowercase();
        self.add(S::TerminalExecute);
        if DANGEROUS_ENV.contains(&name.as_str())
            || name.starts_with("ld_")
            || name.starts_with("dyld_")
            || name.starts_with("git_")
            || name.starts_with("npm_config_")
        {
            self.opaque(&format!(
                "sets {} for the command",
                name.to_ascii_uppercase()
            ));
        } else if word.expansion || paths::has_expansion(value) {
            self.opaque("sets a variable from the environment");
        }
    }

    // ---- paths and hosts ----

    fn path(&mut self, word: &Word, access: Access) {
        let text = word.text.trim();
        if text.is_empty() {
            return;
        }
        let lower = text.to_ascii_lowercase();
        // PowerShell provider drives.
        if let Some((drive, _)) = lower.split_once(':')
            && drive.len() > 1
            && drive.chars().all(|c| c.is_ascii_alphabetic())
        {
            match drive {
                "env" | "variable" | "cert" => {
                    self.add(S::CredentialsAccess);
                    self.note("The command reads environment variables or certificates.");
                    return;
                }
                "hklm" | "hkcu" | "hkcr" | "hku" | "hkcc" | "registry" | "wsman" | "function"
                | "alias" => {
                    self.add(S::FilesystemOutsideWorkspace);
                    if access == Access::Write {
                        self.add(S::TerminalExecute);
                    }
                    self.note("The command uses a PowerShell drive outside the workspace.");
                    return;
                }
                _ => {}
            }
        }
        let info = self.resolve(text);
        if info.outside {
            self.add(S::FilesystemOutsideWorkspace);
            if let Some(note) = &info.note {
                self.note(format!("{}: {note}", info.display));
            }
        }
        if info.opaque {
            self.opaque("names a path KalCode can't interpret safely");
        }
        if info.network {
            self.add(S::NetworkOther);
        }
        if info.credentials {
            self.add(S::CredentialsAccess);
            self.note(format!("{} may contain credentials.", info.display));
        } else if word.glob && !self.names_only && self.glob_reaches_credentials(text) {
            // `cat .en*`, `type *.pem`: the shell expands the pattern into credential files.
            self.add(S::CredentialsAccess);
            self.note(format!("{text} can match files that contain credentials."));
        }
        match access {
            Access::Read => self.add(S::FilesystemRead),
            Access::Write => {
                self.add(S::FilesystemWrite);
                if info.git_internal {
                    self.add(S::TerminalExecute);
                    self.note("Changing files inside .git can make Git run code.");
                    let lower_path = info.display.to_ascii_lowercase();
                    if lower_path.contains("hooks") || lower_path.ends_with("config") {
                        self.opaque("writes Git hooks or configuration, which Git runs later");
                    }
                }
            }
            Access::Execute => {}
        }
        self.facts.paths.push(info);
    }

    /// Whether a wildcard argument can expand to a credential file: statically under the POSIX
    /// dot rule, and against the folder's real entries (PowerShell and cmd.exe let `*` match
    /// dot files).
    fn glob_reaches_credentials(&self, pattern: &str) -> bool {
        if paths::glob_may_match_credentials(pattern) {
            return true;
        }
        let split = pattern.rfind(['/', '\\']);
        let (parent, last) = match split {
            Some(p) => (&pattern[..p], &pattern[p + 1..]),
            None => ("", pattern),
        };
        if parent.contains(['*', '?', '[']) || last.is_empty() {
            return false;
        }
        let parent = if parent.is_empty() { "." } else { parent };
        let info = self.resolve(parent);
        let (Some(relative), Some(root)) = (&info.relative, self.workspace.root()) else {
            return false;
        };
        if info.outside {
            return false;
        }
        let dir = if relative.is_empty() {
            root.to_path_buf()
        } else {
            root.join(relative)
        };
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return false;
        };
        // Bounded: a huge folder is not listed in full; the static check above still applies.
        for entry in entries.take(4096).flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if paths::glob_match(last, &name)
                && (paths::looks_like_credentials(&name)
                    || paths::looks_like_credentials(&format!("{name}/x")))
            {
                return true;
            }
        }
        false
    }

    /// Checks path-looking arguments of a command whose argument meaning KalCode doesn't know.
    fn loose_args(&mut self, args: &[Word], access: Access) {
        for arg in args {
            let text = arg.text.as_str();
            if text == "--" {
                continue;
            }
            if text.contains("://") {
                self.url(text, false);
                continue;
            }
            if arg.is_flag() {
                if let Some((_, value)) = text.split_once('=') {
                    if value.contains("://") {
                        self.url(value, false);
                    } else if looks_like_path(value) {
                        self.path(&Word::plain(value), access);
                    }
                }
                continue;
            }
            if looks_like_path(text) || arg.expansion {
                self.path(arg, access);
            }
        }
    }

    /// Every non-flag argument is a path (`cat a b`, `rm x y`).
    fn file_args(&mut self, args: &[Word], access: Access, windows_flags: bool) -> usize {
        let mut count = 0;
        let mut after_dashes = false;
        for arg in args {
            if !after_dashes && arg.text == "--" {
                after_dashes = true;
                continue;
            }
            if !after_dashes && (arg.is_flag() || (windows_flags && is_windows_flag(&arg.text))) {
                if let Some((_, value)) = arg.text.split_once('=')
                    && looks_like_path(value)
                {
                    self.path(&Word::plain(value), access);
                }
                continue;
            }
            if arg.text.contains("://") {
                self.url(&arg.text, false);
                continue;
            }
            count += 1;
            self.path(arg, access);
        }
        count
    }

    fn url(&mut self, text: &str, sends: bool) {
        match network::url_host(text) {
            Some(host) => self.host(host, sends),
            None => {
                self.add(S::NetworkOther);
                if !text.to_ascii_lowercase().starts_with("file:") {
                    self.note(format!("KalCode couldn't read the host of {text}."));
                } else {
                    self.add(S::FilesystemOutsideWorkspace);
                }
            }
        }
    }

    fn host(&mut self, host: String, sends: bool) {
        if network::is_local_host(&host) {
            self.add(S::TerminalExecute);
        } else if !sends && network::is_docs_host(&host) {
            self.add(S::NetworkDocs);
        } else {
            self.add(S::NetworkOther);
            if sends {
                if MESSAGING_HOSTS
                    .iter()
                    .any(|d| network::host_matches(&host, d))
                {
                    self.add(S::MessagingSend);
                }
                if BILLING_HOSTS
                    .iter()
                    .any(|d| network::host_matches(&host, d))
                {
                    self.add(S::BillingSpend);
                }
            }
        }
        if !self.facts.hosts.contains(&host) {
            self.facts.hosts.push(host);
        }
    }

    /// `user@host`, `host:path` and `host` forms (ssh, scp, rsync).
    fn remote(&mut self, text: &str) {
        let without_user = text.rsplit('@').next().unwrap_or(text);
        let host = without_user.split(':').next().unwrap_or(without_user);
        match network::normalize_host(host) {
            Some(host) => self.host(host, true),
            None => self.add(S::NetworkOther),
        }
        self.add(S::CloudModify);
    }

    fn cd(&mut self, target: Option<&Word>) {
        let Some(target) = target else {
            self.base = Base::Unknown;
            self.add(S::FilesystemOutsideWorkspace);
            self.note("The command changes to the home folder.");
            return;
        };
        if target.text == "-" {
            self.base = Base::Unknown;
            self.add(S::FilesystemOutsideWorkspace);
            return;
        }
        let info = self.resolve(&target.text);
        self.base = self.base_for(&target.text, &info);
        if info.outside {
            self.add(S::FilesystemOutsideWorkspace);
            self.note(format!(
                "The command changes to {}, outside the workspace.",
                info.display
            ));
        }
        if info.opaque {
            self.opaque("changes to a folder KalCode can't interpret safely");
        }
    }

    // ---- programs ----

    fn program(&mut self, words: &[Word], piped: bool, depth: u8) {
        let head = &words[0];
        let args = &words[1..];
        if head.expansion || head.glob {
            self.opaque("chooses the program to run at run time");
            self.add(S::TerminalExecute);
            self.loose_args(args, Access::Read);
            return;
        }
        let mut raw = head.text.trim();
        // `\rm` bypasses shell aliases; it is still `rm`.
        if let Some(rest) = raw.strip_prefix('\\')
            && !rest.contains(['/', '\\'])
        {
            raw = rest;
        }
        let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
        let name = strip_executable_suffix(&base.to_ascii_lowercase());
        let qualified = raw.contains(['/', '\\']);
        if name.is_empty() {
            self.opaque("has no program name");
            self.add(S::TerminalExecute);
            if !args.is_empty() {
                self.program(args, piped, depth);
            }
            return;
        }
        if qualified {
            self.path(head, Access::Execute);
        }
        let n = name.as_str();

        // Grouping keywords and no-ops.
        if matches!(
            n,
            "{" | "}" | "!" | "then" | "do" | "else" | "fi" | "done" | "esac"
        ) {
            if args.is_empty() {
                self.add(S::TerminalReadOnly);
            } else {
                self.program(args, piped, depth);
            }
            return;
        }
        if matches!(
            n,
            "if" | "while"
                | "until"
                | "for"
                | "case"
                | "select"
                | "foreach"
                | "foreach-object"
                | "%"
        ) {
            // Loops and conditionals: the body is in later segments; the header may run code.
            self.opaque("uses shell control flow");
            self.add(S::TerminalExecute);
            if !args.is_empty() && !matches!(n, "for" | "case" | "select") {
                self.program(args, piped, depth);
            }
            return;
        }

        if self.wrapper(n, args, piped, depth)
            || self.shell(n, args, piped, depth)
            || self.interpreter(n, args, piped, depth)
            || self.shell_builtin(n, args, depth)
            || self.destructive(n, args)
            || self.file_writer(n, args)
            || self.git(n, args)
            || self.package(n, args)
            || self.network_program(n, args)
            || self.cloud(n, args)
            || self.credentials(n, args)
            || self.read_only(n, args, qualified)
        {
            return;
        }
        // Anything else runs a program KalCode knows nothing specific about.
        self.add(S::TerminalExecute);
        self.loose_args(args, Access::Read);
    }

    fn wrapper(&mut self, n: &str, args: &[Word], piped: bool, depth: u8) -> bool {
        let rest_after_options = |args: &[Word], with_value: &[&str]| -> usize {
            let mut i = 0;
            while i < args.len() && args[i].is_flag() {
                let flag = args[i].lower();
                if flag == "--" {
                    return i + 1;
                }
                if with_value.contains(&flag.as_str()) {
                    i += 1;
                }
                i += 1;
            }
            i
        };
        match n {
            "sudo" | "doas" | "gsudo" | "pkexec" | "run0" => {
                self.add(S::TerminalExecute);
                self.add(S::FilesystemOutsideWorkspace);
                self.note("The command runs with administrator privileges.");
                let skip = rest_after_options(
                    args,
                    &[
                        "-u", "-g", "-c", "-d", "-h", "-p", "-r", "-t", "-u", "-C", "-D",
                    ],
                );
                if skip < args.len() {
                    self.program(&args[skip..], piped, depth);
                }
                true
            }
            "su" | "runas" | "chroot" | "unshare" | "nsenter" | "firejail" => {
                self.add(S::TerminalExecute);
                self.add(S::FilesystemOutsideWorkspace);
                self.opaque("runs as another user or in another root");
                true
            }
            "env" => {
                let mut i = 0;
                while i < args.len() {
                    let lower = args[i].lower();
                    if (args[i].text.starts_with("-S") || args[i].text.starts_with("-s"))
                        && !lower.starts_with("--")
                        || long_option(&lower, "--split-string", 2)
                    {
                        self.opaque("splits a string into a command");
                        self.add(S::TerminalExecute);
                        return true;
                    }
                    let chdir = lower == "-c" || long_option(&lower, "--chdir", 2);
                    if chdir || lower == "-u" || long_option(&lower, "--unset", 2) {
                        // `--chdir=DIR` carries its value; `-C DIR` takes the next word.
                        let inline = args[i].text.split_once('=').map(|(_, v)| Word::plain(v));
                        if chdir {
                            let target = inline.clone().or_else(|| args.get(i + 1).cloned());
                            self.cd(target.as_ref());
                        }
                        i += if inline.is_some() { 1 } else { 2 };
                        continue;
                    }
                    if args[i].is_flag() {
                        i += 1;
                        continue;
                    }
                    if is_assignment(&args[i]) {
                        self.assignment(&args[i]);
                        i += 1;
                        continue;
                    }
                    break;
                }
                if i >= args.len() {
                    self.add(S::CredentialsAccess);
                    self.add(S::TerminalReadOnly);
                    self.note("Printing the environment can reveal secrets.");
                } else {
                    self.program(&args[i..], piped, depth);
                }
                true
            }
            "nice" | "nohup" | "time" | "timeout" | "stdbuf" | "ionice" | "unbuffer"
            | "caffeinate" | "exec" | "builtin" | "noglob" | "chrt" | "taskset" | "call" => {
                let mut skip = rest_after_options(
                    args,
                    &[
                        "-n",
                        "-c",
                        "-o",
                        "-e",
                        "-i",
                        "-s",
                        "-k",
                        "--signal",
                        "--kill-after",
                    ],
                );
                if n == "timeout" && skip < args.len() {
                    skip += 1; // DURATION
                }
                if matches!(n, "chrt" | "taskset") && skip < args.len() {
                    skip += 1;
                }
                if skip < args.len() {
                    self.program(&args[skip..], piped, depth);
                } else {
                    self.add(S::TerminalReadOnly);
                }
                true
            }
            "command" => {
                if args
                    .first()
                    .is_some_and(|a| matches!(a.lower().as_str(), "-v" | "-V"))
                {
                    self.add(S::TerminalReadOnly);
                } else {
                    let skip = rest_after_options(args, &[]);
                    if skip < args.len() {
                        self.program(&args[skip..], piped, depth);
                    }
                }
                true
            }
            "xargs" | "parallel" => {
                self.opaque("builds command arguments from its input");
                let skip = rest_after_options(
                    args,
                    &[
                        "-i",
                        "-n",
                        "-p",
                        "-d",
                        "-l",
                        "-s",
                        "-e",
                        "-a",
                        "--arg-file",
                        "--delimiter",
                        "--max-args",
                        "--max-procs",
                        "--replace",
                        "-j",
                        "--jobs",
                    ],
                );
                if skip < args.len() {
                    self.program(&args[skip..], true, depth);
                } else {
                    self.add(S::TerminalReadOnly);
                }
                true
            }
            "watch" => {
                let skip = rest_after_options(args, &["-n", "--interval", "-d"]);
                self.add(S::TerminalExecute);
                if skip < args.len() {
                    let joined = join_words(&args[skip..]);
                    self.script(&joined, depth + 1);
                }
                true
            }
            "start" | "start-process" | "saps" | "invoke-item" | "ii" | "open" | "xdg-open"
            | "explorer" => {
                self.add(S::TerminalExecute);
                // `start "title" /b program args` (cmd), `Start-Process prog -ArgumentList …`.
                if matches!(n, "start-process" | "saps") {
                    // Start-Process [-FilePath] prog [-ArgumentList] '…'
                    let mut program: Option<String> = None;
                    let mut arguments: Vec<String> = Vec::new();
                    let mut i = 0;
                    while i < args.len() {
                        let lower = args[i].lower();
                        if lower.starts_with("-verb") {
                            self.note("The command may ask Windows for administrator rights.");
                            self.add(S::FilesystemOutsideWorkspace);
                            i += 2;
                            continue;
                        }
                        if "-filepath".starts_with(lower.as_str()) && lower.len() > 1 {
                            program = args.get(i + 1).map(|w| w.text.clone());
                            i += 2;
                            continue;
                        }
                        if lower.starts_with("-arg") {
                            arguments.extend(args.get(i + 1).map(|w| w.text.clone()));
                            i += 2;
                            continue;
                        }
                        if args[i].is_flag() {
                            i += if matches!(
                                lower.as_str(),
                                "-workingdirectory"
                                    | "-redirectstandardoutput"
                                    | "-redirectstandarderror"
                                    | "-redirectstandardinput"
                                    | "-windowstyle"
                                    | "-credential"
                            ) {
                                2
                            } else {
                                1
                            };
                            continue;
                        }
                        if program.is_none() {
                            program = Some(args[i].text.clone());
                        } else {
                            arguments.push(args[i].text.clone());
                        }
                        i += 1;
                    }
                    match program {
                        Some(program) => {
                            let text = format!("\"{program}\" {}", arguments.join(" "));
                            self.script(&text, depth + 1);
                        }
                        None => self.opaque("starts a process KalCode can't identify"),
                    }
                    return true;
                }
                let mut rest: Vec<Word> = Vec::new();
                let mut title_seen = false;
                for arg in args {
                    if rest.is_empty() {
                        // Options before the program belong to `start`/`open` itself.
                        if arg.text.contains("://") {
                            self.add(S::BrowserNavigate);
                            self.url(&arg.text, false);
                            continue;
                        }
                        if arg.is_flag() || is_windows_flag(&arg.text) {
                            continue;
                        }
                        if n == "start" && arg.quoted && !title_seen {
                            // cmd.exe: the first quoted argument is the window title.
                            title_seen = true;
                            continue;
                        }
                    }
                    rest.push(arg.clone());
                }
                if !rest.is_empty()
                    && !matches!(n, "open" | "xdg-open" | "explorer" | "invoke-item" | "ii")
                {
                    self.program(&rest, piped, depth + 1);
                } else {
                    for word in &rest {
                        self.path(word, Access::Execute);
                    }
                }
                true
            }
            "wsl" | "wsl.exe" => {
                self.add(S::TerminalExecute);
                self.add(S::FilesystemOutsideWorkspace);
                self.note("The command runs inside the Windows Subsystem for Linux.");
                let skip = args
                    .iter()
                    .position(|a| matches!(a.lower().as_str(), "-e" | "--exec" | "--"))
                    .map(|p| p + 1)
                    .unwrap_or_else(|| {
                        rest_after_options(args, &["-d", "--distribution", "-u", "--user", "--cd"])
                    });
                if skip < args.len() {
                    let joined = join_words(&args[skip..]);
                    self.script(&joined, depth + 1);
                }
                true
            }
            _ => false,
        }
    }

    fn shell(&mut self, n: &str, args: &[Word], piped: bool, depth: u8) -> bool {
        match n {
            "bash" | "sh" | "zsh" | "dash" | "ksh" | "fish" | "ash" | "csh" | "tcsh"
            | "busybox" | "git-bash" => {
                self.add(S::TerminalExecute);
                if n == "busybox" {
                    if !args.is_empty() {
                        self.program(args, piped, depth);
                    }
                    return true;
                }
                let mut i = 0;
                while i < args.len() && args[i].is_flag() {
                    let flag = args[i].lower();
                    if !flag.starts_with("--") && flag.contains('c') {
                        match args.get(i + 1) {
                            Some(script) => {
                                self.script(&script.text, depth + 1);
                                if script.expansion {
                                    self.opaque("runs a script built from variables");
                                }
                            }
                            None => self.opaque("runs a shell without a command"),
                        }
                        return true;
                    }
                    if flag == "-s" && piped {
                        self.opaque("runs code piped from another command");
                        return true;
                    }
                    if matches!(flag.as_str(), "-o" | "+o" | "--rcfile" | "--init-file") {
                        i += 1;
                    }
                    i += 1;
                }
                match args.get(i) {
                    Some(script)
                        if script.text == "-"
                            || script.lower().starts_with("/dev/")
                            || script.lower().starts_with("/proc/") =>
                    {
                        self.opaque("runs code piped from another command");
                    }
                    Some(script) => {
                        self.path(script, Access::Execute);
                        self.note(format!("The command runs the script {}.", script.text));
                    }
                    None if piped => self.opaque("runs code piped from another command"),
                    None => self.opaque("starts an interactive shell"),
                }
                true
            }
            "cmd" => {
                self.add(S::TerminalExecute);
                let position = args
                    .iter()
                    .position(|a| matches!(a.lower().as_str(), "/c" | "/k" | "/r"));
                match position {
                    Some(p) if p + 1 < args.len() => {
                        let joined = join_words(&args[p + 1..]);
                        self.script(&joined, depth + 1);
                    }
                    _ if piped => self.opaque("runs code piped from another command"),
                    _ => self.opaque("starts an interactive shell"),
                }
                true
            }
            "powershell" | "pwsh" | "powershell_ise" => {
                self.add(S::TerminalExecute);
                self.powershell(args, piped, depth);
                true
            }
            _ => false,
        }
    }

    /// PowerShell accepts any unambiguous prefix of a parameter (`-enc`, `-e`, `-ec`, `/c`) in
    /// any position, so every argument is scanned for the parameters that carry code.
    fn powershell(&mut self, args: &[Word], piped: bool, depth: u8) {
        let flag_of = |word: &Word| -> Option<String> {
            let raw = word.lower();
            let is_param = raw.starts_with('-')
                || (raw.starts_with('/') && raw.len() > 1 && !raw[1..].contains(['/', '\\']));
            is_param.then(|| raw.trim_start_matches(['-', '/']).to_owned())
        };
        let is_encoded = |f: &str| {
            f == "ec" || (!f.is_empty() && !f.starts_with("ex") && "encodedcommand".starts_with(f))
        };
        let is_command = |f: &str| !f.is_empty() && "command".starts_with(f);
        let is_file = |f: &str| !f.is_empty() && "file".starts_with(f);
        let is_workdir = |f: &str| (f.len() >= 2 && "workingdirectory".starts_with(f)) || f == "wd";
        let takes_value = |f: &str| {
            is_workdir(f)
                || "windowstyle".starts_with(f)
                || (f.len() >= 2 && "executionpolicy".starts_with(f))
                || matches!(
                    f,
                    "ep" | "version"
                        | "v"
                        | "inputformat"
                        | "if"
                        | "outputformat"
                        | "of"
                        | "configurationname"
                        | "psconsolefile"
                        | "settingsfile"
                        | "custompipename"
                )
        };

        for (i, word) in args.iter().enumerate() {
            if let Some(f) = flag_of(word) {
                if is_workdir(&f) {
                    let target = args.get(i + 1).cloned();
                    self.cd(target.as_ref());
                }
                if "windowstyle".starts_with(f.as_str())
                    && args.get(i + 1).is_some_and(|w| w.lower() == "hidden")
                {
                    self.note("The command hides its window.");
                }
            }
        }
        if let Some(i) = args
            .iter()
            .position(|w| flag_of(w).is_some_and(|f| is_encoded(&f)))
        {
            self.opaque("uses an encoded PowerShell command");
            match args
                .get(i + 1)
                .and_then(|w| decode_powershell_base64(&w.text))
            {
                Some(decoded) => {
                    self.note(format!(
                        "Decoded PowerShell command: {}",
                        truncate(&decoded, 200)
                    ));
                    self.script(&decoded, depth + 1);
                }
                None => self.note("The encoded PowerShell command could not be decoded."),
            }
            return;
        }
        if let Some(i) = args
            .iter()
            .position(|w| flag_of(w).is_some_and(|f| is_command(&f)))
        {
            match args.get(i + 1) {
                Some(w) if w.text == "-" => self.opaque("runs code piped from another command"),
                Some(_) => {
                    let joined = join_words(&args[i + 1..]);
                    self.script(&joined, depth + 1);
                }
                None if piped => self.opaque("runs code piped from another command"),
                None => self.opaque("starts an interactive shell"),
            }
            return;
        }
        if let Some(i) = args
            .iter()
            .position(|w| flag_of(w).is_some_and(|f| is_file(&f)))
        {
            if let Some(script) = args.get(i + 1) {
                self.path(script, Access::Execute);
                self.note(format!("The command runs the script {}.", script.text));
            } else {
                self.opaque("runs a script KalCode can't see");
            }
            return;
        }
        // Otherwise the first positional argument starts the command text.
        let mut i = 0;
        while i < args.len() {
            match flag_of(&args[i]) {
                Some(f) => i += if takes_value(&f) { 2 } else { 1 },
                None => {
                    let joined = join_words(&args[i..]);
                    self.script(&joined, depth + 1);
                    return;
                }
            }
        }
        if piped {
            self.opaque("runs code piped from another command");
        } else {
            self.opaque("starts an interactive shell");
        }
    }

    fn interpreter(&mut self, n: &str, args: &[Word], piped: bool, depth: u8) -> bool {
        let inline_flags: &[&str] = match n {
            "python" | "python3" | "python2" | "py" | "pypy" | "pypy3" => &["-c"],
            "node" | "nodejs" => &["-e", "--eval", "-p", "--print"],
            "deno" => &["eval"],
            "bun" => &["-e", "--eval", "-p", "--print"],
            "perl" => &["-e", "-e"],
            "ruby" => &["-e"],
            "php" => &["-r"],
            "lua" | "luajit" => &["-e"],
            "osascript" => &["-e"],
            "rscript" => &["-e"],
            "mshta" | "rundll32" | "regsvr32" | "cscript" | "wscript" | "installutil"
            | "regasm" | "regsvcs" | "msiexec" | "odbcconf" | "cmstp" | "wmic" | "schtasks"
            | "at" | "crontab" => {
                self.add(S::TerminalExecute);
                self.add(S::FilesystemOutsideWorkspace);
                self.opaque(&format!(
                    "uses {n}, which can run hidden or system-wide code"
                ));
                return true;
            }
            _ => return false,
        };
        if only_version_or_help(args) {
            self.add(S::TerminalReadOnly);
            return true;
        }
        self.add(S::TerminalExecute);
        // `python -m pip install x` is a package install.
        if let Some(m) = args.iter().position(|a| a.text == "-m")
            && let Some(module) = args.get(m + 1)
        {
            let module = module.lower();
            if matches!(
                module.as_str(),
                "pip" | "pip3" | "ensurepip" | "pipx" | "uv" | "poetry"
            ) {
                let mut words = vec![Word::plain(&module)];
                words.extend(args[m + 2..].iter().cloned());
                self.program(&words, piped, depth);
                return true;
            }
            self.loose_args(&args[m + 2..], Access::Read);
            return true;
        }
        let perl_like = n == "perl" || n == "ruby";
        for (i, arg) in args.iter().enumerate() {
            let lower = arg.lower();
            let inline = inline_flags.contains(&lower.as_str())
                || (perl_like
                    && (lower.starts_with("-e")
                        || lower.starts_with("-ne")
                        || lower.starts_with("-pe")
                        || lower.contains('e')
                            && lower.starts_with('-')
                            && !lower.starts_with("--")));
            if inline {
                self.opaque("runs inline code");
                if perl_like && lower.contains('i') {
                    self.add(S::FilesystemWrite);
                    self.file_args(&args[i + 2..], Access::Write, false);
                }
                return true;
            }
        }
        match args.iter().find(|a| !a.is_flag()) {
            Some(script) => {
                self.path(script, Access::Execute);
                self.loose_args(args, Access::Read);
            }
            None if piped => self.opaque("runs code piped from another command"),
            None => self.opaque("starts an interactive interpreter"),
        }
        true
    }

    fn shell_builtin(&mut self, n: &str, args: &[Word], depth: u8) -> bool {
        match n {
            "cd" | "chdir" | "pushd" | "set-location" | "sl" | "push-location" => {
                let target = args
                    .iter()
                    .find(|a| !a.is_flag() && !is_windows_flag(&a.text));
                self.cd(target);
                self.add(S::TerminalReadOnly);
                true
            }
            "popd" | "pop-location" => {
                self.base = Base::Unknown;
                self.add(S::TerminalReadOnly);
                true
            }
            "eval" | "iex" | "invoke-expression" | "invoke-command" | "icm" | "source" | "."
            | "trap" | "alias" | "unalias" | "function" | "hash" | "enable" | "set-alias"
            | "new-alias" | "sal" | "nal" | "add-type" | "import-module" | "ipmo" | "set-item" => {
                self.add(S::TerminalExecute);
                self.opaque(&format!(
                    "uses `{n}`, which can change what later commands do"
                ));
                if matches!(n, "source" | ".") {
                    self.file_args(args, Access::Execute, false);
                }
                if matches!(n, "eval" | "iex" | "invoke-expression") && !args.is_empty() {
                    let joined = join_words(args);
                    self.script(&joined, depth + 1);
                }
                true
            }
            "export" | "set" | "declare" | "typeset" | "readonly" | "local" | "setx"
            | "set-variable" | "sv" => {
                let assignments: Vec<&Word> = args.iter().filter(|a| is_assignment(a)).collect();
                // `declare -p X`, `export -p`, `typeset -x`: print variables. cmd.exe's
                // `set PREFIX` prints every variable whose name starts with PREFIX.
                let prints = matches!(n, "declare" | "typeset" | "export" | "readonly" | "local")
                    && args.iter().any(|a| {
                        let l = a.lower();
                        a.is_flag() && !l.starts_with("--") && l.contains('p')
                    })
                    || n == "set"
                        && args
                            .iter()
                            .all(|a| !a.is_flag() && !a.text.starts_with(['+', '/']))
                        && args.iter().any(|a| !is_assignment(a));
                if prints {
                    self.add(S::CredentialsAccess);
                    self.note("Printing shell variables can reveal secrets.");
                }
                if assignments.is_empty()
                    && args.iter().all(|a| a.is_flag())
                    && !matches!(n, "setx" | "set-variable" | "sv")
                {
                    self.add(S::CredentialsAccess);
                    self.add(S::TerminalReadOnly);
                    self.note("Printing shell variables can reveal secrets.");
                    return true;
                }
                if n == "setx" {
                    self.add(S::FilesystemOutsideWorkspace);
                    self.note("setx changes environment variables for the whole user account.");
                }
                self.add(S::TerminalReadOnly);
                for assignment in assignments {
                    self.assignment(assignment);
                }
                if n == "set" && args.iter().any(|a| !a.is_flag() && !is_assignment(a)) {
                    // `set -o …`/`set +x`: shell options.
                    self.opaque("changes shell options");
                }
                true
            }
            "unset" | "remove-variable" | "rv" => {
                self.add(S::TerminalReadOnly);
                if args
                    .iter()
                    .any(|a| DANGEROUS_ENV.contains(&a.lower().as_str()))
                {
                    self.opaque("changes how later commands are found");
                }
                true
            }
            "exit" | "return" | "true" | "false" | ":" | "wait" | "sleep" | "start-sleep"
            | "cls" | "clear" | "clear-host" | "rem" | "title" | "color" | "break" | "continue"
            | "shift" => {
                self.add(S::TerminalReadOnly);
                true
            }
            _ => false,
        }
    }

    fn destructive(&mut self, n: &str, args: &[Word]) -> bool {
        match n {
            "rm" | "rmdir" | "rd" | "del" | "erase" | "unlink" | "remove-item" | "ri" | "trash"
            | "shred" | "srm" | "wipe" => {
                let windows = matches!(n, "rd" | "del" | "erase")
                    || (n == "rmdir" && args.iter().any(|a| is_windows_flag(&a.text)));
                let recursive = args.iter().any(|a| is_recursive_flag(&a.text, windows));
                self.add(S::FilesystemWrite);
                let before = self.facts.paths.len();
                let count = self.file_args(args, Access::Write, windows);
                let targets = &self.facts.paths[before..];
                let risky_target = targets
                    .iter()
                    .any(|p| p.outside || p.git_internal || p.relative.as_deref() == Some(""));
                let wild = args.iter().any(|a| !a.is_flag() && (a.glob || a.expansion));
                if recursive
                    || wild
                    || risky_target
                    || count == 0
                    || matches!(n, "shred" | "srm" | "wipe")
                {
                    self.add(S::Destructive);
                    self.note(if recursive {
                        "The command deletes folders recursively."
                    } else {
                        "The command can delete many files or files outside the workspace."
                    });
                }
                true
            }
            "format" | "format-volume" | "diskpart" | "fdisk" | "sfdisk" | "gdisk" | "parted"
            | "wipefs" | "clear-disk" | "initialize-disk" | "remove-partition"
            | "set-partition" | "mkswap" | "bcdedit" | "vssadmin" | "wbadmin" | "cipher"
            | "sdelete" | "fsutil" | "diskutil" | "zpool" | "lvremove" | "vgremove"
            | "cryptsetup" | "badblocks" => {
                self.add(S::Destructive);
                self.add(S::FilesystemOutsideWorkspace);
                self.add(S::TerminalExecute);
                self.note(format!("`{n}` can erase disks or system data."));
                true
            }
            _ if n.starts_with("mkfs") => {
                self.add(S::Destructive);
                self.add(S::FilesystemOutsideWorkspace);
                self.add(S::TerminalExecute);
                self.note("The command formats a disk.");
                true
            }
            "dd" => {
                self.add(S::TerminalExecute);
                for arg in args {
                    let lower = arg.lower();
                    if let Some(target) = lower.strip_prefix("of=") {
                        if is_raw_device(target) {
                            self.add(S::Destructive);
                            self.add(S::FilesystemOutsideWorkspace);
                            self.note("dd writes directly to a disk device.");
                        } else {
                            self.path(&Word::plain(&arg.text[3..]), Access::Write);
                        }
                    } else if let Some(source) = arg.text.strip_prefix("if=") {
                        self.path(&Word::plain(source), Access::Read);
                    }
                }
                true
            }
            "shutdown"
            | "reboot"
            | "halt"
            | "poweroff"
            | "stop-computer"
            | "restart-computer"
            | "logoff"
            | "init"
            | "systemctl"
            | "launchctl"
            | "sc"
            | "net"
            | "netsh"
            | "reg"
            | "set-executionpolicy"
            | "set-mppreference"
            | "setenforce"
            | "iptables"
            | "ufw" => {
                self.add(S::TerminalExecute);
                self.add(S::FilesystemOutsideWorkspace);
                let read_only_query = matches!(n, "systemctl" | "sc" | "net" | "netsh" | "reg")
                    && args.first().is_some_and(|a| {
                        matches!(
                            a.lower().as_str(),
                            "status"
                                | "query"
                                | "show"
                                | "list-units"
                                | "is-active"
                                | "queryex"
                                | "qc"
                                | "view"
                                | "user"
                                | "localgroup"
                                | "config"
                        )
                    })
                    && args.len() <= 3;
                if !read_only_query {
                    self.add(S::Destructive);
                    self.note(format!(
                        "`{n}` changes the whole computer, not just the workspace."
                    ));
                }
                true
            }
            "killall" | "pkill" | "taskkill" | "stop-process" | "spps" | "tskill" => {
                self.add(S::TerminalExecute);
                self.add(S::Destructive);
                self.note("The command can stop other programs.");
                true
            }
            "kill" => {
                self.add(S::TerminalExecute);
                if args.iter().any(|a| a.text == "-1" || a.text == "0") {
                    self.add(S::Destructive);
                    self.note("The command can stop every program you own.");
                }
                true
            }
            "chmod" | "chown" | "chgrp" | "icacls" | "cacls" | "takeown" | "attrib" | "chattr"
            | "setfacl" | "set-acl" => {
                let windows = matches!(n, "icacls" | "cacls" | "takeown" | "attrib");
                let recursive = args.iter().any(|a| {
                    let l = a.lower();
                    l == "-r"
                        || long_option(&l, "--recursive", 3)
                        || (windows && matches!(l.as_str(), "/t" | "/s" | "/r"))
                        || (!l.starts_with("--")
                            && l.starts_with('-')
                            && l.contains('r')
                            && !windows)
                });
                self.add(S::FilesystemWrite);
                // The first argument of chmod/chown is the mode/owner, not a path.
                let skip = usize::from(matches!(
                    n,
                    "chmod" | "chown" | "chgrp" | "chattr" | "setfacl"
                ));
                let files: Vec<Word> = args
                    .iter()
                    .filter(|a| !a.is_flag())
                    .skip(skip)
                    .cloned()
                    .collect();
                let before = self.facts.paths.len();
                self.file_args(&files, Access::Write, windows);
                let outside = self.facts.paths[before..].iter().any(|p| p.outside);
                if recursive || outside || args.iter().any(|a| a.text.contains("777")) {
                    self.add(S::Destructive);
                    self.note("The command changes permissions broadly.");
                }
                true
            }
            _ => false,
        }
    }

    fn file_writer(&mut self, n: &str, args: &[Word]) -> bool {
        match n {
            "cp" | "copy" | "copy-item" | "cpi" | "xcopy" | "robocopy" | "install" | "ditto" => {
                let windows = matches!(n, "copy" | "xcopy" | "robocopy");
                let files: Vec<&Word> = args
                    .iter()
                    .filter(|a| !a.is_flag() && !(windows && is_windows_flag(&a.text)))
                    .collect();
                for (index, file) in files.iter().enumerate() {
                    let access = if index + 1 == files.len() {
                        Access::Write
                    } else {
                        Access::Read
                    };
                    self.path(file, access);
                }
                if files.len() == 1 {
                    // `cp src` / `copy src` writes into the current folder.
                    self.add(S::FilesystemWrite);
                }
                if n == "robocopy"
                    && args
                        .iter()
                        .any(|a| matches!(a.lower().as_str(), "/mir" | "/purge" | "/move"))
                {
                    self.add(S::Destructive);
                    self.note("robocopy /MIR or /PURGE deletes files at the destination.");
                }
                self.add(S::FilesystemWrite);
                true
            }
            "mv" | "move" | "move-item" | "mi" | "ren" | "rename" | "rename-item" | "rni" => {
                let files: Vec<&Word> = args
                    .iter()
                    .filter(|a| !a.is_flag() && !is_windows_flag(&a.text))
                    .collect();
                for file in &files {
                    if matches!(file.lower().as_str(), "/dev/null" | "nul") {
                        self.add(S::Destructive);
                        continue;
                    }
                    self.path(file, Access::Write);
                }
                self.add(S::FilesystemWrite);
                true
            }
            "mkdir" | "md" | "touch" | "new-item" | "ni" | "truncate" | "mktemp" | "mkfifo"
            | "ln" | "mklink" | "new-symlink" => {
                let windows = matches!(n, "md" | "mklink");
                self.add(S::FilesystemWrite);
                if n == "mktemp" {
                    self.add(S::FilesystemOutsideWorkspace);
                }
                let mut i = 0;
                while i < args.len() {
                    let lower = args[i].lower();
                    // New-Item -ItemType SymbolicLink -Path x -Target y
                    if matches!(lower.as_str(), "-target" | "-value")
                        && let Some(target) = args.get(i + 1)
                    {
                        self.path(target, Access::Read);
                        i += 2;
                        continue;
                    }
                    if matches!(lower.as_str(), "-itemtype" | "-type" | "-name") {
                        i += 2;
                        continue;
                    }
                    if matches!(lower.as_str(), "-path" | "-p") && n != "mkdir" {
                        if let Some(target) = args.get(i + 1) {
                            self.path(target, Access::Write);
                        }
                        i += 2;
                        continue;
                    }
                    if !args[i].is_flag() && !(windows && is_windows_flag(&args[i].text)) {
                        self.path(&args[i], Access::Write);
                    }
                    i += 1;
                }
                true
            }
            "tee" | "tee-object" | "out-file" | "set-content" | "add-content" | "ac"
            | "clear-content" | "clc" | "export-csv" | "export-clixml" => {
                self.add(S::FilesystemWrite);
                let mut i = 0;
                while i < args.len() {
                    let lower = args[i].lower();
                    if matches!(
                        lower.as_str(),
                        "-filepath" | "-path" | "-literalpath" | "-file"
                    ) {
                        if let Some(target) = args.get(i + 1) {
                            self.path(target, Access::Write);
                        }
                        i += 2;
                        continue;
                    }
                    if matches!(
                        lower.as_str(),
                        "-value" | "-inputobject" | "-encoding" | "-variable"
                    ) {
                        i += 2;
                        continue;
                    }
                    if !args[i].is_flag() {
                        self.path(&args[i], Access::Write);
                        if n != "tee" {
                            // Positional value after the path is data.
                            break;
                        }
                    }
                    i += 1;
                }
                true
            }
            "sed" | "perl-i" => {
                let in_place = args.iter().any(|a| {
                    let l = a.lower();
                    l == "-i"
                        || l.starts_with("--in-place")
                        || (l.starts_with("-i") && !l.starts_with("--"))
                        || (l.starts_with('-') && !l.starts_with("--") && l.contains('i'))
                });
                let script_from_flag = args
                    .iter()
                    .any(|a| matches!(a.lower().as_str(), "-e" | "--expression" | "-f" | "--file"));
                let mut positional: Vec<&Word> = args.iter().filter(|a| !a.is_flag()).collect();
                if !script_from_flag && !positional.is_empty() {
                    let script = positional.remove(0);
                    // GNU sed can run commands (`e`) and write files (`w`) from its script.
                    if script.text.contains('e') && script.text.contains(['/', ';'])
                        || script.text.contains(" w ")
                        || script.text.starts_with('w')
                    {
                        self.add(S::TerminalExecute);
                    }
                }
                for file in positional {
                    self.path(
                        file,
                        if in_place {
                            Access::Write
                        } else {
                            Access::Read
                        },
                    );
                }
                if in_place {
                    self.add(S::FilesystemWrite);
                }
                self.add(S::TerminalExecute);
                true
            }
            "patch" => {
                self.add(S::FilesystemWrite);
                self.add(S::TerminalExecute);
                self.loose_args(args, Access::Write);
                true
            }
            "tar" | "bsdtar" | "unzip" | "zip" | "7z" | "7za" | "gzip" | "gunzip" | "bzip2"
            | "bunzip2" | "xz" | "unxz" | "zstd" | "expand-archive" | "compress-archive" => {
                let listing = n == "tar"
                    && args.first().is_some_and(|a| {
                        let l = a.lower();
                        (l.starts_with('-') || l.chars().all(|c| c.is_ascii_alphabetic()))
                            && l.contains('t')
                            && !l.contains('x')
                            && !l.contains('c')
                    });
                if args.iter().any(|a| {
                    let l = a.lower();
                    l.starts_with("--to-command")
                        || l.starts_with("--use-compress-program")
                        || l == "-i" && n == "tar"
                        || l.starts_with("--checkpoint-action")
                        || l.starts_with("--rsh-command")
                        || l.starts_with("--info-script")
                        || l.starts_with("--new-volume-script")
                }) {
                    self.opaque("asks the archiver to run another program");
                    self.add(S::TerminalExecute);
                }
                if listing {
                    self.add(S::TerminalReadOnly);
                    self.file_args(&args[1..], Access::Read, false);
                } else {
                    self.add(S::FilesystemWrite);
                    self.loose_args(args, Access::Write);
                    if matches!(
                        n,
                        "unzip" | "tar" | "bsdtar" | "7z" | "7za" | "expand-archive"
                    ) {
                        self.note(
                            "Extracting an archive can write anywhere the archive's paths point.",
                        );
                    }
                }
                true
            }
            _ => false,
        }
    }

    fn git(&mut self, n: &str, args: &[Word]) -> bool {
        if n != "git" {
            return false;
        }
        let mut i = 0;
        while i < args.len() && args[i].is_flag() {
            let lower = args[i].lower();
            // Git options are case-sensitive: `-C <dir>` changes directory, `-c k=v` sets config.
            if args[i].text == "-C" {
                let target = args.get(i + 1).cloned();
                self.cd(target.as_ref());
                i += 2;
                continue;
            }
            if args[i].text == "-c" {
                self.opaque("overrides Git configuration, which can make Git run programs");
                self.add(S::TerminalExecute);
                i += 2;
                continue;
            }
            if let Some(value) = lower
                .strip_prefix("--git-dir=")
                .or_else(|| lower.strip_prefix("--work-tree="))
            {
                let original = &args[i].text[args[i].text.len() - value.len()..];
                self.path(&Word::plain(original), Access::Read);
            } else if matches!(lower.as_str(), "--git-dir" | "--work-tree" | "--namespace") {
                if let Some(target) = args.get(i + 1) {
                    self.path(target, Access::Read);
                }
                i += 2;
                continue;
            } else if lower.starts_with("--exec-path") || lower.starts_with("--config-env") {
                self.opaque("overrides where Git finds its programs");
                self.add(S::TerminalExecute);
            }
            i += 1;
        }
        let Some(sub) = args.get(i) else {
            self.add(S::GitRead);
            return true;
        };
        let sub = sub.lower();
        let rest = &args[i + 1..];
        let has = |flags: &[&str]| rest.iter().any(|a| flags.contains(&a.lower().as_str()));
        // Options that add authority also match abbreviated (`--forc`, `--har`): Git's option
        // parser accepts any unambiguous prefix of a long option.
        let has_long = |flags: &[&str]| {
            rest.iter().any(|a| {
                let l = a.lower();
                flags
                    .iter()
                    .any(|f| l == *f || (f.starts_with("--") && long_option(&l, f, 2)))
            })
        };
        let positional: Vec<&Word> = rest.iter().filter(|a| !a.is_flag()).collect();
        for (index, arg) in rest.iter().enumerate() {
            let lower = arg.lower();
            if long_option(&lower, "--output", 3) {
                match arg.text.split_once('=') {
                    Some((_, value)) => self.path(&Word::plain(value), Access::Write),
                    None => {
                        if let Some(target) = rest.get(index + 1) {
                            self.path(target, Access::Write);
                        }
                    }
                }
            }
        }
        // Options that make Git run a program named on the command line or in configuration:
        // `--upload-pack=cmd`, `grep -O cmd`, `diff --ext-diff`, `rebase -x cmd`, filters…
        const EXEC_OPTIONS: &[(&str, usize)] = &[
            ("--upload-pack", 2),
            ("--receive-pack", 2),
            ("--exec", 3),
            ("--open-files-in-pager", 2),
            ("--ext-diff", 3),
            ("--extcmd", 3),
            ("--tool", 3),
            ("--to-cmd", 4),
            ("--cc-cmd", 3),
            ("--sendmail-cmd", 3),
            ("--header-cmd", 3),
            ("--index-filter", 3),
            ("--tree-filter", 3),
            ("--msg-filter", 3),
            ("--env-filter", 3),
            ("--commit-filter", 3),
            ("--parent-filter", 3),
            ("--tag-name-filter", 3),
        ];
        let exec_option = rest.iter().any(|a| {
            let l = a.lower();
            EXEC_OPTIONS
                .iter()
                .any(|(option, min)| long_option(&l, option, *min))
                || (matches!(sub.as_str(), "grep")
                    && a.text.starts_with('-')
                    && !a.text.starts_with("--")
                    && a.text.contains('O'))
                || (matches!(sub.as_str(), "clone") && a.text.starts_with("-u"))
                || (matches!(sub.as_str(), "rebase") && a.text.starts_with("-x"))
                || (matches!(sub.as_str(), "help") && matches!(l.as_str(), "-w" | "--web"))
        });
        if exec_option {
            self.add(S::TerminalExecute);
            self.opaque("asks Git to run another program");
        }
        let hooks = |cx: &mut Self| {
            cx.add(S::TerminalExecute);
            cx.note("Git may run repository hooks for this operation.");
        };
        match sub.as_str() {
            "status" | "diff" | "log" | "show" | "blame" | "annotate" | "shortlog" | "describe"
            | "rev-parse" | "rev-list" | "ls-files" | "ls-tree" | "cat-file" | "grep" | "help"
            | "version" | "--version" | "count-objects" | "fsck" | "whatchanged" | "name-rev"
            | "merge-base" | "for-each-ref" | "show-ref" | "check-ignore" | "check-attr"
            | "verify-commit" | "verify-tag" | "show-branch" | "range-diff" | "cherry" | "var"
            | "diff-tree" | "diff-index" | "diff-files" | "shortlog-" => {
                if has(&["--ext-diff", "--textconv"]) {
                    self.add(S::TerminalExecute);
                }
                self.add(S::GitRead);
                // `git diff --no-index /etc/passwd …` and `git grep --no-index` read any file;
                // revisions (`HEAD:src/a`, `main..dev`) are left alone.
                for arg in &positional {
                    let text = arg.text.trim();
                    if is_absolute_like(text)
                        || text.starts_with("..")
                        || text.starts_with('~')
                        || arg.expansion
                    {
                        self.path(arg, Access::Read);
                    }
                }
            }
            "branch" => {
                if has_long(&[
                    "-d",
                    "--delete",
                    "-m",
                    "--move",
                    "-c",
                    "--copy",
                    "-u",
                    "--set-upstream-to",
                    "--unset-upstream",
                    "--edit-description",
                    "-f",
                    "--force",
                ]) || has(&["-D", "-M", "-C"])
                    || rest.iter().any(|a| a.text == "-D" || a.text == "-M")
                {
                    self.add(S::GitCommit);
                    if rest
                        .iter()
                        .any(|a| a.text == "-D" || a.text == "-M" || a.text == "-f")
                        || has_long(&["--force"])
                    {
                        self.add(S::Destructive);
                        self.note("Force-deleting a branch can lose commits.");
                    }
                } else if !positional.is_empty()
                    && !has(&[
                        "-l",
                        "--list",
                        "--contains",
                        "--merged",
                        "--no-merged",
                        "--points-at",
                    ])
                {
                    self.add(S::GitCommit);
                } else {
                    self.add(S::GitRead);
                }
            }
            "tag" => {
                if positional.is_empty()
                    || has(&["-l", "--list", "-n", "--contains", "--points-at"])
                        && !has_long(&["-d", "--delete", "-f", "--force"])
                {
                    self.add(S::GitRead);
                } else {
                    self.add(S::GitCommit);
                }
            }
            "remote" => {
                if positional.is_empty()
                    || matches!(positional[0].lower().as_str(), "show" | "get-url")
                {
                    self.add(S::GitRead);
                    if positional.first().is_some_and(|p| p.lower() == "show") {
                        self.add(S::NetworkOther);
                    }
                } else {
                    self.add(S::GitCommit);
                    if matches!(positional[0].lower().as_str(), "update" | "prune") {
                        self.add(S::NetworkOther);
                    }
                }
            }
            "config" => {
                let reading = has(&[
                    "--get",
                    "--get-all",
                    "--get-regexp",
                    "--list",
                    "-l",
                    "--show-origin",
                    "--show-scope",
                    "--get-urlmatch",
                    "--get-color",
                    "--get-colorbool",
                ]) || (positional.len() == 1
                    && !has(&[
                        "--unset",
                        "--unset-all",
                        "--add",
                        "--replace-all",
                        "--remove-section",
                        "--rename-section",
                        "-e",
                        "--edit",
                    ]))
                    || positional
                        .first()
                        .is_some_and(|p| matches!(p.lower().as_str(), "get" | "list"));
                if reading {
                    self.add(S::GitRead);
                    if rest.iter().any(|a| {
                        a.lower().contains("credential")
                            || a.lower().contains("token")
                            || a.lower().contains("password")
                    }) {
                        self.add(S::CredentialsAccess);
                    }
                } else {
                    self.add(S::GitCommit);
                    self.add(S::TerminalExecute);
                    self.opaque("changes Git configuration, which can make Git run programs");
                    if has_long(&["--global", "--system"]) {
                        self.add(S::FilesystemOutsideWorkspace);
                    }
                }
            }
            "stash" => match positional.first().map(|p| p.lower()).as_deref() {
                Some("list" | "show") => self.add(S::GitRead),
                Some("drop" | "clear") => {
                    self.add(S::GitCommit);
                    self.add(S::Destructive);
                    self.note("Dropping stashes discards saved changes.");
                }
                _ => self.add(S::GitCommit),
            },
            "worktree" => match positional.first().map(|p| p.lower()).as_deref() {
                Some("list") => self.add(S::GitRead),
                Some("remove" | "prune") => {
                    self.add(S::GitCommit);
                    self.add(S::FilesystemWrite);
                    if has_long(&["-f", "--force"]) {
                        self.add(S::Destructive);
                    }
                    self.file_args(&rest[1..], Access::Write, false);
                }
                _ => {
                    self.add(S::GitCommit);
                    self.add(S::FilesystemWrite);
                    hooks(self);
                    let files: Vec<Word> =
                        positional.iter().skip(1).map(|w| (*w).clone()).collect();
                    self.file_args(&files, Access::Write, false);
                }
            },
            "add" | "mv" | "rm" | "commit" | "merge" | "cherry-pick" | "revert" | "am"
            | "apply" | "init" | "notes" | "replace" | "update-index" | "sparse-checkout"
            | "mergetool" | "rerere" | "commit-tree" | "write-tree" | "read-tree"
            | "symbolic-ref" | "hash-object" | "restore" | "checkout" | "switch" | "reset"
            | "rebase" | "update-ref" => {
                self.add(S::GitCommit);
                if matches!(
                    sub.as_str(),
                    "add"
                        | "mv"
                        | "rm"
                        | "apply"
                        | "restore"
                        | "checkout"
                        | "switch"
                        | "reset"
                        | "merge"
                        | "rebase"
                        | "cherry-pick"
                        | "revert"
                        | "am"
                        | "init"
                ) {
                    self.add(S::FilesystemWrite);
                }
                if matches!(
                    sub.as_str(),
                    "commit"
                        | "merge"
                        | "cherry-pick"
                        | "revert"
                        | "am"
                        | "rebase"
                        | "checkout"
                        | "switch"
                        | "mergetool"
                ) {
                    hooks(self);
                }
                let destructive = match sub.as_str() {
                    "reset" => has_long(&["--hard", "--merge", "--keep"]),
                    "checkout" => {
                        has_long(&["-f", "--force", "--", "."])
                            || positional.iter().any(|p| p.text == "." || p.glob)
                    }
                    "switch" => has_long(&["-f", "--force", "--discard-changes"]),
                    "restore" => !has(&["--staged", "-s"]) || has_long(&["--worktree", "-w"]),
                    "update-ref" => has(&["-d"]),
                    "rm" => {
                        has_long(&["-r", "-rf", "-f", "--force"])
                            || rest.iter().any(|a| {
                                a.is_flag()
                                    && !a.text.starts_with("--")
                                    && a.text.contains(['r', 'f'])
                            })
                    }
                    "rebase" => false,
                    _ => false,
                };
                if destructive {
                    self.add(S::Destructive);
                    self.note("This Git operation can discard uncommitted work.");
                }
                if sub == "rebase" && has_long(&["-i", "--interactive", "-x", "--exec"]) {
                    self.opaque("runs an interactive or scripted rebase");
                }
                if sub == "rm" || sub == "mv" || sub == "add" {
                    let files: Vec<Word> = positional.iter().map(|w| (*w).clone()).collect();
                    self.file_args(
                        &files,
                        if sub == "add" {
                            Access::Read
                        } else {
                            Access::Write
                        },
                        false,
                    );
                }
                if sub == "init" {
                    let files: Vec<Word> = positional.iter().map(|w| (*w).clone()).collect();
                    self.file_args(&files, Access::Write, false);
                }
                if sub == "apply" || sub == "am" {
                    let files: Vec<Word> = positional.iter().map(|w| (*w).clone()).collect();
                    self.file_args(&files, Access::Read, false);
                }
            }
            "clean" => {
                if has(&["-n", "--dry-run"]) {
                    self.add(S::GitRead);
                } else {
                    self.add(S::GitCommit);
                    self.add(S::FilesystemWrite);
                    if rest
                        .iter()
                        .any(|a| a.is_flag() && !a.text.starts_with("--") && a.text.contains('f'))
                        || has_long(&["--force"])
                    {
                        self.add(S::Destructive);
                        self.note("git clean deletes untracked files.");
                    }
                }
            }
            "gc" | "prune" | "reflog" | "filter-branch" | "filter-repo" | "maintenance"
            | "repack" => {
                if sub == "reflog" && positional.first().is_none_or(|p| p.lower() == "show") {
                    self.add(S::GitRead);
                } else {
                    self.add(S::GitCommit);
                    if matches!(sub.as_str(), "prune" | "filter-branch" | "filter-repo")
                        || rest.iter().any(|a| {
                            long_option(&a.lower(), "--prune", 3)
                                || a.lower().starts_with("--prune")
                                || a.lower() == "expire"
                                || a.lower() == "delete"
                        })
                    {
                        self.add(S::Destructive);
                        self.note("This Git operation permanently rewrites or removes history.");
                    }
                }
            }
            "fetch" | "ls-remote" => {
                self.add(S::GitRead);
                self.add(S::NetworkOther);
            }
            "pull" => {
                self.add(S::GitCommit);
                self.add(S::FilesystemWrite);
                self.add(S::NetworkOther);
                hooks(self);
            }
            "clone" => {
                self.add(S::NetworkOther);
                self.add(S::FilesystemWrite);
                for arg in &positional {
                    if arg.text.contains("://") {
                        self.url(&arg.text, false);
                    }
                }
                if let Some(target) = positional.get(1) {
                    self.path(target, Access::Write);
                }
                if rest.iter().any(|a| {
                    a.lower().starts_with("--template")
                        || a.lower() == "-u"
                        || a.lower().starts_with("--upload-pack")
                        || a.lower() == "--config"
                        || a.lower() == "-c"
                }) {
                    self.opaque("clones with options that can run programs");
                }
            }
            "push" => {
                self.add(S::GitPush);
                hooks(self);
                let force = rest.iter().any(|a| {
                    let l = a.lower();
                    matches!(l.as_str(), "-f" | "-d")
                        || (a.is_flag()
                            && !l.starts_with("--")
                            && (a.text.contains('f') || a.text.contains('d')))
                        || [
                            "--force",
                            "--mirror",
                            "--delete",
                            "--prune",
                            "--force-if-includes",
                            "--force-with-lease",
                        ]
                        .iter()
                        .any(|o| long_option(&l, o, 2))
                        || (!a.is_flag() && (a.text.starts_with('+') || a.text.starts_with(':')))
                });
                if force {
                    self.add(S::Destructive);
                    self.note("This push can overwrite or delete remote history.");
                }
                if let Some(remote) = positional.first() {
                    if remote.text.contains("://") {
                        self.url(&remote.text, true);
                    }
                    self.note(format!("Pushes to {}.", remote.text));
                }
            }
            "send-email" | "request-pull" | "imap-send" => {
                self.add(S::MessagingSend);
                self.add(S::NetworkOther);
            }
            "submodule" => match positional.first().map(|p| p.lower()).as_deref() {
                Some("status" | "summary") | None => self.add(S::GitRead),
                Some("foreach") => {
                    self.add(S::TerminalExecute);
                    self.opaque("runs a command in every submodule");
                }
                _ => {
                    self.add(S::GitCommit);
                    self.add(S::NetworkOther);
                    self.add(S::FilesystemWrite);
                }
            },
            "bisect" => {
                self.add(S::GitCommit);
                if positional.first().is_some_and(|p| p.lower() == "run") {
                    self.add(S::TerminalExecute);
                    self.opaque("runs a script for every bisect step");
                }
            }
            "credential" | "credential-store" | "credential-cache" | "credential-manager" => {
                self.add(S::CredentialsAccess);
                self.add(S::TerminalExecute);
            }
            "lfs" => {
                self.add(S::GitCommit);
                self.add(S::NetworkOther);
                if positional.first().is_some_and(|p| p.lower() == "push") {
                    self.add(S::GitPush);
                }
            }
            "difftool" | "web--browse" | "instaweb" | "daemon" | "shell" | "archive" | "bundle"
            | "svn" | "p4" | "cvsimport" => {
                self.add(S::TerminalExecute);
                self.add(S::GitRead);
                if matches!(sub.as_str(), "archive" | "bundle") {
                    self.loose_args(rest, Access::Write);
                } else {
                    self.opaque(&format!("runs `git {sub}`, which can start other programs"));
                }
            }
            _ => {
                self.add(S::GitCommit);
                self.add(S::TerminalExecute);
                self.opaque(&format!(
                    "runs `git {sub}`, which may be an alias for another command"
                ));
            }
        }
        true
    }

    fn package(&mut self, n: &str, args: &[Word]) -> bool {
        let first = args.iter().find(|a| !a.is_flag()).map(Word::lower);
        let sub = first.as_deref().unwrap_or("");
        let global = args.iter().any(|a| {
            matches!(
                a.lower().as_str(),
                "-g" | "--global" | "--location=global" | "--user" | "--system" | "--root"
            )
        });
        let install = |cx: &mut Self| {
            cx.add(S::PackageInstall);
            if global {
                cx.add(S::FilesystemOutsideWorkspace);
                cx.note("The command installs packages for the whole computer.");
            }
        };
        match n {
            "npx" | "pnpx" | "bunx" | "uvx" | "pipx"
                if n != "pipx" || matches!(sub, "run" | "") =>
            {
                install(self);
                self.add(S::TerminalExecute);
                self.note("The command downloads and runs a package.");
                true
            }
            "npm" | "pnpm" | "yarn" | "bun" | "cnpm" => {
                let installs = [
                    "install",
                    "i",
                    "in",
                    "ins",
                    "inst",
                    "insta",
                    "instal",
                    "isnt",
                    "isnta",
                    "isntal",
                    "add",
                    "a",
                    "ci",
                    "clean-install",
                    "install-clean",
                    "update",
                    "up",
                    "upgrade",
                    "udpate",
                    "uninstall",
                    "un",
                    "unlink",
                    "remove",
                    "rm",
                    "r",
                    "dedupe",
                    "ddp",
                    "prune",
                    "rebuild",
                    "rb",
                    "link",
                    "ln",
                    "import",
                    "fetch",
                    "patch-commit",
                    "install-test",
                    "it",
                ];
                let runs_packages = ["exec", "x", "dlx", "create", "init"];
                let reads = [
                    "ls",
                    "list",
                    "la",
                    "ll",
                    "why",
                    "explain",
                    "help",
                    "prefix",
                    "root",
                    "bin",
                    "--version",
                    "-v",
                    "config",
                    "get",
                    "licenses",
                    "store",
                    "cache",
                    "pm",
                ];
                let network_reads = [
                    "view", "v", "info", "show", "outdated", "search", "s", "se", "find", "ping",
                    "audit", "doctor", "fund", "docs", "bugs", "repo", "home",
                ];
                let publishes = [
                    "publish",
                    "unpublish",
                    "deprecate",
                    "dist-tag",
                    "owner",
                    "access",
                    "team",
                    "hook",
                    "star",
                    "unstar",
                ];
                let credentials = ["login", "logout", "adduser", "add-user", "token", "whoami"];
                if sub.is_empty() {
                    if n == "yarn" || n == "bun" && args.is_empty() {
                        install(self);
                    } else {
                        self.add(S::TerminalReadOnly);
                    }
                } else if n == "yarn" && sub == "global" {
                    self.add(S::PackageInstall);
                    self.add(S::FilesystemOutsideWorkspace);
                } else if installs.contains(&sub)
                    || (sub == "audit" && args.iter().any(|a| a.lower() == "fix"))
                {
                    install(self);
                } else if runs_packages.contains(&sub) {
                    install(self);
                    self.add(S::TerminalExecute);
                    self.note("The command downloads and runs a package.");
                } else if publishes.contains(&sub) {
                    self.add(S::DeployProduction);
                    self.add(S::NetworkOther);
                    if sub == "unpublish" {
                        self.add(S::Destructive);
                    }
                    self.note("The command publishes to a package registry.");
                } else if credentials.contains(&sub) {
                    self.add(S::CredentialsAccess);
                    self.add(S::NetworkOther);
                } else if sub == "version" && args.iter().filter(|a| !a.is_flag()).count() > 1 {
                    self.add(S::GitCommit);
                    self.add(S::FilesystemWrite);
                    self.add(S::TerminalExecute);
                } else if sub == "config"
                    && args
                        .iter()
                        .any(|a| matches!(a.lower().as_str(), "set" | "delete" | "edit" | "fix"))
                {
                    self.add(S::TerminalExecute);
                    self.add(S::FilesystemOutsideWorkspace);
                    self.opaque("changes package manager configuration");
                } else if reads.contains(&sub) || sub == "version" {
                    self.add(S::TerminalReadOnly);
                } else if network_reads.contains(&sub) {
                    self.add(S::TerminalReadOnly);
                    self.add(S::NetworkOther);
                } else {
                    // run, test, start, or a package.json script by name.
                    self.add(S::TerminalExecute);
                }
                true
            }
            "pip" | "pip3" | "pip2" | "uv" | "poetry" | "pdm" | "pipenv" | "conda" | "mamba"
            | "micromamba" | "pipx" | "hatch" | "rye" => {
                let installs = [
                    "install",
                    "uninstall",
                    "download",
                    "wheel",
                    "add",
                    "remove",
                    "sync",
                    "lock",
                    "update",
                    "upgrade",
                    "create",
                    "inject",
                    "reinstall",
                    "ensurepath",
                    "venv",
                    "init",
                    "new",
                ];
                let sub_pip = if n == "uv" && sub == "pip" {
                    args.iter()
                        .filter(|a| !a.is_flag())
                        .nth(1)
                        .map(Word::lower)
                        .unwrap_or_default()
                } else {
                    sub.to_owned()
                };
                let s = sub_pip.as_str();
                if s.is_empty()
                    || only_version_or_help(args)
                    || matches!(
                        s,
                        "list"
                            | "show"
                            | "freeze"
                            | "check"
                            | "help"
                            | "inspect"
                            | "info"
                            | "tree"
                            | "env"
                            | "debug"
                            | "cache"
                            | "search"
                            | "index"
                    )
                {
                    self.add(S::TerminalReadOnly);
                    if matches!(s, "search" | "index") {
                        self.add(S::NetworkOther);
                    }
                } else if installs.contains(&s) || (n == "uv" && matches!(s, "tool" | "python")) {
                    install(self);
                    if matches!(n, "pipx" | "conda" | "mamba" | "micromamba")
                        || (n == "uv" && matches!(s, "tool" | "python"))
                    {
                        self.add(S::FilesystemOutsideWorkspace);
                    }
                    for (i, arg) in args.iter().enumerate() {
                        if matches!(
                            arg.lower().as_str(),
                            "-r" | "--requirement"
                                | "-c"
                                | "--constraint"
                                | "-e"
                                | "--editable"
                                | "-t"
                                | "--target"
                                | "--prefix"
                        ) && let Some(file) = args.get(i + 1)
                        {
                            self.path(file, Access::Read);
                        }
                    }
                } else if matches!(s, "publish" | "upload") {
                    self.add(S::DeployProduction);
                    self.add(S::NetworkOther);
                } else if matches!(s, "config" | "login" | "logout" | "auth") {
                    self.add(S::CredentialsAccess);
                    self.add(S::TerminalExecute);
                } else {
                    // run, shell, exec, script names…
                    self.add(S::TerminalExecute);
                }
                true
            }
            "cargo" => {
                match sub {
                    "" | "--version" | "-v" | "version" | "help" | "metadata"
                    | "locate-project" | "pkgid" | "read-manifest" | "verify-project"
                    | "--list" => self.add(S::TerminalReadOnly),
                    "search" | "info" => {
                        self.add(S::TerminalReadOnly);
                        self.add(S::NetworkOther);
                    }
                    "tree" => {
                        self.add(S::TerminalReadOnly);
                        self.add(S::NetworkOther);
                    }
                    "add" | "update" | "remove" | "rm" | "fetch" | "vendor"
                    | "generate-lockfile" => install(self),
                    "install" | "uninstall" | "binstall" => {
                        self.add(S::PackageInstall);
                        self.add(S::FilesystemOutsideWorkspace);
                        self.note("cargo install puts programs in your home folder.");
                    }
                    "publish" | "yank" | "owner" => {
                        self.add(S::DeployProduction);
                        self.add(S::NetworkOther);
                    }
                    "login" | "logout" => self.add(S::CredentialsAccess),
                    "clean" => {
                        self.add(S::TerminalExecute);
                        self.add(S::FilesystemWrite);
                    }
                    _ => {
                        self.add(S::TerminalExecute);
                        self.note("Cargo builds run build scripts and procedural macros.");
                    }
                }
                true
            }
            "go" => {
                match sub {
                    "version" | "env" | "list" | "doc" | "help" | "" => {
                        if sub == "env"
                            && args
                                .iter()
                                .any(|a| matches!(a.lower().as_str(), "-w" | "-u"))
                        {
                            self.add(S::TerminalExecute);
                            self.add(S::FilesystemOutsideWorkspace);
                        } else {
                            self.add(S::TerminalReadOnly);
                        }
                    }
                    "get" => install(self),
                    "install" => {
                        self.add(S::PackageInstall);
                        self.add(S::FilesystemOutsideWorkspace);
                    }
                    "mod" => {
                        if args
                            .iter()
                            .any(|a| matches!(a.lower().as_str(), "download" | "tidy" | "vendor"))
                        {
                            install(self);
                        } else {
                            self.add(S::TerminalReadOnly);
                        }
                    }
                    _ => self.add(S::TerminalExecute),
                }
                true
            }
            "gem" | "bundle" | "bundler" | "composer" | "dotnet" | "nuget" | "deno" | "rustup"
            | "nvm" | "fnm" | "volta" | "sdk" | "asdf" | "mise" | "corepack" => {
                let installs = [
                    "install",
                    "i",
                    "add",
                    "require",
                    "update",
                    "upgrade",
                    "uninstall",
                    "remove",
                    "restore",
                    "sync",
                    "use",
                    "default",
                    "toolchain",
                    "target",
                    "component",
                    "enable",
                    "prepare",
                    "cache",
                ];
                if sub.is_empty()
                    || only_version_or_help(args)
                    || matches!(
                        sub,
                        "list"
                            | "show"
                            | "info"
                            | "outdated"
                            | "--version"
                            | "search"
                            | "which"
                            | "check"
                            | "doctor"
                            | "current"
                            | "ls"
                    )
                {
                    self.add(S::TerminalReadOnly);
                } else if n == "dotnet" && sub == "add" {
                    install(self);
                } else if n == "dotnet" && sub == "tool" {
                    install(self);
                    if global {
                        self.add(S::FilesystemOutsideWorkspace);
                    }
                } else if n == "dotnet"
                    && sub == "nuget"
                    && args.iter().any(|a| a.lower() == "push")
                    || n == "nuget" && sub == "push"
                    || n == "gem" && sub == "push"
                    || n == "deno" && sub == "publish"
                {
                    self.add(S::DeployProduction);
                    self.add(S::NetworkOther);
                } else if installs.contains(&sub) {
                    install(self);
                    if matches!(
                        n,
                        "gem"
                            | "rustup"
                            | "nvm"
                            | "fnm"
                            | "volta"
                            | "sdk"
                            | "asdf"
                            | "mise"
                            | "corepack"
                    ) {
                        self.add(S::FilesystemOutsideWorkspace);
                    }
                } else {
                    self.add(S::TerminalExecute);
                }
                true
            }
            "brew" | "apt" | "apt-get" | "aptitude" | "yum" | "dnf" | "pacman" | "yay" | "paru"
            | "apk" | "zypper" | "choco" | "chocolatey" | "winget" | "scoop" | "snap"
            | "flatpak" | "port" | "emerge" | "pkg" | "nix-env" | "install-package"
            | "install-module" | "dpkg" | "rpm" => {
                let reads = [
                    "list",
                    "search",
                    "info",
                    "show",
                    "query",
                    "-q",
                    "-qi",
                    "-ql",
                    "-ss",
                    "-si",
                    "--version",
                    "-v",
                    "status",
                    "policy",
                    "outdated",
                    "leaves",
                    "deps",
                    "uses",
                    "config",
                    "doctor",
                    "home",
                    "export",
                ];
                if sub.is_empty()
                    || reads.contains(&sub)
                    || only_version_or_help(args)
                    || (n == "pacman" && args.first().is_some_and(|a| a.text.starts_with("-Q")))
                    || (n == "dpkg"
                        && args.iter().any(|a| {
                            matches!(
                                a.lower().as_str(),
                                "-l" | "-s" | "-L" | "--list" | "--status"
                            )
                        }))
                {
                    self.add(S::TerminalReadOnly);
                    if matches!(sub, "search" | "info" | "-ss" | "-si" | "outdated") {
                        self.add(S::NetworkOther);
                    }
                } else {
                    self.add(S::PackageInstall);
                    self.add(S::FilesystemOutsideWorkspace);
                    self.note("The command changes software installed on the whole computer.");
                    if matches!(
                        sub,
                        "remove"
                            | "uninstall"
                            | "purge"
                            | "autoremove"
                            | "-r"
                            | "-rs"
                            | "-rns"
                            | "erase"
                    ) {
                        self.add(S::Destructive);
                    }
                }
                true
            }
            "playwright" if sub == "install" => {
                install(self);
                self.add(S::FilesystemOutsideWorkspace);
                true
            }
            _ => false,
        }
    }

    fn network_program(&mut self, n: &str, args: &[Word]) -> bool {
        match n {
            "curl" | "wget" | "invoke-webrequest" | "iwr" | "invoke-restmethod" | "irm"
            | "http" | "https" | "xh" | "httpie" | "aria2c" | "start-bitstransfer"
            | "bitsadmin" | "certutil" | "lwp-request" | "fetch" => {
                let lower: Vec<String> = args.iter().map(Word::lower).collect();
                // PowerShell cmdlets accept abbreviated parameters (`-Me Post -InF .env`).
                let ps = matches!(n, "invoke-webrequest" | "iwr" | "invoke-restmethod" | "irm");
                let ps_method = |i: usize, a: &str| {
                    ps && ps_param(a, "method", 2)
                        && match a.split_once(':') {
                            Some((_, m)) => !matches!(m, "get" | "head" | "options"),
                            None => lower
                                .get(i + 1)
                                .is_some_and(|m| !matches!(m.as_str(), "get" | "head" | "options")),
                        }
                };
                let sends = lower.iter().enumerate().any(|(i, a)| {
                    ps_method(i, a)
                        || ps
                            && (ps_param(a, "body", 2)
                                || ps_param(a, "infile", 3)
                                || ps_param(a, "form", 2))
                        || n == "wget"
                            && ["--post-data", "--post-file", "--body-data", "--body-file"]
                                .iter()
                                .any(|o| long_option(a, o, 3))
                        || a.starts_with("-d") && n == "curl"
                        || a.starts_with("--data")
                        || matches!(
                            a.as_str(),
                            "-f" | "--form"
                                | "-t"
                                | "--upload-file"
                                | "--json"
                                | "--post-data"
                                | "--post-file"
                                | "--body-data"
                                | "--body-file"
                                | "-body"
                                | "-infile"
                                | "--upload"
                                | "/upload"
                        )
                        || a.starts_with("--form")
                        || (matches!(a.as_str(), "-x" | "--request" | "-method" | "--method")
                            && lower
                                .get(i + 1)
                                .is_some_and(|m| !matches!(m.as_str(), "get" | "head" | "options")))
                        || a.starts_with("--method=") && !a.ends_with("=get")
                        || a.starts_with("-x")
                            && a.len() > 2
                            && n == "curl"
                            && !a.ends_with("get")
                            && !a.ends_with("head")
                });
                if n == "curl" && args.iter().any(|a| a.text == "-T") {
                    self.add(S::NetworkOther);
                }
                let mut saw_url = false;
                for (i, arg) in args.iter().enumerate() {
                    let l = &lower[i];
                    if arg.text.contains("://") {
                        saw_url = true;
                        self.url(&arg.text, sends);
                        continue;
                    }
                    if (l == "-uri" || ps && ps_param(l, "uri", 2))
                        && let Some(uri) = args.get(i + 1)
                    {
                        saw_url = true;
                        self.url(&uri.text, sends);
                    }
                    // Files the request uploads: `-d @.env`, `-F f=@key.pem`, `-T x`,
                    // `--post-file=x`, `-InFile x`.
                    let uploads = |cx: &mut Self, value: &str| {
                        let value = value.trim();
                        let file = value
                            .strip_prefix('@')
                            .or_else(|| value.split_once("=@").map(|(_, f)| f))
                            .or_else(|| value.split_once("=<").map(|(_, f)| f))
                            .or_else(|| value.strip_prefix('<'));
                        if let Some(file) = file
                            && !file.is_empty()
                            && file != "-"
                        {
                            cx.path(
                                &Word::plain(file.split(';').next().unwrap_or(file)),
                                Access::Read,
                            );
                        }
                    };
                    if n == "curl" {
                        let takes = matches!(l.as_str(), "-d" | "-f" | "--form" | "--json")
                            || l.starts_with("--data")
                            || l.starts_with("--form");
                        if takes && !l.contains('=') {
                            if let Some(value) = args.get(i + 1) {
                                uploads(self, &value.text);
                            }
                        } else if let Some((_, value)) = arg.text.split_once('=')
                            && l.starts_with("--")
                        {
                            uploads(self, value);
                        } else if (arg.text.starts_with("-d") || arg.text.starts_with("-F"))
                            && arg.text.len() > 2
                        {
                            uploads(self, &arg.text[2..]);
                        }
                        if matches!(arg.text.as_str(), "-T" | "--upload-file")
                            && let Some(file) = args.get(i + 1)
                            && file.text != "-"
                        {
                            self.path(file, Access::Read);
                        }
                    }
                    let upload_file = (n == "wget"
                        && ["--post-file", "--body-file"]
                            .iter()
                            .any(|o| long_option(l, o, 3)))
                        || (ps && ps_param(l, "infile", 3));
                    if upload_file {
                        match arg
                            .text
                            .split_once(['=', ':'])
                            .filter(|_| !ps || l.contains(':'))
                        {
                            Some((_, file)) => self.path(&Word::plain(file), Access::Read),
                            None => {
                                if let Some(file) = args.get(i + 1) {
                                    self.path(file, Access::Read);
                                }
                            }
                        }
                    }
                    let writes_to = (ps && ps_param(l, "outfile", 4))
                        || matches!(l.as_str(), "-o" | "--output" | "-outfile" | "--output-document" | "-d" if n != "curl" || l != "-d")
                        || (n == "wget" && l == "-o")
                        || l == "--dump-header"
                        || (n == "curl" && arg.text == "-D");
                    if writes_to
                        && let Some(target) = args.get(i + 1)
                        && target.text != "-"
                    {
                        self.path(target, Access::Write);
                    }
                    if matches!(
                        l.as_str(),
                        "-k" | "--config" | "-i" | "--input-file" | "-k-"
                    ) && (n == "wget" && l == "-i"
                        || n == "curl" && (l == "-k" || l == "--config") && arg.text == "-K"
                        || l == "--config"
                        || l == "--input-file")
                    {
                        self.opaque("reads its requests from a file");
                    }
                    if matches!(
                        l.as_str(),
                        "-u" | "--user" | "-credential" | "--oauth2-bearer" | "-h" | "--header"
                    ) && args.get(i + 1).is_some_and(|v| {
                        let v = v.lower();
                        l == "-u"
                            || l == "--user"
                            || l == "-credential"
                            || v.contains("authorization")
                            || v.contains("token")
                            || v.contains("api-key")
                            || v.contains("apikey")
                    }) {
                        self.add(S::CredentialsAccess);
                        self.note("The request sends credentials.");
                    }
                }
                if n == "wget"
                    && !args.iter().any(|a| {
                        matches!(
                            a.lower().as_str(),
                            "-o" | "--output-document" | "-q" | "--spider"
                        )
                    })
                {
                    self.add(S::FilesystemWrite);
                }
                if n == "certutil" {
                    if lower.iter().any(|a| {
                        matches!(
                            a.as_str(),
                            "-urlcache" | "/urlcache" | "-verifyctl" | "/verifyctl"
                        )
                    }) {
                        self.add(S::NetworkOther);
                        self.add(S::FilesystemWrite);
                        self.opaque("uses certutil to download files");
                    } else if lower.iter().any(|a| {
                        matches!(
                            a.as_str(),
                            "-decode" | "/decode" | "-decodehex" | "/decodehex"
                        )
                    }) {
                        self.add(S::FilesystemWrite);
                        self.opaque("uses certutil to decode files");
                    } else {
                        self.add(S::TerminalExecute);
                        self.add(S::CredentialsAccess);
                    }
                    return true;
                }
                if n == "bitsadmin" || n == "start-bitstransfer" {
                    self.add(S::NetworkOther);
                    self.add(S::FilesystemWrite);
                }
                if !saw_url {
                    // URLs without a scheme (`curl example.com`).
                    for arg in args.iter().filter(|a| !a.is_flag()) {
                        if arg.text.contains('.')
                            && !looks_like_path(&arg.text)
                            && let Some(host) = network::normalize_host(
                                arg.text.split('/').next().unwrap_or_default(),
                            )
                        {
                            self.host(host, sends);
                            saw_url = true;
                        }
                    }
                }
                if !saw_url {
                    self.add(S::NetworkOther);
                }
                true
            }
            "ssh" | "scp" | "sftp" | "mosh" | "telnet" | "nc" | "ncat" | "netcat" | "socat"
            | "ftp" | "rsh" | "rlogin" | "plink" | "pscp" | "psftp" | "rclone"
            | "enter-pssession" | "new-pssession" | "mstsc" => {
                self.add(S::TerminalExecute);
                self.add(S::NetworkOther);
                self.add(S::CloudModify);
                self.note(format!("`{n}` connects to another machine."));
                for arg in args.iter().filter(|a| !a.is_flag()) {
                    if arg.text.contains('@')
                        || (arg.text.contains(':') && !is_absolute_like(&arg.text))
                    {
                        self.remote(&arg.text);
                    } else if matches!(n, "scp" | "pscp") {
                        self.path(arg, Access::Write);
                    }
                }
                true
            }
            "rsync" => {
                self.add(S::FilesystemWrite);
                let files: Vec<&Word> = args.iter().filter(|a| !a.is_flag()).collect();
                for file in &files {
                    if file.text.contains('@')
                        || (file.text.contains(':') && !is_absolute_like(&file.text))
                    {
                        self.remote(&file.text);
                        self.add(S::NetworkOther);
                    } else {
                        self.path(file, Access::Write);
                    }
                }
                if args.iter().any(|a| {
                    let l = a.lower();
                    // `--del` is rsync's own alias for `--delete-during`.
                    l.starts_with("--del") || long_option(&l, "--remove-source-files", 3)
                }) {
                    self.add(S::Destructive);
                    self.note("rsync --delete removes files at the destination.");
                }
                if args.iter().any(|a| {
                    (a.text.starts_with('-') && !a.text.starts_with("--") && a.text.contains('e'))
                        || long_option(&a.lower(), "--rsh", 2)
                }) {
                    self.opaque("chooses the remote shell to run");
                }
                true
            }
            "ping" | "nslookup" | "dig" | "host" | "traceroute" | "tracert" | "whois"
            | "test-connection" | "tnc" | "test-netconnection" | "resolve-dnsname" | "mtr"
            | "pathping" => {
                self.add(S::NetworkOther);
                self.add(S::TerminalReadOnly);
                true
            }
            _ => false,
        }
    }

    fn cloud(&mut self, n: &str, args: &[Word]) -> bool {
        let positional: Vec<String> = args
            .iter()
            .filter(|a| !a.is_flag())
            .map(Word::lower)
            .collect();
        let has_word = |words: &[&str]| positional.iter().any(|p| words.contains(&p.as_str()));
        let starts = |prefixes: &[&str]| {
            positional
                .iter()
                .any(|p| prefixes.iter().any(|x| p.starts_with(x)))
        };
        const DESTROY: &[&str] = &[
            "delete",
            "destroy",
            "rm",
            "remove",
            "terminate",
            "purge",
            "rb",
            "drop",
            "uninstall",
            "prune",
            "wipe",
            "deregister",
            "rollback",
        ];
        const DEPLOY: &[&str] = &[
            "deploy", "publish", "push", "release", "up", "promote", "ship", "launch",
        ];
        const READ: &[&str] = &[
            "list",
            "ls",
            "get",
            "describe",
            "show",
            "status",
            "logs",
            "log",
            "tail",
            "whoami",
            "version",
            "view",
            "inspect",
            "info",
            "top",
            "explain",
            "api-resources",
            "search",
            "history",
            "validate",
            "plan",
            "output",
            "template",
            "lint",
            "diff",
            "current-context",
            "get-contexts",
            "cluster-info",
            "--version",
            "help",
            "doctor",
            "env-info",
        ];
        let secrets = || {
            positional.iter().any(|p| {
                p.contains("secret")
                    || p.contains("token")
                    || p.contains("credential")
                    || p.contains("password")
                    || p.contains("access-key")
                    || p == "auth"
                    || p == "login"
                    || p.contains("keyvault")
                    || p == "kms"
                    || p == "ssm"
            })
        };
        match n {
            "vercel" | "netlify" | "wrangler" | "firebase" | "fly" | "flyctl" | "heroku"
            | "railway" | "render" | "serverless" | "sls" | "sam" | "cdk" | "amplify" | "eb"
            | "surge" | "now" | "doctl" | "linode-cli" | "vultr" | "hcloud" | "supabase"
            | "neonctl" | "turso" | "planetscale" | "pscale" | "convex" | "expo" | "eas"
            | "fastlane" => {
                let local = has_word(&[
                    "dev",
                    "build",
                    "types",
                    "init",
                    "whoami",
                    "--version",
                    "help",
                    "emulators:start",
                    "emulators",
                    "serve",
                    "start",
                    "link",
                    "pull",
                    "env:pull",
                ]) && !has_word(DEPLOY);
                if only_version_or_help(args) || (local && !secrets()) {
                    self.add(S::TerminalExecute);
                } else if secrets() {
                    self.add(S::CredentialsAccess);
                    self.add(S::CloudModify);
                    self.add(S::NetworkOther);
                } else if has_word(DESTROY)
                    || starts(&["firestore:delete", "apps:destroy", "database:remove"])
                {
                    self.add(S::CloudModify);
                    self.add(S::Destructive);
                    self.add(S::NetworkOther);
                } else if positional.is_empty()
                    && matches!(n, "vercel" | "now" | "surge" | "railway")
                    || has_word(DEPLOY)
                    || starts(&["deploy", "hosting:channel:deploy", "pages"])
                    || args.iter().any(|a| a.lower() == "--prod")
                {
                    self.add(S::DeployProduction);
                    self.add(S::NetworkOther);
                    self.note(format!("`{n}` deploys to a hosting service."));
                } else if has_word(READ) {
                    self.add(S::NetworkOther);
                    self.add(S::TerminalReadOnly);
                } else {
                    self.add(S::CloudModify);
                    self.add(S::NetworkOther);
                }
                true
            }
            "aws" | "gcloud" | "gsutil" | "bq" | "az" | "azcopy" | "oci" | "ibmcloud" | "s3cmd"
            | "kubectl" | "oc" | "helm" | "k9s" | "eksctl" | "kind" | "minikube" | "terraform"
            | "tofu" | "terragrunt" | "pulumi" | "ansible" | "ansible-playbook" | "nomad"
            | "consul" | "vault" | "gh" | "glab" | "hub" | "stripe" | "twilio" | "sendgrid"
            | "slack" | "mailx" | "mail" | "sendmail" | "mutt" | "send-mailmessage" | "docker"
            | "podman" | "docker-compose" | "nerdctl" => {
                self.cloud_cli(n, args, &positional, secrets());
                true
            }
            _ => false,
        }
    }

    fn cloud_cli(&mut self, n: &str, args: &[Word], positional: &[String], secrets: bool) {
        let has_word = |words: &[&str]| positional.iter().any(|p| words.contains(&p.as_str()));
        let any_prefix = |prefixes: &[&str]| {
            positional
                .iter()
                .any(|p| prefixes.iter().any(|x| p.starts_with(x)))
        };
        if only_version_or_help(args)
            || positional.is_empty()
                && !matches!(
                    n,
                    "mail" | "mailx" | "sendmail" | "mutt" | "send-mailmessage"
                )
        {
            self.add(S::TerminalReadOnly);
            return;
        }
        match n {
            "docker" | "podman" | "docker-compose" | "nerdctl" => {
                let sub = positional.first().map(String::as_str).unwrap_or("");
                match sub {
                    "ps" | "images" | "logs" | "inspect" | "version" | "info" | "stats" | "top"
                    | "history" | "port" | "diff" | "events" | "search" => {
                        self.add(S::TerminalReadOnly);
                        if sub == "search" {
                            self.add(S::NetworkOther);
                        }
                    }
                    "push" => {
                        self.add(S::DeployProduction);
                        self.add(S::NetworkOther);
                        self.note("docker push publishes an image to a registry.");
                    }
                    "login" | "logout" => self.add(S::CredentialsAccess),
                    "rm" | "rmi" | "prune" | "kill" => {
                        self.add(S::TerminalExecute);
                        self.add(S::Destructive);
                    }
                    "system" | "volume" | "image" | "container" | "network" | "builder"
                    | "buildx"
                        if has_word(&["prune", "rm", "remove"]) =>
                    {
                        self.add(S::TerminalExecute);
                        self.add(S::Destructive);
                        self.note("The command deletes Docker data.");
                    }
                    "pull" => {
                        self.add(S::PackageInstall);
                        self.add(S::NetworkOther);
                    }
                    _ => {
                        self.add(S::TerminalExecute);
                        for (i, arg) in args.iter().enumerate() {
                            let l = arg.lower();
                            if matches!(l.as_str(), "-v" | "--volume" | "--mount")
                                && let Some(spec) = args.get(i + 1)
                            {
                                let host = spec.text.split(':').next().unwrap_or_default();
                                let host = if spec.text.len() > 2 && spec.text.as_bytes()[1] == b':'
                                {
                                    // Windows drive letter in the host part.
                                    spec.text
                                        .splitn(3, ':')
                                        .take(2)
                                        .collect::<Vec<_>>()
                                        .join(":")
                                } else {
                                    host.to_owned()
                                };
                                if looks_like_path(&host) {
                                    self.path(&Word::plain(&host), Access::Write);
                                }
                            }
                            if l == "--privileged"
                                || l.starts_with("--pid=host")
                                || l.starts_with("--network=host")
                                || l == "--net=host"
                            {
                                self.add(S::FilesystemOutsideWorkspace);
                                self.note("The container gets access to the host computer.");
                            }
                        }
                        if has_word(&["up", "run", "start", "exec", "build", "compose"]) {
                            self.note("Containers run code with the Docker daemon's privileges.");
                        }
                    }
                }
            }
            "gh" | "glab" | "hub" => {
                let area = positional.first().map(String::as_str).unwrap_or("");
                let verb = positional.get(1).map(String::as_str).unwrap_or("");
                if area == "auth"
                    || area == "secret"
                    || area == "ssh-key"
                    || area == "gpg-key"
                    || (area == "api" && positional.iter().any(|p| p.contains("secret")))
                {
                    self.add(S::CredentialsAccess);
                    self.add(S::NetworkOther);
                    if matches!(verb, "set" | "delete" | "add") {
                        self.add(S::CloudModify);
                    }
                } else if area == "api" {
                    let writes = args.iter().enumerate().any(|(i, a)| {
                        let l = a.lower();
                        (matches!(l.as_str(), "-x" | "--method")
                            && args.get(i + 1).is_some_and(|m| m.lower() != "get"))
                            || matches!(
                                l.as_str(),
                                "-f" | "--field" | "-F" | "--raw-field" | "--input"
                            )
                            || a.text == "-F"
                    });
                    self.add(S::NetworkOther);
                    if writes {
                        self.add(S::CloudModify);
                        self.opaque("calls the GitHub API with a request KalCode can't interpret");
                    }
                } else if matches!(
                    verb,
                    "list"
                        | "view"
                        | "status"
                        | "diff"
                        | "checks"
                        | "watch"
                        | "search"
                        | "ls"
                        | "download"
                ) || matches!(
                    area,
                    "status"
                        | "search"
                        | "browse"
                        | "help"
                        | "version"
                        | "extension"
                        | "config"
                        | "alias"
                        | "completion"
                ) && !matches!(verb, "install" | "set" | "create")
                {
                    self.add(S::NetworkOther);
                    self.add(S::TerminalReadOnly);
                    if area == "browse" {
                        self.add(S::BrowserNavigate);
                    }
                } else {
                    self.add(S::NetworkOther);
                    self.add(S::CloudModify);
                    if matches!(area, "pr" | "issue" | "discussion")
                        && matches!(
                            verb,
                            "create" | "comment" | "review" | "close" | "reopen" | "edit" | "ready"
                        )
                    {
                        self.add(S::MessagingSend);
                        self.note("The command posts on the repository where others can see it.");
                    }
                    if area == "pr" && verb == "merge" {
                        self.add(S::GitPush);
                    }
                    if matches!(verb, "delete" | "archive" | "rename" | "transfer") {
                        self.add(S::Destructive);
                    }
                    if area == "release" && verb == "create" || area == "repo" && verb == "create" {
                        self.add(S::DeployProduction);
                    }
                }
            }
            "stripe" | "twilio" | "sendgrid" => {
                if any_prefix(&[
                    "list", "retrieve", "get", "logs", "listen", "status", "version", "open",
                    "config", "samples",
                ]) && !has_word(&["create", "update", "pay", "capture", "confirm"])
                {
                    self.add(S::NetworkOther);
                    self.add(S::TerminalReadOnly);
                } else if n == "stripe" {
                    self.add(S::BillingSpend);
                    self.add(S::CloudModify);
                    self.add(S::NetworkOther);
                    self.note("The command can create charges, payouts or subscriptions.");
                } else {
                    self.add(S::MessagingSend);
                    self.add(S::BillingSpend);
                    self.add(S::NetworkOther);
                }
            }
            "slack" | "mailx" | "mail" | "sendmail" | "mutt" | "send-mailmessage" => {
                self.add(S::MessagingSend);
                self.add(S::NetworkOther);
            }
            _ => {
                // aws, gcloud, az, kubectl, terraform, pulumi, helm, vault, …
                const DESTROY: &[&str] = &[
                    "delete",
                    "destroy",
                    "rm",
                    "remove",
                    "terminate",
                    "purge",
                    "rb",
                    "drop",
                    "uninstall",
                    "prune",
                    "wipe",
                    "deregister",
                    "drain",
                    "taint",
                    "state",
                ];
                const DEPLOY: &[&str] = &["deploy", "publish", "release", "up", "promote", "ship"];
                const MESSAGE: &[&str] = &[
                    "send-email",
                    "send-raw-email",
                    "send-templated-email",
                    "send-bulk-email",
                    "publish",
                    "send-message",
                    "send-messages",
                ];
                const CREDENTIAL: &[&str] = &[
                    "get-secret-value",
                    "print-access-token",
                    "print-identity-token",
                    "get-access-token",
                    "export-credentials",
                    "get-login-password",
                    "get-session-token",
                    "get-authorization-token",
                    "create-access-key",
                    "decrypt",
                ];
                const READ_PREFIXES: &[&str] = &[
                    "describe",
                    "list",
                    "get",
                    "show",
                    "ls",
                    "logs",
                    "top",
                    "explain",
                    "api-resources",
                    "plan",
                    "validate",
                    "fmt",
                    "output",
                    "version",
                    "status",
                    "template",
                    "lint",
                    "diff",
                    "search",
                    "history",
                    "inspect",
                    "view",
                    "whoami",
                    "current-context",
                    "cluster-info",
                    "graph",
                    "providers",
                    "workspace",
                    "stack",
                    "preview",
                    "config",
                    "wait",
                    "info",
                    "account",
                    "auth",
                    "sts",
                    "read",
                    "kv",
                ];
                let writes_word = has_word(&[
                    "create",
                    "update",
                    "apply",
                    "patch",
                    "replace",
                    "scale",
                    "rollout",
                    "edit",
                    "set",
                    "label",
                    "annotate",
                    "cordon",
                    "uncordon",
                    "exec",
                    "cp",
                    "mv",
                    "sync",
                    "run",
                    "start",
                    "stop",
                    "restart",
                    "reboot",
                    "put",
                    "import",
                    "upgrade",
                    "install",
                    "attach",
                    "detach",
                    "invoke",
                    "submit",
                    "enable",
                    "disable",
                    "write",
                    "mb",
                    "refresh",
                    "up",
                    "expose",
                    "autoscale",
                    "port-forward",
                    "proxy",
                    "debug",
                    "ssh",
                    "tag",
                    "add",
                    "modify",
                    "reset",
                    "sign",
                    "encrypt",
                ]);
                if has_word(CREDENTIAL)
                    || (secrets && !has_word(&["list"]))
                    || (n == "vault" && has_word(&["read", "kv", "login", "token"]))
                    || (matches!(n, "terraform" | "tofu" | "pulumi")
                        && has_word(&["output"])
                        && args.iter().any(|a| {
                            matches!(a.lower().as_str(), "-json" | "-raw" | "--show-secrets")
                        }))
                {
                    self.add(S::CredentialsAccess);
                    self.add(S::NetworkOther);
                    if writes_word {
                        self.add(S::CloudModify);
                    }
                } else if has_word(DESTROY) {
                    self.add(S::CloudModify);
                    self.add(S::Destructive);
                    self.add(S::NetworkOther);
                    self.note(format!("`{n}` deletes remote resources."));
                } else if matches!(n, "aws")
                    && positional.first().is_some_and(|s| {
                        matches!(s.as_str(), "ses" | "sesv2" | "sns" | "pinpoint" | "sqs")
                    })
                    && has_word(MESSAGE)
                {
                    self.add(S::MessagingSend);
                    self.add(S::NetworkOther);
                } else if has_word(DEPLOY)
                    || (matches!(n, "terraform" | "tofu" | "terragrunt") && has_word(&["apply"]))
                    || (n == "pulumi" && has_word(&["up"]))
                    || positional.windows(2).any(|w| {
                        (w[0] == "app" || w[0] == "functions" || w[0] == "run") && w[1] == "deploy"
                    })
                {
                    self.add(S::CloudModify);
                    self.add(S::DeployProduction);
                    self.add(S::NetworkOther);
                } else if writes_word {
                    self.add(S::CloudModify);
                    self.add(S::NetworkOther);
                } else if matches!(n, "terraform" | "tofu" | "terragrunt" | "pulumi")
                    && has_word(&["init"])
                {
                    self.add(S::PackageInstall);
                    self.add(S::NetworkOther);
                } else if positional
                    .iter()
                    .any(|p| READ_PREFIXES.iter().any(|r| p.starts_with(r)))
                {
                    self.add(S::NetworkOther);
                    self.add(S::TerminalReadOnly);
                    if n == "kubectl"
                        && has_word(&["config"])
                        && args.iter().any(|a| a.lower() == "--raw")
                    {
                        self.add(S::CredentialsAccess);
                    }
                } else {
                    self.add(S::CloudModify);
                    self.add(S::NetworkOther);
                    self.note(format!("KalCode treats `{n}` commands it doesn't recognize as changing remote resources."));
                }
            }
        }
    }

    fn credentials(&mut self, n: &str, args: &[Word]) -> bool {
        match n {
            "printenv" | "get-childitem-env" => {
                self.add(S::CredentialsAccess);
                self.add(S::TerminalReadOnly);
                self.note("Printing the environment can reveal secrets.");
                true
            }
            "compgen" => {
                self.add(S::TerminalReadOnly);
                if args.iter().any(|a| {
                    let l = a.lower();
                    matches!(l.as_str(), "-v" | "-e") || l.contains("variable") || l == "export"
                }) {
                    self.add(S::CredentialsAccess);
                    self.note("Listing shell variables can reveal secrets.");
                }
                true
            }
            "security"
            | "cmdkey"
            | "get-credential"
            | "get-storedcredential"
            | "secret-tool"
            | "pass"
            | "op"
            | "bw"
            | "lpass"
            | "keyring"
            | "ssh-add"
            | "ssh-keygen"
            | "gpg"
            | "gpg2"
            | "age"
            | "sops"
            | "keytool"
            | "openssl"
            | "dpapi"
            | "vaultcmd"
            | "mimikatz"
            | "procdump" => {
                self.add(S::CredentialsAccess);
                self.add(S::TerminalExecute);
                self.note(format!(
                    "`{n}` works with keys, passwords or other secrets."
                ));
                if matches!(n, "mimikatz" | "procdump") {
                    self.opaque("uses a credential-dumping tool");
                    self.add(S::Destructive);
                }
                self.loose_args(args, Access::Read);
                true
            }
            _ => false,
        }
    }

    /// Options that make an otherwise read-only program run another program, write a file or
    /// print secrets. Returns true when the program is fully handled.
    fn read_only_escapes(&mut self, n: &str, args: &[Word]) -> bool {
        let lower: Vec<String> = args.iter().map(Word::lower).collect();
        let runs = |cx: &mut Self, why: &str| {
            cx.add(S::TerminalExecute);
            cx.opaque(why);
        };
        match n {
            // In bash and zsh `fc` edits and re-runs commands from history.
            "fc" => {
                runs(
                    self,
                    "uses `fc`, which re-runs commands from shell history in bash",
                );
                self.loose_args(args, Access::Read);
                return true;
            }
            "watchman" if lower.iter().any(|a| a == "trigger" || a == "--") => {
                runs(self, "registers a watchman trigger that runs a command");
                return true;
            }
            "man"
                if args.iter().zip(&lower).any(|(w, a)| {
                    w.text.starts_with("-P")
                        || w.text.starts_with("-H")
                        || long_option(a, "--pager", 2)
                        || long_option(a, "--html", 2)
                        || long_option(a, "--preprocessor", 3)
                }) =>
            {
                runs(
                    self,
                    "tells man to run another program as its pager or browser",
                );
            }
            "bat" | "batcat" if lower.iter().any(|a| long_option(a, "--pager", 2)) => {
                runs(self, "tells bat to run another program as its pager");
            }
            "sort"
                if lower
                    .iter()
                    .any(|a| long_option(a, "--compress-program", 2)) =>
            {
                runs(self, "tells sort to run a compression program");
            }
            "less" | "more" | "tree" => {
                for (i, a) in lower.iter().enumerate() {
                    let log = a == "-o" || (n != "tree" && long_option(a, "--log-file", 3));
                    if log {
                        if let Some((_, value)) = args[i].text.split_once('=') {
                            self.path(&Word::plain(value), Access::Write);
                        } else if let Some(target) = args.get(i + 1) {
                            self.path(target, Access::Write);
                        }
                    } else if n != "tree" && a.len() > 2 && a.starts_with("-o") {
                        self.path(&Word::plain(&args[i].text[2..]), Access::Write);
                    }
                }
            }
            "ps" if args
                .iter()
                .any(|a| !a.text.starts_with('-') && a.text.contains('e')) =>
            {
                // BSD-style `ps e` / `ps auxe` prints every process's environment.
                self.add(S::CredentialsAccess);
                self.note("Printing process environments can reveal secrets.");
            }
            "get-variable" | "gv" => {
                self.add(S::CredentialsAccess);
                self.note("Listing variables can reveal secrets.");
            }
            "hostnamectl" if lower.iter().any(|a| a.starts_with("set-")) => {
                self.add(S::TerminalExecute);
                self.add(S::FilesystemOutsideWorkspace);
                self.note("hostnamectl set-… changes system settings.");
            }
            "get-help" | "help" if lower.iter().any(|a| ps_param(a, "online", 2)) => {
                self.add(S::BrowserNavigate);
                self.add(S::NetworkOther);
            }
            _ => {}
        }
        false
    }

    fn read_only(&mut self, n: &str, args: &[Word], qualified: bool) -> bool {
        const FILE_READERS: &[&str] = &[
            "cat",
            "head",
            "tail",
            "less",
            "more",
            "wc",
            "stat",
            "file",
            "nl",
            "od",
            "hexdump",
            "xxd",
            "strings",
            "md5sum",
            "sha1sum",
            "sha256sum",
            "sha512sum",
            "shasum",
            "cksum",
            "b2sum",
            "get-content",
            "gc",
            "get-item",
            "gi",
            "get-itemproperty",
            "gp",
            "test-path",
            "resolve-path",
            "rvpa",
            "get-filehash",
            "diff",
            "cmp",
            "comm",
            "tac",
            "column",
            "fold",
            "rev",
            "cut",
            "paste",
            "join",
            "jq",
            "yq",
            "type",
            "bat",
            "batcat",
            "readlink",
            "realpath",
            "basename",
            "dirname",
            "du",
            "ls",
            "dir",
            "tree",
            "get-childitem",
            "gci",
            "exa",
            "eza",
            "lsd",
            "vdir",
            "fc",
            "compare-object",
            "import-csv",
            "get-acl",
            "sort",
            "uniq",
        ];
        const SEARCHERS: &[&str] = &[
            "grep",
            "egrep",
            "fgrep",
            "rg",
            "ag",
            "ack",
            "findstr",
            "select-string",
            "sls",
            "git-grep",
        ];
        const PLAIN: &[&str] = &[
            "pwd",
            "echo",
            "printf",
            "which",
            "where",
            "whereis",
            "whoami",
            "uname",
            "id",
            "groups",
            "ps",
            "lsof",
            "uptime",
            "nproc",
            "arch",
            "ver",
            "tasklist",
            "free",
            "df",
            "seq",
            "yes",
            "test",
            "[",
            "[[",
            "get-location",
            "gl",
            "get-command",
            "gcm",
            "get-process",
            "gps",
            "measure-object",
            "measure",
            "format-list",
            "fl",
            "format-table",
            "ft",
            "format-wide",
            "select-object",
            "where-object",
            "sort-object",
            "group-object",
            "write-output",
            "write",
            "write-host",
            "get-date",
            "get-help",
            "help",
            "man",
            "get-member",
            "gm",
            "out-string",
            "convertto-json",
            "convertfrom-json",
            "tr",
            "expr",
            "bc",
            "cal",
            "systeminfo",
            "lscpu",
            "lsblk",
            "lsusb",
            "lspci",
            "sw_vers",
            "hostnamectl",
            "locale",
            "tty",
            "logname",
            "users",
            "who",
            "w",
            "last",
            "history",
            "get-history",
            "jobs",
            "get-host",
            "get-culture",
            "get-uiculture",
            "get-psdrive",
            "get-module",
            "get-alias",
            "get-variable",
            "tput",
            "stty",
            "getconf",
            "top",
            "htop",
            "btop",
            "netstat",
            "ss",
            "ipconfig",
            "ifconfig",
            "ip",
            "route",
            "arp",
            "get-netipaddress",
            "get-netadapter",
            "hostname",
            "date",
            "time",
            "sleep",
            "true",
            "false",
            "watchman",
        ];
        let known = FILE_READERS.contains(&n)
            || SEARCHERS.contains(&n)
            || PLAIN.contains(&n)
            || n == "find"
            || n == "fd"
            || n == "fdfind";
        if !known {
            return false;
        }
        if qualified {
            // A program named by path could be anything that happens to share the name.
            self.add(S::TerminalExecute);
            self.loose_args(args, Access::Read);
            return true;
        }
        self.add(S::TerminalReadOnly);
        if self.read_only_escapes(n, args) {
            return true;
        }
        match n {
            "find" => {
                let lower: Vec<String> = args.iter().map(Word::lower).collect();
                if let Some(i) = lower
                    .iter()
                    .position(|a| matches!(a.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir"))
                {
                    self.opaque("runs a command for every file it finds");
                    self.add(S::TerminalExecute);
                    let end = args[i + 1..]
                        .iter()
                        .position(|a| a.text == ";" || a.text == "+" || a.text == "\\;")
                        .map_or(args.len(), |p| i + 1 + p);
                    if i + 1 < end {
                        self.program(&args[i + 1..end], true, 1);
                    }
                }
                if lower.iter().any(|a| a == "-delete") {
                    self.add(S::FilesystemWrite);
                    self.add(S::Destructive);
                    self.note("find -delete removes every file it matches.");
                }
                for (i, a) in lower.iter().enumerate() {
                    if matches!(a.as_str(), "-fprint" | "-fprint0" | "-fprintf" | "-fls")
                        && let Some(target) = args.get(i + 1)
                    {
                        self.path(target, Access::Write);
                    }
                }
                // Windows `find "text" file` or POSIX `find <paths> <expression>`.
                let starts: Vec<Word> = args
                    .iter()
                    .take_while(|a| !a.text.starts_with('-') && a.text != "(" && a.text != "!")
                    .cloned()
                    .collect();
                if starts.is_empty() {
                    self.path(&Word::plain("."), Access::Read);
                } else {
                    let skip = usize::from(starts.first().is_some_and(|w| w.quoted));
                    self.file_args(&starts[skip..], Access::Read, false);
                }
            }
            "fd" | "fdfind" => {
                if args.iter().any(|a| {
                    matches!(a.lower().as_str(), "-x" | "--exec" | "--exec-batch") || a.text == "-X"
                }) {
                    self.opaque("runs a command for every file it finds");
                    self.add(S::TerminalExecute);
                }
                self.loose_args(args, Access::Read);
            }
            "sort" => {
                for (i, a) in args.iter().enumerate() {
                    let l = a.lower();
                    if (l == "-o" || l == "/o" || l == "--output")
                        && let Some(target) = args.get(i + 1)
                    {
                        self.path(target, Access::Write);
                    } else if let Some(target) = l.strip_prefix("--output=") {
                        self.path(&Word::plain(target), Access::Write);
                    }
                }
                self.file_args(
                    &args
                        .iter()
                        .filter(|a| !matches!(a.lower().as_str(), "-o" | "/o" | "--output"))
                        .cloned()
                        .collect::<Vec<_>>(),
                    Access::Read,
                    true,
                );
            }
            "uniq" => {
                let files: Vec<&Word> = args.iter().filter(|a| !a.is_flag()).collect();
                if let Some(input) = files.first() {
                    self.path(input, Access::Read);
                }
                if let Some(output) = files.get(1) {
                    self.path(output, Access::Write);
                }
            }
            "xxd" | "yq" => {
                let in_place = n == "yq"
                    && args
                        .iter()
                        .any(|a| matches!(a.lower().as_str(), "-i" | "--inplace"));
                let reverse = n == "xxd" && args.iter().any(|a| a.lower() == "-r");
                let files: Vec<&Word> = args.iter().filter(|a| !a.is_flag()).collect();
                for (i, file) in files.iter().enumerate() {
                    let write = in_place || (reverse && i == 1) || (n == "xxd" && i == 1);
                    self.path(file, if write { Access::Write } else { Access::Read });
                }
            }
            "hostname" | "date" | "time" => {
                let sets = args.iter().any(|a| {
                    let l = a.lower();
                    if n == "date" {
                        l == "-s"
                            || l.starts_with("--set")
                            || (!a.is_flag() && !a.text.starts_with('+') && l != "/t")
                    } else if n == "time" {
                        !a.is_flag() && l != "/t"
                    } else {
                        !a.is_flag() || l == "-b" || l == "--boot" || l == "-f" && false
                    }
                });
                if sets {
                    self.add(S::TerminalExecute);
                    self.add(S::FilesystemOutsideWorkspace);
                    self.note(format!("`{n}` with arguments changes system settings."));
                }
            }
            "ipconfig" | "ifconfig" | "ip" | "route" | "arp" | "netstat" | "ss" => {
                let changes = args.iter().any(|a| {
                    matches!(
                        a.lower().as_str(),
                        "/release"
                            | "/renew"
                            | "/flushdns"
                            | "/registerdns"
                            | "add"
                            | "del"
                            | "delete"
                            | "change"
                            | "flush"
                            | "up"
                            | "down"
                            | "set"
                            | "replace"
                            | "-d"
                            | "-s"
                    )
                });
                if changes {
                    self.add(S::TerminalExecute);
                    self.add(S::FilesystemOutsideWorkspace);
                    self.note("The command changes network settings.");
                }
            }
            "history" | "get-history" => {
                self.add(S::CredentialsAccess);
                self.note("Shell history can contain secrets typed on the command line.");
            }
            "get-variable" | "get-childitem" | "gci" | "ls" | "dir"
                if args.iter().any(|a| {
                    a.lower().starts_with("env:") || a.lower().starts_with("variable:")
                }) =>
            {
                self.add(S::CredentialsAccess);
                self.note("Listing environment variables can reveal secrets.");
            }
            _ if SEARCHERS.contains(&n) => {
                // The first positional argument is the pattern unless one is given by flag.
                let pattern_by_flag = args.iter().any(|a| {
                    matches!(
                        a.lower().as_str(),
                        "-e" | "--regexp" | "-f" | "--file" | "-pattern" | "/c"
                    )
                });
                let mut positional: Vec<Word> = Vec::new();
                let mut skip_next = false;
                for a in args {
                    if skip_next {
                        skip_next = false;
                        continue;
                    }
                    let l = a.lower();
                    if matches!(
                        l.as_str(),
                        "-e" | "--regexp"
                            | "-pattern"
                            | "-g"
                            | "--glob"
                            | "-t"
                            | "--type"
                            | "-m"
                            | "--max-count"
                            | "-a"
                            | "-b"
                            | "-c"
                            | "--context"
                            | "--after-context"
                            | "--before-context"
                    ) {
                        skip_next = true;
                        continue;
                    }
                    if a.is_flag() || (n == "findstr" && is_windows_flag(&a.text)) {
                        continue;
                    }
                    positional.push(a.clone());
                }
                let files = if pattern_by_flag || positional.is_empty() {
                    &positional[..]
                } else {
                    &positional[1..]
                };
                self.file_args(files, Access::Read, n == "findstr");
                if files.is_empty() {
                    self.path(&Word::plain("."), Access::Read);
                }
                if n == "rg" && args.iter().any(|a| a.lower().starts_with("--pre")) {
                    self.opaque("runs a preprocessor program");
                    self.add(S::TerminalExecute);
                }
            }
            _ if FILE_READERS.contains(&n) => {
                let windows = matches!(n, "dir" | "type" | "fc");
                // PowerShell parameters that take a value.
                let mut words: Vec<Word> = Vec::new();
                let mut skip_next = false;
                for a in args {
                    if skip_next {
                        skip_next = false;
                        continue;
                    }
                    let l = a.lower();
                    if matches!(l.as_str(), "-path" | "-literalpath" | "-lp") {
                        continue;
                    }
                    if matches!(
                        l.as_str(),
                        "-filter"
                            | "-include"
                            | "-exclude"
                            | "-depth"
                            | "-encoding"
                            | "-totalcount"
                            | "-tail"
                            | "-first"
                            | "-last"
                            | "-head"
                            | "-n"
                            | "-c"
                            | "--lines"
                            | "--bytes"
                            | "-l"
                            | "-algorithm"
                            | "-delimiter"
                            | "-f"
                            | "--arg"
                            | "--argjson"
                            | "-d"
                            | "-s"
                    ) && !(n == "ls" && l == "-l")
                        && !(n == "cut" && l == "-f" && false)
                    {
                        skip_next = !matches!(n, "ls" | "dir" | "du" | "tree")
                            || matches!(l.as_str(), "-filter" | "-include" | "-exclude" | "-depth");
                        continue;
                    }
                    words.push(a.clone());
                }
                if matches!(n, "jq" | "yq")
                    && let Some(p) = words.iter().position(|w| !w.is_flag())
                {
                    words.remove(p); // the filter expression
                }
                if matches!(n, "cut" | "tr") {
                    words.retain(|w| {
                        looks_like_path(&w.text)
                            || !w.is_flag() && std::path::Path::new(&w.text).extension().is_some()
                    });
                }
                // Listing names is not reading contents: `ls *.pem` doesn't reveal a key.
                self.names_only = matches!(
                    n,
                    "ls" | "dir"
                        | "tree"
                        | "du"
                        | "get-childitem"
                        | "gci"
                        | "exa"
                        | "eza"
                        | "lsd"
                        | "vdir"
                        | "test-path"
                        | "resolve-path"
                        | "rvpa"
                        | "stat"
                        | "basename"
                        | "dirname"
                        | "realpath"
                        | "readlink"
                );
                let count = self.file_args(&words, Access::Read, windows);
                self.names_only = false;
                if count == 0
                    && matches!(
                        n,
                        "ls" | "dir"
                            | "tree"
                            | "du"
                            | "get-childitem"
                            | "gci"
                            | "exa"
                            | "eza"
                            | "lsd"
                            | "vdir"
                    )
                {
                    self.path(&Word::plain("."), Access::Read);
                }
            }
            _ => {
                // echo/printf/etc.: arguments are data, not paths.
            }
        }
        true
    }
}

fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}' | '\u{00AD}'
    )
}

fn is_assignment(word: &Word) -> bool {
    let Some((name, _)) = word.text.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && !name.starts_with(|c: char| c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn strip_executable_suffix(name: &str) -> String {
    for suffix in [".exe", ".com", ".bat", ".cmd", ".ps1", ".sh", ".py", ".js"] {
        if let Some(stripped) = name.strip_suffix(suffix)
            && !stripped.is_empty()
            && [".exe", ".com", ".bat", ".cmd", ".ps1"].contains(&suffix)
        {
            return stripped.to_owned();
        }
    }
    name.to_owned()
}

fn is_absolute_like(text: &str) -> bool {
    let t = text.trim();
    let b = t.as_bytes();
    t.starts_with('/')
        || t.starts_with('\\')
        || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
}

/// A cmd.exe-style switch (`/s`, `/Q`, `/MIR`, `/v:on`) rather than a POSIX path.
fn is_windows_flag(text: &str) -> bool {
    let Some(rest) = text.strip_prefix('/') else {
        return false;
    };
    !rest.is_empty()
        && rest.len() <= 12
        && !rest.contains(['/', '\\', '.'])
        && rest
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '?')
}

fn is_recursive_flag(text: &str, windows: bool) -> bool {
    let lower = dash_normalize(text).to_ascii_lowercase();
    if windows && matches!(lower.as_str(), "/s") {
        return true;
    }
    // GNU long options may be abbreviated (`--rec`, `--no-pres`).
    if long_option(&lower, "--recursive", 1) || long_option(&lower, "--no-preserve-root", 4) {
        return true;
    }
    if let Some(flag) = lower.strip_prefix('-')
        && !flag.starts_with('-')
    {
        // PowerShell `-r`, `-rec`, `-Recurse:$true`; POSIX clusters `-rf`, `-fR`.
        let name = flag.split(':').next().unwrap_or_default();
        let powershell = !name.is_empty() && "recurse".starts_with(name);
        let posix_cluster =
            flag.len() <= 4 && flag.chars().all(|c| c.is_ascii_alphabetic()) && flag.contains('r');
        return powershell || posix_cluster;
    }
    false
}

/// Whether `arg` (lower case) is the GNU long option `option` (`--recursive`), possibly
/// abbreviated to at least `min` characters after the dashes and possibly with `=value`.
/// getopt_long accepts any unambiguous prefix; an ambiguous one is refused by the program, so
/// treating every prefix as a match only ever adds authority.
fn long_option(arg: &str, option: &str, min: usize) -> bool {
    let (Some(given), Some(full)) = (arg.strip_prefix("--"), option.strip_prefix("--")) else {
        return false;
    };
    let given = given.split('=').next().unwrap_or_default();
    given.len() >= min.max(1) && full.starts_with(given)
}

/// Whether `arg` (lower case) is the PowerShell parameter `-name`, abbreviated to at least `min`
/// characters (PowerShell accepts any unambiguous prefix) and possibly written `-name:value`.
fn ps_param(arg: &str, name: &str, min: usize) -> bool {
    let normalized = dash_normalize(arg);
    let Some(given) = normalized.strip_prefix('-') else {
        return false;
    };
    if given.starts_with('-') {
        return false;
    }
    let given = given.split(':').next().unwrap_or_default();
    given.len() >= min.max(1) && name.starts_with(given)
}

/// PowerShell treats en dash, em dash and horizontal bar as `-` (the figure dash too, here).
fn dash_normalize(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}' => '-',
            _ => c,
        })
        .collect()
}

fn looks_like_path(text: &str) -> bool {
    let t = text.trim();
    !t.is_empty()
        && !t.contains("://")
        && (t.contains('/')
            || t.contains('\\')
            || t.starts_with('.')
            || t.starts_with('~')
            || paths::has_expansion(t)
            || is_absolute_like(t))
}

fn is_raw_device(lower: &str) -> bool {
    let l = lower.trim();
    l.starts_with("/dev/sd")
        || l.starts_with("/dev/hd")
        || l.starts_with("/dev/nvme")
        || l.starts_with("/dev/disk")
        || l.starts_with("/dev/rdisk")
        || l.starts_with("/dev/mmcblk")
        || l.starts_with("/dev/vd")
        || l.starts_with("/dev/xvd")
        || l.starts_with("/dev/mapper")
        || l.starts_with(r"\\.\physicaldrive")
        || l.starts_with("//./physicaldrive")
        || l.starts_with(r"\\.\")
}

fn only_version_or_help(args: &[Word]) -> bool {
    !args.is_empty()
        && args.iter().all(|a| {
            matches!(
                a.lower().as_str(),
                "--version"
                    | "-v"
                    | "-version"
                    | "version"
                    | "--help"
                    | "-h"
                    | "help"
                    | "-?"
                    | "/?"
            ) || a.text == "-V"
        })
}

/// Rebuilds command text from words handed to another shell (`cmd /c …`, `-Command …`). A
/// single argument is the script itself (`cmd /c "del /s x"` runs `del /s x`).
fn join_words(words: &[Word]) -> String {
    if let [only] = words {
        return only.text.clone();
    }
    words
        .iter()
        .map(|w| {
            if w.quoted && w.text.contains([' ', '\t']) {
                format!("\"{}\"", w.text.replace('"', "\\\""))
            } else {
                w.text.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_owned()
    } else {
        format!("{}…", text.chars().take(max).collect::<String>())
    }
}

/// Decodes a PowerShell `-EncodedCommand` argument (base64 of UTF-16LE).
pub fn decode_powershell_base64(text: &str) -> Option<String> {
    let bytes = decode_base64(text.trim())?;
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).ok()
}

fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

/// Hosts whose APIs send messages when they receive data.
const MESSAGING_HOSTS: &[&str] = &[
    "hooks.slack.com",
    "slack.com",
    "discord.com",
    "discordapp.com",
    "api.telegram.org",
    "api.twilio.com",
    "api.sendgrid.com",
    "api.mailgun.net",
    "api.postmarkapp.com",
    "api.resend.com",
    "graph.microsoft.com",
    "outlook.office.com",
    "gmail.googleapis.com",
    "chat.googleapis.com",
    "api.pushover.net",
    "ntfy.sh",
];

/// Hosts whose APIs move money when they receive data.
const BILLING_HOSTS: &[&str] = &[
    "api.stripe.com",
    "api.paypal.com",
    "api-m.paypal.com",
    "api.braintreegateway.com",
    "api.squareup.com",
    "api.lemonsqueezy.com",
    "api.paddle.com",
    "checkout.stripe.com",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn classify(command: &str) -> CommandFacts {
        classify_command(command, &[], "", &Workspace::none())
    }

    #[test]
    fn tokenizer_splits_on_every_separator() {
        for text in [
            "a && b",
            "a; b",
            "a || b",
            "a | b",
            "a & b",
            "a\nb",
            "(a) && b",
            "{ a; }; b",
        ] {
            let t = tokenize(text, false);
            let programs: Vec<&str> = t
                .segments
                .iter()
                .map(|s| s.words[0].text.as_str())
                .collect();
            assert_eq!(programs, vec!["a", "b"], "{text}");
        }
    }

    #[test]
    fn tokenizer_removes_quotes_and_escapes_from_words() {
        let t = tokenize(r#"r"m" 'a b' r^m \rm "x\"y""#, false);
        let words: Vec<&str> = t.segments[0]
            .words
            .iter()
            .map(|w| w.text.as_str())
            .collect();
        // `\rm` keeps its backslash here (it may be a Windows path); `program` strips it.
        assert_eq!(words, vec!["rm", "a b", "rm", r"\rm", "x\"y"]);
    }

    #[test]
    fn tokenizer_keeps_windows_paths() {
        let t = tokenize(r"type C:\Users\me\file.txt", false);
        assert_eq!(t.segments[0].words[1].text, r"C:\Users\me\file.txt");
    }

    #[test]
    fn tokenizer_finds_redirects_and_ignores_fd_duplication() {
        let t = tokenize("echo hi > out.txt 2>&1 < in.txt", false);
        let seg = &t.segments[0];
        assert_eq!(seg.words.len(), 2);
        assert_eq!(seg.redirects.len(), 2);
        assert_eq!(seg.redirects[0].0, Redirect::Write);
        assert_eq!(seg.redirects[0].1.text, "out.txt");
        assert_eq!(seg.redirects[1].0, Redirect::Read);
    }

    #[test]
    fn substitutions_are_extracted() {
        let t = tokenize("echo $(rm -rf /) `whoami` \"$(curl x)\"", false);
        assert_eq!(t.substitutions, vec!["rm -rf /", "whoami", "curl x"]);
    }

    #[test]
    fn powershell_base64_round_trip() {
        // "Remove-Item -Recurse C:\x" as UTF-16LE base64.
        let script = "Remove-Item -Recurse C:\\x";
        let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let encoded = encode_base64(&utf16);
        assert_eq!(decode_powershell_base64(&encoded).as_deref(), Some(script));
        assert_eq!(decode_powershell_base64("!!!"), None);
    }

    pub(crate) fn encode_base64(bytes: &[u8]) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            out.push(T[(n >> 18) as usize & 63] as char);
            out.push(T[(n >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 {
                T[(n >> 6) as usize & 63] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                T[n as usize & 63] as char
            } else {
                '='
            });
        }
        out
    }

    #[test]
    fn simple_commands_are_reported_for_rules() {
        assert_eq!(classify("npm test").simple.as_deref(), Some("npm test"));
        assert_eq!(
            classify("npm   test  --  -x").simple.as_deref(),
            Some("npm test -- -x")
        );
        assert_eq!(classify("npm test && rm -rf /").simple, None);
        assert_eq!(classify("npm test > out.txt").simple, None);
        assert_eq!(classify("CI=1 npm test").simple, None);
    }
}
