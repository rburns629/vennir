//! rot13's "transform" action: each Latin letter moved 13 places along the
//! alphabet, so applying it twice gives the original back. Everything else
//! (digits, spacing, accents, emoji) passes through unchanged.
//!
//! The binary is the image's entrypoint: the platform passes the action as
//! its first argument. It reads /platform/input/request.json and writes
//! /platform/output/result.json:
//! {"status": "succeeded", "outputs": {...}} or
//! {"status": "failed", "error": {"code", "message", "retryable"}}.
use serde_json::{json, Value};
use std::{env, fs, process};

const INPUT_PATH: &str = "/platform/input/request.json";
const OUTPUT_PATH: &str = "/platform/output/result.json";
// result.json is limited to 4 KB, and the output carries the text back.
const MAX_LENGTH: usize = 1000;

fn write_result(result: &Value) {
    if let Err(error) = fs::write(OUTPUT_PATH, result.to_string()) {
        eprintln!("can't write result.json: {error}");
    }
}

fn fail(code: &str, message: &str) -> i32 {
    write_result(&json!({
        "status": "failed",
        "error": { "code": code, "message": message, "retryable": false }
    }));
    1
}

fn rot13(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            'a'..='z' => (((c as u8 - b'a' + 13) % 26) + b'a') as char,
            'A'..='Z' => (((c as u8 - b'A' + 13) % 26) + b'A') as char,
            _ => c,
        })
        .collect()
}

fn run(action: Option<String>) -> i32 {
    if action.as_deref() != Some("transform") {
        let action = action.unwrap_or_default();
        return fail("UNSUPPORTED_ACTION", &format!("no action \"{action}\": this product has transform"));
    }

    let request: Value = match fs::read_to_string(INPUT_PATH).map(|s| serde_json::from_str(&s)) {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => return fail("INVALID_INPUT", &format!("request.json isn't valid JSON: {error}")),
        Err(error) => return fail("MISSING_INPUT", &format!("can't read request.json: {error}")),
    };
    let text = match request["inputs"]["text"].as_str() {
        Some(text) if !text.trim().is_empty() => text,
        _ => return fail("MISSING_INPUT", "inputs.text is required: the text to change."),
    };
    // Counted in code points, the way the other language samples count.
    let length = text.chars().count();
    if length > MAX_LENGTH {
        return fail(
            "TEXT_TOO_LONG",
            &format!("inputs.text is {length} characters; the limit is {MAX_LENGTH}."),
        );
    }

    // A JSON line with level info: what everyone who can see the run sees.
    // Anything else (debug, warn, error, plain) only this team sees.
    println!("{{\"level\":\"info\",\"msg\":\"rotated {length} characters\"}}");
    write_result(&json!({
        "status": "succeeded",
        "outputs": { "text": rot13(text), "language": "Rust" }
    }));
    0
}

fn main() {
    // The action, which the platform passes as the first argument: only
    // compared with "transform", never trusted for anything else.
    process::exit(run(env::args().nth(1))); // nosemgrep: rust.lang.security.args.args
}
