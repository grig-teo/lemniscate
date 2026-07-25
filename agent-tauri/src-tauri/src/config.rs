//! Pairing config persistence: device credentials under the OS config dir,
//! written owner-only (mode 0600 on unix) because the token is a secret.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub server: String,
    pub device_id: String,
    pub device_token: String,
    pub name: String,
    pub platform: String,
}

/// Default on-disk location: <config-dir>/lemniscate-agent/config.json.
pub fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("lemniscate-agent")
        .join("config.json")
}

/// Load persisted device credentials; `None` when missing or unreadable.
pub fn load(path: &Path) -> Option<Config> {
    let text = fs::read_to_string(path).ok()?;
    let config: Config = serde_json::from_str(&text).ok()?;
    if config.device_token.is_empty() || config.server.is_empty() {
        return None;
    }
    Some(config)
}

/// Persist device credentials owner-only.
pub fn save(config: &Config, path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(config).expect("config serializes") + "\n";
    write_owner_only(path, body.as_bytes())
}

/// Remove the persisted config (e.g. after the server rejects the token).
pub fn clear(path: &Path) {
    let _ = fs::remove_file(path);
}

#[cfg(unix)]
fn write_owner_only(path: &Path, body: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(body)?;
    // An existing file keeps its old mode — force 0600 either way.
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn write_owner_only(path: &Path, body: &[u8]) -> io::Result<()> {
    fs::write(path, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lemn-agent-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn sample_config() -> Config {
        Config {
            server: "https://x.space".into(),
            device_id: "d1".into(),
            device_token: "secret".into(),
            name: "Mac".into(),
            platform: "desktop".into(),
        }
    }

    #[test]
    fn save_load_round_trips() {
        let file = temp_file("config.json");
        let config = sample_config();
        save(&config, &file).unwrap();
        assert_eq!(load(&file), Some(config));
        let _ = fs::remove_file(&file);
    }

    #[cfg(unix)]
    #[test]
    fn save_writes_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let file = temp_file("config-0600.json");
        save(&sample_config(), &file).unwrap();
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = fs::remove_file(&file);
    }

    #[cfg(unix)]
    #[test]
    fn save_fixes_mode_on_preexisting_file() {
        use std::os::unix::fs::PermissionsExt;
        let file = temp_file("config-preexisting.json");
        fs::write(&file, "{}").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        save(&sample_config(), &file).unwrap();
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn load_returns_none_for_missing_or_invalid_files() {
        assert_eq!(load(Path::new("/nonexistent/lemn-agent.json")), None);
        let file = temp_file("bad.json");
        fs::write(&file, r#"{"deviceToken": 42}"#).unwrap();
        assert_eq!(load(&file), None);
        fs::write(&file, r#"{"server":"","deviceId":"d","deviceToken":"t","name":"n","platform":"desktop"}"#)
            .unwrap();
        assert_eq!(load(&file), None);
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn clear_removes_the_file() {
        let file = temp_file("config-clear.json");
        save(&sample_config(), &file).unwrap();
        clear(&file);
        assert!(!file.exists());
    }
}
