//! `build_android`: clone/pull, gradle build inside the android build box
//! docker image, pick the newest APK from the module outputs, upload it to
//! the server with the device token. Parity with executeBuildAndroid.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::config::Config;
use crate::exec::{self, CommandContext, ResultSender};

const GRADLE_BUILD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const DEFAULT_IMAGE: &str = "mingc/android-build-box:1.29.0";
const DEFAULT_MODULE: &str = "app";
const DEFAULT_TASK: &str = "assembleDebug";

pub async fn execute(tx: ResultSender, config: Config, id: String, payload: Value) {
    let mut ctx = CommandContext::new(tx, id);
    ctx.running().await;
    match attempt(&mut ctx, &config, &payload).await {
        Ok(result) => ctx.done(result).await,
        Err(error) => ctx.fail_with_log(error, &config.server, &config.device_token).await,
    }
}

async fn attempt(ctx: &mut CommandContext, config: &Config, payload: &Value) -> Result<Value, String> {
    let repo_url = exec::required_str(payload, "repoUrl", "build_android")?;
    let branch = exec::required_str(payload, "branch", "build_android")?;
    let project_dir = exec::ensure_repo(ctx, &repo_url, &branch).await?;
    ensure_gradlew_executable(ctx, &project_dir)?;
    build_apk_in_docker(ctx, &project_dir, payload).await?;
    let module = payload.get("gradleModule").and_then(Value::as_str).unwrap_or(DEFAULT_MODULE);
    let apk = find_newest_apk(&project_dir, module)
        .ok_or("Build succeeded but no APK was found in the outputs")?;
    upload_apk(ctx, config, payload, &apk).await
}

/// gradlew must be executable inside the container; best-effort chmod.
fn ensure_gradlew_executable(ctx: &mut CommandContext, project_dir: &Path) -> Result<(), String> {
    let gradlew = project_dir.join("gradlew");
    if !gradlew.exists() {
        return Err("gradlew not found at repo root".to_string());
    }
    set_executable(&gradlew)?;
    ctx.append("chmod +x gradlew");
    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("cannot chmod gradlew: {e}"))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Run the gradle build inside the android build box image.
async fn build_apk_in_docker(
    ctx: &mut CommandContext,
    project_dir: &Path,
    payload: &Value,
) -> Result<(), String> {
    let image = payload.get("image").and_then(Value::as_str).unwrap_or(DEFAULT_IMAGE);
    let module = payload.get("gradleModule").and_then(Value::as_str).unwrap_or(DEFAULT_MODULE);
    let task = payload.get("gradleTask").and_then(Value::as_str).unwrap_or(DEFAULT_TASK);
    let docker = exec::require_docker().await?;
    let args = gradle_docker_args(project_dir, image, module, task);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    ctx.step(&docker, &refs, None, GRADLE_BUILD_TIMEOUT).await?;
    Ok(())
}

/// POST the APK to the server, authenticated with this device's own token.
async fn upload_apk(
    ctx: &mut CommandContext,
    config: &Config,
    payload: &Value,
    apk_path: &Path,
) -> Result<Value, String> {
    let apk_name = apk_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or("APK path has no file name")?;
    let upload_base = exec::required_str(payload, "uploadBaseUrl", "build_android")?;
    let body = tokio::fs::read(apk_path).await.map_err(|e| format!("cannot read APK: {e}"))?;
    let key = exec::post_artifact(&upload_base, &apk_name, &body, &config.device_token).await?;
    ctx.append(&format!("Uploaded {apk_name} ({} bytes) → {key}", body.len()));
    Ok(json!({ "artifactKey": key, "apkName": apk_name, "sizeBytes": body.len() }))
}

// --- pure helpers -----------------------------------------------------------------

/// docker run args for a gradle build inside the android build box image.
fn gradle_docker_args(repo_dir: &Path, image: &str, module: &str, task: &str) -> Vec<String> {
    vec![
        "run".into(),
        "--rm".into(),
        "-v".into(),
        format!("{}:/project", repo_dir.display()),
        "-w".into(),
        "/project".into(),
        image.into(),
        "sh".into(),
        "-c".into(),
        format!("./gradlew --no-daemon {module}:{task}"),
    ]
}

/// Newest APK by mtime under <repoDir>/<module>/build/outputs/apk.
fn find_newest_apk(repo_dir: &Path, gradle_module: &str) -> Option<PathBuf> {
    let root = repo_dir.join(gradle_module).join("build").join("outputs").join("apk");
    let mut candidates = Vec::new();
    collect_apks(&root, &mut candidates);
    pick_newest(candidates)
}

fn collect_apks(dir: &Path, out: &mut Vec<(PathBuf, SystemTime)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        collect_entry(&entry, out);
    }
}

fn collect_entry(entry: &std::fs::DirEntry, out: &mut Vec<(PathBuf, SystemTime)>) {
    let path = entry.path();
    if path.is_dir() {
        collect_apks(&path, out);
        return;
    }
    let is_apk = path.extension().is_some_and(|ext| ext == "apk");
    let mtime = entry.metadata().and_then(|m| m.modified());
    if let (true, Ok(mtime)) = (is_apk, mtime) {
        out.push((path, mtime));
    }
}

/// Newest APK by mtime among candidates, None when empty.
fn pick_newest(candidates: Vec<(PathBuf, SystemTime)>) -> Option<PathBuf> {
    candidates.into_iter().max_by_key(|(_, mtime)| *mtime).map(|(path, _)| path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gradle_docker_args_builds_the_docker_run_invocation() {
        let args = gradle_docker_args(Path::new("/repos/app"), "img:1", "app", "assembleDebug");
        assert_eq!(
            args,
            vec![
                "run", "--rm",
                "-v", "/repos/app:/project",
                "-w", "/project",
                "img:1",
                "sh", "-c", "./gradlew --no-daemon app:assembleDebug",
            ]
        );
    }

    #[test]
    fn artifact_upload_url_appends_the_encoded_filename_query() {
        assert_eq!(
            exec::artifact_upload_url("https://x.space/", "my app.apk"),
            "https://x.space/api/devices/artifacts?filename=my%20app.apk"
        );
    }

    #[test]
    fn pick_newest_picks_the_most_recent_candidate_none_when_empty() {
        let older = SystemTime::UNIX_EPOCH + Duration::from_secs(1);
        let newer = SystemTime::UNIX_EPOCH + Duration::from_secs(2);
        let candidates = vec![
            (PathBuf::from("/a.apk"), older),
            (PathBuf::from("/b.apk"), newer),
        ];
        assert_eq!(pick_newest(candidates), Some(PathBuf::from("/b.apk")));
        assert_eq!(pick_newest(vec![]), None);
    }

    #[test]
    fn find_newest_apk_walks_the_module_output_tree() {
        let root = std::env::temp_dir().join(format!("lemn-apk-test-{}", std::process::id()));
        let nested = root.join("app").join("build").join("outputs").join("apk").join("debug");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("app-debug.apk"), b"apk").unwrap();
        std::fs::write(nested.join("notes.txt"), b"no").unwrap();
        assert_eq!(find_newest_apk(&root, "app"), Some(nested.join("app-debug.apk")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn find_newest_apk_is_none_when_the_output_dir_does_not_exist() {
        let root = std::env::temp_dir().join("lemn-apk-test-nonexistent-dir");
        assert_eq!(find_newest_apk(&root, "app"), None);
    }
}
