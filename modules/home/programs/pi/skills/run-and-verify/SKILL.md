---
name: run-and-verify
description: How to see a change working where it really runs (web app, CLI, server, iPhone/iPad, Android, Mac app) and read its logs, screenshots and crashes yourself. Use before calling any change done or a bug fixed, when reproducing a bug, and when briefing another agent on how to check its work.
---

# Run and verify

Tests, simulators and fakes tell you the code does what you think. Only the real target
tells you it does what the person sees. Set up the loop below once per task, early: it is
what lets you find causes instead of guessing, and it keeps the person from being your test
suite.

## The loop

1. **Build and put the change where it runs**: deploy, install, restart. Check that what
   runs is your build (a version, a build number, a commit hash, a log line you added).
2. **Reproduce** the bug, or exercise the feature, the way the person does.
3. **Collect evidence**: logs, a screenshot or recording, the command output. Save it in a
   folder for the task (`evidence/<task>/`, git-ignored, or a temp dir), so you and others
   can compare before and after.
4. **Read it** before concluding. Exit codes, the full error, the timestamps: does it show
   your build?
5. After the fix, the **same steps** must show the bug gone.

If a step needs something only the person can give (a password, a tap on a dialog, a cable),
ask for exactly that, once, and automate the rest. When you can't reach the target at all,
say what remains unverified.

Give the app logs you can read: one logging subsystem, extra detail in debug builds, and a
line at each boundary (request in, response out, state applied) of the area under work.

## Recipes

### Web app

- Start the dev server in the background, wait for it to answer (`curl -fsS`), then drive the
  page with a browser tool (Playwright, or a browser MCP if one is loaded): click through the
  flow, take a screenshot, read the console errors and the failed network requests.
- Check the viewport sizes that matter, and light and dark mode when the page has both.

### CLI, library, script

- Run the real command with real input, not only the unit tests. Compare the output with
  what was asked. Check the exit status; a pipe hides it (`set -o pipefail`).

### Server or remote machine

- Deploy or rebuild first, and confirm the running version is your commit.
- Read the service state and its logs there (`ssh host …`: `systemctl status` and
  `journalctl -u`, `launchctl print`, the app's log files), then run the action and read the
  logs again.
- A probe script you leave on the server must pick what is really running (the active
  config, the process's own interpreter), not whatever it finds first.

### iPhone and iPad (physical device)

The simulator differs from a device: input, keyboard, notifications, background modes,
signing, performance and OS version. A UI or system behaviour bug is checked on the device.

- Find the device: `xcrun devicectl list devices` (name, UDID, connection state).
- Build and install:
  `xcodebuild -scheme <S> -destination 'platform=iOS,id=<UDID>' -derivedDataPath <dir> build`,
  then `xcrun devicectl device install app --device <UDID> <path/to/App.app>`.
- Launch and capture stdout/stderr:
  `xcrun devicectl device process launch --device <UDID> --terminate-existing --console <bundle-id>`
  (blocks until the app exits; run it in the background; `--json-output` needs a file path
  with `--console`).
- See the screen: `xcrun devicectl device capture screenshot --device <UDID> --destination <file.png>`,
  `xcrun devicectl device capture screen-record --device <UDID> --duration <s> --destination <file.mov>`.
- System logs after the fact: `log collect --device-udid <UDID> --last 5m --output <dir>`, then
  `log show <archive> --predicate 'subsystem == "<your.subsystem>"'`. If it needs root, ask
  the person to run it with `! sudo …`.
- Crashes: `xcrun devicectl device info files --device <UDID> --domain-type systemCrashLogs`,
  copy the report with `xcrun devicectl device copy from`, symbolicate with `xcrun crashlog`.
- The app's own files (a log file it writes):
  `xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer --domain-identifier <bundle-id> --source <path> --destination <path>`.
- Taps and assertions on the device: an XCUITest run with
  `xcodebuild test -destination 'platform=iOS,id=<UDID>' -only-testing:<Target/Class/test>`.
  It takes over the screen: ask first.
- Before uninstalling anything, match the bundle id, never the display name. A free
  developer account allows only 3 sideloaded apps at once.
- Screenshots of a real phone show the person's real data and go to the model provider:
  prefer a test account, and say so.

### iOS simulator

- `xcrun simctl boot <udid>`, `xcrun simctl install booted <App.app>`,
  `xcrun simctl launch --console-pty booted <bundle-id>`,
  `xcrun simctl io booted screenshot <file.png>` and `xcrun simctl io booted recordVideo <file.mov>`,
  `xcrun simctl spawn booted log stream --predicate 'subsystem == "<sub>"'`.
- Agents in parallel each use their own simulator and derived data folder.

### Android

- `adb devices`, `adb install -r <app.apk>`, `adb shell am start -n <package>/<activity>`,
  `adb exec-out screencap -p > file.png`, `adb shell screenrecord /sdcard/r.mp4`,
  `adb logcat -d` (filter by tag or `--pid=$(adb shell pidof <package>)`),
  `adb shell uiautomator dump` for the view tree.

### Mac app

- Launch the build (`open <App.app>` or its binary), read
  `log stream --predicate 'subsystem == "<sub>"'` or `log show --last 5m …`, capture a window
  with `screencapture -l <windowid> file.png`, crashes in `~/Library/Logs/DiagnosticReports`.
