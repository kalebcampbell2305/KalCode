//! Identifiers. Every KalCode entity id is a UUIDv7 string (time-ordered, globally unique).

/// A new time-ordered id.
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// True for a canonical hyphenated UUID string (what KalCode issues). Ids that cross IPC are
/// checked with this before they touch storage.
pub fn is_valid_id(id: &str) -> bool {
    id.len() == 36
        && uuid::Uuid::try_parse(id)
            .is_ok_and(|u| u.hyphenated().to_string() == id.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_issued_ids_and_rejects_others() {
        assert!(is_valid_id(&new_id()));
        for bad in [
            "",
            "not-an-id",
            "0192f3c4000070008000000000000000",
            "../../etc/passwd",
            &"a".repeat(36),
        ] {
            assert!(!is_valid_id(bad), "{bad:?}");
        }
    }
}
