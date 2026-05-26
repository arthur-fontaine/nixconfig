# Manual follow-up

These steps still need manual handling even after the Nix conversion.

## First-run app setup

### Raycast

- open Raycast
- replace Spotlight
- enable cloud sync

### 1Password

- sign in
- enable SSH agent
- enable CLI integration

### AirBattery

- allow launch in macOS security settings

### Lunar

- set brightness hotkeys behavior as before

### Ice

- grant accessibility permission
- enable launch at login

### Alcove

- grant the requested permissions

### Android emulator

The `android-commandlinetools` cask installs `sdkmanager`, `avdmanager`, and
`emulator` under `$ANDROID_HOME` (`/opt/homebrew/share/android-commandlinetools`).
The system images and AVDs are large downloads, so they are not declarative.
Run these once in a fresh shell after the cask is installed:

```sh
# Accept all SDK licenses
yes | sdkmanager --licenses

# Install platform-tools, emulator, the latest stable platform and a system image.
# Bump the API level when a newer one is available: `sdkmanager --list | grep system-images`.
sdkmanager --install \
  "platform-tools" \
  "emulator" \
  "platforms;android-36" \
  "system-images;android-36;google_apis_playstore;arm64-v8a"

# Create an AVD that mimics a recent Pixel
avdmanager create avd \
  --name Pixel_API_36 \
  --package "system-images;android-36;google_apis_playstore;arm64-v8a" \
  --device "pixel_7"
```

Useful commands afterwards:

- `emulator -list-avds` — list configured AVDs
- `emulator -avd Pixel_API_36` — boot the emulator
- `adb devices` — confirm the emulator is connected
- `adb install path/to/app.apk` — sideload an APK
