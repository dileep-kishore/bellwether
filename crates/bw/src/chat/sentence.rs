//! One sentence for a tools row, from its chips' counted texts ("Read 3 files", "Ran 2 commands").

/// One text as it is, two as "A and b", more as "A, b and c"; each text after the first starts lower case.
/// Empty texts are left out.
pub fn join(texts: &[String]) -> String {
    let parts: Vec<String> = texts
        .iter()
        .filter(|t| !t.is_empty())
        .enumerate()
        .map(|(i, t)| if i == 0 { t.clone() } else { lower_first(t) })
        .collect();
    match parts.as_slice() {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

fn lower_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s<const N: usize>(v: [&str; N]) -> Vec<String> {
        v.iter().map(|t| t.to_string()).collect()
    }

    #[test]
    fn sentence_join_rules() {
        assert_eq!(join(&s([])), "");
        assert_eq!(join(&s(["Ran a command"])), "Ran a command");
        assert_eq!(
            join(&s(["Read 3 files", "Ran 2 commands"])),
            "Read 3 files and ran 2 commands"
        );
        assert_eq!(
            join(&s([
                "Read a file",
                "Searched the code 2 times",
                "Ran a command"
            ])),
            "Read a file, searched the code 2 times and ran a command"
        );
        assert_eq!(
            join(&s(["Edited files", "Éditer", ""])),
            "Edited files and éditer"
        );
    }
}
