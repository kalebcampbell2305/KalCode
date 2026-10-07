//! The architectures of a Mach-O executable, read from its own header: what `lipo -archs` prints.
//!
//! The macOS updater must not depend on developer tools. `/usr/bin/lipo` is an `xcrun` shim (the
//! same xcselect stub as `/usr/bin/git`): it works only where Xcode or the Command Line Tools are
//! installed, and on any other Mac it fails, so an update would be rejected as invalid. A confined
//! update proof whose sandbox hid the developer directory failed exactly there
//! (`lipo_live_architectures`, exit 72), while every proof on the owner's Mac (which has Xcode)
//! passed. Reading the header needs no tool and no developer directory.
//!
//! Only the bounded header region is read: 8 bytes for a thin image, plus at most
//! [`MAX_FAT_ARCHITECTURES`] fat entries for a universal one.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

/// More fat entries than any real universal binary carries; a larger count is a damaged header.
pub const MAX_FAT_ARCHITECTURES: u32 = 32;

const MH_MAGIC: u32 = 0xfeed_face;
const MH_MAGIC_64: u32 = 0xfeed_facf;
const FAT_MAGIC: u32 = 0xcafe_babe;
const FAT_MAGIC_64: u32 = 0xcafe_babf;

const CPU_ARCH_ABI64: u32 = 0x0100_0000;
const CPU_TYPE_X86: u32 = 7;
const CPU_TYPE_ARM: u32 = 12;
const CPU_TYPE_POWERPC: u32 = 18;
const CPU_TYPE_X86_64: u32 = CPU_TYPE_X86 | CPU_ARCH_ABI64;
const CPU_TYPE_ARM64: u32 = CPU_TYPE_ARM | CPU_ARCH_ABI64;
const CPU_TYPE_POWERPC64: u32 = CPU_TYPE_POWERPC | CPU_ARCH_ABI64;
/// The high byte of a CPU subtype carries capability bits (for example arm64e's pointer
/// authentication ABI), not the subtype itself.
const CPU_SUBTYPE_MASK: u32 = 0x00ff_ffff;

/// The architecture names of the Mach-O image at `path`, in file order, as `lipo -archs` prints them.
pub fn architectures(path: &Path) -> io::Result<Vec<&'static str>> {
    architectures_from(File::open(path)?)
}

/// The macOS update rule: an installable KalCode executable is exactly one plain arm64 image. A
/// universal binary, an arm64e or unknown arm64 slice, or no arm64 slice at all is refused.
pub fn is_exactly_arm64(architectures: &[&str]) -> bool {
    architectures == ["arm64"]
}

/// [`architectures`] over any reader positioned at the start of the image.
pub fn architectures_from(mut reader: impl Read) -> io::Result<Vec<&'static str>> {
    let mut header = [0_u8; 8];
    reader.read_exact(&mut header)?;
    let magic_be = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
    let magic_le = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let fat_entry = match magic_be {
        FAT_MAGIC => Some(20),
        FAT_MAGIC_64 => Some(32),
        _ => None,
    };
    if let Some(entry_size) = fat_entry {
        let count = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
        if count == 0 || count > MAX_FAT_ARCHITECTURES {
            return Err(invalid(
                "universal header lists an impossible number of architectures",
            ));
        }
        let mut names = Vec::with_capacity(count as usize);
        let mut entry = [0_u8; 32];
        for _ in 0..count {
            reader.read_exact(&mut entry[..entry_size])?;
            let cpu_type = u32::from_be_bytes([entry[0], entry[1], entry[2], entry[3]]);
            let cpu_subtype = u32::from_be_bytes([entry[4], entry[5], entry[6], entry[7]]);
            names.push(architecture_name(cpu_type, cpu_subtype));
        }
        return Ok(names);
    }
    // A thin image stores its header in its own byte order; the magic says which.
    let read_u32 = |bytes: [u8; 4], little: bool| {
        if little {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        }
    };
    let little = match (magic_le, magic_be) {
        (MH_MAGIC | MH_MAGIC_64, _) => true,
        (_, MH_MAGIC | MH_MAGIC_64) => false,
        _ => return Err(invalid("not a Mach-O image")),
    };
    let cpu_type = read_u32([header[4], header[5], header[6], header[7]], little);
    let mut subtype = [0_u8; 4];
    reader.read_exact(&mut subtype)?;
    Ok(vec![architecture_name(cpu_type, read_u32(subtype, little))])
}

/// Strict on purpose: the updater accepts exactly `["arm64"]`, so only the plain arm64 subtypes
/// (ALL, V8) carry that name. Newer pointer-authentication slices that `lipo` itself reports as an
/// unknown arm64 subtype (Apple's `arm64e.x1`, subtype 12) are `unknown`, never `arm64`.
fn architecture_name(cpu_type: u32, cpu_subtype: u32) -> &'static str {
    match (cpu_type, cpu_subtype & CPU_SUBTYPE_MASK) {
        (CPU_TYPE_ARM64, 0 | 1) => "arm64",
        (CPU_TYPE_ARM64, 2) => "arm64e",
        (CPU_TYPE_X86_64, 8) => "x86_64h",
        (CPU_TYPE_X86_64, _) => "x86_64",
        (CPU_TYPE_X86, _) => "i386",
        (CPU_TYPE_ARM, _) => "arm",
        (CPU_TYPE_POWERPC, _) => "ppc",
        (CPU_TYPE_POWERPC64, _) => "ppc64",
        _ => "unknown",
    }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thin(magic_le: u32, cpu_type: u32, cpu_subtype: u32) -> Vec<u8> {
        let mut image = magic_le.to_le_bytes().to_vec();
        image.extend(cpu_type.to_le_bytes());
        image.extend(cpu_subtype.to_le_bytes());
        image.extend([0_u8; 64]);
        image
    }

    fn fat(magic: u32, slices: &[(u32, u32)]) -> Vec<u8> {
        let mut image = magic.to_be_bytes().to_vec();
        image.extend((slices.len() as u32).to_be_bytes());
        for (cpu_type, cpu_subtype) in slices {
            image.extend(cpu_type.to_be_bytes());
            image.extend(cpu_subtype.to_be_bytes());
            if magic == FAT_MAGIC_64 {
                image.extend(0x4000_u64.to_be_bytes()); // offset
                image.extend(0x1000_u64.to_be_bytes()); // size
                image.extend(14_u32.to_be_bytes()); // align
                image.extend(0_u32.to_be_bytes()); // reserved
            } else {
                image.extend(0x4000_u32.to_be_bytes());
                image.extend(0x1000_u32.to_be_bytes());
                image.extend(14_u32.to_be_bytes());
            }
        }
        image
    }

    fn archs(image: &[u8]) -> io::Result<Vec<&'static str>> {
        architectures_from(image)
    }

    #[test]
    fn a_thin_arm64_executable_is_exactly_arm64() {
        assert_eq!(
            archs(&thin(MH_MAGIC_64, CPU_TYPE_ARM64, 0)).unwrap(),
            ["arm64"]
        );
        // The capability byte never changes the name.
        assert_eq!(
            archs(&thin(MH_MAGIC_64, CPU_TYPE_ARM64, 0x8000_0000)).unwrap(),
            ["arm64"]
        );
    }

    #[test]
    fn other_thin_architectures_are_named_as_lipo_names_them() {
        assert_eq!(
            archs(&thin(MH_MAGIC_64, CPU_TYPE_ARM64, 2)).unwrap(),
            ["arm64e"]
        );
        assert_eq!(
            archs(&thin(MH_MAGIC_64, CPU_TYPE_ARM64, 0x8000_0002)).unwrap(),
            ["arm64e"]
        );
        assert_eq!(
            archs(&thin(MH_MAGIC_64, CPU_TYPE_X86_64, 3)).unwrap(),
            ["x86_64"]
        );
        assert_eq!(
            archs(&thin(MH_MAGIC_64, CPU_TYPE_X86_64, 8)).unwrap(),
            ["x86_64h"]
        );
        assert_eq!(archs(&thin(MH_MAGIC, CPU_TYPE_X86, 3)).unwrap(), ["i386"]);
        assert_eq!(
            archs(&thin(MH_MAGIC_64, 0x0100_00ff, 0)).unwrap(),
            ["unknown"]
        );
        // Apple's universal system binaries carry a third slice, cpusubtype 0x8000000c, that lipo
        // reports as an unknown arm64 subtype ("arm64e.x1"). It must never pass as plain arm64.
        assert_eq!(
            archs(&thin(MH_MAGIC_64, CPU_TYPE_ARM64, 0x8000_000c)).unwrap(),
            ["unknown"]
        );
        assert_eq!(
            archs(&thin(MH_MAGIC_64, CPU_TYPE_ARM64, 1)).unwrap(),
            ["arm64"]
        );
    }

    #[test]
    fn a_big_endian_thin_image_reads_its_own_byte_order() {
        let mut image = MH_MAGIC.to_be_bytes().to_vec();
        image.extend(CPU_TYPE_POWERPC.to_be_bytes());
        image.extend(0_u32.to_be_bytes());
        assert_eq!(archs(&image).unwrap(), ["ppc"]);
    }

    #[test]
    fn universal_images_list_every_slice_in_order() {
        let both = fat(FAT_MAGIC, &[(CPU_TYPE_X86_64, 3), (CPU_TYPE_ARM64, 0)]);
        assert_eq!(archs(&both).unwrap(), ["x86_64", "arm64"]);
        let wide = fat(FAT_MAGIC_64, &[(CPU_TYPE_ARM64, 0), (CPU_TYPE_ARM64, 2)]);
        assert_eq!(archs(&wide).unwrap(), ["arm64", "arm64e"]);
        // The exact fat header of macOS 15's /bin/ls (x86_64, arm64e, arm64e.x1), read on a Mac.
        let system = fat(
            FAT_MAGIC,
            &[
                (CPU_TYPE_X86_64, 3),
                (CPU_TYPE_ARM64, 0x8000_0002),
                (CPU_TYPE_ARM64, 0x8000_000c),
            ],
        );
        assert_eq!(archs(&system).unwrap(), ["x86_64", "arm64e", "unknown"]);
        // A universal image holding only arm64 is still exactly arm64.
        assert_eq!(
            archs(&fat(FAT_MAGIC, &[(CPU_TYPE_ARM64, 0)])).unwrap(),
            ["arm64"]
        );
    }

    #[test]
    fn only_an_exactly_arm64_image_passes_the_update_rule() {
        let passes = |image: Vec<u8>| is_exactly_arm64(&archs(&image).unwrap());
        assert!(passes(thin(MH_MAGIC_64, CPU_TYPE_ARM64, 0)));
        assert!(passes(fat(FAT_MAGIC, &[(CPU_TYPE_ARM64, 0)])));
        // Universal or fat binaries without an arm64 slice, or with anything besides it, are refused.
        assert!(!passes(fat(FAT_MAGIC, &[(CPU_TYPE_X86_64, 3)])));
        assert!(!passes(fat(
            FAT_MAGIC_64,
            &[(CPU_TYPE_X86_64, 3), (CPU_TYPE_X86_64, 8)]
        )));
        assert!(!passes(fat(FAT_MAGIC, &[(CPU_TYPE_ARM64, 0x8000_0002)])));
        assert!(!passes(fat(FAT_MAGIC, &[(CPU_TYPE_ARM64, 0x8000_000c)])));
        assert!(!passes(fat(
            FAT_MAGIC,
            &[(CPU_TYPE_X86_64, 3), (CPU_TYPE_ARM64, 0)]
        )));
        assert!(!passes(fat(
            FAT_MAGIC,
            &[(CPU_TYPE_ARM64, 0), (CPU_TYPE_ARM64, 0)]
        )));
        assert!(!passes(thin(MH_MAGIC_64, CPU_TYPE_X86_64, 3)));
        assert!(!passes(thin(MH_MAGIC_64, CPU_TYPE_ARM64, 2)));
        assert!(!is_exactly_arm64(&[]));
    }

    #[test]
    fn damaged_or_foreign_files_are_refused_not_guessed() {
        assert_eq!(
            archs(b"#!/bin/sh\necho hi\n").unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            archs(&[0_u8; 16]).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            archs(&[0xcf, 0xfa]).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        let mut truncated = thin(MH_MAGIC_64, CPU_TYPE_ARM64, 0);
        truncated.truncate(10);
        assert_eq!(
            archs(&truncated).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        let mut huge = FAT_MAGIC.to_be_bytes().to_vec();
        huge.extend(1_000_000_u32.to_be_bytes());
        assert_eq!(archs(&huge).unwrap_err().kind(), io::ErrorKind::InvalidData);
        let mut empty = FAT_MAGIC.to_be_bytes().to_vec();
        empty.extend(0_u32.to_be_bytes());
        assert_eq!(
            archs(&empty).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let mut short_table = fat(FAT_MAGIC, &[(CPU_TYPE_ARM64, 0), (CPU_TYPE_X86_64, 3)]);
        short_table.truncate(8 + 20 + 5);
        assert_eq!(
            archs(&short_table).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn reads_a_real_file_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kalcode");
        std::fs::write(&path, thin(MH_MAGIC_64, CPU_TYPE_ARM64, 0)).unwrap();
        assert_eq!(architectures(&path).unwrap(), ["arm64"]);
        assert_eq!(
            architectures(&dir.path().join("missing"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::NotFound
        );
    }
}
