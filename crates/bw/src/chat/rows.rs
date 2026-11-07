//! What the chat draws, one row each: the conversation items, plus time separators, one footer per agent turn,
//! and a changed-files row before the footer of a turn that edited files.
//!
//! Adapted from Flockbook's xplat/flockbook-modfeed/src/rows.rs (MIT, Copyright (c) 2026 Min-Chen Lee).

use chrono::{Datelike, Duration, TimeZone, Timelike};
use herdr_core::conversation::codex_patch_files;
use herdr_core::util::Date;
use herdr_core::*;
use serde::Serialize;
use unicode_segmentation::UnicodeSegmentation;

use super::sentence;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FeedRow {
    /// Always "row".
    #[serde(rename = "type")]
    pub kind_tag: &'static str,
    /// "user", "assistant", "tools", "changed", "perm", "question", "status", "sep", "footer".
    pub k: String,
    /// Stable across reads of the same log.
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Milliseconds since 1970.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<usize>,
    /// Where the item's pictures are in the log. Only for items read with line offsets (`feed --pictures`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pics: Option<Vec<FeedPic>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chips: Option<Vec<FeedChip>>,
    /// Tools rows: the chips' texts as one sentence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sentence: Option<String>,
    /// Tools rows: some call has no result yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live: Option<bool>,
    /// Tools rows: some call failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
    /// Changed rows: the files the turn edited, in order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub perm: Option<FeedPerm>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<FeedQuestion>,
}

impl FeedRow {
    pub fn new(k: &str, id: &str, text: Option<String>, ts: Option<i64>) -> FeedRow {
        FeedRow {
            kind_tag: "row",
            k: k.into(),
            id: id.into(),
            text,
            ts,
            images: None,
            pics: None,
            chips: None,
            sentence: None,
            live: None,
            error: None,
            files: None,
            perm: None,
            question: None,
        }
    }
}

/// A picture's place in the log: its line's offset, its place in the line, and its fingerprint (16 hex digits).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FeedPic {
    pub format: &'static str,
    pub width: i64,
    pub height: i64,
    pub offset: u64,
    pub index: usize,
    pub digest: String,
}

/// The item's pictures: the owner's for a user item, every call's result pictures in call order for a tool group. None when there are none, or when a ref has no line offset.
pub fn pics(it: &ConversationItem) -> Option<Vec<FeedPic>> {
    let refs: Vec<&ImageRef> = match &it.kind {
        ItemKind::UserText(_) => it.images.iter().collect(),
        ItemKind::ToolChips(chips) => chips
            .iter()
            .flat_map(|c| &c.calls)
            .flat_map(|x| &x.images)
            .collect(),
        _ => vec![],
    };
    if refs.is_empty() {
        return None;
    }
    refs.iter()
        .map(|r| {
            Some(FeedPic {
                format: herdr_core::log_image::format_raw(r.format),
                width: r.width,
                height: r.height,
                offset: r.offset?,
                index: r.index,
                digest: format!("{:016x}", r.digest),
            })
        })
        .collect()
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FeedChip {
    pub symbol: String,
    pub text: String,
    pub calls: Vec<FeedCall>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FeedCall {
    pub name: String,
    pub summary: String,
    pub done: bool,
    pub error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedPerm {
    pub title: String,
    pub command: String,
    pub tool: String,
    pub tool_use_id: String,
    pub state: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FeedOption {
    pub label: String,
    pub detail: String,
    pub recommended: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FeedQuestionItem {
    pub id: String,
    pub header: String,
    pub text: String,
    pub multi: bool,
    pub options: Vec<FeedOption>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedQuestion {
    pub tool_use_id: String,
    pub agent: String,
    /// "picker" or "message".
    pub delivery: String,
    /// "pending", "answered", "declined".
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answers: Option<Vec<String>>,
    pub questions: Vec<FeedQuestionItem>,
}

/// Longer text is cut (a trailing "…" marks the cut).
pub const TEXT_CAP: usize = 20_000;
pub const OUTPUT_CAP: usize = 400;
/// A gap this long between rows (or a new day) gets a time separator.
pub const SEPARATOR_GAP_S: i64 = 900;

/// `s` cut to `n` grapheme clusters, with "…" marking a cut.
pub fn cut(s: &str, n: usize) -> String {
    let mut it = s.grapheme_indices(true);
    match it.nth(n) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// Seconds since 1970 as whole milliseconds.
pub fn ms(t: Option<f64>) -> Option<i64> {
    t.map(|t| (t * 1000.0).round() as i64)
}

/// A log time (seconds since 1970) as a date, to the microsecond.
pub fn date(t: f64) -> Date {
    let us = (t * 1_000_000.0).round() as i64;
    chrono::DateTime::<chrono::Utc>::from_timestamp_micros(us).unwrap_or_default()
}

/// Adjacent tool items become one row, keyed by the first one's id.
pub fn merged(items: &[ConversationItem]) -> Vec<ConversationItem> {
    let mut out: Vec<ConversationItem> = vec![];
    let mut run: Vec<ConversationItem> = vec![];
    fn flush(run: &mut Vec<ConversationItem>, out: &mut Vec<ConversationItem>) {
        let Some(first) = run.first().cloned() else {
            return;
        };
        if run.len() == 1 {
            out.push(first);
        } else {
            let chips: Vec<ToolChip> = run
                .iter()
                .flat_map(|r| {
                    if let ItemKind::ToolChips(c) = &r.kind {
                        c.clone()
                    } else {
                        vec![]
                    }
                })
                .collect();
            out.push(ConversationItem {
                id: first.id.clone(),
                kind: ItemKind::ToolChips(chips),
                timestamp: first.timestamp,
                images: vec![],
            });
        }
        run.clear();
    }
    for it in items {
        if matches!(it.kind, ItemKind::ToolChips(_)) {
            run.push(it.clone());
        } else {
            flush(&mut run, &mut out);
            out.push(it.clone());
        }
    }
    flush(&mut run, &mut out);
    out
}

pub fn question(q: &QuestionRequest) -> FeedQuestion {
    let (state, answers) = match &q.state {
        QuestionState::Pending => ("pending", None),
        QuestionState::Answered(a) => ("answered", a.clone()),
        QuestionState::Declined => ("declined", None),
    };
    FeedQuestion {
        tool_use_id: q.tool_use_id.clone(),
        agent: q.agent.clone(),
        delivery: if q.delivery == Delivery::Picker {
            "picker"
        } else {
            "message"
        }
        .into(),
        state: state.into(),
        answers,
        questions: q
            .questions
            .iter()
            .map(|x| FeedQuestionItem {
                id: x.id.clone(),
                header: x.header.clone(),
                text: x.text.clone(),
                multi: x.multi_select,
                options: x
                    .options
                    .iter()
                    .map(|o| FeedOption {
                        label: o.label.clone(),
                        detail: o.detail.clone(),
                        recommended: o.recommended,
                    })
                    .collect(),
            })
            .collect(),
    }
}

pub fn row(it: &ConversationItem) -> FeedRow {
    let mut r = FeedRow::new("status", &it.id, None, ms(it.timestamp));
    r.pics = pics(it);
    match &it.kind {
        ItemKind::UserText(s) => {
            r.k = "user".into();
            r.text = Some(cut(s, TEXT_CAP));
            if !it.images.is_empty() {
                r.images = Some(it.images.len());
            }
        }
        ItemKind::AssistantText(s) => {
            r.k = "assistant".into();
            r.text = Some(cut(s, TEXT_CAP));
        }
        ItemKind::Status(s) => r.text = Some(s.clone()),
        ItemKind::ToolChips(chips) => {
            r.k = "tools".into();
            let texts: Vec<String> = chips.iter().map(|c| c.text.clone()).collect();
            r.sentence = Some(sentence::join(&texts));
            let calls = || chips.iter().flat_map(|c| &c.calls);
            r.live = Some(calls().any(|x| x.output.is_none()));
            r.error = Some(calls().any(|x| x.is_error));
            r.chips = Some(
                chips
                    .iter()
                    .map(|c| FeedChip {
                        symbol: c.symbol.clone(),
                        text: c.text.clone(),
                        calls: c
                            .calls
                            .iter()
                            .map(|x| FeedCall {
                                name: x.tool_name.clone(),
                                summary: cut(&x.summary, 300),
                                done: x.output.is_some(),
                                error: x.is_error,
                                output: x.output.as_ref().map(|o| cut(o, OUTPUT_CAP)),
                            })
                            .collect(),
                    })
                    .collect(),
            );
        }
        ItemKind::PermissionRequest(p) => {
            r.k = "perm".into();
            r.text = Some(p.title.clone());
            r.perm = Some(FeedPerm {
                title: p.title.clone(),
                command: cut(&p.command, TEXT_CAP),
                tool: p.tool_name.clone(),
                tool_use_id: p.tool_use_id.clone(),
                state: if p.state == PermState::Pending {
                    "pending"
                } else {
                    "resolved"
                }
                .into(),
            });
        }
        ItemKind::Question(q) => {
            r.k = "question".into();
            r.question = Some(question(q));
        }
    }
    r
}

fn secs(a: &Date, b: &Date) -> f64 {
    (*a - *b).num_microseconds().unwrap_or(i64::MAX) as f64 / 1e6
}

/// The files a call edited: a Claude edit's path, or the paths of a Codex patch. A failed call edited nothing.
pub fn edited_files(call: &ToolCall) -> Vec<String> {
    if call.is_error {
        return vec![];
    }
    match call.tool_name.as_str() {
        "Edit" | "MultiEdit" | "NotebookEdit" | "Write" if !call.summary.is_empty() => {
            vec![call.summary.clone()]
        }
        tool => codex_patch_files(tool, &call.input),
    }
}

fn changed_row(id: &str, files: &[String]) -> FeedRow {
    let n = files.len();
    let text = format!("Changed {n} file{}", if n == 1 { "" } else { "s" });
    let mut r = FeedRow::new("changed", &format!("c-{id}"), Some(text), None);
    r.files = Some(files.to_vec());
    r
}

/// Rows with time separators, changed-files rows and turn footers ("01:41 · Worked 36s · 3 tools"). `tz`: the
/// calendar's time zone.
pub fn rows<Tz: TimeZone>(items: &[ConversationItem], now: &Date, tz: &Tz) -> Vec<FeedRow> {
    let mut out: Vec<FeedRow> = vec![];
    let mut prev_time: Option<Date> = None;
    let mut prev_row: Option<ConversationItem> = None;
    let mut turn = Turn::default();
    for it in merged(items) {
        if matches!(it.kind, ItemKind::UserText(_)) {
            turn.close(&mut out, &prev_row, tz);
            turn = Turn {
                start: it.timestamp.map(date),
                ..Turn::default()
            };
        }
        if let Some(t) = it.timestamp.map(date) {
            if let Some(p) = prev_time {
                if secs(&t, &p) >= SEPARATOR_GAP_S as f64 || !same_day(&t, &p, tz) {
                    out.push(FeedRow::new(
                        "sep",
                        &format!("s-{}", it.id),
                        Some(separator(&t, now, tz)),
                        None,
                    ));
                }
            }
            prev_time = Some(t);
            turn.end = Some(t);
        }
        if matches!(it.kind, ItemKind::AssistantText(_)) {
            turn.has_reply = true;
        }
        if let ItemKind::ToolChips(c) = &it.kind {
            turn.tools += c.iter().map(|x| x.calls.len().max(1)).sum::<usize>();
            for f in c.iter().flat_map(|x| &x.calls).flat_map(edited_files) {
                if !turn.files.contains(&f) {
                    turn.files.push(f);
                }
            }
        }
        out.push(row(&it));
        prev_row = Some(it);
    }
    turn.close(&mut out, &prev_row, tz);
    out
}

/// One agent turn: from a user message up to the next.
#[derive(Default)]
struct Turn {
    start: Option<Date>,
    end: Option<Date>,
    tools: usize,
    has_reply: bool,
    files: Vec<String>,
}

impl Turn {
    /// A turn with a reply ends with its changed-files row, if it edited files, and its footer.
    fn close<Tz: TimeZone>(
        &self,
        out: &mut Vec<FeedRow>,
        last: &Option<ConversationItem>,
        tz: &Tz,
    ) {
        let (true, Some(end), Some(last)) = (self.has_reply, self.end, last) else {
            return;
        };
        let mut parts = vec![clock(&end, tz)];
        if let Some(s) = self.start {
            let d = secs(&end, &s);
            if d >= 1.0 {
                parts.push(format!("Worked {}", duration(d)));
            }
        }
        if self.tools > 0 {
            parts.push(format!(
                "{} tool{}",
                self.tools,
                if self.tools == 1 { "" } else { "s" }
            ));
        }
        if !self.files.is_empty() {
            out.push(changed_row(&last.id, &self.files));
        }
        out.push(FeedRow::new(
            "footer",
            &format!("f-{}", last.id),
            Some(parts.join(" · ")),
            None,
        ));
    }
}

fn same_day<Tz: TimeZone>(a: &Date, b: &Date, tz: &Tz) -> bool {
    a.with_timezone(tz).date_naive() == b.with_timezone(tz).date_naive()
}

pub fn clock<Tz: TimeZone>(d: &Date, tz: &Tz) -> String {
    let l = d.with_timezone(tz);
    format!("{:02}:{:02}", l.hour(), l.minute())
}

/// Whole seconds, rounded half away from zero.
pub fn duration(s: f64) -> String {
    let n = s.round() as i64;
    if n >= 3600 {
        format!("{}h {}m", n / 3600, n % 3600 / 60)
    } else if n >= 60 {
        format!("{}m {}s", n / 60, n % 60)
    } else {
        format!("{n}s")
    }
}

pub fn separator<Tz: TimeZone>(d: &Date, now: &Date, tz: &Tz) -> String {
    let day = d.with_timezone(tz).date_naive();
    let today = now.with_timezone(tz).date_naive();
    if day == today {
        return clock(d, tz);
    }
    if today.checked_sub_signed(Duration::days(1)) == Some(day) {
        return format!("Yesterday {}", clock(d, tz));
    }
    // "EEE d MMM", en_US_POSIX.
    const WD: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const MO: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!(
        "{} {} {} {}",
        WD[day.weekday().num_days_from_monday() as usize],
        day.day(),
        MO[day.month0() as usize],
        clock(d, tz)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn ts(s: u32) -> String {
        format!("2026-11-06T20:00:{s:02}.000Z")
    }

    fn line(id: &str, t: u32, role: &str, content: &str) -> String {
        format!(
            r#"{{"type":"{role}","uuid":"{id}","timestamp":"{}","message":{{"role":"{role}","content":{content}}}}}"#,
            ts(t)
        )
    }

    fn call(id: &str, t: u32, call: &str, tool: &str, path: &str) -> String {
        let input =
            format!(r#"{{"file_path":"{path}","old_string":"a","new_string":"b","content":"c"}}"#);
        line(
            id,
            t,
            "assistant",
            &format!(r#"[{{"type":"tool_use","id":"{call}","name":"{tool}","input":{input}}}]"#),
        )
    }

    fn result(id: &str, t: u32, call: &str, error: bool) -> String {
        line(
            id,
            t,
            "user",
            &format!(
                r#"[{{"type":"tool_result","tool_use_id":"{call}","content":"done","is_error":{error}}}]"#
            ),
        )
    }

    fn say(id: &str, t: u32, text: &str) -> String {
        line(
            id,
            t,
            "assistant",
            &format!(r#"[{{"type":"text","text":"{text}"}}]"#),
        )
    }

    #[test]
    fn changed_row_lists_claude_edits_that_worked() {
        let lines = vec![
            line("u1", 0, "user", r#""Fix it""#),
            call("a1", 1, "c1", "Edit", "/w/a.rs"),
            result("r1", 2, "c1", false),
            call("a2", 3, "c2", "Write", "/w/b.rs"),
            result("r2", 4, "c2", false),
            call("a3", 5, "c3", "Edit", "/w/c.rs"),
            result("r3", 6, "c3", true),
            call("a4", 7, "c4", "MultiEdit", "/w/a.rs"),
            result("r4", 8, "c4", false),
            call("a5", 9, "c5", "Read", "/w/d.rs"),
            result("r5", 10, "c5", false),
            say("a6", 11, "Done."),
        ];
        let rs = rows(&super::super::tail::items(&lines), &Utc::now(), &Utc);
        let ks: Vec<&str> = rs.iter().map(|r| r.k.as_str()).collect();
        assert_eq!(ks, ["user", "tools", "assistant", "changed", "footer"]);
        let changed = &rs[3];
        assert_eq!(changed.text.as_deref(), Some("Changed 2 files"));
        assert_eq!(
            changed.files,
            Some(vec!["/w/a.rs".to_string(), "/w/b.rs".to_string()])
        );
        assert_eq!(changed.id, format!("c-{}", rs[2].id));
        let tools = &rs[1];
        assert_eq!(tools.error, Some(true), "the failed edit marks the row");
        assert_eq!(tools.live, Some(false));
        assert!(tools
            .sentence
            .as_deref()
            .unwrap()
            .contains(" and read a file"));
    }

    #[test]
    fn no_changed_row_without_a_reply() {
        let lines = vec![
            line("u1", 0, "user", r#""Fix it""#),
            call("a1", 1, "c1", "Edit", "/w/a.rs"),
            result("r1", 2, "c1", false),
        ];
        let rs = rows(&super::super::tail::items(&lines), &Utc::now(), &Utc);
        assert!(rs.iter().all(|r| r.k != "changed" && r.k != "footer"));
    }
}
