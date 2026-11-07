use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn main() {
    let build = git(&["rev-parse", "--short=12", "HEAD"])
        .filter(|s| s.len() == 12 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=BW_BUILD={build}");
    println!(
        "cargo:rustc-env=BW_TARGET={}",
        std::env::var("TARGET").unwrap_or_default()
    );

    println!("cargo:rerun-if-changed=../../.git/HEAD");
    // A commit moves the branch ref, not HEAD, and in a worktree .git is a file, so ask git for both paths.
    let mut watch = vec![git(&["rev-parse", "--git-path", "HEAD"])];
    if let Some(head_ref) = git(&["symbolic-ref", "-q", "HEAD"]) {
        watch.push(git(&["rev-parse", "--git-path", &head_ref]));
    }
    for path in watch.into_iter().flatten() {
        println!("cargo:rerun-if-changed={path}");
    }
}
