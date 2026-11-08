//! The Codex 0.167 `/new` folder prompt ("Where should the new conversation run?").
//!
//! Task 1 case (j): numbered options, each a name, two or more spaces and a description, then the footer
//! `enter select · esc back`. Each option's digit picks it at once, with no Enter. hc says `idle`, never
//! `blocked`, while it shows, so a reader that waits for `blocked` never sees it.

use herdr_core::approval::hash_id;

use super::codex_approval::{blocks, footer_is, options, question_end};

pub const QUESTION: &str = "Where should the new conversation run?";
pub const FOOTER: &str = "enter select · esc back";

const DIGITS: [&str; 9] = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderBox {
    /// Each option's name and the keys that pick it.
    pub options: Vec<(String /* label */, Vec<&'static str> /* keys */)>,
    /// Each option's description, in the same order; empty when the option has none.
    pub details: Vec<String>,
    /// Every non-blank line from the question to the footer, as `plain` gives them.
    pub lines: Vec<String>,
}

pub fn folder_box(screen: &str) -> Option<FolderBox> {
    let raw: Vec<&str> = screen.split('\n').collect();
    let after = question_end(&raw, QUESTION)?;
    let found = blocks(&raw[after..]);
    let [option_lines, footer] = found.as_slice() else {
        return None;
    };
    if !footer_is(footer, FOOTER) {
        return None;
    }
    let opts = options(option_lines)?;
    if opts.is_empty() || opts.len() > DIGITS.len() {
        return None;
    }
    let (mut named, mut details) = (vec![], vec![]);
    for (i, text) in opts.iter().enumerate() {
        let (name, detail) = text.split_once("  ").unwrap_or((text.as_str(), ""));
        if name.trim().is_empty() {
            return None;
        }
        named.push((name.trim().to_string(), vec![DIGITS[i]]));
        details.push(detail.split_whitespace().collect::<Vec<_>>().join(" "));
    }
    let lines = std::iter::once(QUESTION.to_string())
        .chain(found.into_iter().flatten())
        .collect();
    Some(FolderBox {
        options: named,
        details,
        lines,
    })
}

/// The question and the option names: a narrow pane drops the descriptions, so they are not part of the id.
pub fn folder_id(b: &FolderBox) -> String {
    let names: Vec<&str> = b.options.iter().map(|(name, _)| name.as_str()).collect();
    hash_id(&format!("codex-folder\n{QUESTION}\n{}", names.join("\n")))
}
