//! `bw diff patch`: one file's patch, as the section shows it, in pages under 4 MiB.

use std::path::Path;

use serde_json::json;

use super::{commit_of, digest, emit, fail, git_capped, place, Fail, DIFF_FLAGS};
use crate::chat::args::Args;

/// The most JSON-escaped text one page holds, leaving room for the line's other fields under 4 MiB.
pub const PAGE: usize = 4 * 1024 * 1024 - 64 * 1024;
/// A patch past this many bytes is not read at all.
pub const MAX_PATCH: usize = 256 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Staged,
    Changes,
    Committed,
}

pub fn section_of(s: &str) -> Result<Section, Fail> {
    match s {
        "staged" => Ok(Section::Staged),
        "changes" => Ok(Section::Changes),
        "committed" => Ok(Section::Committed),
        o => Err(fail(
            "usage",
            format!("a section is staged, changes or committed, not {o:?}"),
        )),
    }
}

/// Which patch to show: a file of a section, with a rename's old path and, for Committed, the range.
pub struct Spec {
    pub section: Section,
    pub file: String,
    pub old: Option<String>,
    pub untracked: bool,
    pub from: Option<String>,
    pub to: Option<String>,
}

/// The patch Git prints for `spec`, run in the worktree's top folder; `None` past `MAX_PATCH`.
pub fn patch_bytes(top: &Path, spec: &Spec) -> Result<Option<Vec<u8>>, Fail> {
    let mut args: Vec<&str> = vec!["diff"];
    args.extend(DIFF_FLAGS);
    let paths: Vec<&str> = spec
        .old
        .as_deref()
        .into_iter()
        .chain([spec.file.as_str()])
        .collect();
    match spec.section {
        Section::Staged => args.extend(["--cached", "-M", "--"]),
        Section::Changes if spec.untracked => {
            args.extend(["--no-index", "--", "/dev/null", spec.file.as_str()]);
            return git_capped(top, &args, MAX_PATCH);
        }
        Section::Changes => args.push("--"),
        Section::Committed => {
            let (Some(from), Some(to)) = (spec.from.as_deref(), spec.to.as_deref()) else {
                return Ok(Some(Vec::new()));
            };
            args.extend(["-M", from, to, "--"]);
        }
    }
    args.extend(paths);
    git_capped(top, &args, MAX_PATCH)
}

/// The size of `line` as a JSON string's contents.
fn escaped_len(line: &str) -> usize {
    serde_json::to_string(line).map_or(line.len(), |s| s.len() - 2)
}

/// A page: its text and the lines in it that were too large, each as (line within the page, bytes).
pub struct Page {
    pub text: String,
    pub cut: Vec<(usize, usize)>,
}

/// Splits a patch into pages of whole lines under `limit` escaped bytes. A line that alone passes the limit
/// keeps only its first byte (the `+`, `-` or space) and is listed in its page's `cut`.
pub fn pages(bytes: &[u8], limit: usize) -> Vec<Page> {
    let mut out = vec![Page {
        text: String::new(),
        cut: Vec::new(),
    }];
    let mut size = 0;
    let mut lines_in_page = 0;
    for raw in bytes.split_inclusive(|&b| b == b'\n') {
        let line = String::from_utf8_lossy(raw);
        let mut len = escaped_len(&line);
        let too_large = len > limit;
        if too_large {
            len = 4;
        }
        if lines_in_page > 0 && size + len > limit {
            out.push(Page {
                text: String::new(),
                cut: Vec::new(),
            });
            size = 0;
            lines_in_page = 0;
        }
        let page = out.last_mut().expect("one page at least");
        if too_large {
            page.cut.push((lines_in_page, raw.len()));
            page.text.push(char::from(raw[0]));
            if raw.ends_with(b"\n") {
                page.text.push('\n');
            }
        } else {
            page.text.push_str(&line);
        }
        size += len;
        lines_in_page += 1;
    }
    out
}

pub fn run(a: &Args) -> Result<(), Fail> {
    let path = a
        .get("path")
        .ok_or_else(|| fail("usage", "--path is required"))?;
    let section = section_of(
        a.get("section")
            .ok_or_else(|| fail("usage", "--section is required"))?,
    )?;
    let file = a
        .get("file")
        .ok_or_else(|| fail("usage", "--file is required"))?;
    let page: usize = match a.get("page") {
        None => 0,
        Some(n) => n
            .parse()
            .map_err(|_| fail("usage", format!("--page is a number, not {n:?}")))?,
    };
    let top = place(path)?.top;
    let mut spec = Spec {
        section,
        file: file.to_string(),
        old: a.get("old").map(str::to_string),
        untracked: a.has("untracked"),
        from: None,
        to: None,
    };
    if section == Section::Committed {
        for (name, slot) in [("from", &mut spec.from), ("to", &mut spec.to)] {
            let rev = a
                .get(name)
                .ok_or_else(|| fail("usage", "committed needs --from and --to"))?;
            *slot = Some(
                commit_of(&top, rev)?
                    .ok_or_else(|| fail("bad_ref", format!("--{name} {rev} is not a commit")))?,
            );
        }
    }
    let bytes = patch_bytes(&top, &spec)?.ok_or_else(|| {
        fail(
            "too_large",
            format!("the patch of {file} is over {} MiB", MAX_PATCH >> 20),
        )
    })?;
    let all = pages(&bytes, PAGE);
    let total = all.len();
    let p = all.into_iter().nth(page).ok_or_else(|| {
        fail(
            "no_page",
            format!("page {page} is past the patch's {total} pages"),
        )
    })?;
    emit(json!({
        "type": "diff-patch",
        "page": page,
        "pages": total,
        "bytes": bytes.len(),
        "digest": digest(&bytes),
        "text": p.text,
        "cut": p.cut.iter().map(|(line, b)| json!({"line": line, "bytes": b})).collect::<Vec<_>>(),
    }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_keep_whole_lines_under_the_limit() {
        let text = "aaaa\nbbbb\ncccc\n";
        let p = pages(text.as_bytes(), 10);
        assert_eq!(
            p.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(),
            ["aaaa\n", "bbbb\n", "cccc\n"]
        );
        let p = pages(text.as_bytes(), 1000);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].text, text);
    }

    #[test]
    fn a_line_past_the_limit_is_cut() {
        let long = format!("+{}\n", "x".repeat(50));
        let text = format!("@@ -0,0 +1 @@\n{long} ctx\n");
        let p = pages(text.as_bytes(), 20);
        let joined: String = p.iter().map(|p| p.text.as_str()).collect();
        assert_eq!(joined, "@@ -0,0 +1 @@\n+\n ctx\n");
        let cut: Vec<_> = p.iter().flat_map(|p| p.cut.clone()).collect();
        assert_eq!(cut, [(1, long.len())]);
    }

    #[test]
    fn escaping_counts_toward_the_limit() {
        // Each NUL escapes to six bytes, so three lines of two NULs need two pages at 30.
        let text = "\0\0\n\0\0\n\0\0\n";
        assert_eq!(pages(text.as_bytes(), 30).len(), 2);
    }

    #[test]
    fn empty_patch_is_one_empty_page() {
        let p = pages(b"", 10);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].text, "");
    }
}
