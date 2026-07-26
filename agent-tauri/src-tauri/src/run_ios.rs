//! `run_ios` (macOS only): clone/pull, optional xcodegen, resolve a simulator
//! or device destination, xcodebuild into a local derived-data dir, then
//! install + launch via simctl (or devicectl for physical devices).
//! Parity with executeRunIos in agent/index.js; pure helpers live in xcode.rs.

use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

use crate::config::Config;
use crate::exec::{self, CommandContext, ResultSender};
use crate::xcode::{self, IosDestination, XcodeProject};

const XCODE_BUILD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const SIMCTL_LIST_TIMEOUT: Duration = Duration::from_secs(30);
const XCODEGEN_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn execute(tx: ResultSender, config: Config, id: String, payload: Value) {
    let mut ctx = CommandContext::new(tx, id);
    ctx.running().await;
    match attempt(&mut ctx, &payload).await {
        Ok(result) => ctx.done(result).await,
        Err(error) => ctx.fail_with_log(error, &config.server, &config.device_token).await,
    }
}

async fn attempt(ctx: &mut CommandContext, payload: &Value) -> Result<Value, String> {
    if std::env::consts::OS != "macos" {
        return Err("run_ios needs macOS with Xcode — this device is not a Mac".to_string());
    }
    let repo_url = exec::required_str(payload, "repoUrl", "run_ios")?;
    let branch = exec::required_str(payload, "branch", "run_ios")?;
    let project_dir = exec::ensure_repo(ctx, &repo_url, &branch).await?;
    ctx.progress("Repository ready").await;
    if maybe_run_xcodegen(ctx, &project_dir).await? {
        ctx.progress("Generated the Xcode project with xcodegen").await;
    }
    let project = xcode::find_xcode_project(&project_dir)
        .ok_or("No .xcodeproj or .xcworkspace found at repo root or one level deep")?;
    let scheme = payload.get("scheme").and_then(Value::as_str).unwrap_or(&project.name).to_string();
    let destination = resolve_ios_destination(ctx, payload.get("destination").and_then(Value::as_str)).await?;
    build_and_install(ctx, &project_dir, &project, &scheme, &destination).await
}

/// xcodebuild into <repo>/dd, then install + launch on the destination.
async fn build_and_install(
    ctx: &mut CommandContext,
    project_dir: &Path,
    project: &XcodeProject,
    scheme: &str,
    destination: &IosDestination,
) -> Result<Value, String> {
    let kind = if destination.simulator { "simulator" } else { "device" };
    ctx.progress(&format!("Building scheme {scheme} for {kind} {}", destination.udid)).await;
    let derived_data = project_dir.join("dd");
    let args = xcode::xcodebuild_args(project, scheme, destination, &derived_data);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    ctx.step("xcodebuild", &refs, Some(project_dir), XCODE_BUILD_TIMEOUT).await?;
    let app = xcode::find_built_app(&derived_data.join("Build").join("Products"))
        .ok_or("Build succeeded but no .app was found in the derived data products")?;
    let app_str = app.to_string_lossy().into_owned();
    if !destination.simulator {
        return install_on_device(ctx, scheme, &destination.udid, &app_str, project_dir).await;
    }
    install_on_simulator(ctx, scheme, &destination.udid, &app_str, project_dir).await
}

async fn install_on_simulator(
    ctx: &mut CommandContext,
    scheme: &str,
    udid: &str,
    app_path: &str,
    project_dir: &Path,
) -> Result<Value, String> {
    ctx.step("xcrun", &["simctl", "install", udid, app_path], None, exec::DEFAULT_CMD_TIMEOUT).await?;
    let bundle_id = read_bundle_id(ctx, app_path).await?;
    ctx.step("xcrun", &["simctl", "launch", udid, &bundle_id], None, exec::DEFAULT_CMD_TIMEOUT).await?;
    Ok(json!({ "scheme": scheme, "simulator": udid, "appPath": app_path, "bundleId": bundle_id, "projectDir": project_dir }))
}

/// Physical device: provisioning is on the user, install is best-effort.
async fn install_on_device(
    ctx: &mut CommandContext,
    scheme: &str,
    udid: &str,
    app_path: &str,
    project_dir: &Path,
) -> Result<Value, String> {
    ctx.step("xcrun", &["devicectl", "device", "install", "app", "--device", udid, app_path], None, exec::DEFAULT_CMD_TIMEOUT)
        .await?;
    Ok(json!({ "scheme": scheme, "device": udid, "appPath": app_path, "projectDir": project_dir }))
}

/// Regenerate the Xcode project when the repo ships an xcodegen setup.
async fn maybe_run_xcodegen(ctx: &mut CommandContext, project_dir: &Path) -> Result<bool, String> {
    let Some(dir) = xcode::xcodegen_dir(project_dir) else {
        return Ok(false);
    };
    let probe = exec::run_capture("xcodegen", &["--version"], None, XCODEGEN_PROBE_TIMEOUT).await;
    ctx.append(&format!("$ xcodegen --version\n{}", probe.output));
    if !probe.ok {
        return Ok(false);
    }
    ctx.step("xcodegen", &[], Some(&dir), exec::DEFAULT_CMD_TIMEOUT).await?;
    Ok(true)
}

/// UDID to target: payload.destination wins (simulator or physical device);
/// otherwise a booted simulator, else boot the first available iPhone sim.
async fn resolve_ios_destination(
    ctx: &mut CommandContext,
    requested: Option<&str>,
) -> Result<IosDestination, String> {
    let list = exec::run_capture("xcrun", &["simctl", "list", "devices", "-j"], None, SIMCTL_LIST_TIMEOUT).await;
    if !list.ok {
        return Err("xcrun simctl failed — is Xcode installed on this device?".to_string());
    }
    if let Some(udid) = requested {
        let simulator = xcode::is_simulator_udid(&list.output, udid);
        return Ok(IosDestination { udid: udid.to_string(), simulator });
    }
    if let Some(booted) = xcode::parse_booted_simulator_udid(&list.output) {
        return Ok(IosDestination { udid: booted, simulator: true });
    }
    boot_first_available_iphone(ctx, &list.output).await
}

async fn boot_first_available_iphone(ctx: &mut CommandContext, simctl_json: &str) -> Result<IosDestination, String> {
    let Some((udid, name)) = xcode::parse_available_iphone(simctl_json) else {
        return Err("No booted simulator and no available iPhone simulator found".to_string());
    };
    ctx.step("xcrun", &["simctl", "boot", &udid], None, exec::DEFAULT_CMD_TIMEOUT).await?;
    ctx.append(&format!("Booted simulator {name} ({udid})"));
    Ok(IosDestination { udid, simulator: true })
}

/// CFBundleIdentifier of the built app, read from its Info.plist.
async fn read_bundle_id(ctx: &mut CommandContext, app_path: &str) -> Result<String, String> {
    let plist = Path::new(app_path).join("Info.plist");
    let plist_str = plist.to_string_lossy().into_owned();
    let result = exec::run_capture(
        "/usr/libexec/PlistBuddy",
        &["-c", "Print:CFBundleIdentifier", &plist_str],
        None,
        exec::DEFAULT_CMD_TIMEOUT,
    )
    .await;
    ctx.append(&format!("$ /usr/libexec/PlistBuddy -c Print:CFBundleIdentifier {plist_str}\n{}", result.output));
    let bundle_id = result.output.trim();
    if !result.ok || bundle_id.is_empty() {
        return Err("Could not read CFBundleIdentifier from the built app".to_string());
    }
    Ok(bundle_id.to_string())
}
