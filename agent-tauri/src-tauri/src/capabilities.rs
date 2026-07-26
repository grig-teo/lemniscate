//! Live run-target probes reported in the `capabilities` frame: docker, adb
//! devices (usb/wifi), physical iOS devices (devicectl), simulators (simctl)
//! and Android emulators. Pure parsers are unit-tested; the probes themselves
//! are best-effort — a missing tool just yields an empty list. Mirrors the
//! capabilities section of agent/lib.js — keep both in sync.

use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

use crate::{exec, install_apk, xcode};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// The environment report sent as `{type: "capabilities", capabilities}`.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub docker_available: bool,
    pub android_devices: Vec<AndroidDevice>,
    pub ios_devices: Vec<IosDevice>,
    pub simulators: Vec<Simulator>,
    pub emulators: Vec<Emulator>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AndroidDevice {
    pub serial: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub transport: String, // "usb" | "wifi"
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IosDevice {
    pub name: String,
    pub udid: String,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Simulator {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub udid: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Emulator {
    pub name: String,
}

// --- probes -------------------------------------------------------------------

/// All probes in parallel; each one degrades to false/empty on its own.
pub async fn collect() -> Capabilities {
    let (docker, android_devices, ios_devices, simulators, emulators) = tokio::join!(
        docker_available(),
        probe_adb_devices(),
        probe_ios_devices(),
        probe_simulators(),
        probe_emulators()
    );
    Capabilities { docker_available: docker, android_devices, ios_devices, simulators, emulators }
}

async fn docker_available() -> bool {
    exec::run_capture("docker", &["info"], None, PROBE_TIMEOUT).await.ok
}

async fn probe_adb_devices() -> Vec<AndroidDevice> {
    let Some(adb) = install_apk::find_adb().await else {
        return vec![];
    };
    let result = exec::run_capture(&adb, &["devices", "-l"], None, PROBE_TIMEOUT).await;
    if result.ok { parse_adb_devices(&result.output) } else { vec![] }
}

/// devicectl writes its JSON to a file; read it back and clean up.
async fn probe_ios_devices() -> Vec<IosDevice> {
    let path = std::env::temp_dir().join(format!("lemniscate-devicectl-{}.json", std::process::id()));
    let arg = path.to_string_lossy().into_owned();
    let result =
        exec::run_capture("xcrun", &["devicectl", "list", "devices", "--json-output", &arg], None, PROBE_TIMEOUT)
            .await;
    let json = std::fs::read_to_string(&path).unwrap_or_default();
    let _ = std::fs::remove_file(&path);
    if result.ok { parse_devicectl_devices(&json) } else { vec![] }
}

async fn probe_simulators() -> Vec<Simulator> {
    let result =
        exec::run_capture("xcrun", &["simctl", "list", "devices", "-j", "available"], None, PROBE_TIMEOUT)
            .await;
    if result.ok { parse_simctl_devices(&result.output) } else { vec![] }
}

async fn probe_emulators() -> Vec<Emulator> {
    for candidate in emulator_candidates() {
        let candidate = candidate.to_string_lossy().into_owned();
        let result = exec::run_capture(&candidate, &["-list-avds"], None, PROBE_TIMEOUT).await;
        if result.ok {
            return parse_emulator_list(&result.output);
        }
    }
    vec![]
}

/// Candidate emulator binaries: PATH first, then the standard SDK locations.
fn emulator_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("emulator")];
    if let Ok(root) = std::env::var("ANDROID_HOME") {
        candidates.push(PathBuf::from(root).join("emulator").join("emulator"));
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    candidates.push(home.join("Library").join("Android").join("sdk").join("emulator").join("emulator"));
    candidates
}

// --- pure parsers ---------------------------------------------------------------

/// Devices in state `device` from `adb devices -l` output, with model and
/// transport (wifi serials are host:5555 or mDNS `._adb-tls-connect`).
pub fn parse_adb_devices(output: &str) -> Vec<AndroidDevice> {
    output
        .lines()
        .skip(1) // "List of devices attached"
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 2 || fields[1] != "device" {
                return None;
            }
            let model = fields.iter().find_map(|f| f.strip_prefix("model:")).map(str::to_string);
            Some(AndroidDevice {
                serial: fields[0].to_string(),
                model,
                transport: adb_transport(fields[0]).to_string(),
            })
        })
        .collect()
}

fn adb_transport(serial: &str) -> &'static str {
    if serial.contains(":5555") || serial.contains("._adb-tls-connect") { "wifi" } else { "usb" }
}

/// Available simulators from `xcrun simctl list devices -j available` JSON.
pub fn parse_simctl_devices(json_text: &str) -> Vec<Simulator> {
    let mut simulators = Vec::new();
    let Some(devices) = xcode::simctl_devices(json_text) else {
        return simulators;
    };
    for (runtime, list) in &devices {
        for device in list.as_array().into_iter().flatten() {
            if device.get("isAvailable").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let Some(name) = device.get("name").and_then(Value::as_str) else {
                continue;
            };
            simulators.push(Simulator {
                name: name.to_string(),
                runtime: Some(sim_runtime_label(runtime)),
                state: device.get("state").and_then(Value::as_str).map(str::to_string),
                udid: device.get("udid").and_then(Value::as_str).map(str::to_string),
            });
        }
    }
    simulators
}

/// 'com.apple.CoreSimulator.SimRuntime.iOS-17-5' → 'iOS 17.5'.
fn sim_runtime_label(runtime: &str) -> String {
    let short = runtime.trim_start_matches("com.apple.CoreSimulator.SimRuntime.").replace('-', ".");
    match short.find('.') {
        Some(index) => format!("{} {}", &short[..index], &short[index + 1..]),
        None => short,
    }
}

/// AVD names from `emulator -list-avds` output; noise lines skipped.
pub fn parse_emulator_list(output: &str) -> Vec<Emulator> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("INFO") && !line.starts_with("WARNING") && !line.starts_with("ERROR"))
        .map(|name| Emulator { name: name.to_string() })
        .collect()
}

/// Physical iOS devices from `xcrun devicectl list devices --json-output` JSON.
pub fn parse_devicectl_devices(json_text: &str) -> Vec<IosDevice> {
    let data: Value = match serde_json::from_str(json_text) {
        Ok(data) => data,
        Err(_) => return vec![],
    };
    let Some(devices) = data.pointer("/result/devices").and_then(Value::as_array) else {
        return vec![];
    };
    devices.iter().filter(|entry| is_physical_ios_device(entry)).filter_map(ios_device_entry).collect()
}

fn is_physical_ios_device(entry: &Value) -> bool {
    let hardware = entry.get("hardwareProperties");
    hardware.and_then(|h| h.get("platform")).and_then(Value::as_str) == Some("iOS")
        && hardware.and_then(|h| h.get("reality")).and_then(Value::as_str) == Some("physical")
}

fn ios_device_entry(entry: &Value) -> Option<IosDevice> {
    let hardware = entry.get("hardwareProperties")?;
    let name = hardware
        .get("marketingName")
        .and_then(Value::as_str)
        .or_else(|| entry.pointer("/deviceProperties/name").and_then(Value::as_str))
        .unwrap_or("iOS device");
    let udid = hardware
        .get("udid")
        .and_then(Value::as_str)
        .or_else(|| entry.get("identifier").and_then(Value::as_str))?;
    let available =
        entry.pointer("/connectionProperties/tunnelState").and_then(Value::as_str) != Some("unavailable");
    Some(IosDevice { name: name.to_string(), udid: udid.to_string(), available })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // --- adb -l (mirrors agent/lib.test.js) ----------------------------------------

    #[test]
    fn adb_devices_keeps_online_entries_only_with_transport() {
        let output = "List of devices attached\n\
                      emulator-5554\tdevice\n\
                      0a1b2c3d\toffline\n\
                      9x8y7z\tunauthorized\n\n";
        assert_eq!(
            parse_adb_devices(output),
            vec![AndroidDevice { serial: "emulator-5554".into(), model: None, transport: "usb".into() }]
        );
    }

    #[test]
    fn adb_devices_parses_models_and_wifi_serials() {
        let output = "List of devices attached\n\
                      0a1b2c3d\tdevice usb:1-2 product:a model:Pixel_8 device:b transport_id:1\n\
                      192.168.1.5:5555\tdevice product:x model:Pixel_7 device:y transport_id:2\n\
                      adb-abc-XYZ._adb-tls-connect._tcp.\tdevice product:x model:Pixel_6 device:y\n";
        let serials: Vec<(String, String)> = parse_adb_devices(output)
            .into_iter()
            .map(|d| (d.serial, d.transport))
            .collect();
        assert_eq!(
            serials,
            vec![
                ("0a1b2c3d".to_string(), "usb".to_string()),
                ("192.168.1.5:5555".to_string(), "wifi".to_string()),
                ("adb-abc-XYZ._adb-tls-connect._tcp.".to_string(), "wifi".to_string()),
            ]
        );
        assert!(parse_adb_devices("List of devices attached\n").is_empty());
    }

    // --- simctl JSON ------------------------------------------------------------------

    #[test]
    fn simctl_devices_lists_available_simulators_with_runtime_and_state() {
        let json = r#"{"devices": {
            "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
                {"udid": "S1", "name": "iPhone 15", "state": "Booted", "isAvailable": true},
                {"udid": "S2", "name": "iPhone SE", "state": "Shutdown", "isAvailable": true},
                {"udid": "S3", "name": "iPhone 14", "state": "Shutdown", "isAvailable": false}
            ],
            "com.apple.CoreSimulator.SimRuntime.watchOS-10-5": [
                {"udid": "W1", "name": "Apple Watch", "state": "Shutdown", "isAvailable": true}
            ]
        }}"#;
        let names: Vec<(String, Option<String>, Option<String>)> =
            parse_simctl_devices(json).into_iter().map(|s| (s.name, s.runtime, s.udid)).collect();
        assert_eq!(
            names,
            vec![
                ("iPhone 15".into(), Some("iOS 17.5".into()), Some("S1".into())),
                ("iPhone SE".into(), Some("iOS 17.5".into()), Some("S2".into())),
                ("Apple Watch".into(), Some("watchOS 10.5".into()), Some("W1".into())),
            ]
        );
        assert!(parse_simctl_devices("garbage").is_empty());
        assert!(parse_simctl_devices(r#"{"devices":{}}"#).is_empty());
    }

    // --- emulator -list-avds ------------------------------------------------------------

    #[test]
    fn emulator_list_returns_avd_names_skipping_noise() {
        let output = "INFO    | Storing crashdata\nPixel_API_35\n\nMedium_Phone_API_36\n";
        assert_eq!(
            parse_emulator_list(output),
            vec![Emulator { name: "Pixel_API_35".into() }, Emulator { name: "Medium_Phone_API_36".into() }]
        );
        assert!(parse_emulator_list("").is_empty());
    }

    // --- devicectl JSON -------------------------------------------------------------------

    #[test]
    fn devicectl_devices_lists_physical_ios_devices_with_availability() {
        let json = json!({"result": {"devices": [
            {"identifier": "73BB",
             "hardwareProperties": {"platform": "iOS", "reality": "physical",
                 "marketingName": "iPhone 14 Pro Max", "udid": "00008120-X"},
             "deviceProperties": {"name": "iPhone"},
             "connectionProperties": {"tunnelState": "disconnected", "pairingState": "paired"}},
            {"identifier": "D3FA",
             "hardwareProperties": {"platform": "iOS", "reality": "physical",
                 "marketingName": "iPhone 13", "udid": "UDID-2"},
             "connectionProperties": {"tunnelState": "unavailable"}},
            {"identifier": "SIM-1",
             "hardwareProperties": {"platform": "iOS", "reality": "virtual",
                 "marketingName": "iPhone 17"},
             "connectionProperties": {"tunnelState": "connected"}}
        ]}})
        .to_string();
        assert_eq!(
            parse_devicectl_devices(&json),
            vec![
                IosDevice { name: "iPhone 14 Pro Max".into(), udid: "00008120-X".into(), available: true },
                IosDevice { name: "iPhone 13".into(), udid: "UDID-2".into(), available: false },
            ]
        );
        assert!(parse_devicectl_devices("garbage").is_empty());
        assert!(parse_devicectl_devices(r#"{"result":{}}"#).is_empty());
    }
}
