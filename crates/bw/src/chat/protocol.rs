//! JSON lines for the chat commands, one object per line, with no header or end line.
//!
//! Adapted from Flockbook's xplat/flockbook-modfeed/src/protocol.rs (MIT, Copyright (c) 2026 Min-Chen Lee).

use serde::Serialize;
use serde_json::Value;

/// Collects output lines; `text` prints them. Keys come out sorted (serde_json's map is ordered by key) and
/// slashes unescaped.
#[derive(Default, Debug)]
pub struct JsonLines {
    pub lines: Vec<String>,
}

impl JsonLines {
    pub fn new() -> JsonLines {
        JsonLines::default()
    }

    /// Any serializable value; a struct leaves out fields marked `skip_serializing_if`.
    pub fn emit<T: Serialize>(&mut self, value: &T) {
        if let Ok(v) = serde_json::to_value(value) {
            self.lines.push(v.to_string());
        }
    }

    /// An object; `Value::Null` fields stay.
    pub fn emit_value(&mut self, v: Value) {
        self.lines.push(v.to_string());
    }

    /// A line that is already JSON.
    pub fn raw(&mut self, line: String) {
        self.lines.push(line);
    }

    pub fn text(&self) -> String {
        self.lines.iter().map(|l| format!("{l}\n")).collect()
    }
}

/// A stable 64-bit FNV-1a hash, lowercase hex without leading zeros, as Flockbook's cursors spell it.
pub fn fnv1a(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorted_keys_and_slashes() {
        let mut o = JsonLines::new();
        o.emit_value(json!({"type": "log", "path": "/a/b", "agent": "claude", "x": null}));
        assert_eq!(
            o.lines[0],
            r#"{"agent":"claude","path":"/a/b","type":"log","x":null}"#
        );
        assert_eq!(fnv1a(""), "cbf29ce484222325");
        assert_eq!(fnv1a("a"), "af63dc4c8601ec8c");
    }

    #[test]
    fn text_ends_every_line() {
        let mut o = JsonLines::new();
        o.raw(r#"{"type":"unchanged"}"#.into());
        o.emit(&json!({"b": 1, "a": 2}));
        assert_eq!(o.text(), "{\"type\":\"unchanged\"}\n{\"a\":2,\"b\":1}\n");
    }
}
