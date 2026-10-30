// Polls the daemon from Rust so the menu bar count and the macOS notifications keep working
// while the window is closed (a hidden webview can be throttled; this thread is not).

use crate::daemon;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;

const NEEDS_YOU: [&str; 4] = ["needs_input", "review_ready", "no_change", "failed"];

#[derive(Clone, PartialEq)]
struct Seen {
    status: String,
    comments: usize,
}

pub fn start<R: Runtime>(app: AppHandle<R>, tray_id: &'static str) {
    thread::spawn(move || {
        let mut seen: Option<HashMap<String, Seen>> = None;
        let mut last_title = String::new();
        loop {
            let title = match fetch_state() {
                Some(state) => {
                    let tickets = state.get("tickets").and_then(Value::as_object).cloned().unwrap_or_default();
                    let now: HashMap<String, Seen> = tickets
                        .iter()
                        .map(|(id, t)| {
                            let status = t.get("status").and_then(Value::as_str).unwrap_or("").to_string();
                            let comments = t.pointer("/pr/comments").and_then(Value::as_array).map_or(0, Vec::len);
                            (id.clone(), Seen { status, comments })
                        })
                        .collect();
                    // the first poll after start only seeds: nothing "happened" yet
                    if let Some(before) = &seen {
                        for (id, t) in &tickets {
                            let current = &now[id];
                            notify_change(&app, id, t, before.get(id), current);
                        }
                    }
                    seen = Some(now);
                    tray_title(&tickets)
                }
                None => "○".to_string(),
            };
            if title != last_title {
                if let Some(tray) = app.tray_by_id(tray_id) {
                    let _ = tray.set_title(Some(&title));
                    let tip = if title == "○" { "metwo · daemon not running".to_string() } else { format!("metwo · {title}") };
                    let _ = tray.set_tooltip(Some(&tip));
                }
                last_title = title;
            }
            thread::sleep(Duration::from_secs(5));
        }
    });
}

// "2 +1" = two need you, one new assignment; "⟳1" = one lane working; "" = all quiet.
fn tray_title(tickets: &serde_json::Map<String, Value>) -> String {
    let status = |t: &Value| t.get("status").and_then(Value::as_str).unwrap_or("").to_string();
    let needs = tickets.values().filter(|t| NEEDS_YOU.contains(&status(t).as_str())).count();
    let assigned = tickets.values().filter(|t| status(t) == "assigned").count();
    let running = tickets.values().filter(|t| status(t) == "running").count();
    let mut parts = Vec::new();
    if needs > 0 {
        parts.push(needs.to_string());
    }
    if assigned > 0 {
        parts.push(format!("+{assigned}"));
    }
    if parts.is_empty() && running > 0 {
        parts.push(format!("⟳{running}"));
    }
    parts.join(" ")
}

fn notify_change<R: Runtime>(app: &AppHandle<R>, id: &str, t: &Value, before: Option<&Seen>, now: &Seen) {
    let title_of = |v: &Value| v.get("title").and_then(Value::as_str).unwrap_or("").to_string();
    let ticket_title = title_of(t);
    let status_changed = before.map_or(true, |b| b.status != now.status);
    let message = if status_changed {
        match now.status.as_str() {
            "assigned" if before.is_none() => Some((format!("New ticket · {id}"), ticket_title.clone())),
            "needs_input" => Some((format!("{id} has a question"), t.get("question").and_then(Value::as_str).unwrap_or(&ticket_title).chars().take(180).collect())),
            "review_ready" => Some((format!("{id} is ready for your review"), ticket_title.clone())),
            "no_change" => Some((format!("{id}: no change needed"), ticket_title.clone())),
            "failed" => {
                let why = t.pointer("/failure/title").and_then(Value::as_str).unwrap_or("failed");
                Some((format!("{id} · {why}"), t.pointer("/failure/hint").and_then(Value::as_str).unwrap_or(&ticket_title).to_string()))
            }
            "pr_draft" => Some((format!("{id} draft PR open"), ticket_title.clone())),
            _ => None,
        }
    } else if before.is_some_and(|b| now.comments > b.comments) {
        Some((format!("New PR comment on {id}"), ticket_title.clone()))
    } else {
        None
    };
    if let Some((title, body)) = message {
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

fn fetch_state() -> Option<Value> {
    let addr: SocketAddr = ([127, 0, 0, 1], daemon::PORT).into();
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    // HTTP/1.0 so the reply is a plain body that ends when the socket closes, never chunked
    let request = format!("GET /api/state HTTP/1.0\r\nHost: localhost:{}\r\n\r\n", daemon::PORT);
    stream.write_all(request.as_bytes()).ok()?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n")?;
    if !head.starts_with("HTTP/1.1 200") && !head.starts_with("HTTP/1.0 200") {
        return None;
    }
    serde_json::from_str(body).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_read_at_a_glance() {
        let make = |list: &[(&str, &str)]| -> serde_json::Map<String, Value> {
            list.iter().map(|(id, s)| (id.to_string(), serde_json::json!({ "status": s }))).collect()
        };
        assert_eq!(tray_title(&make(&[])), "");
        assert_eq!(tray_title(&make(&[("A", "running")])), "⟳1");
        assert_eq!(tray_title(&make(&[("A", "assigned")])), "+1");
        assert_eq!(tray_title(&make(&[("A", "review_ready"), ("B", "failed"), ("C", "assigned"), ("D", "running")])), "2 +1");
        assert_eq!(tray_title(&make(&[("A", "done"), ("B", "skipped")])), "");
    }
}

#[cfg(test)]
mod fetch_tests {
    use super::*;

    #[test]
    fn reads_the_daemon_state() {
        // a stand-in daemon on the real port, answering like Hono does
        let dir = std::env::temp_dir().join(format!("tf-watch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("s.cjs"),
            "require('http').createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({tickets:{'WEB-1':{status:'review_ready',title:'x',pr:{comments:[1,2]}}},nextPortIndex:0}))}).listen(4747)",
        )
        .unwrap();
        let mut child = std::process::Command::new("node").arg(dir.join("s.cjs")).spawn().unwrap();
        let mut state = None;
        for _ in 0..40 {
            state = fetch_state();
            if state.is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        child.kill().ok();
        let state = state.expect("state");
        let tickets = state.get("tickets").and_then(Value::as_object).unwrap();
        assert_eq!(tray_title(tickets), "1");
        assert_eq!(state.pointer("/tickets/WEB-1/pr/comments").and_then(Value::as_array).map(Vec::len), Some(2));
    }
}
