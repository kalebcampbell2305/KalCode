use std::io::{BufReader, BufWriter};

fn main() {
    let mut args = std::env::args_os().skip(1);
    let Some(flag) = args.next() else {
        std::process::exit(2);
    };
    #[cfg(target_os = "macos")]
    if flag == "--custodian" {
        let Some(fd_flag) = args.next() else {
            std::process::exit(2);
        };
        let Some(fd) = args.next() else {
            std::process::exit(2);
        };
        if fd_flag != "--control-fd" || fd != "3" || args.next().is_some() {
            std::process::exit(2);
        }
        match kalcode_providers::guardian::custodian::run(3) {
            Ok(code) => std::process::exit(code),
            Err(_) => std::process::exit(125),
        }
    }
    let Some(recovery_root) = args.next() else {
        std::process::exit(2);
    };
    let Some(identity_flag) = args.next() else {
        std::process::exit(2);
    };
    let Some(recovery_root_identity) = args.next() else {
        std::process::exit(2);
    };
    if flag != "--recovery-root" || identity_flag != "--recovery-root-id" || args.next().is_some() {
        std::process::exit(2);
    }
    let input = std::io::stdin();
    let output = std::io::stdout();
    let mut input = BufReader::new(input.lock());
    let mut output = BufWriter::new(output.lock());
    if kalcode_providers::guardian::server::serve_with_recovery_root(
        &mut input,
        &mut output,
        std::path::Path::new(&recovery_root),
        &recovery_root_identity.to_string_lossy(),
    )
    .is_err()
    {
        std::process::exit(1);
    }
}
