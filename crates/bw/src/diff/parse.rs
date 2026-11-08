//! Parsers for Git's `-z` output: `diff --raw --numstat -z` and `status --porcelain=v2 -z`.

use std::collections::HashMap;

/// One file of a `diff --raw` listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEntry {
    /// Git's status letter: M, A, D, R, C, T, U or X.
    pub status: char,
    pub path: String,
    /// The source of a rename or copy.
    pub old_path: Option<String>,
}

/// Lines added and removed, or `None` for a binary file (numstat prints `-`).
pub type Counts = Option<(u64, u64)>;

/// Reads `git diff --raw --numstat -z`: the raw records, then the numstat records, keyed by new path.
pub fn raw_numstat(out: &[u8]) -> (Vec<RawEntry>, HashMap<String, Counts>) {
    let text = String::from_utf8_lossy(out);
    let mut tokens = text.split('\0').peekable();
    let mut raw = Vec::new();
    let mut counts = HashMap::new();
    while let Some(tok) = tokens.next() {
        if tok.is_empty() {
            continue;
        }
        if let Some(meta) = tok.strip_prefix(':') {
            let status = meta
                .rsplit(' ')
                .next()
                .and_then(|s| s.chars().next())
                .unwrap_or('M');
            let first = tokens.next().unwrap_or("").to_string();
            let (path, old_path) = if status == 'R' || status == 'C' {
                (tokens.next().unwrap_or("").to_string(), Some(first))
            } else {
                (first, None)
            };
            raw.push(RawEntry {
                status,
                path,
                old_path,
            });
            continue;
        }
        let mut parts = tok.splitn(3, '\t');
        let (a, r, p) = (parts.next(), parts.next(), parts.next());
        let (Some(a), Some(r), Some(p)) = (a, r, p) else {
            continue;
        };
        // A rename's numstat leaves the path empty and names old and new in the next two tokens.
        let path = if p.is_empty() {
            tokens.next();
            tokens.next().unwrap_or("").to_string()
        } else {
            p.to_string()
        };
        let c = match (a.parse::<u64>(), r.parse::<u64>()) {
            (Ok(a), Ok(r)) => Some((a, r)),
            _ => None,
        };
        counts.insert(path, c);
    }
    (raw, counts)
}

/// One entry of `git status --porcelain=v2 -z`, as the Changes section needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatusEntry {
    /// A tracked file; `worktree` is the Y column (`.` when the worktree matches the index).
    Tracked {
        worktree: char,
        path: String,
    },
    Unmerged {
        path: String,
    },
    Untracked {
        path: String,
    },
}

/// The status entries and the `# branch.oid` and `# branch.head` headers (`None` for an unborn HEAD or a
/// detached one).
pub struct Status {
    pub entries: Vec<StatusEntry>,
    pub oid: Option<String>,
    pub head: Option<String>,
}

pub fn status_v2(out: &[u8]) -> Status {
    let text = String::from_utf8_lossy(out);
    let mut tokens = text.split('\0');
    let mut s = Status {
        entries: Vec::new(),
        oid: None,
        head: None,
    };
    while let Some(tok) = tokens.next() {
        if let Some(h) = tok.strip_prefix("# branch.oid ") {
            s.oid = (h != "(initial)").then(|| h.to_string());
        } else if let Some(h) = tok.strip_prefix("# branch.head ") {
            s.head = (h != "(detached)").then(|| h.to_string());
        } else if let Some(rest) = tok.strip_prefix("1 ") {
            // XY sub mH mI mW hH hI path
            let f: Vec<&str> = rest.splitn(8, ' ').collect();
            if f.len() == 8 {
                s.entries.push(StatusEntry::Tracked {
                    worktree: f[0].chars().nth(1).unwrap_or('.'),
                    path: f[7].to_string(),
                });
            }
        } else if let Some(rest) = tok.strip_prefix("2 ") {
            // XY sub mH mI mW hH hI Xscore path, then the original path as its own token.
            let f: Vec<&str> = rest.splitn(9, ' ').collect();
            tokens.next();
            if f.len() == 9 {
                s.entries.push(StatusEntry::Tracked {
                    worktree: f[0].chars().nth(1).unwrap_or('.'),
                    path: f[8].to_string(),
                });
            }
        } else if let Some(rest) = tok.strip_prefix("u ") {
            // XY sub m1 m2 m3 mW h1 h2 h3 path
            let f: Vec<&str> = rest.splitn(10, ' ').collect();
            if f.len() == 10 {
                s.entries.push(StatusEntry::Unmerged {
                    path: f[9].to_string(),
                });
            }
        } else if let Some(p) = tok.strip_prefix("? ") {
            s.entries.push(StatusEntry::Untracked {
                path: p.to_string(),
            });
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_numstat_reads_renames_binaries_and_odd_paths() {
        let out = b":100644 100644 f687187 4fa3796 M\0mark.tc\0:100644 100644 0fdf397 0fdf397 R100\0old name.txt\0new\tname.txt\0:100644 100644 99639a9 3df8115 M\0pic.bin\0:000000 100644 0000000 1111111 A\0-dash.txt\0\
1\t0\tmark.tc\0\
0\t0\t\0old name.txt\0new\tname.txt\0\
-\t-\tpic.bin\0\
2\t0\t-dash.txt\0";
        let (raw, counts) = raw_numstat(out);
        assert_eq!(
            raw,
            vec![
                RawEntry {
                    status: 'M',
                    path: "mark.tc".into(),
                    old_path: None
                },
                RawEntry {
                    status: 'R',
                    path: "new\tname.txt".into(),
                    old_path: Some("old name.txt".into())
                },
                RawEntry {
                    status: 'M',
                    path: "pic.bin".into(),
                    old_path: None
                },
                RawEntry {
                    status: 'A',
                    path: "-dash.txt".into(),
                    old_path: None
                },
            ]
        );
        assert_eq!(counts["mark.tc"], Some((1, 0)));
        assert_eq!(counts["new\tname.txt"], Some((0, 0)));
        assert_eq!(counts["pic.bin"], None);
        assert_eq!(counts["-dash.txt"], Some((2, 0)));
    }

    #[test]
    fn status_v2_reads_branch_tracked_unmerged_and_untracked() {
        let out = b"# branch.oid 9c6652cb\0# branch.head feat\0\
1 .M N... 100644 100644 100644 a2544f7 a2544f7 dash -name.txt\0\
1 M. N... 100644 100644 100644 f687187 4fa3796 mark.tc\0\
2 R. N... 100644 100644 100644 0fdf397 0fdf397 R100 new.txt\0old.txt\0\
u UU N... 100644 100644 100644 100644 aaa bbb ccc both.txt\0\
? fresh file.txt\0";
        let s = status_v2(out);
        assert_eq!(s.oid.as_deref(), Some("9c6652cb"));
        assert_eq!(s.head.as_deref(), Some("feat"));
        assert_eq!(
            s.entries,
            vec![
                StatusEntry::Tracked {
                    worktree: 'M',
                    path: "dash -name.txt".into()
                },
                StatusEntry::Tracked {
                    worktree: '.',
                    path: "mark.tc".into()
                },
                StatusEntry::Tracked {
                    worktree: '.',
                    path: "new.txt".into()
                },
                StatusEntry::Unmerged {
                    path: "both.txt".into()
                },
                StatusEntry::Untracked {
                    path: "fresh file.txt".into()
                },
            ]
        );
    }

    #[test]
    fn status_v2_unborn_and_detached() {
        let s = status_v2(b"# branch.oid (initial)\0# branch.head main\0");
        assert_eq!((s.oid, s.head.as_deref()), (None, Some("main")));
        let s = status_v2(b"# branch.oid abc\0# branch.head (detached)\0");
        assert_eq!((s.oid.as_deref(), s.head), (Some("abc"), None));
    }
}
