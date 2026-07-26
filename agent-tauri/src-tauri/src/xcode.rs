//! Pure Xcode/simctl helpers for `run_ios`: project discovery, simctl JSON
//! parsing, derived-data .app lookup, xcodebuild argument construction.
//! Ports the run_ios section of agent/lib.js — keep both in sync.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// UDID to build for, and whether it is a simulator or a physical device.
pub struct IosDestination {
    pub udid: String,
    pub simulator: bool,
}

/// The Xcode project to build: flag for xcodebuild, path, default scheme name.
pub struct XcodeProject {
    pub flag: &'static str, // "-workspace" or "-project"
    pub path: PathBuf,
    pub name: String,
}

/// Directory holding an xcodegen project.yml, ios/ first then the repo root.
pub fn xcodegen_dir(project_dir: &Path) -> Option<PathBuf> {
    for dir in ["ios", "."] {
        let candidate = project_dir.join(dir);
        if candidate.join("project.yml").exists() {
            return Some(candidate);
        }
    }
    None
}

/// Locate the Xcode project to build: ios/ first, then the repo root, then
/// any other one-level-deep directory (alphabetical); within a directory a
/// .xcworkspace wins over a .xcodeproj.
pub fn find_xcode_project(project_dir: &Path) -> Option<XcodeProject> {
    for dir in xcode_search_dirs(project_dir) {
        if let Some(project) = xcode_project_in(&project_dir.join(&dir)) {
            return Some(project);
        }
    }
    None
}

fn xcode_search_dirs(project_dir: &Path) -> Vec<String> {
    let mut others: Vec<String> = dir_names(project_dir)
        .into_iter()
        .filter(|name| name != "ios" && !name.starts_with('.'))
        .collect();
    others.sort();
    let mut dirs = vec!["ios".to_string(), ".".to_string()];
    dirs.extend(others);
    dirs
}

fn xcode_project_in(dir: &Path) -> Option<XcodeProject> {
    let names = file_names(dir);
    for (suffix, flag) in [(".xcworkspace", "-workspace"), (".xcodeproj", "-project")] {
        if let Some(name) = names.iter().find(|name| name.ends_with(suffix)) {
            return Some(XcodeProject {
                flag,
                path: dir.join(name),
                name: name.trim_end_matches(suffix).to_string(),
            });
        }
    }
    None
}

/// True when the UDID belongs to a simulator (not a physical device).
pub fn is_simulator_udid(json_text: &str, udid: &str) -> bool {
    let Some(devices) = simctl_devices(json_text) else {
        return false;
    };
    devices
        .values()
        .filter_map(Value::as_array)
        .flatten()
        .any(|device| device.get("udid").and_then(Value::as_str) == Some(udid))
}

/// First booted simulator UDID from `xcrun simctl list devices -j` JSON.
pub fn parse_booted_simulator_udid(json_text: &str) -> Option<String> {
    let devices = simctl_devices(json_text)?;
    devices.values().filter_map(Value::as_array).flatten().find_map(|device| {
        let booted = device.get("state").and_then(Value::as_str) == Some("Booted");
        booted.then(|| device.get("udid").and_then(Value::as_str).map(str::to_string))?
    })
}

/// First available iPhone simulator (udid, name) from simctl list JSON.
pub fn parse_available_iphone(json_text: &str) -> Option<(String, String)> {
    let devices = simctl_devices(json_text)?;
    for (runtime, list) in &devices {
        if !runtime.contains("iOS") {
            continue;
        }
        if let Some(found) = list.as_array().and_then(|devices| available_iphone_in(devices)) {
            return Some(found);
        }
    }
    None
}

fn available_iphone_in(devices: &[Value]) -> Option<(String, String)> {
    devices.iter().find_map(|device| {
        let available = device.get("isAvailable").and_then(Value::as_bool) != Some(false);
        let name = device.get("name").and_then(Value::as_str).unwrap_or_default();
        let udid = device.get("udid").and_then(Value::as_str);
        match (available, name.contains("iPhone"), udid) {
            (true, true, Some(udid)) => Some((udid.to_string(), name.to_string())),
            _ => None,
        }
    })
}

/// The `devices` object from `xcrun simctl list devices -j` JSON.
pub(crate) fn simctl_devices(json_text: &str) -> Option<Map<String, Value>> {
    let data: Value = serde_json::from_str(json_text).ok()?;
    data.get("devices").and_then(Value::as_object).cloned()
}

/// First .app under a derived-data Products dir (Debug-iphonesimulator or
/// Debug-iphoneos), None when the build produced none.
pub fn find_built_app(products_root: &Path) -> Option<PathBuf> {
    let mut dirs = dir_names(products_root);
    dirs.sort();
    for dir in dirs {
        if !(dir.ends_with("-iphonesimulator") || dir.ends_with("-iphoneos")) {
            continue;
        }
        let full = products_root.join(&dir);
        let mut apps: Vec<String> = file_names(&full).into_iter().filter(|n| n.ends_with(".app")).collect();
        apps.sort();
        if let Some(app) = apps.into_iter().next() {
            return Some(full.join(app));
        }
    }
    None
}

/// xcodebuild invocation for a simulator or device destination build.
pub fn xcodebuild_args(
    project: &XcodeProject,
    scheme: &str,
    destination: &IosDestination,
    derived_data: &Path,
) -> Vec<String> {
    let destination_arg = if destination.simulator {
        format!("platform=iOS Simulator,id={}", destination.udid)
    } else {
        format!("id={}", destination.udid)
    };
    vec![
        project.flag.into(),
        project.path.to_string_lossy().into_owned(),
        "-scheme".into(),
        scheme.into(),
        "-destination".into(),
        destination_arg,
        "-derivedDataPath".into(),
        derived_data.to_string_lossy().into_owned(),
        "build".into(),
    ]
}

fn dir_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return vec![];
    };
    entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect()
}

fn file_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return vec![];
    };
    entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMCTL_JSON: &str = r#"{
        "devices": {
            "com.apple.CoreSimulator.SimRuntime.watchOS-10-0": [
                {"udid": "W1", "name": "Apple Watch", "state": "Shutdown", "isAvailable": true}
            ],
            "com.apple.CoreSimulator.SimRuntime.iOS-17-0": [
                {"udid": "S1", "name": "iPhone 15", "state": "Shutdown", "isAvailable": false},
                {"udid": "S2", "name": "iPad Pro", "state": "Shutdown", "isAvailable": true},
                {"udid": "S3", "name": "iPhone 15 Pro", "state": "Booted", "isAvailable": true}
            ]
        }
    }"#;

    #[test]
    fn parse_booted_simulator_udid_returns_the_first_booted_device() {
        assert_eq!(parse_booted_simulator_udid(SIMCTL_JSON), Some("S3".to_string()));
        assert_eq!(parse_booted_simulator_udid(r#"{"devices":{}}"#), None);
        assert_eq!(parse_booted_simulator_udid("not json"), None);
    }

    #[test]
    fn parse_available_iphone_skips_unavailable_devices_and_non_ios_runtimes() {
        let json = r#"{"devices": {
            "com.apple.CoreSimulator.SimRuntime.iOS-17-0": [
                {"udid": "S1", "name": "iPhone 15", "isAvailable": false},
                {"udid": "S2", "name": "iPad Pro", "isAvailable": true},
                {"udid": "S4", "name": "iPhone 16", "isAvailable": true}
            ]
        }}"#;
        assert_eq!(parse_available_iphone(json), Some(("S4".to_string(), "iPhone 16".to_string())));
        assert_eq!(parse_available_iphone(r#"{"devices":{"com.apple.x.watchOS-1":[]}}"#), None);
    }

    #[test]
    fn is_simulator_udid_distinguishes_simulators_from_physical_devices() {
        assert!(is_simulator_udid(SIMCTL_JSON, "S1"));
        assert!(!is_simulator_udid(SIMCTL_JSON, "00008030-001A2B3C"));
    }

    #[test]
    fn xcodegen_dir_prefers_ios_over_the_repo_root() {
        let root = temp_dir("xcodegen");
        std::fs::create_dir_all(root.join("ios")).unwrap();
        std::fs::write(root.join("project.yml"), b"root").unwrap();
        assert_eq!(xcodegen_dir(&root), Some(root.clone()));
        std::fs::write(root.join("ios").join("project.yml"), b"ios").unwrap();
        assert_eq!(xcodegen_dir(&root), Some(root.join("ios")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn xcodegen_dir_is_none_without_a_project_yml() {
        let root = temp_dir("xcodegen-none");
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(xcodegen_dir(&root), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn find_xcode_project_prefers_ios_and_workspaces_over_projects() {
        let root = temp_dir("xcodeproj");
        let ios = root.join("ios");
        std::fs::create_dir_all(ios.join("App.xcodeproj")).unwrap();
        std::fs::create_dir_all(root.join("Root.xcworkspace")).unwrap();
        let project = find_xcode_project(&root).expect("a project");
        assert_eq!(project.flag, "-project");
        assert_eq!(project.path, ios.join("App.xcodeproj"));
        assert_eq!(project.name, "App");
        std::fs::create_dir_all(ios.join("App.xcworkspace")).unwrap();
        let project = find_xcode_project(&root).expect("a workspace");
        assert_eq!(project.flag, "-workspace");
        assert_eq!(project.path, ios.join("App.xcworkspace"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn find_xcode_project_falls_back_to_a_root_project_none_when_absent() {
        let root = temp_dir("xcodeproj-root");
        std::fs::create_dir_all(root.join("Root.xcodeproj")).unwrap();
        let project = find_xcode_project(&root).expect("root project");
        assert_eq!(project.name, "Root");
        let empty = temp_dir("xcodeproj-none");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(find_xcode_project(&empty).is_none());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&empty);
    }

    #[test]
    fn find_built_app_picks_an_app_under_a_products_subdir() {
        let root = temp_dir("built-app");
        let products = root.join("Products");
        std::fs::create_dir_all(products.join("Debug-iphonesimulator").join("Demo.app")).unwrap();
        std::fs::create_dir_all(products.join("RandomDir")).unwrap();
        assert_eq!(
            find_built_app(&products),
            Some(products.join("Debug-iphonesimulator").join("Demo.app"))
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn find_built_app_is_none_when_the_build_produced_no_app() {
        let root = temp_dir("built-app-none");
        std::fs::create_dir_all(root.join("Debug-iphonesimulator")).unwrap();
        assert_eq!(find_built_app(&root), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn xcodebuild_args_for_a_simulator_destination() {
        let project = XcodeProject {
            flag: "-project",
            path: PathBuf::from("/repo/ios/App.xcodeproj"),
            name: "App".into(),
        };
        let dest = IosDestination { udid: "U1".into(), simulator: true };
        let args = xcodebuild_args(&project, "App", &dest, Path::new("/repo/dd"));
        assert_eq!(
            args,
            vec![
                "-project", "/repo/ios/App.xcodeproj",
                "-scheme", "App",
                "-destination", "platform=iOS Simulator,id=U1",
                "-derivedDataPath", "/repo/dd",
                "build",
            ]
        );
    }

    #[test]
    fn xcodebuild_args_for_a_device_destination_uses_the_plain_udid() {
        let project = XcodeProject {
            flag: "-workspace",
            path: PathBuf::from("/repo/App.xcworkspace"),
            name: "App".into(),
        };
        let dest = IosDestination { udid: "D1".into(), simulator: false };
        let args = xcodebuild_args(&project, "App", &dest, Path::new("/repo/dd"));
        assert!(args.contains(&"id=D1".to_string()));
    }

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("lemn-ios-test-{name}-{}", std::process::id()))
    }
}
