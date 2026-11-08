//! Options for the chat commands: `--name value` pairs and bare `--flag`s, each named once.

pub struct Args {
    values: Vec<(String, String)>,
    flags: Vec<String>,
}

/// `flags` and `options` are names without the leading `--`.
pub fn parse(args: &[String], flags: &[&str], options: &[&str]) -> Result<Args, String> {
    parse_free(args, flags, options, &["text"])
}

/// As `parse`, but each option in `free` takes any value, even one that looks like an option: a message
/// typed as written, or a path or ref that Git itself must check.
pub fn parse_free(
    args: &[String],
    flags: &[&str],
    options: &[&str],
    free: &[&str],
) -> Result<Args, String> {
    let mut out = Args {
        values: Vec::new(),
        flags: Vec::new(),
    };
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let name = arg
            .strip_prefix("--")
            .ok_or_else(|| format!("unexpected argument {arg:?}"))?;
        if out.has(name) || out.get(name).is_some() {
            return Err(format!("--{name} is given twice"));
        }
        if flags.contains(&name) {
            out.flags.push(name.to_string());
            continue;
        }
        if !options.contains(&name) {
            return Err(format!("unknown option {arg:?}"));
        }
        let value = it.next().ok_or_else(|| format!("--{name} needs a value"))?;
        if !free.contains(&name) && (value.is_empty() || value.starts_with('-')) {
            return Err(format!("--{name} needs a value, not {value:?}"));
        }
        out.values.push((name.to_string(), value.clone()));
    }
    Ok(out)
}

impl Args {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    pub fn has(&self, flag: &str) -> bool {
        self.flags.iter().any(|f| f == flag)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn options_and_flags() {
        let a = parse(
            &s(&["--log", "/a.jsonl", "--pictures", "--agent", "codex"]),
            &["pictures"],
            &["log", "agent", "cursor"],
        )
        .unwrap();
        assert_eq!(a.get("log"), Some("/a.jsonl"));
        assert_eq!(a.get("agent"), Some("codex"));
        assert_eq!(a.get("cursor"), None);
        assert!(a.has("pictures"));
        assert!(!parse(&s(&[]), &["pictures"], &[]).unwrap().has("pictures"));
    }

    #[test]
    fn text_value_may_start_with_dash() {
        for text in ["--force -x", "-", "", "line one\nline two", "--text"] {
            let a = parse(
                &s(&["--text", text, "--terminal", "t1"]),
                &[],
                &["text", "terminal"],
            )
            .unwrap();
            assert_eq!(a.get("text"), Some(text));
            assert_eq!(a.get("terminal"), Some("t1"));
        }
    }

    #[test]
    fn other_value_may_not() {
        let opts = &["terminal", "text"];
        assert!(parse(&s(&["--terminal", "--text", "hi"]), &[], opts).is_err());
        assert!(parse(&s(&["--terminal", "-x"]), &[], opts).is_err());
        assert!(parse(&s(&["--terminal", ""]), &[], opts).is_err());
        assert!(parse(&s(&["--terminal"]), &[], opts).is_err());
        assert!(parse(&s(&["--text"]), &[], opts).is_err());
    }

    #[test]
    fn free_value_may_start_with_dash() {
        let a = parse_free(
            &s(&["--base", "--output=x", "--path", "/w"]),
            &[],
            &["base", "path"],
            &["base"],
        )
        .unwrap();
        assert_eq!(a.get("base"), Some("--output=x"));
        assert!(parse_free(&s(&["--path", "-x"]), &[], &["path"], &["base"]).is_err());
    }

    #[test]
    fn unknown_option_is_refused() {
        assert!(parse(&s(&["--force"]), &["pictures"], &["text"]).is_err());
        assert!(parse(&s(&["--text=hi"]), &[], &["text"]).is_err());
        assert!(parse(&s(&["stray"]), &[], &["text"]).is_err());
    }

    #[test]
    fn repeated_option_is_refused() {
        assert!(parse(&s(&["--log", "/a", "--log", "/b"]), &[], &["log"]).is_err());
        assert!(parse(&s(&["--pictures", "--pictures"]), &["pictures"], &[]).is_err());
    }
}
