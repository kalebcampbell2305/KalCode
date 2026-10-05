//! Bounded, ephemeral input correlation for Cursor's native prompt hook.
//! Never infer readiness from terminal output. Unrecognized editing makes the current
//! draft unknown; only an exact native prompt fingerprint can acknowledge a submission.

use kalcode_hook_bridge::record::cursor_prompt_fingerprint;

const MAX_DRAFT_BYTES: usize = 64 * 1024;
const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";

#[derive(Default)]
pub(super) struct CursorInput {
    draft: Vec<u8>,
    unknown: bool,
    paste: bool,
    prefix: Vec<u8>,
}

pub(super) struct Submission {
    pub fingerprint: Option<String>,
    pub trailing_input: bool,
    /// Ephemeral submitted input for the shared title sink. Never persisted as terminal history.
    pub text: Option<String>,
}

impl CursorInput {
    pub fn observe(&mut self, data: &[u8]) -> Vec<Submission> {
        let mut buffered = std::mem::take(&mut self.prefix);
        buffered.extend_from_slice(data);
        let mut submissions = Vec::new();
        let mut offset = 0;
        while offset < buffered.len() {
            let marker = if self.paste { PASTE_END } else { PASTE_START };
            let remaining = &buffered[offset..];
            if marker.starts_with(remaining) {
                self.prefix.extend_from_slice(remaining);
                break;
            }
            if remaining.starts_with(marker) {
                self.paste = !self.paste;
                offset += marker.len();
                continue;
            }
            let byte = buffered[offset];
            offset += 1;
            if !self.paste && matches!(byte, b'\r' | b'\n') {
                let text = (!self.unknown)
                    .then(|| std::str::from_utf8(&self.draft).ok())
                    .flatten()
                    .filter(|text| !text.is_empty())
                    .map(str::to_owned);
                let fingerprint = text.as_deref().map(cursor_prompt_fingerprint);
                submissions.push(Submission {
                    fingerprint,
                    trailing_input: offset < buffered.len(),
                    text,
                });
                self.draft.clear();
                self.unknown = false;
                // The caller treats overflow as permanently unverified, bounding even a flood
                // of empty native commands independently from the PTY write limit.
                if submissions.len() > 32 {
                    break;
                }
            } else if !self.paste && matches!(byte, 8 | 127) {
                if let Ok(text) = std::str::from_utf8(&self.draft) {
                    let end = text
                        .char_indices()
                        .next_back()
                        .map_or(0, |(index, _)| index);
                    self.draft.truncate(end);
                } else {
                    self.unknown = true;
                    self.draft.clear();
                }
            } else if !self.paste && byte.is_ascii_control() {
                self.unknown = true;
                self.draft.clear();
            } else if !self.unknown && self.draft.len() < MAX_DRAFT_BYTES {
                self.draft.push(byte);
            } else {
                self.unknown = true;
                self.draft.clear();
            }
        }
        submissions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_utf8_and_bracketed_paste_keep_exact_native_bytes() {
        let mut input = CursorInput::default();
        assert!(input.observe(b"\x1b[20").is_empty());
        assert!(input.observe(b"0~caf\xc3").is_empty());
        assert!(input.observe(b"\xa9\nsecond line\x1b[2").is_empty());
        let submits = input.observe(b"01~\rnext draft");
        assert_eq!(submits.len(), 1);
        assert_eq!(
            submits[0].fingerprint,
            Some(cursor_prompt_fingerprint("café\nsecond line"))
        );
        assert!(submits[0].trailing_input);
        let next = input.observe(b"\r");
        assert_eq!(
            next[0].fingerprint,
            Some(cursor_prompt_fingerprint("next draft"))
        );
    }

    #[test]
    fn uncertain_edits_and_oversized_input_cannot_certify_a_prompt() {
        let mut input = CursorInput::default();
        assert!(input.observe(b"draft\x1b[A").is_empty());
        assert!(input.observe(b"\r")[0].fingerprint.is_none());
        input.observe(&vec![b'x'; MAX_DRAFT_BYTES + 1]);
        assert!(input.observe(b"\r")[0].fingerprint.is_none());
        let edited = input.observe("café\x7feteria\r".as_bytes());
        assert_eq!(
            edited[0].fingerprint,
            Some(cursor_prompt_fingerprint("cafeteria"))
        );
    }
}
