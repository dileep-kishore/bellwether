//! Where an agent process keeps its logs: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` from its own environment, then from
//! `bw`'s, then `~/.claude` and `~/.codex`.
//!
//! macOS 27 no longer shows another process's environment (`ps -E` and `KERN_PROCARGS2` give argv only), so there
//! a Codex home is also read from the rollouts the agent holds open; Claude holds nothing in its folder open.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The value of the last whitespace-separated `KEY=` word of a `ps -E` line, where the environment follows the
/// command. A value holding spaces is not supported: only its first word is read.
pub fn env_value(ps_line: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    ps_line
        .split_whitespace()
        .rev()
        .find_map(|w| w.strip_prefix(&prefix))
        .map(String::from)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentDirs {
    pub claude_config: PathBuf,
    pub codex_home: PathBuf,
}

impl AgentDirs {
    /// `<config>/sessions`, where Claude writes `<pid>.json`.
    pub fn claude_sessions(&self) -> PathBuf {
        self.claude_config.join("sessions")
    }

    pub fn claude_projects(&self) -> PathBuf {
        self.claude_config.join("projects")
    }

    pub fn codex_sessions(&self) -> PathBuf {
        self.codex_home.join("sessions")
    }
}

/// An empty or relative value is skipped, since the agent would not have read it as a folder either.
fn first_dir(candidates: [Option<String>; 2], fallback: PathBuf) -> PathBuf {
    candidates
        .into_iter()
        .flatten()
        .find(|v| v.starts_with('/'))
        .map(PathBuf::from)
        .unwrap_or(fallback)
}

pub fn agent_dirs(ps_line: &str, own_env: &HashMap<String, String>, home: &Path) -> AgentDirs {
    let pick = |key: &str, default: &str| {
        first_dir(
            [env_value(ps_line, key), own_env.get(key).cloned()],
            home.join(default),
        )
    };
    AgentDirs {
        claude_config: pick("CLAUDE_CONFIG_DIR", ".claude"),
        codex_home: pick("CODEX_HOME", ".codex"),
    }
}

fn is_digits(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit())
}

/// The `<home>` of open `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl` files, when they all name the same one.
pub fn codex_home_of_open(open_files: &[String]) -> Option<PathBuf> {
    let mut homes = open_files.iter().filter_map(|f| {
        let p = Path::new(f);
        let name = p.file_name()?.to_str()?;
        if !name.starts_with("rollout-") || !name.ends_with(".jsonl") || f.contains("/../") {
            return None;
        }
        let day = p.parent()?;
        let month = day.parent()?;
        let year = month.parent()?;
        let sessions = year.parent()?;
        let part = |q: &Path| {
            q.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string()
        };
        let dated =
            is_digits(&part(day), 2) && is_digits(&part(month), 2) && is_digits(&part(year), 4);
        (dated && part(sessions) == "sessions").then(|| sessions.parent().map(Path::to_path_buf))?
    });
    let first = homes.next()?;
    homes.all(|h| h == first).then_some(first)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn env_value_takes_the_last_word() {
        let line = "node /x/codex --arg CODEX_HOME=/fake CODEX_HOME=/s/ch PATH=/bin";
        assert_eq!(env_value(line, "CODEX_HOME").as_deref(), Some("/s/ch"));
        assert_eq!(env_value(line, "PATH").as_deref(), Some("/bin"));
        assert_eq!(env_value(line, "HOME"), None);
        assert_eq!(env_value("x XCODEX_HOME=/no", "CODEX_HOME"), None);
    }

    #[test]
    fn codex_home_from_agent_env() {
        let home = Path::new("/home/u");
        assert_eq!(
            agent_dirs("node /x/codex CODEX_HOME=/s/ch PATH=/bin", &env(&[]), home).codex_home,
            PathBuf::from("/s/ch")
        );
    }

    #[test]
    fn codex_home_from_open_rollouts() {
        let open = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let parent = "/s/ch/sessions/2026/11/06/rollout-2026-11-06T22-11-05-a.jsonl";
        let child = "/s/ch/sessions/2026/11/06/rollout-2026-11-06T22-11-09-b.jsonl";
        assert_eq!(
            codex_home_of_open(&open(&[
                "/dev/null",
                parent,
                child,
                "/s/ch/log/codex-tui.log"
            ])),
            Some(PathBuf::from("/s/ch"))
        );
        let other = "/t/sessions/2026/11/06/rollout-2026-11-06T22-11-09-c.jsonl";
        assert_eq!(
            codex_home_of_open(&open(&[parent, other])),
            None,
            "two homes name none"
        );
        assert_eq!(
            codex_home_of_open(&open(&["/s/ch/sessions/x/rollout-a.jsonl"])),
            None
        );
        assert_eq!(
            codex_home_of_open(&open(&["/s/ch/archive/2026/11/06/rollout-a.jsonl"])),
            None
        );
        assert_eq!(codex_home_of_open(&[]), None);
    }

    #[test]
    fn agent_env_then_own_env_then_home() {
        let home = Path::new("/home/u");
        let own = env(&[
            ("CLAUDE_CONFIG_DIR", "/own/claude"),
            ("CODEX_HOME", "/own/codex"),
        ]);
        let d = agent_dirs("claude CLAUDE_CONFIG_DIR=/agent/claude", &own, home);
        assert_eq!(d.claude_config, PathBuf::from("/agent/claude"));
        assert_eq!(d.codex_home, PathBuf::from("/own/codex"));
        let d = agent_dirs("claude CLAUDE_CONFIG_DIR= CODEX_HOME=rel", &env(&[]), home);
        assert_eq!(d.claude_config, PathBuf::from("/home/u/.claude"));
        assert_eq!(d.codex_home, PathBuf::from("/home/u/.codex"));
        assert_eq!(
            d.claude_sessions(),
            PathBuf::from("/home/u/.claude/sessions")
        );
        assert_eq!(
            d.claude_projects(),
            PathBuf::from("/home/u/.claude/projects")
        );
        assert_eq!(d.codex_sessions(), PathBuf::from("/home/u/.codex/sessions"));
    }
}
