//! `install_apk`: install via adb when a device/emulator is attached
//! (PATH → $ANDROID_HOME → ~/Library/Android/sdk discovery), otherwise
//! download the APK (same-origin `Device` token, 100MB cap) and — on Termux —
//! fire the install intent. Parity with executeInstallApk in agent/index.js.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

use crate::config::Config;
use crate::exec::{self, CommandContext, ResultSender};
use crate::protocol;

/// install_apk downloads are refused beyond this size.
const APK_MAX_BYTES: usize = 100 * 1024 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const DEVICES_TIMEOUT: Duration = Duration::from_secs(15);
const INTENT_TIMEOUT: Duration = Duration::from_secs(15);

pub async fn execute(tx: ResultSender, config: Config, id: String, payload: Value) {
    let mut ctx = CommandContext::new(tx, id);
    ctx.running().await;
    match attempt(&mut ctx, &config, &payload).await {
        Ok(result) => ctx.done(result).await,
        Err(error) => ctx.fail(error).await,
    }
}

async fn attempt(ctx: &mut CommandContext, config: &Config, payload: &Value) -> Result<Value, String> {
    let adb = find_adb().await;
    let device = match &adb {
        Some(adb) => first_adb_device(ctx, adb).await,
        None => None,
    };
    let apk_path = obtain_apk(ctx, config, payload).await?;
    if let (Some(adb), Some(device)) = (adb, device) {
        ctx.step(&adb, &["-s", &device, "install", "-r", &apk_path], None, exec::DEFAULT_CMD_TIMEOUT).await?;
        return Ok(json!({ "installedTo": device, "apkPath": apk_path, "method": "adb" }));
    }
    let launched = if is_termux() { launch_install_intent(ctx, &apk_path).await } else { false };
    Ok(json!({ "savedTo": apk_path, "installIntentLaunched": launched }))
}

// --- adb ----------------------------------------------------------------------

/// First adb binary that answers, or None when adb is not installed.
async fn find_adb() -> Option<String> {
    for candidate in adb_candidates() {
        let probe = exec::run_capture(&candidate, &["version"], None, PROBE_TIMEOUT).await;
        if probe.ok {
            return Some(candidate);
        }
    }
    None
}

/// Serial of the first attached device/emulator, or None when none is online.
async fn first_adb_device(ctx: &mut CommandContext, adb: &str) -> Option<String> {
    let result = exec::run_capture(adb, &["devices", "-l"], None, DEVICES_TIMEOUT).await;
    ctx.append(&format!("$ {adb} devices -l\n{}", result.output));
    if !result.ok {
        return None;
    }
    parse_adb_devices(&result.output).into_iter().next()
}

/// Candidate adb binaries: PATH first, then the standard SDK locations.
fn adb_candidates() -> Vec<String> {
    let android_home = std::env::var("ANDROID_HOME").ok();
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    adb_candidates_from(android_home.as_deref(), &home)
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

fn adb_candidates_from(android_home: Option<&str>, home: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("adb")];
    if let Some(root) = android_home {
        candidates.push(PathBuf::from(root).join("platform-tools").join("adb"));
    }
    candidates.push(home.join("Library").join("Android").join("sdk").join("platform-tools").join("adb"));
    candidates
}

/// Serials of devices in state `device` from `adb devices [-l]` output.
fn parse_adb_devices(output: &str) -> Vec<String> {
    output
        .lines()
        .skip(1) // "List of devices attached"
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            (fields.len() >= 2 && fields[1] == "device").then(|| fields[0].to_string())
        })
        .collect()
}

// --- obtain the APK -------------------------------------------------------------

/// Local path of the APK to install: the chained build output when given.
async fn obtain_apk(ctx: &mut CommandContext, config: &Config, payload: &Value) -> Result<String, String> {
    if let Some(path) = payload.get("apkPath").and_then(Value::as_str) {
        if !Path::new(path).exists() {
            return Err(format!("APK not found at {path}"));
        }
        return Ok(path.to_string());
    }
    let url = payload
        .get("apkUrl")
        .and_then(Value::as_str)
        .ok_or("install_apk needs either apkUrl or apkPath in the payload")?;
    let app_name = payload.get("appName").and_then(Value::as_str);
    let dest = apk_path_for(url, app_name);
    let auth = download_auth(&config.server, url, &config.device_token);
    download_apk(ctx, url, &dest, auth.as_deref()).await?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Stream the APK to disk (redirects followed), enforcing the size cap.
async fn download_apk(
    ctx: &mut CommandContext,
    url: &str,
    dest: &Path,
    auth: Option<&str>,
) -> Result<(), String> {
    match try_download_apk(url, dest, auth).await {
        Ok(received) => {
            ctx.append(&format!("Downloaded {received} bytes → {}", dest.display()));
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::remove_file(dest);
            Err(error)
        }
    }
}

async fn try_download_apk(url: &str, dest: &Path, auth: Option<&str>) -> Result<u64, String> {
    let mut request = reqwest::Client::new().get(url);
    if let Some(auth) = auth {
        request = request.header("authorization", auth);
    }
    let mut response = request.send().await.map_err(|e| format!("APK download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("APK download failed (HTTP {})", response.status()));
    }
    let mut file = create_dest_file(dest).await?;
    let mut received: u64 = 0;
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("APK download failed: {e}"))? {
        received += chunk.len() as u64;
        if received > APK_MAX_BYTES as u64 {
            return Err("APK exceeds the 100MB limit".to_string());
        }
        file.write_all(&chunk).await.map_err(|e| format!("cannot write APK: {e}"))?;
    }
    Ok(received)
}

async fn create_dest_file(dest: &Path) -> Result<tokio::fs::File, String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create apks dir: {e}"))?;
    }
    tokio::fs::File::create(dest).await.map_err(|e| format!("cannot write APK: {e}"))
}

// --- Termux fallback ----------------------------------------------------------

/// True on Termux (Android userland): android target or TERMUX_VERSION set.
fn is_termux() -> bool {
    cfg!(target_os = "android") || std::env::var("TERMUX_VERSION").is_ok()
}

/// Try the `am start` install intent, falling back to termux-open.
async fn launch_install_intent(ctx: &mut CommandContext, apk_path: &str) -> bool {
    let args = [
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        &format!("file://{apk_path}"),
        "-t",
        "application/vnd.android.package-archive",
    ];
    let intent = exec::run_capture("am", &args, None, INTENT_TIMEOUT).await;
    ctx.append(&format!("$ am {}\n{}", args.join(" "), intent.output));
    if intent.ok {
        return true;
    }
    let fallback = exec::run_capture("termux-open", &[apk_path], None, INTENT_TIMEOUT).await;
    ctx.append(&format!("$ termux-open {apk_path}\n{}", fallback.output));
    fallback.ok
}

// --- pure helpers -----------------------------------------------------------------

fn apks_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".lemniscate-agent")
        .join("apks")
}

fn apk_path_for(apk_url: &str, app_name: Option<&str>) -> PathBuf {
    apks_root().join(apk_file_name(apk_url, app_name))
}

/// Deterministic APK file name: slug (app name or URL basename) + short hash.
fn apk_file_name(apk_url: &str, app_name: Option<&str>) -> String {
    let base = apk_slug_base(apk_url, app_name);
    let base = if base.is_empty() { "app".to_string() } else { base };
    format!("{}-{}.apk", base, protocol::short_hash(apk_url))
}

fn apk_slug_base(apk_url: &str, app_name: Option<&str>) -> String {
    if let Some(name) = app_name.filter(|n| !n.is_empty()) {
        return apk_slug(name);
    }
    let basename = url::Url::parse(apk_url)
        .ok()
        .and_then(|u| u.path_segments()?.next_back().map(str::to_string))
        .unwrap_or_default();
    apk_slug(&basename)
}

/// Lowercase alnum-and-dash slug, `.apk` suffix stripped (no length cap,
/// unlike repo slugs — mirrors apkSlugBase in agent/lib.js).
fn apk_slug(text: &str) -> String {
    let stripped = match text.to_lowercase().strip_suffix(".apk") {
        Some(head) => head.to_string(),
        None => text.to_lowercase(),
    };
    let mut out = String::with_capacity(stripped.len());
    let mut last_was_dash = true; // suppress leading dashes
    for ch in stripped.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_was_dash = false;
        } else if !last_was_dash {
            out.push('-');
            last_was_dash = true;
        }
    }
    out.trim_end_matches('-').to_string()
}

/// Auth header value for APK downloads from OUR server; None for external
/// URLs so no token leaks to third parties (mirrors downloadHeaders).
fn download_auth(server: &str, url: &str, device_token: &str) -> Option<String> {
    if device_token.is_empty() {
        return None;
    }
    let url = url::Url::parse(url).ok()?;
    let server = url::Url::parse(server).ok()?;
    (url.origin() == server.origin()).then(|| format!("Device {device_token}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- adb candidates / parsing (mirrors agent/lib.test.js) ----------------------

    #[test]
    fn adb_candidates_cover_path_and_standard_sdk_locations() {
        let home = Path::new("/home/u");
        let candidates = adb_candidates_from(Some("/opt/android-sdk"), home);
        assert_eq!(
            candidates,
            vec![
                PathBuf::from("adb"),
                PathBuf::from("/opt/android-sdk/platform-tools/adb"),
                PathBuf::from("/home/u/Library/Android/sdk/platform-tools/adb"),
            ]
        );
    }

    #[test]
    fn adb_candidates_skip_android_home_when_unset() {
        let candidates = adb_candidates_from(None, Path::new("/home/u"));
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0], PathBuf::from("adb"));
    }

    #[test]
    fn parse_adb_devices_returns_serials_in_state_device_only() {
        let output = "List of devices attached\n\
                      emulator-5554\tdevice\n\
                      0a1b2c3d\tunauthorized\n\
                      9x8y7z\toffline\n\n";
        assert_eq!(parse_adb_devices(output), vec!["emulator-5554".to_string()]);
    }

    #[test]
    fn parse_adb_devices_parses_dash_l_output_and_empty_lists() {
        let output = "List of devices attached\n\
                      emulator-5554\tdevice product:sdk model:Pixel device:emu64a\n\
                      192.168.1.5:5555\tdevice product:x model:y device:z\n";
        assert_eq!(
            parse_adb_devices(output),
            vec!["emulator-5554".to_string(), "192.168.1.5:5555".to_string()]
        );
        assert!(parse_adb_devices("List of devices attached\n").is_empty());
    }

    // --- apk file naming -------------------------------------------------------------

    #[test]
    fn apk_file_name_prefers_the_app_name_slug() {
        let name = apk_file_name("https://x.space/a/b.apk", Some("My Cool App!"));
        assert!(name.starts_with("my-cool-app-"), "got {name}");
        assert!(name.ends_with(".apk"));
    }

    #[test]
    fn apk_file_name_falls_back_to_the_url_basename_stripping_apk() {
        let name = apk_file_name("https://x.space/releases/Demo-App.APK?token=1", None);
        assert!(name.starts_with("demo-app-"), "got {name}");
    }

    #[test]
    fn apk_file_name_falls_back_to_app_for_opaque_urls_and_is_deterministic() {
        let url = "https://x.space/";
        let name = apk_file_name(url, None);
        assert!(name.starts_with("app-"), "got {name}");
        assert_eq!(name, apk_file_name(url, None));
    }

    // --- download auth -----------------------------------------------------------------

    #[test]
    fn download_auth_attaches_the_token_for_same_origin_downloads() {
        let auth = download_auth("https://lemniscate.x.space", "https://lemniscate.x.space/a.apk", "tok");
        assert_eq!(auth, Some("Device tok".to_string()));
    }

    #[test]
    fn download_auth_never_leaks_the_token_to_third_party_origins() {
        assert_eq!(download_auth("https://a.space", "https://evil.example/a.apk", "tok"), None);
        assert_eq!(download_auth("https://a.space", "https://a.space:8443/a.apk", "tok"), None);
    }

    #[test]
    fn download_auth_is_none_without_a_token_or_on_unparseable_urls() {
        assert_eq!(download_auth("https://a.space", "https://a.space/a.apk", ""), None);
        assert_eq!(download_auth("not a url", "https://a.space/a.apk", "tok"), None);
        assert_eq!(download_auth("https://a.space", "not a url", "tok"), None);
    }
}
