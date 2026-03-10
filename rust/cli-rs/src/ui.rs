use colored::Colorize;
use std::io::Write;

/// Human-friendly output with colors and symbols
#[allow(dead_code)]
pub struct HumanFormatter;

#[allow(dead_code)]
impl HumanFormatter {
    pub fn success(message: &str) {
        let _ = writeln!(std::io::stdout(), "{} {}", "✓".green(), message);
    }

    pub fn error(message: &str) {
        let _ = writeln!(std::io::stderr(), "{} {}", "✗".red(), message);
    }

    pub fn info(message: &str) {
        let _ = writeln!(std::io::stdout(), "{} {}", "ℹ".blue(), message);
    }

    pub fn section(title: &str) {
        let _ = writeln!(std::io::stdout());
        let _ = writeln!(std::io::stdout(), "{}", title.bold());
    }

    pub fn key_value(key: &str, value: &str) {
        let _ = writeln!(std::io::stdout(), "  {}: {}", key.dimmed(), value);
    }
}

/// LLM-friendly output (structured, compact, no colors)
pub struct LlmFormatter;

impl LlmFormatter {
    pub fn section(title: &str) {
        // Handle EPIPE gracefully by ignoring broken pipe errors
        if let Err(e) = std::io::Write::write_all(
            &mut std::io::stdout(),
            format!("\n{}\n\n", title.to_uppercase()).as_bytes(),
        ) {
            if e.kind() == std::io::ErrorKind::BrokenPipe {
                std::process::exit(0);
            }
        }
    }

    pub fn key_value(key: &str, value: &str) {
        // Handle EPIPE gracefully by ignoring broken pipe errors
        if let Err(e) = std::io::Write::write_all(
            &mut std::io::stdout(),
            format!("{}: {}\n", key, value).as_bytes(),
        ) {
            if e.kind() == std::io::ErrorKind::BrokenPipe {
                std::process::exit(0);
            }
        }
    }

    pub fn table(headers: &[&str], rows: &[Vec<String>]) {
        if rows.is_empty() {
            return;
        }

        // Calculate column widths
        let col_widths: Vec<usize> = headers
            .iter()
            .enumerate()
            .map(|(i, h)| {
                let max_data_width = rows
                    .iter()
                    .map(|r| r.get(i).map(|s| s.len()).unwrap_or(0))
                    .max()
                    .unwrap_or(0);
                h.len().max(max_data_width)
            })
            .collect();

        // Print header
        let _ = write!(std::io::stdout(), "|");
        for (i, header) in headers.iter().enumerate() {
            let _ = write!(
                std::io::stdout(),
                " {:<width$} |",
                header,
                width = col_widths[i]
            );
        }
        let _ = writeln!(std::io::stdout());

        // Print separator
        let _ = write!(std::io::stdout(), "|");
        for width in &col_widths {
            let _ = write!(std::io::stdout(), "{}", "-".repeat(width + 2));
            let _ = write!(std::io::stdout(), "|");
        }
        let _ = writeln!(std::io::stdout());

        // Print rows
        for row in rows {
            let _ = write!(std::io::stdout(), "|");
            for (i, cell) in row.iter().enumerate() {
                let _ = write!(
                    std::io::stdout(),
                    " {:<width$} |",
                    cell,
                    width = col_widths[i]
                );
            }
            let _ = writeln!(std::io::stdout());
        }
    }
}
