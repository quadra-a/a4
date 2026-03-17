use anyhow::Result;
use quadra_a_cli_rs::conformance::{default_spec_root, ensure_report_passes, run};
use std::path::PathBuf;

fn parse_arg(flag: &str) -> Option<PathBuf> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == flag {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

fn output_report(report: &quadra_a_cli_rs::conformance::ConformanceReport) -> Result<()> {
    if let Some(path) = parse_arg("--out") {
        std::fs::write(&path, serde_json::to_vec_pretty(report)?)?;
    } else {
        println!("{}", serde_json::to_string_pretty(report)?);
    }
    Ok(())
}

fn main() -> Result<()> {
    let spec_root = parse_arg("--spec-root").unwrap_or_else(default_spec_root);
    let report = run(&spec_root)?;
    output_report(&report)?;
    ensure_report_passes(&report)
}
