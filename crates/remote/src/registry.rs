//! The paired-device registry (`remote-devices.json`): public keys and metadata only.
//!
//! Revoked devices stay listed (with `revoked` and `revokedAt`) so a later handshake from the
//! same key is answered `revoked` rather than `unpaired`. Every change is written atomically
//! (temporary file + rename) before the call returns.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use tokio::sync::broadcast;

use crate::Error;
use crate::noise::{KEY_LEN, decode_public_key, encode_public_key};
use crate::wire::DeviceHello;

/// A paired device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// `dev_` + random hex.
    pub id: String,
    pub name: String,
    pub platform: String,
    pub model: String,
    /// App version reported at the last handshake.
    #[serde(default)]
    pub app: String,
    /// Static X25519 public key, standard base64.
    pub public_key: String,
    #[serde(with = "time::serde::rfc3339")]
    pub paired_at: OffsetDateTime,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub last_seen_at: Option<OffsetDateTime>,
    #[serde(default)]
    pub revoked: bool,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub revoked_at: Option<OffsetDateTime>,
}

#[derive(Default, Serialize, Deserialize)]
struct File {
    devices: Vec<Device>,
}

/// The device registry, shared by every connection.
pub struct Registry {
    path: PathBuf,
    devices: Mutex<Vec<Device>>,
    revocations: broadcast::Sender<String>,
}

impl Registry {
    /// Opens the registry at `path`, loading it when the file exists. A corrupt file is an
    /// error, never silently replaced.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, Error> {
        let path = path.into();
        let devices = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<File>(&bytes)?.devices,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        let (revocations, _) = broadcast::channel(16);
        Ok(Self {
            path,
            devices: Mutex::new(devices),
            revocations,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn lock(&self) -> MutexGuard<'_, Vec<Device>> {
        self.devices.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Every device, revoked ones included, in pairing order.
    pub fn list(&self) -> Vec<Device> {
        self.lock().clone()
    }

    pub fn get(&self, id: &str) -> Option<Device> {
        self.lock().iter().find(|d| d.id == id).cloned()
    }

    /// The device holding `public_key`, revoked or not.
    pub fn find_by_public_key(&self, public_key: &[u8; KEY_LEN]) -> Option<Device> {
        self.lock()
            .iter()
            .find(|d| decode_public_key(&d.public_key).is_ok_and(|k| &k == public_key))
            .cloned()
    }

    /// Registers a newly paired device.
    pub fn register(
        &self,
        public_key: &[u8; KEY_LEN],
        hello: &DeviceHello,
    ) -> Result<Device, Error> {
        let now = OffsetDateTime::now_utc();
        let device = Device {
            id: crate::random_id("dev_")?,
            name: hello.device.clone(),
            platform: hello.platform.clone(),
            model: hello.model.clone(),
            app: hello.app.clone(),
            public_key: encode_public_key(public_key),
            paired_at: now,
            last_seen_at: Some(now),
            revoked: false,
            revoked_at: None,
        };
        let mut devices = self.lock();
        let mut next = devices.clone();
        next.push(device.clone());
        self.save(&next)?;
        *devices = next;
        Ok(device)
    }

    /// Records a successful connection and refreshes the device's reported metadata.
    pub fn touch(&self, id: &str, hello: &DeviceHello) -> Result<Option<Device>, Error> {
        self.update(id, |d| {
            d.name.clone_from(&hello.device);
            d.platform.clone_from(&hello.platform);
            d.model.clone_from(&hello.model);
            d.app.clone_from(&hello.app);
            d.last_seen_at = Some(OffsetDateTime::now_utc());
            true
        })
    }

    /// Revokes a device: its key is refused from now on and its live connections are closed
    /// with `bye revoked`. Returns false when the id is unknown or already revoked.
    pub fn revoke(&self, id: &str) -> Result<bool, Error> {
        let changed = self.update(id, |d| {
            if d.revoked {
                return false;
            }
            d.revoked = true;
            d.revoked_at = Some(OffsetDateTime::now_utc());
            true
        })?;
        let revoked = changed.is_some();
        if revoked {
            // No live connection means no receiver; that is fine.
            let _ = self.revocations.send(id.to_owned());
        }
        Ok(revoked)
    }

    /// Ids of devices as they are revoked. [`crate::server::serve_connection`] subscribes.
    pub fn revocations(&self) -> broadcast::Receiver<String> {
        self.revocations.subscribe()
    }

    /// Applies `change` to device `id`; persists and returns it when `change` reports a change.
    fn update(
        &self,
        id: &str,
        change: impl FnOnce(&mut Device) -> bool,
    ) -> Result<Option<Device>, Error> {
        let mut devices = self.lock();
        let mut next = devices.clone();
        let Some(device) = next.iter_mut().find(|d| d.id == id) else {
            return Ok(None);
        };
        if !change(device) {
            return Ok(None);
        }
        let device = device.clone();
        self.save(&next)?;
        *devices = next;
        Ok(Some(device))
    }

    fn save(&self, devices: &[Device]) -> Result<(), Error> {
        #[derive(Serialize)]
        struct FileRef<'a> {
            devices: &'a [Device],
        }
        let json = serde_json::to_vec_pretty(&FileRef { devices })?;
        if let Some(dir) = self.path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)?;
        }
        let mut tmp = self.path.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        {
            use std::io::Write as _;
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(&json)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used)]
    use super::*;

    fn hello(name: &str) -> DeviceHello {
        DeviceHello {
            v: 1,
            device: name.into(),
            platform: "ios".into(),
            model: "iPhone17,1".into(),
            app: "1.0 (1)".into(),
            pair: None,
            ts: 0,
        }
    }

    #[test]
    fn registers_persists_and_revokes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote-devices.json");
        let registry = Registry::open(&path).unwrap();
        assert!(registry.list().is_empty());
        let key = [9u8; 32];
        let device = registry.register(&key, &hello("Phone")).unwrap();
        assert!(device.id.starts_with("dev_") && device.id.len() == 28);
        assert_eq!(registry.find_by_public_key(&key).unwrap().id, device.id);
        assert!(registry.find_by_public_key(&[1u8; 32]).is_none());

        let mut revocations = registry.revocations();
        assert!(registry.revoke(&device.id).unwrap());
        assert!(!registry.revoke(&device.id).unwrap());
        assert!(!registry.revoke("dev_unknown").unwrap());
        assert_eq!(revocations.try_recv().unwrap(), device.id);

        let reopened = Registry::open(&path).unwrap();
        let stored = reopened.find_by_public_key(&key).unwrap();
        assert!(stored.revoked && stored.revoked_at.is_some());
        assert_eq!(reopened.list().len(), 1);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn touch_refreshes_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path().join("r.json")).unwrap();
        let device = registry.register(&[3u8; 32], &hello("Old")).unwrap();
        let touched = registry.touch(&device.id, &hello("New")).unwrap().unwrap();
        assert_eq!(touched.name, "New");
        assert_eq!(registry.get(&device.id).unwrap().name, "New");
    }

    #[test]
    fn corrupt_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("r.json");
        std::fs::write(&path, b"{not json").unwrap();
        assert!(Registry::open(&path).is_err());
    }
}
