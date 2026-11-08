//! The prompt matchers `bw cards` and `bw answer` share: Claude's boxes and the Codex ones.
//!
//! Each matcher reads one screen and names the keys of each action; a screen it cannot read gives no prompt, so no
//! key is chosen for it. Keys are hc key names (`hc keys -- <t> <key>`).

use herdr_core::approval::{
    screen_box, screen_prompt, screen_shows_prompt, CLIPPED_TITLE, PROMPT_MARKER, QUESTION_LINES,
};
use herdr_core::question;

use super::codex_approval::{codex_box, codex_id, plain, FOOTER};
use super::codex_folder::{folder_box, folder_id};

/// Task 1 case (e): a Codex sub-agent's box shows on the parent's screen, the matcher reads it
/// (`codex_child_box_is_read`), and `y` there created `child.txt`.
pub const CODEX_CHILD_ANSWERABLE: bool = true;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Action {
    /// `approve`, `always`, `deny` or `option-<n>`.
    pub id: String,
    pub label: String,
    /// The label as the box draws it, its wrapped lines joined with `\n`, for `same_label`.
    pub drawn: String,
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
    /// The box outside its command up to the options, lines kept: who asks, the description and the question with
    /// the file it names. The screen id leaves their spacing out, so `bw cards` and `bw answer` compare this.
    pub question: String,
    /// The box's top is off screen: its header and command are not read.
    pub clipped: bool,
    /// The box's top rule is off screen but its command is whole: no header or tool was read, so a call matches it
    /// by command alone.
    pub header_cut: bool,
    pub actions: Vec<Action>,
    /// Who the box says asks: Claude's agent type (`from the toucher agent`), Codex's thread path. It names no id,
    /// so it only confirms who asked.
    pub from: Option<String>,
}

/// Whether two drawings of a command say the same: a line break stands for nothing or one space, since a pane
/// breaks a line between words or inside one. Whitespace inside a line, runs included, must match, so
/// `touch a.txt` and `touch a .txt` differ, and so do `rm 'a  b'` and `rm 'a b'`. A command over `DRAWN_MAX`
/// characters must match exactly.
pub fn same_drawn(a: &str, b: &str) -> bool {
    drawn_match(a, b, false)
}

/// Whether two drawings of an option's label say the same, line breaks aside, or one is the other cut short with
/// or without a trailing `…`, as a narrow pane cuts Claude's option text.
pub fn same_label(a: &str, b: &str) -> bool {
    cut_of(a, b) || cut_of(b, a)
}

/// Whether `short` is `long` cut short, or the same, line breaks aside.
pub fn cut_of(short: &str, long: &str) -> bool {
    let short = short.trim_end();
    let short = short.strip_suffix('…').unwrap_or(short);
    !short.trim().is_empty() && drawn_match(short, long, true)
}

/// `same_drawn`, or with `prefix` whether `a` says the same as the start of `b`.
fn drawn_match(a: &str, b: &str, prefix: bool) -> bool {
    let norm = |s: &str| -> Vec<char> {
        s.split('\n')
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
            .chars()
            .collect()
    };
    let (a, b) = (norm(a), norm(b));
    if a.len() > DRAWN_MAX || b.len() > DRAWN_MAX {
        return if prefix { b.starts_with(&a) } else { a == b };
    }
    // ok[i][j]: a[i..] and b[j..] say the same (with `prefix`, a[i..] and the start of b[j..]).
    let (n, m) = (a.len(), b.len());
    let mut ok = vec![vec![false; m + 1]; n + 1];
    for i in (0..=n).rev() {
        for j in (0..=m).rev() {
            if i == n && (j == m || prefix) {
                ok[i][j] = true;
                continue;
            }
            let (x, y) = (a.get(i), b.get(j));
            ok[i][j] = (x.is_some() && x == y && ok[i + 1][j + 1])
                || (x == Some(&'\n') && (ok[i + 1][j] || (y == Some(&' ') && ok[i + 1][j + 1])))
                || (y == Some(&'\n') && (ok[i][j + 1] || (x == Some(&' ') && ok[i + 1][j + 1])));
        }
    }
    ok[0][0]
}

/// Longer commands are compared exactly, keeping `same_drawn`'s table small.
const DRAWN_MAX: usize = 4096;

/// `N. text` as `(N, text)`; a narrow pane draws `2.Yes` with no space after the number.
fn option_number(line: &str) -> Option<(usize, &str)> {
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    let rest = line[digits..].strip_prefix('.')?;
    if digits == 0 || rest.is_empty() {
        return None;
    }
    Some((line[..digits].parse().ok()?, rest.trim()))
}

fn action(id: &str, label: &str, keys: &[&'static str]) -> Action {
    Action {
        id: id.into(),
        label: label.into(),
        drawn: label.into(),
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
        match option_number(l) {
            Some((n, text)) if n == opts.len() + 1 => opts.push(text.to_string()),
            Some(_) => return None,
            // The question's own wrapped tail ("proceed?") comes before option 1.
            None if opts.is_empty() => {}
            None => {
                let last = opts.last_mut()?;
                last.push('\n');
                last.push_str(l);
            }
        }
    }
    let options = b.lines[ask + 1..]
        .iter()
        .position(|l| option_number(l).is_some())
        .map_or(b.lines.len(), |k| ask + 1 + k);
    let is_rule = |l: &&String| l.starts_with('╌');
    let rules: Vec<usize> = (0..ask).filter(|&i| is_rule(&&b.lines[i])).collect();
    // The command is the block between the first two rules, else every line between the header and the question.
    let outside: Vec<&String> = match (b.clipped, rules.as_slice()) {
        (true, _) => b.lines[ask..options].iter().collect(),
        (false, [r1, r2, ..]) => b.lines[..*r1]
            .iter()
            .chain(&b.lines[r2 + 1..options])
            .collect(),
        (false, _) => b.lines[..1].iter().chain(&b.lines[ask..options]).collect(),
    };
    let question = outside
        .into_iter()
        .filter(|l| !is_rule(l))
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("\n");
    let shown = |o: &String| o.replace('\n', " ");
    if !opts
        .first()
        .map(shown)
        .is_some_and(|o| o == "Yes" || o.starts_with("Yes ") || o.starts_with("Yes,"))
    {
        return None;
    }
    let mut actions = vec![action("approve", "Approve", &["1"])];
    if let Some(always) = opts.get(1).filter(|o| {
        let o = shown(o);
        o.starts_with("Yes, and") || o.starts_with("Yes, allow")
    }) {
        actions.push(Action {
            drawn: always.clone(),
            ..action("always", &shown(always), &["2"])
        });
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
        question,
        clipped: b.clipped,
        header_cut: b.header_cut,
        actions,
        from,
    })
}

fn codex_prompt(screen: &str) -> Option<ScreenPrompt> {
    let b = codex_box(screen)?;
    let mut actions = vec![action("approve", "Approve", &["y"])];
    if let (Some(always), Some(drawn)) = (&b.always, &b.always_drawn) {
        actions.push(Action {
            drawn: drawn.clone(),
            ..action("always", always, &["p"])
        });
    }
    actions.push(action("deny", "Deny", &["esc"]));
    Some(ScreenPrompt {
        agent: "codex".into(),
        screen_id: codex_id(&b),
        title: super::codex_approval::QUESTION.into(),
        tool: "Bash".into(),
        command: b.command.clone(),
        detail: b.reason.clone(),
        question: b.question.clone(),
        clipped: false,
        header_cut: false,
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
            drawn: label.clone(),
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
        question: String::new(),
        clipped: false,
        header_cut: false,
        actions,
        from: None,
    })
}

/// Whitespace runs as one space, ends trimmed.
fn words(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A tool name Codex gives a shell command: `Bash` in its hooks, `exec`, `js` and others in its rollouts.
pub fn codex_command_tool(tool: &str) -> bool {
    matches!(
        tool,
        "Bash" | "exec" | "js" | "exec_command" | "shell" | "local_shell" | "container.exec"
    )
}

/// The log's call is the prompt on screen: same tool, same non-empty command. Each line break of the box stands
/// for one space or none; inside a line, words must match. Codex's log names its command tools as they are
/// (`exec`, `exec_command`, `shell`…), its box always as a command. A box whose header is cut off names no tool, so
/// only its command is compared.
pub fn same_call(tool: &str, command: &str, p: &ScreenPrompt) -> bool {
    let codex_command = p.agent == "codex" && codex_command_tool(tool);
    if !p.header_cut && (p.tool.is_empty() || !(tool == p.tool || codex_command)) {
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

/// A line `Do you want …` whose question ends with `?` within `QUESTION_LINES` lines, as Claude asks.
fn claude_asks(screen: &str) -> bool {
    let ls: Vec<&str> = screen
        .split('\n')
        .map(|l| l.trim_matches(|c| "│|┃ \t❯".contains(c)))
        .collect();
    ls.iter().enumerate().any(|(i, l)| {
        l.starts_with(PROMPT_MARKER)
            && ls[i..(i + QUESTION_LINES).min(ls.len())]
                .iter()
                .any(|x| x.ends_with('?'))
    })
}
