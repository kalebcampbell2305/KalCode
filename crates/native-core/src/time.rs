//! Timestamp helpers. All persisted timestamps are UTC RFC 3339 with millisecond precision.

use time::OffsetDateTime;
use time::macros::format_description;

pub fn now_rfc3339() -> String {
    format_rfc3339(OffsetDateTime::now_utc())
}

pub fn format_rfc3339(at: OffsetDateTime) -> String {
    let format =
        format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");
    at.to_offset(time::UtcOffset::UTC)
        .format(&format)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn formats_utc_with_millis() {
        assert_eq!(
            format_rfc3339(datetime!(2026-09-24 18:02:11.412345 UTC)),
            "2026-09-24T18:02:11.412Z"
        );
        assert_eq!(
            format_rfc3339(datetime!(2026-09-24 20:00:00 +2)),
            "2026-09-24T18:00:00.000Z"
        );
    }
}
