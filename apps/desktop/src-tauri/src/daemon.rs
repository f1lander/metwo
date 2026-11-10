// Supervises the Node daemon as a child process. It runs through an interactive login shell so it gets
// the same PATH as a terminal (claude, gh, pnpm, cloudflared), in its own process group so
// a stop also takes down the lanes it spawned.

use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const PORT: u16 = 4747;
const MAX_LOG_LINES: usize = 600;

pub const RESTART_CODE: i32 = 75;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub exit_code: Option<i32>,
    pub root: String,
    // true when something else (a terminal `pnpm daemon`) already owns the port
    pub external: bool,
}

struct Inner {
    child: Option<Child>,
    started_at: Option<String>,
    exit_code: Option<i32>,
}

#[derive(Clone)]
pub struct Daemon {
    root: PathBuf,
    inner: Arc<Mutex<Inner>>,
    logs: Arc<Mutex<VecDeque<String>>>,
}

impl Daemon {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            inner: Arc::new(Mutex::new(Inner { child: None, started_at: None, exit_code: None })),
            logs: Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LOG_LINES))),
        }
    }

    pub fn status(&self) -> DaemonStatus {
        let mut inner = self.inner.lock().unwrap();
        if let Some(child) = inner.child.as_mut() {
            if let Ok(Some(exit)) = child.try_wait() {
                inner.exit_code = exit.code();
                inner.child = None;
                self.log(&format!("[mevo] daemon exited ({})", exit));
            }
        }
        let own = inner.child.as_ref().map(|c| c.id());
        let external = own.is_none() && port_open();
        DaemonStatus {
            running: own.is_some() || external,
            pid: own,
            started_at: if own.is_some() { inner.started_at.clone() } else { None },
            exit_code: inner.exit_code,
            root: self.root.display().to_string(),
            external,
        }
    }

    pub fn start(&self) -> Result<DaemonStatus, String> {
        let current = self.status();
        if current.running {
            return Ok(current);
        }
        if !self.root.join("package.json").exists() {
            return Err(format!("mevo: project not found at {} (set METWO_ROOT)", self.root.display()));
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        // -i too: nvm and friends usually live in .zshrc, which a plain login shell skips
        let cmd = std::env::var("METWO_DAEMON_CMD").unwrap_or_else(|_| "exec pnpm daemon".into());
        let mut child = Command::new(shell)
            .args(["-lic", &cmd])
            .current_dir(&self.root)
            .env("FORCE_COLOR", "0")
            // tells the daemon it may exit with RESTART_CODE to pick up new code: we start it again
            .env("METWO_SUPERVISED", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .map_err(|e| format!("could not start the daemon: {e}"))?;

        if let Some(out) = child.stdout.take() {
            self.pipe(out, "");
        }
        if let Some(err) = child.stderr.take() {
            self.pipe(err, "");
        }
        self.log(&format!("[mevo] started daemon pid {} in {}", child.id(), self.root.display()));
        let mut inner = self.inner.lock().unwrap();
        inner.child = Some(child);
        inner.started_at = Some(now_iso());
        inner.exit_code = None;
        drop(inner);
        Ok(self.status())
    }

    // Only stops a daemon this app started; one started from a terminal is left alone.
    pub fn stop(&self) -> DaemonStatus {
        let child = self.inner.lock().unwrap().child.take();
        let owned = child.is_some();
        if let Some(mut child) = child {
            let pgid = child.id() as i32;
            self.log("[mevo] stopping daemon");
            // SIGTERM the whole group (daemon, its lanes, cloudflared), escalate if needed.
            unsafe { libc::kill(-pgid, libc::SIGTERM) };
            let deadline = Instant::now() + Duration::from_secs(6);
            loop {
                match child.try_wait() {
                    Ok(Some(exit)) => {
                        self.inner.lock().unwrap().exit_code = exit.code();
                        break;
                    }
                    _ if Instant::now() > deadline => {
                        unsafe { libc::kill(-pgid, libc::SIGKILL) };
                        let _ = child.wait();
                        break;
                    }
                    _ => thread::sleep(Duration::from_millis(150)),
                }
            }
        }
        // wait for the port to free so a restart does not trip over the old listener
        let deadline = Instant::now() + Duration::from_secs(4);
        while owned && port_open() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(150));
        }
        self.status()
    }

    // The daemon exits with RESTART_CODE when its code changed on disk and nothing is running;
    // this brings it straight back up on the new code.
    pub fn supervise(&self) {
        let me = self.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(2));
            let s = me.status();
            if !s.running && s.exit_code == Some(RESTART_CODE) {
                me.log("[mevo] the daemon restarted to load new code");
                if let Err(e) = me.start() {
                    me.log(&format!("[mevo] could not start it again: {e}"));
                    me.inner.lock().unwrap().exit_code = None;
                }
            }
        });
    }

    pub fn restart(&self) -> Result<DaemonStatus, String> {
        self.stop();
        self.start()
    }

    pub fn logs(&self) -> Vec<String> {
        self.logs.lock().unwrap().iter().cloned().collect()
    }

    fn log(&self, line: &str) {
        let mut logs = self.logs.lock().unwrap();
        if logs.len() >= MAX_LOG_LINES {
            logs.pop_front();
        }
        logs.push_back(line.to_string());
    }

    fn pipe<R: Read + Send + 'static>(&self, reader: R, prefix: &'static str) {
        let me = self.clone();
        thread::spawn(move || {
            for line in BufReader::new(reader).lines().map_while(Result::ok) {
                me.log(&format!("{prefix}{}", strip_ansi(&line)));
            }
        });
    }
}

pub fn port_open() -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], PORT).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

// Tiny HTTP POST to the daemon's control API, so the tray works without a webview round trip.
pub fn post(path: &str) -> Result<(), String> {
    let addr: SocketAddr = ([127, 0, 0, 1], PORT).into();
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
    let request = format!("POST {path} HTTP/1.1\r\nHost: localhost:{PORT}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}");
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut head = [0u8; 16];
    let n = stream.read(&mut head).map_err(|e| e.to_string())?;
    let status = String::from_utf8_lossy(&head[..n]);
    if status.contains(" 200") {
        Ok(())
    } else {
        Err(format!("daemon answered {}", status.lines().next().unwrap_or("")))
    }
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn now_iso() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // RFC 3339 in UTC without pulling chrono in
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days as i64);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervises_a_daemon_and_its_children() {
        let dir = std::env::temp_dir().join(format!("tf-sup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // fake daemon: listens on PORT and spawns a long-lived child, like a lane
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"fake","private":true,"scripts":{"daemon":"node server.cjs"}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("server.cjs"),
            "require('child_process').spawn('sleep',['300'],{stdio:'ignore'}).unref();\
             require('fs').writeFileSync('lane.pid','x');\
             require('http').createServer((q,r)=>r.end('ok')).listen(4747,()=>console.log('daemon up'))",
        )
        .unwrap();
        std::env::set_var("SHELL", "/bin/bash");

        let d = Daemon::new(dir.clone());
        assert!(!d.status().running, "port must be free before the test");
        let s = d.start().unwrap();
        assert!(s.pid.is_some());
        let deadline = Instant::now() + Duration::from_secs(20);
        while !port_open() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(200));
        }
        assert!(port_open(), "daemon should listen; logs: {:?}", d.logs());
        assert!(d.logs().iter().any(|l| l.contains("daemon up")), "stdout captured: {:?}", d.logs());

        let pgid = s.pid.unwrap() as i32;
        let stopped = d.stop();
        assert!(!stopped.running);
        assert!(!port_open());
        // nothing left in the process group: the "lane" died with the daemon
        // zombies do not count: in a container without an init nothing reaps them
        let ps = Command::new("ps").args(["-eo", "pgid=,stat=,comm="]).output().unwrap();
        let left: Vec<String> = String::from_utf8_lossy(&ps.stdout)
            .lines()
            .filter(|l| l.split_whitespace().next() == Some(&pgid.to_string()) && !l.split_whitespace().nth(1).unwrap_or("").starts_with('Z'))
            .map(String::from)
            .collect();
        assert!(left.is_empty(), "process group should be gone: {left:?}");

        // a daemon started outside the app is reported as external and left alone
        let mut outside = Command::new("node").arg(dir.join("server.cjs")).current_dir(&dir).spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !port_open() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(100));
        }
        let ext = d.status();
        assert!(ext.running && ext.external && ext.pid.is_none());
        let t = Instant::now();
        d.stop();
        assert!(port_open(), "external daemon must survive stop()");
        assert!(t.elapsed() < Duration::from_secs(1), "stop() must not wait on a port it does not own");
        outside.kill().ok();
        let _ = outside.wait();
        let _ = std::process::Command::new("pkill").args(["-f", "sleep 300"]).status();

        // exit code 75 (new code on disk): supervise() starts it again; it boots fine the second time
        let deadline = Instant::now() + Duration::from_secs(5);
        while port_open() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(100));
        }
        std::fs::write(
            dir.join("server.cjs"),
            "const fs=require('fs');\
             if(!fs.existsSync('booted')){fs.writeFileSync('booted','1');console.log('restart please');process.exit(75)}\
             require('http').createServer((q,r)=>r.end('ok')).listen(4747,()=>console.log('daemon up again'))",
        )
        .unwrap();
        let _ = std::fs::remove_file(dir.join("booted"));
        d.supervise();
        d.start().unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !port_open() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(200));
        }
        assert!(port_open(), "supervise() should start it again after 75; logs: {:?}", d.logs());
        assert!(d.logs().iter().any(|l| l.contains("restarted to load new code")), "{:?}", d.logs());
        d.stop();
    }
}
