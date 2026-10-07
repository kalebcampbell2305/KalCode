//! The paired-device registry (`remote-devices.json`): public keys and metadata only.
//!
//! Revoked devices stay listed (with `revoked` and `revokedAt`) so a later handshake from the
//! same key is answered `revoked` rather than `unpaired`. Every change is written atomically
//! (temporary file + fsync + rename, then a directory fsync on Unix) before the call returns.
//!
//! Writes block on disk, so async code calls them through `spawn_blocking` (the connection
//! driver does). File I/O happens outside the lock readers take: lookups never wait on a disk.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

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

/// `touch` skips the disk write when the device was seen this recently and nothing changed.
pub const TOUCH_INTERVAL: Duration = Duration::from_secs(60);

/// The device registry, shared by every connection. Cheap to clone; clones share state.
#[derive(Clone)]
pub struct Registry {
    inner: Arc<Inner>,
}

struct Inner {
    path: PathBuf,
    devices: Mutex<Vec<Device>>,
    /// Serializes writers (and their file I/O) without blocking readers of `devices`.
    io: Mutex<()>,
    revocations: broadcast::Sender<String>,
}

impl std::fmt::Debug for Registry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Registry")
            .field("path", &self.inner.path)
            .finish_non_exhaustive()
    }
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
            inner: Arc::new(Inner {
                path,
                devices: Mutex::new(devices),
                io: Mutex::new(()),
                revocations,
            }),
        })
    }

    pub fn path(&self) -> &Path {
        &self.inner.path
    }

    fn lock(&self) -> MutexGuard<'_, Vec<Device>> {
        self.inner
            .devices
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn lock_io(&self) -> MutexGuard<'_, ()> {
        self.inner.io.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs a blocking registry call on the blocking pool.
    pub(crate) async fn blocking<T: Send + 'static>(
        &self,
        call: impl FnOnce(&Self) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        let registry = self.clone();
        tokio::task::spawn_blocking(move || call(&registry))
            .await
            .map_err(|e| Error::Io(std::io::Error::other(e)))?
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
        self.register_as(crate::random_id("dev_")?, public_key, hello)
    }

    /// Registers a newly paired device under an id chosen earlier (the handshake reply
    /// carries it before the device's `hello` commits the pairing). Refuses a key that is
    /// already registered.
    pub(crate) fn register_as(
        &self,
        id: String,
        public_key: &[u8; KEY_LEN],
        hello: &DeviceHello,
    ) -> Result<Device, Error> {
        let now = OffsetDateTime::now_utc();
        let device = Device {
            id,
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
        let _io = self.lock_io();
        let mut next = self.lock().clone();
        if next
            .iter()
            .any(|d| d.public_key == device.public_key || d.id == device.id)
        {
            return Err(Error::BadHandshake("this device is already paired".into()));
        }
        next.push(device.clone());
        self.save(&next)?;
        *self.lock() = next;
        Ok(device)
    }

    /// Records a successful connection and refreshes the device's platform, model and app
    /// version. The name chosen at pairing is kept. Writes only when something changed or the
    /// last recorded visit is at least [`TOUCH_INTERVAL`] old; returns the device when written.
    pub fn touch(&self, id: &str, hello: &DeviceHello) -> Result<Option<Device>, Error> {
        let now = OffsetDateTime::now_utc();
        self.update(id, |d| {
            let mut changed = false;
            for (field, value) in [
                (&mut d.platform, &hello.platform),
                (&mut d.model, &hello.model),
                (&mut d.app, &hello.app),
            ] {
                if field != value {
                    field.clone_from(value);
                    changed = true;
                }
            }
            let stale = d
                .last_seen_at
                .is_none_or(|seen| now - seen >= TOUCH_INTERVAL);
            if changed || stale {
                d.last_seen_at = Some(now);
            }
            changed || stale
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
            let _ = self.inner.revocations.send(id.to_owned());
        }
        Ok(revoked)
    }

    /// Ids of devices as they are revoked. [`crate::server::serve_connection`] subscribes.
    pub fn revocations(&self) -> broadcast::Receiver<String> {
        self.inner.revocations.subscribe()
    }

    /// Applies `change` to device `id`; persists and returns it when `change` reports a change.
    fn update(
        &self,
        id: &str,
        change: impl FnOnce(&mut Device) -> bool,
    ) -> Result<Option<Device>, Error> {
        let _io = self.lock_io();
        let mut next = self.lock().clone();
        let Some(device) = next.iter_mut().find(|d| d.id == id) else {
            return Ok(None);
        };
        if !change(device) {
            return Ok(None);
        }
        let device = device.clone();
        self.save(&next)?;
        *self.lock() = next;
        Ok(Some(device))
    }

    fn save(&self, devices: &[Device]) -> Result<(), Error> {
        #[derive(Serialize)]
        struct FileRef<'a> {
            devices: &'a [Device],
        }
        let json = serde_json::to_vec_pretty(&FileRef { devices })?;
        let path = &self.inner.path;
        let dir = path.parent().filter(|d| !d.as_os_str().is_empty());
        if let Some(dir) = dir {
            std::fs::create_dir_all(dir)?;
        }
        let mut tmp = path.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        {
            use std::io::Write as _;
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(&json)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, path)?;
        // The rename itself must survive a crash.
        #[cfg(unix)]
        std::fs::File::open(dir.unwrap_or(Path::new(".")))?.sync_all()?;
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
    fn touch_keeps_the_name_and_skips_recent_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("r.json");
        let registry = Registry::open(&path).unwrap();
        let device = registry.register(&[3u8; 32], &hello("Old")).unwrap();
        // Seen just now and nothing changed: no write.
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert!(registry.touch(&device.id, &hello("New")).unwrap().is_none());
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            modified
        );
        assert_eq!(registry.get(&device.id).unwrap().name, "Old");
        // A new app version is recorded; the name still is not replaced.
        let mut upgraded = hello("New");
        upgraded.app = "1.1 (2)".into();
        let touched = registry.touch(&device.id, &upgraded).unwrap().unwrap();
        assert_eq!(
            (touched.name.as_str(), touched.app.as_str()),
            ("Old", "1.1 (2)")
        );
        assert_eq!(
            Registry::open(&path).unwrap().get(&device.id).unwrap().app,
            "1.1 (2)"
        );
    }

    #[test]
    fn register_refuses_a_known_key() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path().join("r.json")).unwrap();
        registry.register(&[4u8; 32], &hello("A")).unwrap();
        assert!(registry.register(&[4u8; 32], &hello("B")).is_err());
        assert_eq!(registry.list().len(), 1);
    }

    #[test]
    fn corrupt_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("r.json");
        std::fs::write(&path, b"{not json").unwrap();
        assert!(Registry::open(&path).is_err());
    }
}
