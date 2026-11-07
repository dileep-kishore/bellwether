//! The prompt matchers `bw cards` and `bw answer` share: Claude's boxes and the Codex ones.
//!
//! Each matcher reads one screen and names the keys of each action; a screen it cannot read gives no prompt, so no
//! key is chosen for it. Keys are hc key names (`hc keys -- <t> <key>`).

#![expect(
    dead_code,
    reason = "bw cards and bw answer (phase 3 Tasks 8 and 9) use it"
)]

use herdr_core::approval::{
    screen_box, screen_prompt, screen_shows_prompt, CLIPPED_TITLE, PROMPT_MARKER,
};
use herdr_core::question;

use super::codex_approval::{codex_box, codex_id, numbered, plain, FOOTER};
use super::codex_folder::{folder_box, folder_id};

/// Task 1 case (e): a Codex sub-agent's box shows on the parent's screen, the matcher reads it
/// (`codex_child_box_is_read`), and `y` there created `child.txt`.
pub const CODEX_CHILD_ANSWERABLE: bool = true;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Action {
    /// `approve`, `always`, `deny` or `option-<n>`.
    pub id: String,
    pub label: String,
    pub keys: Vec<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScreenPrompt {
    pub agent: String,
    pub screen_id: String,
    pub title: String,
    pub tool: String,
    pub command: String,
    pub detail: String,
    /// The box's top is off screen: its header and command are not read.
    pub clipped: bool,
    pub actions: Vec<Action>,
    /// Who the box says asks: Claude's agent type (`from the toucher agent`), Codex's thread path. It names no id,
    /// so it only confirms who asked.
    pub from: Option<String>,
}

fn action(id: &str, label: &str, keys: &[&'static str]) -> Action {
    Action {
        id: id.into(),
        label: label.into(),
        keys: keys.to_vec(),
    }
}

/// The approval box on screen, Claude's or Codex 0.167's.
pub fn approval_on_screen(agent: &str, screen: &str) -> Option<ScreenPrompt> {
    match agent {
        "claude" => claude_box(screen),
        "codex" => codex_prompt(screen),
        _ => None,
    }
}

fn claude_box(screen: &str) -> Option<ScreenPrompt> {
    if !screen_shows_prompt(screen) || question::claude_screen(screen).is_some() {
        return None;
    }
    let b = screen_box(screen)?;
    let screen_id = screen_prompt(screen)?;
    let ask = b.lines.iter().rposition(|l| l.contains(PROMPT_MARKER))?;
    // A question with no header above it is no box this code knows.
    if !b.clipped && ask == 0 {
        return None;
    }
    let mut opts: Vec<String> = vec![];
    for l in &b.lines[ask + 1..] {
        match numbered(l) {
            Some((n, text)) if n == opts.len() + 1 => opts.push(text.to_string()),
            Some(_) => return None,
            None => {
                let last = opts.last_mut()?;
                last.push(' ');
                last.push_str(l);
            }
        }
    }
    if !opts
        .first()
        .is_some_and(|o| o == "Yes" || o.starts_with("Yes ") || o.starts_with("Yes,"))
    {
        return None;
    }
    let mut actions = vec![action("approve", "Approve", &["1"])];
    if let Some(always) = opts
        .get(1)
        .filter(|o| o.starts_with("Yes, and") || o.starts_with("Yes, allow"))
    {
        actions.push(action("always", always, &["2"]));
    }
    actions.push(action("deny", "Deny", &["esc"]));
    let (title, detail, from) = if b.clipped {
        (CLIPPED_TITLE.to_string(), String::new(), None)
    } else {
        let rule = b.lines.iter().position(|l| l.starts_with('╌'));
        let detail = rule.map(|r| b.lines[1..r].join("\n")).unwrap_or_default();
        let from = b
            .header
            .rsplit_once("· from the ")
            .and_then(|(_, who)| who.strip_suffix(" agent"))
            .map(|who| who.trim().to_string());
        (b.header.clone(), detail, from)
    };
    Some(ScreenPrompt {
        agent: "claude".into(),
        screen_id,
        title,
        tool: b.tool,
        command: b.command,
        detail,
        clipped: b.clipped,
        actions,
        from,
    })
}

fn codex_prompt(screen: &str) -> Option<ScreenPrompt> {
    let b = codex_box(screen)?;
    let mut actions = vec![action("approve", "Approve", &["y"])];
    if let Some(always) = &b.always {
        actions.push(action("always", always, &["p"]));
    }
    actions.push(action("deny", "Deny", &["esc"]));
    Some(ScreenPrompt {
        agent: "codex".into(),
        screen_id: codex_id(&b),
        title: super::codex_approval::QUESTION.into(),
        tool: "Bash".into(),
        command: b.command.clone(),
        detail: b.reason.clone(),
        clipped: false,
        actions,
        from: b.thread.clone(),
    })
}

/// Codex 0.167's `/new` folder prompt as a `prompt` request: one action per option, no Always or Deny.
pub fn folder_prompt_on_screen(agent: &str, screen: &str) -> Option<ScreenPrompt> {
    if agent != "codex" {
        return None;
    }
    let f = folder_box(screen)?;
    let actions = f
        .options
        .iter()
        .enumerate()
        .map(|(i, (label, keys))| Action {
            id: format!("option-{}", i + 1),
            label: label.clone(),
            keys: keys.clone(),
        })
        .collect();
    let detail = f
        .options
        .iter()
        .zip(&f.details)
        .map(|((label, _), d)| {
            if d.is_empty() {
                label.clone()
            } else {
                format!("{label}: {d}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(ScreenPrompt {
        agent: "codex".into(),
        screen_id: folder_id(&f),
        title: "Codex asks where the new conversation should run".into(),
        tool: "new_conversation".into(),
        command: String::new(),
        detail,
        clipped: false,
        actions,
        from: None,
    })
}

/// Whitespace runs as one space, ends trimmed.
fn words(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The log's call is the prompt on screen: same tool, same non-empty command. Each line break of the box stands
/// for one space or none; inside a line, words must match. Codex's log names its command tools as they are
/// (`exec`, `exec_command`, `shell`…), its box always as a command.
pub fn same_call(tool: &str, command: &str, p: &ScreenPrompt) -> bool {
    let codex_command = p.agent == "codex"
        && matches!(
            tool,
            "Bash" | "exec" | "js" | "exec_command" | "shell" | "local_shell" | "container.exec"
        );
    if p.tool.is_empty() || !(tool == p.tool || codex_command) {
        return false;
    }
    let all = words(command);
    if all.is_empty() {
        return false;
    }
    let box_lines: Vec<String> = p
        .command
        .split('\n')
        .map(words)
        .filter(|l| !l.is_empty())
        .collect();
    if box_lines.is_empty() {
        return false;
    }
    let mut rest: &str = &all;
    for (i, line) in box_lines.iter().enumerate() {
        if i > 0 && rest.starts_with(' ') {
            rest = &rest[1..];
        }
        match rest.strip_prefix(line.as_str()) {
            Some(r) => rest = r,
            None => return false,
        }
    }
    rest.is_empty()
}

/// A prompt shape on screen that no matcher reads: Claude's `Do you want …?` without a box it knows, Codex's
/// `Would you like to …` or its approval footer without a command box. The card shows "Answer in the terminal".
pub fn other_prompt(agent: &str, screen: &str) -> bool {
    match agent {
        "claude" => {
            approval_on_screen(agent, screen).is_none()
                && question::claude_screen(screen).is_none()
                && claude_asks(screen)
        }
        "codex" => {
            approval_on_screen(agent, screen).is_none()
                && folder_prompt_on_screen(agent, screen).is_none()
                && question::codex_screen(screen).is_none()
                && screen
                    .split('\n')
                    .map(plain)
                    .any(|l| l.starts_with("Would you like to") || l.starts_with(FOOTER))
        }
        _ => false,
    }
}

/// A line `Do you want …` whose question ends with `?` within three lines, as Claude asks.
fn claude_asks(screen: &str) -> bool {
    let ls: Vec<&str> = screen
        .split('\n')
        .map(|l| l.trim_matches(|c| "│|┃ \t❯".contains(c)))
        .collect();
    ls.iter().enumerate().any(|(i, l)| {
        l.starts_with(PROMPT_MARKER)
            && ls[i..(i + 3).min(ls.len())]
                .iter()
                .any(|x| x.ends_with('?'))
    })
}
