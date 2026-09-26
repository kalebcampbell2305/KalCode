#![allow(dead_code, clippy::expect_used, clippy::unwrap_used)]

use std::path::Path;
use std::sync::Arc;

use kalcode_core::flags::BuildChannel;
use kalcode_core::{Core, CoreConfig, Paths};

pub fn core(dir: &Path) -> Arc<Core> {
    Arc::new(
        Core::open(CoreConfig {
            paths: Paths::new(dir),
            app_version: "0.0.0-doctor-test".into(),
            channel: BuildChannel::Development,
        })
        .expect("open core"),
    )
}
