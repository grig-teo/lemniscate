# Lemniscate iOS

Native iOS client for lemniscate — SwiftUI, glass design, iOS 17+, no
third-party dependencies (URLSession + Codable only).

## Setup

1. (Optional) Point the app at your own backend:

   ```sh
   cp Config.example.xcconfig Config.xcconfig
   # edit SERVER_URL in Config.xcconfig
   ```

   `Config.xcconfig` is git-ignored and optionally included from
   `Base.xcconfig`; without it the default `https://grig-teo.space/lemniscate`
   is used. Note that xcconfig treats `//` as a comment, so URLs are written
   as `https:/$()/host/path`.

2. The Xcode project is generated with [xcodegen](https://github.com/yonaskolb/XcodeGen)
   from `project.yml`. If `Lemniscate.xcodeproj` is missing or `project.yml`
   changed, regenerate it:

   ```sh
   brew install xcodegen   # once
   xcodegen                # run inside ios/
   ```

3. Open `Lemniscate.xcodeproj` in Xcode 15+ and run the `Lemniscate` scheme
   on an iOS 17+ device or simulator.

Command-line build:

```sh
xcodebuild -project ios/Lemniscate.xcodeproj -scheme Lemniscate \
  -destination 'generic/platform=iOS Simulator' build
```

## Notes

- Sign-in: GitHub/GitLab use OAuth in a WebView sheet (the session cookie is
  harvested when the flow lands on `/dashboard`); GitVerse uses a personal
  access token via `POST /api/connections`. The session cookie is persisted
  in the Keychain.
- The mic button dictates a prompt with SFSpeechRecognizer and posts it as a
  task (`POST /api/tasks`) for the selected repository. Speech recognition
  works best on a real device; simulator support is limited.
- `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`
  are declared in `Lemniscate/Info.plist`.
