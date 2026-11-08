//! The Codex 0.167 command approval box.
//!
//! Read only in the two shapes Task 1 saved (`docs/research/2026-11-06-phase3-requests.md`, cases d, e, i): the
//! question, then optional `Thread:` (a sub-agent's box), `Environment:` and `Reason:` lines, the `$ <command>`
//! lines, options `1. … (y)`, an optional `2. … (p)` and a last `… (esc)`, and the footer. Anything else in the box
//! gives no match, so no key is ever chosen for a prompt this code has not seen.

use herdr_core::approval::{hash_id, id_text};

pub const QUESTION: &str = "Would you like to run the following command?";
pub const FOOTER: &str = "Press enter to confirm or esc to cancel";
/// A sub-agent's box adds this to the footer, and a `Thread:` line under the question.
pub const FOOTER_CHILD: &str = "Press enter to confirm or esc to cancel or o to open thread";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexBox {
    /// The command as the screen shows it, its wrapped lines joined with `\n`.
    pub command: String,
    /// The model's reason, wrapped lines joined with a space; empty when the box has none.
    pub reason: String,
    /// Every non-blank line from the question to the footer, as `plain` gives them.
    pub lines: Vec<String>,
    /// Option 2's text without its ` (p)` key hint, when the box offers it.
    pub always: Option<String>,
    /// `always` as drawn, its wrapped lines joined with `\n`.
    pub always_drawn: Option<String>,
    /// The question and the labelled lines under it (`Thread:`, `Environment:`, `Reason:`) as drawn.
    pub question: String,
    /// The `Thread:` line's agent path (`/root/<path>`), only on a sub-agent's box.
    pub thread: Option<String>,
}

/// A screen line as the boxes compare it: trimmed, with the cursor `›` before an option dropped, so moving the
/// cursor keeps the box's id.
pub fn plain(line: &str) -> &str {
    let t = line.trim();
    t.strip_prefix('›').map(str::trim_start).unwrap_or(t)
}

/// The index of the line after the last run of non-blank lines that read `question` once whitespace is dropped: a
/// narrow pane wraps the question over several lines, between words or inside one.
pub fn question_end(raw: &[&str], question: &str) -> Option<usize> {
    let squeeze = |s: &str| s.split_whitespace().collect::<String>();
    let want = squeeze(question);
    let mut end = None;
    let mut i = 0;
    while i < raw.len() {
        if plain(raw[i]).is_empty() {
            i += 1;
            continue;
        }
        let start = i;
        while i < raw.len() && !plain(raw[i]).is_empty() {
            i += 1;
        }
        let text: String = raw[start..i].iter().map(|l| squeeze(plain(l))).collect();
        if text == want {
            end = Some(i);
        }
    }
    end
}

/// `N. text` as `(N, text)`.
pub fn numbered(line: &str) -> Option<(usize, &str)> {
    let (n, text) = line.split_once(". ")?;
    if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((n.parse().ok()?, text.trim()))
}

/// The plain non-blank lines of `raw`, grouped into runs that blank lines separate.
pub fn blocks(raw: &[&str]) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = vec![];
    let mut run: Vec<String> = vec![];
    for l in raw {
        let p = plain(l);
        if p.is_empty() {
            if !run.is_empty() {
                out.push(std::mem::take(&mut run));
            }
        } else {
            run.push(p.to_string());
        }
    }
    if !run.is_empty() {
        out.push(run);
    }
    out
}

/// Numbered options, each continued by the lines under it until the next number; numbered 1, 2, 3… or None.
pub fn options(lines: &[String]) -> Option<Vec<String>> {
    options_joined(lines, ' ')
}

/// `options` with each option's lines joined by `sep`.
fn options_joined(lines: &[String], sep: char) -> Option<Vec<String>> {
    let mut out: Vec<String> = vec![];
    for l in lines {
        match numbered(l) {
            Some((n, text)) if n == out.len() + 1 => out.push(text.to_string()),
            Some(_) => return None,
            None => {
                let last = out.last_mut()?;
                last.push(sep);
                last.push_str(l);
            }
        }
    }
    Some(out)
}

/// A footer that may have wrapped anywhere, even inside a word.
pub fn footer_is(lines: &[String], footer: &str) -> bool {
    let squeeze = |s: &str| s.split_whitespace().collect::<String>();
    squeeze(&lines.join(" ")) == squeeze(footer)
}

/// The labelled lines between the question and the command; each at most once, in this order.
#[derive(PartialEq, PartialOrd)]
enum Label {
    Thread,
    Environment,
    Reason,
}

pub fn codex_box(screen: &str) -> Option<CodexBox> {
    let raw: Vec<&str> = screen.split('\n').collect();
    let after = question_end(&raw, QUESTION)?;
    let mut rest = blocks(&raw[after..]).into_iter();
    let (mut thread, mut reason, mut seen) = (None, String::new(), None::<Label>);
    let mut question = vec![QUESTION.to_string()];
    let command_block = loop {
        let b = rest.next()?;
        let first = b[0].as_str();
        let label = if first.starts_with("$ ") {
            break b;
        } else if first.starts_with("Thread:") {
            Label::Thread
        } else if first.starts_with("Environment:") {
            Label::Environment
        } else if first.starts_with("Reason:") {
            Label::Reason
        } else {
            return None;
        };
        if seen.as_ref().is_some_and(|s| *s >= label) {
            return None;
        }
        let (_, value) = first.split_once(':')?;
        let value = std::iter::once(value.trim())
            .chain(b[1..].iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ");
        match label {
            Label::Thread if b.len() == 1 && !value.is_empty() => thread = Some(value),
            Label::Environment if b.len() == 1 => {}
            Label::Reason => reason = value,
            _ => return None,
        }
        seen = Some(label);
        question.extend(b);
    };
    // The command runs until a blank line or the first option.
    let split = command_block
        .iter()
        .position(|l| numbered(l).is_some())
        .unwrap_or(command_block.len());
    let (command, mut option_lines) = (
        command_block[..split].to_vec(),
        command_block[split..].to_vec(),
    );
    if option_lines.is_empty() {
        option_lines = rest.next()?;
    }
    let footer = rest.next()?;
    if rest.next().is_some() {
        return None;
    }
    let child = if footer_is(&footer, FOOTER) {
        false
    } else if footer_is(&footer, FOOTER_CHILD) {
        true
    } else {
        return None;
    };
    if child != thread.is_some() {
        return None;
    }
    let opts = options(&option_lines)?;
    let always = match opts.as_slice() {
        [yes, no] if yes.ends_with("(y)") && no.ends_with("(esc)") => None,
        [yes, always, no] if yes.ends_with("(y)") && no.ends_with("(esc)") => {
            Some(always.strip_suffix("(p)")?.trim_end().to_string())
        }
        _ => return None,
    };
    let always_drawn = match always {
        Some(_) => Some(
            options_joined(&option_lines, '\n')?[1]
                .strip_suffix("(p)")?
                .trim_end()
                .to_string(),
        ),
        None => None,
    };
    let first = command[0].strip_prefix("$ ")?.trim();
    let command: Vec<&str> = std::iter::once(first)
        .chain(command[1..].iter().map(String::as_str))
        .collect();
    if first.is_empty() {
        return None;
    }
    let lines = std::iter::once(QUESTION.to_string())
        .chain(blocks(&raw[after..]).into_iter().flatten())
        .collect();
    Some(CodexBox {
        command: command.join("\n"),
        reason,
        lines,
        always,
        always_drawn,
        question: question.join("\n"),
        thread,
    })
}

/// The box's id: a hash of its lines, which include the command, the reason and a sub-agent's thread, without
/// whitespace, so a rewrap keeps it.
pub fn codex_id(b: &CodexBox) -> String {
    hash_id(&format!("codex\n{}", id_text(&b.lines)))
}
