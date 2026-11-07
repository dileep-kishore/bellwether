//! `HcScreen`: the vendored `PaneScreen` over the `hc` CLI, for one terminal on this machine, so the vendored
//! approval and question code reads and answers it as Flockbook's does over hc's socket.

use std::ffi::OsString;
use std::time::Duration;

use herdr_core::hc::{keys, mapper};
use herdr_core::{BackendKind, HerdrError, PaneScreen, Workspace};

use crate::hc::{self, HcError};

pub struct HcScreen {
    /// The terminal's address on this machine (`t5`), as `bw answer` takes it.
    pub address: String,
    /// How long one `hc keys` or `hc send` may take before it counts as timed out.
    pub keys_timeout: Duration,
    /// The hc program: `BW_HC`, else `hc`.
    pub program: OsString,
    /// `BW_NO_PAUSE=1`: no sleep between screen polls, for tests.
    pub no_pause: bool,
}

impl HcScreen {
    pub fn new(address: &str, keys_timeout: Duration) -> HcScreen {
        HcScreen {
            address: address.to_string(),
            keys_timeout,
            program: hc::program(),
            no_pause: std::env::var("BW_NO_PAUSE").is_ok_and(|v| v == "1"),
        }
    }

    /// The address a pane id names, only when it is this screen's own terminal, so no key reaches another one.
    fn own(&self, pane_id: &str) -> Result<&str, HerdrError> {
        let named = mapper::address_from_pane_id(pane_id);
        if named.as_deref().unwrap_or(pane_id) == self.address {
            Ok(&self.address)
        } else {
            Err(HerdrError::Protocol(format!(
                "pane {pane_id} is not terminal {}",
                self.address
            )))
        }
    }

    fn keys(&self, pane_id: &str, names: &[String]) -> Result<(), HerdrError> {
        let address = self.own(pane_id)?;
        if names.is_empty() {
            return Ok(());
        }
        let names: Vec<&str> = names.iter().map(String::as_str).collect();
        hc::hc_keys_with(&self.program, address, &names, self.keys_timeout)
            .map(drop)
            .map_err(herdr_error)
    }
}

/// hc's failures in the vendored error type; a timeout keeps its meaning that the keys may still land.
pub fn herdr_error(e: HcError) -> HerdrError {
    match e {
        HcError::Refused { kind, message } => HerdrError::Server {
            code: kind,
            message,
        },
        HcError::TimedOut => HerdrError::Timeout(e.to_string()),
        HcError::Unreachable(m) | HcError::NoProgram(m) => HerdrError::Socket(m),
        HcError::Failed(m) => HerdrError::Protocol(m),
    }
}

impl PaneScreen for HcScreen {
    fn backend(&self) -> BackendKind {
        BackendKind::Hc
    }

    /// One workspace, one tab and this terminal's pane, mapped from `hc get` as `bw locate` maps it.
    fn snapshot(&self) -> Result<Vec<Workspace>, HerdrError> {
        let term = hc::hc_get_with(&self.program, &self.address).map_err(herdr_error)?;
        Ok(mapper::workspaces(std::slice::from_ref(&term)))
    }

    fn visible_text(&self, pane_id: &str) -> Result<String, HerdrError> {
        let address = self.own(pane_id)?;
        hc::hc_read_with(&self.program, address).map_err(herdr_error)
    }

    /// Unused: `bw answer` presses the keys its matcher names for each action.
    fn respond(&self, _pane_id: &str, _allow: bool) -> Result<(), HerdrError> {
        Err(HerdrError::Protocol(
            "bw presses an action's own keys; respond is not used".into(),
        ))
    }

    fn send_named_keys(&self, names: &[String], pane_id: &str) -> Result<(), HerdrError> {
        let names: Vec<String> = names.iter().map(|k| keys::translate(k)).collect();
        self.keys(pane_id, &names)
    }

    fn send_keys(&self, bytes: &[u8], pane_id: &str) -> Result<(), HerdrError> {
        self.keys(pane_id, &keys::names(bytes))
    }

    fn send_text(&self, text: &str, pane_id: &str) -> Result<(), HerdrError> {
        let address = self.own(pane_id)?;
        hc::hc_send_with(&self.program, address, text, self.keys_timeout)
            .map(drop)
            .map_err(herdr_error)
    }

    fn pause(&self, ms: u64) {
        if !self.no_pause {
            std::thread::sleep(Duration::from_millis(ms));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hc::fake::Fake;
    use herdr_core::AgentStatus;

    fn screen(fake: &Fake) -> HcScreen {
        HcScreen {
            address: "t1".into(),
            keys_timeout: Duration::from_secs(5),
            program: fake.program.clone().into_os_string(),
            no_pause: true,
        }
    }

    #[test]
    fn named_keys_map_to_hc_names() {
        let fake = Fake::new(&[]);
        let s = screen(&fake);
        let names: Vec<String> = [
            "Enter", "Escape", "Down", "Up", "Tab", "Space", "C-c", "2", "y",
        ]
        .map(String::from)
        .to_vec();
        s.send_named_keys(&names, "hc:t1").unwrap();
        assert_eq!(
            fake.log(),
            "keys t1 enter esc down up tab space ctrl+c 2 y\n"
        );
        s.send_keys(b"\x1b", "t1").unwrap();
        s.send_keys(b"", "t1").unwrap();
        assert_eq!(
            fake.log(),
            "keys t1 enter esc down up tab space ctrl+c 2 y\nkeys t1 esc\n"
        );
    }

    #[test]
    fn keys_for_another_pane_press_nothing() {
        let fake = Fake::new(&[]);
        let s = screen(&fake);
        for pane in ["hc:t2", "t10", "hc:mini/t1"] {
            assert!(matches!(
                s.send_named_keys(&["1".into()], pane),
                Err(HerdrError::Protocol(_))
            ));
            assert!(s.send_text("hi", pane).is_err());
            assert!(s.visible_text(pane).is_err());
        }
        assert!(s.respond("hc:t1", true).is_err());
        assert_eq!(fake.log(), "");
    }

    #[test]
    fn snapshot_maps_one_pane_with_its_agent() {
        let gets = tempfile::tempdir().unwrap();
        std::fs::write(
            gets.path().join("t1.json"),
            r#"{"address":"t1","argv":["claude"],"pid":4242,"created_ms":5,"cwd":"/x","state":"live",
                "status":{"state":"blocked","kind":"permission"}}"#,
        )
        .unwrap();
        let fake = Fake::new(&[("FAKE_HC_GET_DIR", gets.path().to_str().unwrap())]);
        let ws = screen(&fake).snapshot().unwrap();
        assert_eq!(ws.len(), 1);
        assert_eq!(ws[0].tabs.len(), 1);
        let panes = &ws[0].tabs[0].panes;
        assert_eq!(panes.len(), 1);
        assert_eq!(panes[0].id, "hc:t1");
        assert_eq!(panes[0].cwd, "/x");
        let agent = panes[0].agent.as_ref().expect("an agent");
        assert_eq!(agent.kind, "claude");
        assert_eq!(agent.status, AgentStatus::Blocked);
        assert_eq!(agent.status_kind.as_deref(), Some("permission"));
        assert_eq!(agent.process.as_deref(), Some("4242@5"));
        assert_eq!(agent.backend, BackendKind::Hc);
    }

    #[test]
    fn screen_text_and_send_go_through_hc() {
        let screens = tempfile::tempdir().unwrap();
        std::fs::write(screens.path().join("t1.txt"), "Do you want to proceed?\n").unwrap();
        let fake = Fake::new(&[("FAKE_HC_SCREEN_DIR", screens.path().to_str().unwrap())]);
        let s = screen(&fake);
        assert_eq!(s.visible_text("hc:t1").unwrap(), "Do you want to proceed?");
        s.send_text("--large", "hc:t1").unwrap();
        assert_eq!(fake.log(), "read t1\nsend t1 --large\n");
    }

    #[test]
    fn hc_failures_keep_their_meaning() {
        let fake = Fake::new(&[("FAKE_HC_KEYS_FAIL", "not_found")]);
        match screen(&fake).send_named_keys(&["Enter".into()], "hc:t1") {
            Err(HerdrError::Server { code, .. }) => assert_eq!(code, "not_found"),
            other => panic!("expected not_found, got {other:?}"),
        }
        let fake = Fake::new(&[("FAKE_HC_KEYS_SLEEP", "3")]);
        let mut s = screen(&fake);
        s.keys_timeout = Duration::from_millis(300);
        assert!(matches!(
            s.send_named_keys(&["1".into()], "hc:t1"),
            Err(HerdrError::Timeout(_))
        ));
    }
}
