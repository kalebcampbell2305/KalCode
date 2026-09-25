//! What a target provider accepts, as far as context goes.
//!
//! Concrete capabilities come from the provider runtime later (`ProviderCapabilities
//! .contextLimits`, `docs/CONTRACTS_ADVANCED.md` §10). Until a provider *declares* a modality,
//! KalCode assumes it does not have it: the defaults are text-only, no attachments, no image
//! input, no file references and no link fetching. Nothing in this crate assumes that a
//! provider accepts images or attachments without a capability flag.

pub use kalcode_contracts::context::Modality;
use serde::{Deserialize, Serialize};

use crate::content::ImageFormat;

/// Default cap for one package (ADVANCED.md §10: "default package cap 2 MiB").
pub const DEFAULT_PACKAGE_CAP_BYTES: u64 = 2 * 1024 * 1024;

/// Per-provider context capabilities. Implemented by the provider runtime; this crate ships
/// [`TextOnlyDefaults`], [`ContextLimitsDescriptor`] and a test double.
pub trait ProviderContextCapabilities: Send + Sync {
    /// The provider id, for the preview and the decision log.
    fn provider_id(&self) -> &str;

    /// Largest input the provider takes in one message, in bytes.
    fn max_input_bytes(&self) -> u64;

    /// Whether the provider accepts `modality`. The default accepts text only.
    fn accepts(&self, modality: Modality) -> bool {
        modality == Modality::Text
    }

    /// Largest single attachment, in bytes (0 = none).
    fn max_attachment_bytes(&self) -> u64 {
        0
    }

    /// Image formats the provider decodes (checked only when images are accepted).
    fn accepts_image_format(&self, _format: ImageFormat) -> bool {
        false
    }
}

/// Documented defaults for a provider that has declared nothing: text only, capped at
/// [`DEFAULT_PACKAGE_CAP_BYTES`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextOnlyDefaults {
    pub provider_id: String,
}

impl TextOnlyDefaults {
    pub fn new(provider_id: impl Into<String>) -> Self {
        Self {
            provider_id: provider_id.into(),
        }
    }
}

impl ProviderContextCapabilities for TextOnlyDefaults {
    fn provider_id(&self) -> &str {
        &self.provider_id
    }

    fn max_input_bytes(&self) -> u64 {
        DEFAULT_PACKAGE_CAP_BYTES
    }
}

/// Adapter for the proposed contract `ContextLimits { maxInputBytes, acceptsImages }`.
/// Images are accepted only when the flag is set, in PNG/JPEG/GIF/WebP, each at most a quarter
/// of the input budget (and never above 5 MiB).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextLimitsDescriptor {
    pub provider_id: String,
    pub max_input_bytes: u64,
    pub accepts_images: bool,
}

impl ProviderContextCapabilities for ContextLimitsDescriptor {
    fn provider_id(&self) -> &str {
        &self.provider_id
    }

    fn max_input_bytes(&self) -> u64 {
        self.max_input_bytes
    }

    fn accepts(&self, modality: Modality) -> bool {
        match modality {
            Modality::Text => true,
            Modality::Image => self.accepts_images,
            _ => false,
        }
    }

    fn max_attachment_bytes(&self) -> u64 {
        if self.accepts_images {
            (self.max_input_bytes / 4).min(5 * 1024 * 1024)
        } else {
            0
        }
    }

    fn accepts_image_format(&self, format: ImageFormat) -> bool {
        self.accepts_images && format != ImageFormat::Bmp
    }
}

/// Test double with every capability configurable. Public so integration tests in other crates
/// (provider runtime, QA) can use it; it is not a real provider's description.
pub mod testing {
    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct FakeProviderCapabilities {
        pub provider_id: String,
        pub max_input_bytes: u64,
        pub modalities: Vec<Modality>,
        pub max_attachment_bytes: u64,
        pub image_formats: Vec<ImageFormat>,
    }

    impl FakeProviderCapabilities {
        /// Text only, 2 MiB.
        pub fn text_only() -> Self {
            Self {
                provider_id: "fake-provider".to_owned(),
                max_input_bytes: DEFAULT_PACKAGE_CAP_BYTES,
                modalities: vec![Modality::Text],
                max_attachment_bytes: 0,
                image_formats: Vec::new(),
            }
        }

        /// Everything accepted, 8 MiB input, 4 MiB attachments.
        pub fn everything() -> Self {
            Self {
                provider_id: "fake-provider".to_owned(),
                max_input_bytes: 8 * 1024 * 1024,
                modalities: vec![
                    Modality::Text,
                    Modality::Image,
                    Modality::Document,
                    Modality::FileReference,
                    Modality::UrlFetch,
                ],
                max_attachment_bytes: 4 * 1024 * 1024,
                image_formats: vec![
                    ImageFormat::Png,
                    ImageFormat::Jpeg,
                    ImageFormat::Gif,
                    ImageFormat::Webp,
                ],
            }
        }

        pub fn with_max_input_bytes(mut self, bytes: u64) -> Self {
            self.max_input_bytes = bytes;
            self
        }
    }

    impl ProviderContextCapabilities for FakeProviderCapabilities {
        fn provider_id(&self) -> &str {
            &self.provider_id
        }

        fn max_input_bytes(&self) -> u64 {
            self.max_input_bytes
        }

        fn accepts(&self, modality: Modality) -> bool {
            self.modalities.contains(&modality)
        }

        fn max_attachment_bytes(&self) -> u64 {
            self.max_attachment_bytes
        }

        fn accepts_image_format(&self, format: ImageFormat) -> bool {
            self.image_formats.contains(&format)
        }
    }
}
