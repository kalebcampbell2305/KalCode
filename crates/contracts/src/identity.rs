//! Process-wide application identity. Stable values are compatibility contracts.
pub const IDENTIFIER: &str = if cfg!(debug_assertions) {
    "com.kalcode.desktop.dev"
} else {
    "com.kalcode.desktop"
};

pub const URL_SCHEME: &str = if cfg!(debug_assertions) {
    "kalcode-dev"
} else {
    "kalcode"
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_selects_a_consistent_identity() {
        if cfg!(debug_assertions) {
            assert_eq!(IDENTIFIER, "com.kalcode.desktop.dev");
            assert_eq!(URL_SCHEME, "kalcode-dev");
        } else {
            assert_eq!(IDENTIFIER, "com.kalcode.desktop");
            assert_eq!(URL_SCHEME, "kalcode");
        }
    }
}
