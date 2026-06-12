use base64::Engine;
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};
use tiny_http::{Header, Response, Server, StatusCode};
use url::Url;

const PORT: u16 = 12999;
const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MOBILE_UA: &str = "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

#[derive(Clone)]
struct AppState {
    inner: Arc<Mutex<Option<IptvStore>>>,
    headers: Arc<Mutex<Option<ChannelHeaders>>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            headers: Arc::new(Mutex::new(None)),
        }
    }

    fn with_store<T>(&self, f: impl FnOnce(&IptvStore) -> Result<T, String>) -> Result<T, String> {
        let guard = self.inner.lock().map_err(|e| e.to_string())?;
        let store = guard.as_ref().ok_or_else(|| "store is not initialized".to_string())?;
        f(store)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Channel {
    name: String,
    url: String,
    logo: String,
    logo_url: String,
    group: String,
    user_agent: String,
    referrer: String,
    source_id: i64,
    source_name: String,
    source_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedChannel {
    name: String,
    url: String,
    logo: String,
    group: String,
    user_agent: String,
    referrer: String,
}

#[derive(Debug, Clone, Serialize)]
struct PlaylistSource {
    id: i64,
    name: String,
    url: String,
    enabled: i64,
    priority: i64,
    last_fetch_at: Option<String>,
    last_success_at: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelHeaders {
    url: Option<String>,
    user_agent: Option<String>,
    referrer: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveDialogOptions {
    default_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct RefreshResult {
    results: Vec<RefreshSourceResult>,
    channels: Vec<Channel>,
}

#[derive(Debug, Clone, Serialize)]
struct RefreshSourceResult {
    url: String,
    ok: bool,
    count: Option<usize>,
    error: Option<String>,
}

struct IptvStore {
    db_path: PathBuf,
    logo_cache_dir: PathBuf,
    user_data_dir: PathBuf,
}

impl IptvStore {
    fn new(user_data_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&user_data_dir).map_err(|e| e.to_string())?;
        let logo_cache_dir = user_data_dir.join("logo-cache");
        fs::create_dir_all(&logo_cache_dir).map_err(|e| e.to_string())?;
        let store = Self {
            db_path: user_data_dir.join("my-iptv.db"),
            logo_cache_dir,
            user_data_dir,
        };
        store.init()?;
        Ok(store)
    }

    fn connect(&self) -> Result<Connection, String> {
        Connection::open(&self.db_path).map_err(|e| e.to_string())
    }

    fn init(&self) -> Result<(), String> {
        let db = self.connect()?;
        db.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
        db.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
        db.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS playlist_sources (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              url TEXT NOT NULL UNIQUE,
              enabled INTEGER NOT NULL DEFAULT 1,
              priority INTEGER NOT NULL DEFAULT 100,
              last_fetch_at TEXT,
              last_success_at TEXT,
              etag TEXT,
              last_modified TEXT,
              status TEXT
            );
            CREATE TABLE IF NOT EXISTS channels (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              source_id INTEGER NOT NULL,
              name TEXT NOT NULL,
              url TEXT NOT NULL,
              logo_url TEXT,
              logo_cache_key TEXT,
              group_title TEXT,
              user_agent TEXT,
              referrer TEXT,
              normalized_key TEXT NOT NULL,
              enabled INTEGER NOT NULL DEFAULT 1,
              last_seen_at TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (source_id) REFERENCES playlist_sources(id) ON DELETE CASCADE,
              UNIQUE(source_id, url)
            );
            CREATE INDEX IF NOT EXISTS idx_channels_url ON channels(url);
            CREATE INDEX IF NOT EXISTS idx_channels_group ON channels(group_title);
            CREATE INDEX IF NOT EXISTS idx_channels_seen ON channels(last_seen_at);
            CREATE TABLE IF NOT EXISTS favorites (channel_url TEXT PRIMARY KEY, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS play_history (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_url TEXT NOT NULL, played_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS channel_health (
              channel_url TEXT PRIMARY KEY,
              last_check_at TEXT NOT NULL,
              status TEXT NOT NULL,
              latency_ms INTEGER,
              fail_count INTEGER NOT NULL DEFAULT 0,
              last_error TEXT
            );
            CREATE TABLE IF NOT EXISTS logo_cache (
              logo_url TEXT PRIMARY KEY,
              cache_key TEXT NOT NULL UNIQUE,
              file_path TEXT NOT NULL,
              content_type TEXT,
              size_bytes INTEGER NOT NULL DEFAULT 0,
              etag TEXT,
              last_modified TEXT,
              last_access_at TEXT NOT NULL,
              expires_at TEXT
            );
            "#,
        )
        .map_err(|e| e.to_string())?;
        db.execute(
            "INSERT OR IGNORE INTO playlist_sources (name, url, enabled, priority, status) VALUES (?1, ?2, 1, ?3, 'seeded')",
            params!["ZBDS IPTV", "https://live.zbds.top/tv/iptv4.m3u", 10],
        ).map_err(|e| e.to_string())?;
        db.execute(
            "INSERT OR IGNORE INTO playlist_sources (name, url, enabled, priority, status) VALUES (?1, ?2, 1, ?3, 'seeded')",
            params!["IPTV Org", "https://iptv-org.github.io/iptv/index.m3u", 20],
        ).map_err(|e| e.to_string())?;
        if self.list_channels()?.is_empty() {
            self.import_bootstrap_channels()?;
        }
        Ok(())
    }

    fn settings_path(&self) -> PathBuf {
        self.user_data_dir.join("settings.json")
    }

    fn last_channel_path(&self) -> PathBuf {
        self.user_data_dir.join("last-channel.json")
    }

    fn debug_log_path(&self) -> PathBuf {
        self.user_data_dir.join("debug-log.txt")
    }

    fn list_channels(&self) -> Result<Vec<Channel>, String> {
        let db = self.connect()?;
        let mut stmt = db.prepare(
            r#"
            SELECT c.name, c.url, c.logo_url, c.group_title, c.user_agent, c.referrer,
              ps.id AS source_id, ps.name AS source_name, ps.url AS source_url
            FROM channels c
            JOIN playlist_sources ps ON ps.id = c.source_id
            WHERE c.enabled = 1
            ORDER BY c.name COLLATE NOCASE ASC
            "#,
        ).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let logo_url: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
                Ok(Channel {
                    name: row.get(0)?,
                    url: row.get(1)?,
                    logo: if logo_url.is_empty() {
                        String::new()
                    } else {
                        format!("http://127.0.0.1:{PORT}/logo?url={}", encode_component(&logo_url))
                    },
                    logo_url,
                    group: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    user_agent: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    referrer: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    source_id: row.get(6)?,
                    source_name: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                    source_url: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for row in rows {
            let channel = row.map_err(|e| e.to_string())?;
            if seen.insert(channel.url.clone()) {
                out.push(channel);
            }
        }
        Ok(out)
    }

    fn import_bootstrap_channels(&self) -> Result<(), String> {
        let channels = parse_m3u(include_str!("../../channels.m3u"));
        if channels.is_empty() {
            return Ok(());
        }
        let db = self.connect()?;
        db.execute(
            "INSERT OR IGNORE INTO playlist_sources (name, url, enabled, priority, status) VALUES (?1, ?2, 1, 0, 'local')",
            params!["Pre-compiled", "embedded://channels.m3u"],
        ).map_err(|e| e.to_string())?;
        let source_id: i64 = db
            .query_row("SELECT id FROM playlist_sources WHERE url = ?1", params!["embedded://channels.m3u"], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        drop(db);
        self.replace_source_channels(source_id, &channels)
    }

    fn playlist_sources(&self, enabled_only: bool) -> Result<Vec<PlaylistSource>, String> {
        let db = self.connect()?;
        let sql = if enabled_only {
            "SELECT id, name, url, enabled, priority, last_fetch_at, last_success_at, status FROM playlist_sources WHERE enabled = 1 ORDER BY priority ASC, id ASC"
        } else {
            "SELECT id, name, url, enabled, priority, last_fetch_at, last_success_at, status FROM playlist_sources ORDER BY priority ASC, id ASC"
        };
        let mut stmt = db.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(PlaylistSource {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    url: row.get(2)?,
                    enabled: row.get(3)?,
                    priority: row.get(4)?,
                    last_fetch_at: row.get(5)?,
                    last_success_at: row.get(6)?,
                    status: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    fn replace_source_channels(&self, source_id: i64, channels: &[ParsedChannel]) -> Result<(), String> {
        let mut db = self.connect()?;
        let seen_at = now_iso();
        let tx = db.transaction().map_err(|e| e.to_string())?;
        for ch in channels {
            if ch.url.is_empty() {
                continue;
            }
            let created_at: Option<String> = tx
                .query_row(
                    "SELECT created_at FROM channels WHERE source_id = ?1 AND url = ?2",
                    params![source_id, ch.url],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            tx.execute(
                r#"
                INSERT INTO channels (
                  source_id, name, url, logo_url, logo_cache_key, group_title, user_agent, referrer,
                  normalized_key, enabled, last_seen_at, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11, ?10)
                ON CONFLICT(source_id, url) DO UPDATE SET
                  name = excluded.name,
                  logo_url = excluded.logo_url,
                  logo_cache_key = excluded.logo_cache_key,
                  group_title = excluded.group_title,
                  user_agent = excluded.user_agent,
                  referrer = excluded.referrer,
                  normalized_key = excluded.normalized_key,
                  enabled = 1,
                  last_seen_at = excluded.last_seen_at,
                  updated_at = excluded.updated_at
                "#,
                params![
                    source_id,
                    fallback(&ch.name, "Unknown"),
                    ch.url,
                    ch.logo,
                    if ch.logo.is_empty() { String::new() } else { logo_cache_key(&ch.logo) },
                    ch.group,
                    ch.user_agent,
                    ch.referrer,
                    format!("{}|{}", ch.name.to_lowercase(), ch.url),
                    seen_at,
                    created_at.unwrap_or_else(|| seen_at.clone()),
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "UPDATE channels SET enabled = 0, updated_at = ?1 WHERE source_id = ?2 AND last_seen_at != ?1",
            params![seen_at, source_id],
        ).map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE playlist_sources SET last_fetch_at = ?1, last_success_at = ?1, status = ?2 WHERE id = ?3",
            params![seen_at, format!("ok:{}", channels.len()), source_id],
        ).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    fn mark_source_fetch_failed(&self, source_id: i64, error: &str) -> Result<(), String> {
        let db = self.connect()?;
        db.execute(
            "UPDATE playlist_sources SET last_fetch_at = ?1, status = ?2 WHERE id = ?3",
            params![now_iso(), format!("error:{}", error.chars().take(160).collect::<String>()), source_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn get_favorites(&self) -> Result<Vec<String>, String> {
        let db = self.connect()?;
        let mut stmt = db.prepare("SELECT channel_url FROM favorites ORDER BY created_at ASC").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| row.get(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    fn toggle_favorite(&self, channel_url: String) -> Result<Vec<String>, String> {
        let db = self.connect()?;
        let exists: Option<String> = db
            .query_row("SELECT channel_url FROM favorites WHERE channel_url = ?1", params![channel_url], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if exists.is_some() {
            db.execute("DELETE FROM favorites WHERE channel_url = ?1", params![channel_url]).map_err(|e| e.to_string())?;
        } else {
            db.execute("INSERT INTO favorites (channel_url, created_at) VALUES (?1, ?2)", params![channel_url, now_iso()]).map_err(|e| e.to_string())?;
        }
        self.get_favorites()
    }

    fn record_play(&self, channel_url: String) -> Result<(), String> {
        let db = self.connect()?;
        db.execute("INSERT INTO play_history (channel_url, played_at) VALUES (?1, ?2)", params![channel_url, now_iso()]).map_err(|e| e.to_string())?;
        self.update_channel_health(channel_url, "playing".to_string(), None)
    }

    fn update_channel_health(&self, channel_url: String, status: String, error: Option<String>) -> Result<(), String> {
        let db = self.connect()?;
        let fail_count: i64 = if status == "error" {
            db.query_row("SELECT fail_count FROM channel_health WHERE channel_url = ?1", params![channel_url], |row| row.get(0))
                .optional()
                .map_err(|e| e.to_string())?
                .unwrap_or(0) + 1
        } else {
            0
        };
        db.execute(
            r#"
            INSERT INTO channel_health (channel_url, last_check_at, status, fail_count, last_error)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(channel_url) DO UPDATE SET
              last_check_at = excluded.last_check_at,
              status = excluded.status,
              fail_count = excluded.fail_count,
              last_error = excluded.last_error
            "#,
            params![channel_url, now_iso(), status, fail_count, error.unwrap_or_default()],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn write_debug_log(&self, value: serde_json::Value) -> Result<PathBuf, String> {
        let mut map = serde_json::Map::new();
        map.insert("time".into(), serde_json::Value::String(now_iso()));
        if let serde_json::Value::Object(obj) = value {
            for (k, v) in obj {
                map.insert(k, v);
            }
        }
        let line = serde_json::Value::Object(map).to_string() + "\n";
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.debug_log_path())
            .and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()))
            .map_err(|e| e.to_string())?;
        Ok(self.debug_log_path())
    }
}

#[tauri::command]
fn get_channels(state: State<AppState>) -> Result<Vec<Channel>, String> {
    state.with_store(|store| store.list_channels())
}

#[tauri::command]
fn refresh_channels(state: State<AppState>) -> Result<RefreshResult, String> {
    let client = http_client()?;
    state.with_store(|store| {
        let sources = store.playlist_sources(true)?;
        let mut results = Vec::new();
        for source in sources {
            match fetch_text(&client, &source.url, None) {
                Ok(text) => {
                    let channels = if source.url.ends_with(".json") {
                        serde_json::from_str::<Vec<ParsedChannel>>(&text).map_err(|e| e.to_string())?
                    } else {
                        parse_m3u(&text)
                    };
                    store.replace_source_channels(source.id, &channels)?;
                    results.push(RefreshSourceResult { url: source.url, ok: true, count: Some(channels.len()), error: None });
                }
                Err(e) => {
                    let _ = store.mark_source_fetch_failed(source.id, &e);
                    results.push(RefreshSourceResult { url: source.url, ok: false, count: None, error: Some(e) });
                }
            }
        }
        Ok(RefreshResult { results, channels: store.list_channels()? })
    })
}

#[tauri::command]
fn get_playlist_sources(state: State<AppState>) -> Result<Vec<PlaylistSource>, String> {
    state.with_store(|store| store.playlist_sources(false))
}

#[tauri::command]
fn get_favorites(state: State<AppState>) -> Result<Vec<String>, String> {
    state.with_store(|store| store.get_favorites())
}

#[tauri::command]
fn toggle_favorite(channel_id: String, state: State<AppState>) -> Result<Vec<String>, String> {
    state.with_store(|store| store.toggle_favorite(channel_id))
}

#[tauri::command]
fn set_channel_headers(headers: ChannelHeaders, state: State<AppState>) -> Result<(), String> {
    *state.headers.lock().map_err(|e| e.to_string())? = Some(headers);
    Ok(())
}

#[tauri::command]
fn get_last_channel(state: State<AppState>) -> Result<Option<serde_json::Value>, String> {
    state.with_store(|store| read_json_file(&store.last_channel_path()))
}

#[tauri::command]
fn save_last_channel(url: String, state: State<AppState>) -> Result<(), String> {
    state.with_store(|store| write_json_file(&store.last_channel_path(), &serde_json::json!({ "url": url })))
}

#[tauri::command]
fn record_play(url: String, state: State<AppState>) -> Result<(), String> {
    if url.is_empty() {
        return Ok(());
    }
    state.with_store(|store| store.record_play(url))
}

#[tauri::command]
fn update_channel_health(url: String, status: String, error: Option<String>, state: State<AppState>) -> Result<(), String> {
    if url.is_empty() {
        return Ok(());
    }
    state.with_store(|store| store.update_channel_health(url, status, error))
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Result<Option<serde_json::Value>, String> {
    state.with_store(|store| read_json_file(&store.settings_path()))
}

#[tauri::command]
fn save_settings(settings: serde_json::Value, state: State<AppState>) -> Result<(), String> {
    state.with_store(|store| write_json_file(&store.settings_path(), &settings))
}

#[tauri::command]
fn write_debug_log(entry: serde_json::Value, state: State<AppState>) -> Result<serde_json::Value, String> {
    state.with_store(|store| {
        let path = store.write_debug_log(entry)?;
        Ok(serde_json::json!({ "ok": true, "path": path }))
    })
}

#[tauri::command]
fn save_file(options: SaveDialogOptions, data: String) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(default_name) = options.default_name {
        dialog = dialog.set_file_name(default_name);
    }
    let Some(path) = dialog.save_file() else {
        return Ok(None);
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let state = app.state::<AppState>();
            let store = IptvStore::new(app_data_dir).map_err(std::io::Error::other)?;
            *state.inner.lock().map_err(|e| std::io::Error::other(e.to_string()))? = Some(store);
            start_proxy_server(state.inner.clone(), state.headers.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_channels,
            refresh_channels,
            get_playlist_sources,
            get_favorites,
            toggle_favorite,
            set_channel_headers,
            get_last_channel,
            save_last_channel,
            record_play,
            update_channel_health,
            get_settings,
            save_settings,
            write_debug_log,
            save_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn start_proxy_server(store: Arc<Mutex<Option<IptvStore>>>, headers: Arc<Mutex<Option<ChannelHeaders>>>) {
    thread::spawn(move || {
        let Ok(server) = Server::http(("127.0.0.1", PORT)) else {
            return;
        };
        let Ok(client) = http_client() else {
            return;
        };
        for request in server.incoming_requests() {
            let url = request.url().to_string();
            if url.starts_with("/logo") {
                handle_logo(request, &client, &store);
            } else if url.starts_with("/proxy") {
                let channel_headers = headers.lock().ok().and_then(|h| h.clone());
                handle_proxy(request, &client, channel_headers, 0);
            } else {
                let _ = request.respond(Response::empty(StatusCode(404)));
            }
        }
    });
}

fn handle_logo(request: tiny_http::Request, client: &Client, store: &Arc<Mutex<Option<IptvStore>>>) {
    let Some(logo_url) = query_param(request.url(), "url") else {
        let _ = request.respond(Response::empty(StatusCode(204)));
        return;
    };
    let guard = match store.lock() {
        Ok(guard) => guard,
        Err(_) => {
            let _ = request.respond(Response::empty(StatusCode(204)));
            return;
        }
    };
    let Some(store) = guard.as_ref() else {
        let _ = request.respond(Response::empty(StatusCode(204)));
        return;
    };
    match load_or_fetch_logo(store, client, &logo_url) {
        Ok((bytes, content_type)) => {
            let response = Response::from_data(bytes).with_header(header("Content-Type", &content_type));
            let _ = request.respond(response);
        }
        Err(_) => {
            let _ = request.respond(Response::empty(StatusCode(204)));
        }
    }
}

fn handle_proxy(request: tiny_http::Request, client: &Client, headers: Option<ChannelHeaders>, depth: usize) {
    if depth > 5 {
        let _ = request.respond(Response::from_string("Too many redirects").with_status_code(502));
        return;
    }
    let Some(target_url) = query_param(request.url(), "url") else {
        let _ = request.respond(Response::from_string("Missing url").with_status_code(400));
        return;
    };
    match fetch_bytes(client, &target_url, headers.as_ref()) {
        Ok(FetchedResponse { status, content_type, bytes, final_url }) => {
            if is_m3u8(&target_url, &content_type, &bytes) {
                let body = String::from_utf8_lossy(&bytes);
                let rewritten = rewrite_m3u8(&body, &final_url);
                let response = Response::from_string(rewritten)
                    .with_status_code(status)
                    .with_header(header("Content-Type", "application/vnd.apple.mpegurl"))
                    .with_header(header("Access-Control-Allow-Origin", "*"))
                    .with_header(header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"));
                let _ = request.respond(response);
            } else {
                let response = Response::from_data(bytes)
                    .with_status_code(status)
                    .with_header(header("Content-Type", fallback(&content_type, "application/octet-stream")))
                    .with_header(header("Access-Control-Allow-Origin", "*"))
                    .with_header(header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"));
                let _ = request.respond(response);
            }
        }
        Err(e) => {
            let _ = request.respond(Response::from_string(e).with_status_code(502));
        }
    }
}

struct FetchedResponse {
    status: u16,
    content_type: String,
    bytes: Vec<u8>,
    final_url: String,
}

fn fetch_bytes(client: &Client, target_url: &str, headers: Option<&ChannelHeaders>) -> Result<FetchedResponse, String> {
    let mut req = client.get(target_url).header("User-Agent", headers.and_then(|h| h.user_agent.as_deref()).unwrap_or(MOBILE_UA));
    if let Some(referrer) = headers.and_then(|h| h.referrer.as_deref()) {
        req = req.header("Referer", referrer);
    }
    let mut res = req.send().map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}"));
    }
    let final_url = res.url().to_string();
    let content_type = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut bytes = Vec::new();
    res.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(FetchedResponse { status, content_type, bytes, final_url })
}

fn fetch_text(client: &Client, target_url: &str, headers: Option<&ChannelHeaders>) -> Result<String, String> {
    let fetched = fetch_bytes(client, target_url, headers)?;
    String::from_utf8(fetched.bytes).map_err(|e| e.to_string())
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(DEFAULT_UA)
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())
}

fn parse_m3u(text: &str) -> Vec<ParsedChannel> {
    let mut result = Vec::new();
    let mut cur: Option<ParsedChannel> = None;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("#EXTINF:") {
            let name = t.rsplit_once(',').map(|(_, name)| name.trim()).unwrap_or("Unknown");
            cur = Some(ParsedChannel {
                name: name.to_string(),
                logo: attr(t, "tvg-logo").unwrap_or_default(),
                group: attr(t, "group-title").unwrap_or_default(),
                url: String::new(),
                user_agent: String::new(),
                referrer: String::new(),
            });
        } else if let Some(value) = t.strip_prefix("#EXTVLCOPT:http-user-agent=") {
            if let Some(ch) = &mut cur {
                ch.user_agent = value.to_string();
            }
        } else if let Some(value) = t.strip_prefix("#EXTVLCOPT:http-referrer=") {
            if let Some(ch) = &mut cur {
                ch.referrer = value.to_string();
            }
        } else if !t.is_empty() && !t.starts_with('#') {
            if let Some(mut ch) = cur.take() {
                ch.url = t.to_string();
                result.push(ch);
            }
        }
    }
    result
}

fn attr(text: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let start = text.find(&needle)? + needle.len();
    let rest = &text[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn rewrite_m3u8(content: &str, base_url: &str) -> String {
    content
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            if !trimmed.is_empty() && !trimmed.starts_with('#') && !is_absolute_url(trimmed) {
                return resolve_url(base_url, trimmed);
            }
            if trimmed.contains("URI=\"") {
                return rewrite_uri_attrs(trimmed, base_url);
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn rewrite_uri_attrs(line: &str, base_url: &str) -> String {
    let mut out = String::new();
    let mut rest = line;
    while let Some(pos) = rest.find("URI=\"") {
        out.push_str(&rest[..pos + 5]);
        let after = &rest[pos + 5..];
        if let Some(end) = after.find('"') {
            let uri = &after[..end];
            out.push_str(&if is_absolute_url(uri) || uri.starts_with("data:") { uri.to_string() } else { resolve_url(base_url, uri) });
            out.push('"');
            rest = &after[end + 1..];
        } else {
            out.push_str(after);
            rest = "";
        }
    }
    out.push_str(rest);
    out
}

fn resolve_url(base_url: &str, relative: &str) -> String {
    Url::parse(base_url)
        .ok()
        .and_then(|base| base.join(relative).ok())
        .map(|url| url.to_string())
        .unwrap_or_else(|| relative.to_string())
}

fn is_m3u8(target_url: &str, content_type: &str, bytes: &[u8]) -> bool {
    content_type.contains("mpegurl")
        || content_type.contains("x-mpegurl")
        || target_url.contains(".m3u8")
        || bytes.starts_with(b"#EXTM3U")
}

fn load_or_fetch_logo(store: &IptvStore, client: &Client, logo_url: &str) -> Result<(Vec<u8>, String), String> {
    if !logo_url.starts_with("http://") && !logo_url.starts_with("https://") {
        return Err("unsupported logo url".into());
    }
    let db = store.connect()?;
    let cached: Option<(String, String)> = db
        .query_row("SELECT file_path, content_type FROM logo_cache WHERE logo_url = ?1", params![logo_url], |row| Ok((row.get(0)?, row.get::<_, Option<String>>(1)?.unwrap_or_default())))
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((file_path, content_type)) = cached {
        if let Ok(bytes) = fs::read(&file_path) {
            let _ = db.execute("UPDATE logo_cache SET last_access_at = ?1 WHERE logo_url = ?2", params![now_iso(), logo_url]);
            return Ok((bytes, fallback(&content_type, "application/octet-stream").to_string()));
        }
    }
    let fetched = fetch_bytes(client, logo_url, None)?;
    if fetched.bytes.len() > 2 * 1024 * 1024 {
        return Err("Logo too large".into());
    }
    let content_type = fallback(&fetched.content_type, "application/octet-stream").to_string();
    let key = logo_cache_key(logo_url);
    let ext = logo_extension(&content_type, logo_url);
    let file_path = store.logo_cache_dir.join(&key[..2]).join(format!("{key}{ext}"));
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&file_path, &fetched.bytes).map_err(|e| e.to_string())?;
    db.execute(
        r#"
        INSERT INTO logo_cache (logo_url, cache_key, file_path, content_type, size_bytes, last_access_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(logo_url) DO UPDATE SET
          file_path = excluded.file_path,
          content_type = excluded.content_type,
          size_bytes = excluded.size_bytes,
          last_access_at = excluded.last_access_at
        "#,
        params![logo_url, key, file_path.to_string_lossy(), content_type, fetched.bytes.len() as i64, now_iso()],
    ).map_err(|e| e.to_string())?;
    Ok((fetched.bytes, content_type))
}

fn logo_extension(content_type: &str, logo_url: &str) -> &'static str {
    match content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/webp" => ".webp",
        "image/svg+xml" => ".svg",
        _ if logo_url.ends_with(".png") => ".png",
        _ if logo_url.ends_with(".jpg") || logo_url.ends_with(".jpeg") => ".jpg",
        _ if logo_url.ends_with(".webp") => ".webp",
        _ if logo_url.ends_with(".svg") => ".svg",
        _ => ".img",
    }
}

fn logo_cache_key(url: &str) -> String {
    format!("{:x}", Sha1::digest(url.as_bytes()))
}

fn read_json_file(path: &Path) -> Result<Option<serde_json::Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map(Some).map_err(|e| e.to_string())
}

fn write_json_file(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

fn query_param(request_url: &str, name: &str) -> Option<String> {
    Url::parse(&format!("http://localhost{request_url}"))
        .ok()?
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.to_string())
}

fn encode_component(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn fallback<'a>(value: &'a str, default_value: &'a str) -> &'a str {
    if value.is_empty() { default_value } else { value }
}

fn is_absolute_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

fn now_iso() -> String {
    let duration = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{}", duration.as_secs())
}
