//! `bw linear projects|issues|issue|search`: the Issues panel's reads of Linear, run on the window machine.
//! Every request goes through `client::post`, which reads the key itself; nothing here prints it.

use std::process::ExitCode;

use serde_json::{json, Value};

use crate::chat::args;

pub mod cache;
pub mod client;
pub mod query;

use query::Scope;

/// A description longer than this is trimmed or sent as a file (design spec, Issues).
pub const TEXT_LIMIT: usize = 8 * 1024;
/// Pages of projects read for the link picker; 250 projects is far past a personal workspace.
const PROJECT_PAGES: usize = 5;

#[derive(Debug)]
pub struct Fail {
    pub code: &'static str,
    pub message: String,
}

pub fn fail(code: &'static str, message: impl Into<String>) -> Fail {
    Fail {
        code,
        message: message.into(),
    }
}

const USAGE: &str = "usage: bw linear projects | bw linear issues --scope project|mine|all [--project <id>] \
    [--after <cursor>] | bw linear search --text <words> --scope … [--project <id>] [--after <cursor>] \
    | bw linear issue --id <identifier> [--text [--trim | --put <terminal>]]";

pub fn run(argv: &[String]) -> ExitCode {
    let (cmd, rest) = match argv.split_first() {
        Some((c, r)) => (c.as_str(), r),
        None => return crate::usage(USAGE),
    };
    let result = match cmd {
        "projects" => args::parse_free(rest, &[], &[], &[])
            .map_err(|e| fail("usage", e))
            .and_then(|_| projects()),
        "issues" => args::parse_free(rest, &[], &["scope", "project", "after"], &["after"])
            .map_err(|e| fail("usage", e))
            .and_then(|a| list(&a, None)),
        "search" => args::parse_free(
            rest,
            &[],
            &["text", "scope", "project", "after"],
            &["text", "after"],
        )
        .map_err(|e| fail("usage", e))
        .and_then(|a| {
            let text = a.get("text").unwrap_or("").trim().to_string();
            if text.is_empty() {
                return Err(fail("usage", "--text is empty"));
            }
            list(&a, Some(&text))
        }),
        "issue" => args::parse_free(rest, &["text", "trim"], &["id", "put"], &["put"])
            .map_err(|e| fail("usage", e))
            .and_then(|a| issue(&a)),
        other => Err(fail("usage", format!("unknown linear command {other:?}"))),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(f) if f.code == "usage" => crate::usage(&format!("{}; {USAGE}", f.message)),
        Err(f) => crate::chat::error(f.code, &f.message),
    }
}

/// The answer to `body`, from Linear or, when Linear cannot be reached, from the cache with its time.
fn read(body: &Value) -> Result<(Value, Option<i64>), Fail> {
    match client::post(body) {
        Ok(data) => {
            cache::store(body, &data);
            Ok((data, None))
        }
        Err(f) if f.code == "offline" => match cache::load(body) {
            Some((data, at)) => Ok((data, Some(at))),
            None => Err(fail(
                "offline",
                format!("{} (nothing cached for this list)", f.message),
            )),
        },
        Err(f) => Err(f),
    }
}

/// `cached` and `age_s` for an answer read at `at` (None: just now from Linear).
fn freshness(at: Option<i64>) -> (bool, Value) {
    match at {
        None => (false, Value::Null),
        Some(at) => (true, json!(((cache::now_ms() - at) / 1000).max(0))),
    }
}

fn projects() -> Result<(), Fail> {
    let mut after: Option<String> = None;
    let mut oldest: Option<i64> = None;
    let mut lines = Vec::new();
    for _ in 0..PROJECT_PAGES {
        let (data, at) = read(&query::projects(after.as_deref()))?;
        if let Some(at) = at {
            oldest = Some(oldest.map_or(at, |o: i64| o.min(at)));
        }
        let conn = &data["projects"];
        lines.extend(
            conn["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .map(query::project_line),
        );
        if conn["pageInfo"]["hasNextPage"].as_bool() != Some(true) {
            break;
        }
        after = conn["pageInfo"]["endCursor"].as_str().map(String::from);
        if after.is_none() {
            break;
        }
    }
    for l in lines {
        println!("{l}");
    }
    let (cached, age) = freshness(oldest);
    println!(
        "{}",
        json!({"type": "linear-done", "at": cache::now_ms(), "cached": cached, "age_s": age})
    );
    Ok(())
}

fn list(a: &args::Args, text: Option<&str>) -> Result<(), Fail> {
    let scope = a
        .get("scope")
        .and_then(Scope::parse)
        .ok_or_else(|| fail("usage", "--scope must be project, mine or all"))?;
    let project = a.get("project");
    if scope == Scope::Project && project.is_none_or(str::is_empty) {
        return Err(fail("usage", "--scope project needs --project <id>"));
    }
    let filter = query::filter(scope, project);
    let after = a.get("after").filter(|s| !s.is_empty());
    let (body, field) = match text {
        Some(t) => (query::search(t, filter, after), "searchIssues"),
        None => (query::issues(filter, after), "issues"),
    };
    let (data, at) = read(&body)?;
    let conn = &data[field];
    for n in conn["nodes"].as_array().into_iter().flatten() {
        let state = n["state"]["type"].as_str().unwrap_or("");
        // searchIssues may rank a closed issue in; the list shows open ones only.
        if query::CLOSED.contains(&state) {
            continue;
        }
        println!("{}", query::issue_line(n));
    }
    let next = if conn["pageInfo"]["hasNextPage"].as_bool() == Some(true) {
        conn["pageInfo"]["endCursor"].clone()
    } else {
        Value::Null
    };
    let (cached, age) = freshness(at);
    println!(
        "{}",
        json!({"type": "linear-page", "next": next, "at": cache::now_ms(), "cached": cached, "age_s": age})
    );
    Ok(())
}

fn issue(a: &args::Args) -> Result<(), Fail> {
    let id = a
        .get("id")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| fail("usage", "--id is required"))?;
    let (data, at) = read(&query::issue(id))?;
    let n = &data["issue"];
    if !n.is_object() {
        return Err(fail("not_found", format!("Linear has no issue {id}")));
    }
    let description = n["description"].as_str().unwrap_or("").to_string();
    if !a.has("text") {
        if a.has("trim") || a.get("put").is_some() {
            return Err(fail("usage", "--trim and --put go with --text"));
        }
        let mut line = query::issue_line(n);
        line["bytes"] = json!(description.len());
        line["description"] = json!(description);
        let (cached, age) = freshness(at);
        line["cached"] = json!(cached);
        line["age_s"] = age;
        println!("{line}");
        return Ok(());
    }
    if a.has("trim") && a.get("put").is_some() {
        return Err(fail("usage", "--trim and --put cannot both be given"));
    }
    let identifier = n["identifier"].as_str().unwrap_or(id);
    let title = n["title"].as_str().unwrap_or("");
    let url = n["url"].as_str().unwrap_or("");
    let bytes = description.len();
    let (mode, block, path) = if let Some(address) = a.get("put") {
        let landed = put(address, identifier, &description)?;
        (
            "file",
            format!("The description ({}) is in {landed}", size_text(bytes)),
            Some(landed),
        )
    } else if bytes > TEXT_LIMIT && a.has("trim") {
        (
            "trim",
            format!(
                "{}\n[Trimmed to 8 KB; the full description is at the link above.]",
                trim_to(&description, TEXT_LIMIT)
            ),
            None,
        )
    } else if bytes > TEXT_LIMIT {
        return Err(fail(
            "too_large",
            format!(
                "{identifier}'s description is {}: trim it or send it as a file",
                size_text(bytes)
            ),
        ));
    } else {
        ("full", description.trim_end().to_string(), None)
    };
    let text = issue_text(identifier, title, url, &block);
    println!(
        "{}",
        json!({"type": "linear-text", "identifier": identifier, "text": text, "bytes": bytes, "mode": mode, "path": path})
    );
    Ok(())
}

/// The text that goes ahead of the user's message: the heading line, the URL, the description and `---`.
pub fn issue_text(identifier: &str, title: &str, url: &str, description: &str) -> String {
    let mut s = format!("Linear issue {identifier}: {title}\n{url}\n");
    if !description.trim().is_empty() {
        s.push('\n');
        s.push_str(description.trim_end());
        s.push('\n');
    }
    s.push_str("---\n");
    s
}

/// At most `limit` bytes of `s`, cut at a line end when one is in the last quarter, else at a character.
pub fn trim_to(s: &str, limit: usize) -> &str {
    if s.len() <= limit {
        return s;
    }
    let mut end = limit;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    match s[..end].rfind('\n') {
        Some(i) if i >= limit * 3 / 4 => &s[..i],
        _ => &s[..end],
    }
}

pub fn size_text(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes} bytes")
    } else {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    }
}

/// Writes the description to a file here and sends it beside `address` with `hc put`; returns where it
/// landed on that terminal's machine.
fn put(address: &str, identifier: &str, description: &str) -> Result<String, Fail> {
    if !identifier
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(fail(
            "linear_failed",
            format!("{identifier:?} is not an issue identifier"),
        ));
    }
    let dir = cache::dir().join("attach");
    std::fs::create_dir_all(&dir).map_err(|e| {
        fail(
            "linear_failed",
            format!("could not make {}: {e}", dir.display()),
        )
    })?;
    let file = dir.join(format!("{identifier}-description.md"));
    std::fs::write(&file, description).map_err(|e| {
        fail(
            "linear_failed",
            format!("could not write {}: {e}", file.display()),
        )
    })?;
    let path = file.to_string_lossy().to_string();
    let v = crate::hc::hc_json(&["put", "--json", "--", address, &path])
        .map_err(|e| fail("put_failed", format!("hc put {address} failed: {e}")))?;
    ["path", "landed", "dest", "to"]
        .iter()
        .find_map(|k| v[*k].as_str())
        .or_else(|| v.as_str())
        .map(String::from)
        .ok_or_else(|| fail("put_failed", "hc put did not say where the file landed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_has_heading_url_description_and_rule() {
        assert_eq!(
            issue_text("PLA-1", "T", "https://u", "d\n"),
            "Linear issue PLA-1: T\nhttps://u\n\nd\n---\n"
        );
        assert_eq!(
            issue_text("PLA-1", "T", "https://u", ""),
            "Linear issue PLA-1: T\nhttps://u\n---\n"
        );
    }

    #[test]
    fn trim_keeps_characters_whole() {
        let s = "é".repeat(5000);
        let t = trim_to(&s, TEXT_LIMIT);
        assert!(t.len() <= TEXT_LIMIT);
        assert!(t.chars().all(|c| c == 'é'));
        let lines = "abcdefghi\n".repeat(1000);
        let t = trim_to(&lines, TEXT_LIMIT);
        assert!(t.len() <= TEXT_LIMIT && t.ends_with('i'));
    }
}
