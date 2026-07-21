# Lemniscate Android app

Native Android client for lemniscate: sign in, pick a repository, dictate a
task prompt with the mic, and the backend agent does the work.

Kotlin · Jetpack Compose (Material 3) · MVVM · Retrofit/OkHttp ·
kotlinx-serialization · DataStore. Min SDK 26, target SDK 34.

## Environment setup

1. Install the Android SDK (Android Studio or `sdkmanager`) and JDK 17.
2. Create `local.properties` in this directory (git-ignored) using
   `.env.example` as a reference:

   ```properties
   sdk.dir=/Users/<you>/Library/Android/sdk
   SERVER_URL=https://grig-teo.space/lemniscate
   ```

   `SERVER_URL` is the base URL of the deployed lemniscate server. It is baked
   into `BuildConfig.SERVER_URL` at compile time (`app/build.gradle.kts`); if
   omitted, the production URL above is the default.

## Build

```sh
gradle assembleDebug      # system Gradle
# or, after generating the wrapper once with `gradle wrapper`:
./gradlew assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/`.

## Run

Install on a connected device/emulator with `gradle installDebug` or
`adb install app/build/outputs/apk/debug/app-debug.apk`, then launch
**Lemniscate**. Speech recognition needs a device/emulator image with Google
speech services; grant the microphone permission when asked.

## Auth flow

- **GitHub / GitLab** — OAuth runs in an in-app WebView; when the backend
  redirects to `/dashboard` the app harvests the `lemniscate_token` cookie
  into its own cookie jar.
- **GitVerse** — paste an access token (`POST /api/connections`); the session
  cookie is captured automatically from the response.

The session cookie is persisted in DataStore, so you stay signed in across
restarts. OAuth app credentials must be configured in `backend/.env` (see the
root README/docs).
