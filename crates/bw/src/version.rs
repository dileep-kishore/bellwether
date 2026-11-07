use serde_json::{json, Value};

pub const PROTOCOL: u32 = 1;

pub fn version_json() -> Value {
    json!({
        "protocol": PROTOCOL,
        "version": env!("CARGO_PKG_VERSION"),
        "build": env!("BW_BUILD"),
        "target": env!("BW_TARGET"),
    })
}
