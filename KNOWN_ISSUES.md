# Known Issues & Workarounds 🛠️

**English** | [Tiếng Việt](./readme/KNOWN_ISSUES.vi.md)

This document tracks current limitations and historical issues that have been addressed in **Zalo for Linux**, along with credits to the community contributors who helped resolve them.

---

## ⚠️ Current Issues & Limitations

- **Calls on ARM64:** 
  Calls now run on the native engine (`zcall-native/`, Node.js + Python, nothing x86-only) instead of Wine and `ZaloCall.exe` ([PR #62](https://github.com/VN-Linux-Family/zalo-for-linux/pull/62), [Issue #70](https://github.com/VN-Linux-Family/zalo-for-linux/issues/70)), so aarch64 is no longer ruled out, but calls have not been tried on aarch64 yet.

---

## ✅ Resolved Issues & Workarounds

- **System/Auto Theme not working:** 
  - **Issue:** The app does not follow the system's dark/light mode. Both ZaDark and Zalo ignore `prefers-color-scheme`. 
  - **Solution:** The app now can do real-time detection via GNOME D-Bus (org.gnome.desktop.interface color-scheme), XDG Desktop Portal (org.freedesktop.appearane), or gtk-theme. Automatically synchronizes `nativeTheme.themeSource` and the `.dark` class in DOM without interfering with or altering the operating system's default title bar.
  - **Credits:** Thanks to [@nct88](https://github.com/nct88). See [PR #87](https://github.com/VN-Linux-Family/zalo-for-linux/pull/87), [Issue #22](https://github.com/VN-Linux-Family/zalo-for-linux/issues/22), and [Issue #21](https://github.com/VN-Linux-Family/zalo-for-linux/issues/21#issuecomment-4437302799).


- **Message Synchronization (E2EE):**
  - **Issue:** Missing `db-cross-v4` native module caused end-to-end encryption (E2EE) messages to fail to sync on Linux.
  - **Solution:** Reimplemented `db-cross-v4` in C++. E2EE message sync now works natively without any Wine dependency.
  - **Credits:** Thanks to [@realdtn2](https://github.com/realdtn2) for the implementation and [@DMKha2k7](https://github.com/DMKha2k7) for the integration PR. See [PR #24](https://github.com/VN-Linux-Family/zalo-for-linux/pull/24) and [Issue #15](https://github.com/VN-Linux-Family/zalo-for-linux/issues/15).

- **Conversation Info Panel (Photos/Videos, Files, and Links):**
  - **Issue:** Media, files, and links in the right-side info panel did not load.
  - **Solution:** Resolved by providing the native `db-cross-v4` module.

- **Message Reactions:**
  - **Issue:** Unable to view or react to messages with emoji reactions.
  - **Solution:** Resolved by providing the native `db-cross-v4` module.

- **Pasting & Sending Images:**
  - **Issue:** Copying images in Linux and pressing `Ctrl+V` into chat did not work, and sending images often defaulted to raw file attachments instead of inline photo previews.
  - **Solution:** Image files (`.png`, `.jpg`, `.jpeg`, etc.) can now be pasted into chats via `Ctrl+V` (Wayland via `wl-clipboard` and X11 via `xclip`), and images sent from the file picker are properly recognized as photos rather than generic file attachments.
  - **Credits:** Thanks to [@realdtn2](https://github.com/realdtn2) for the original clipboard solution, [@DMKha2k7](https://github.com/DMKha2k7) for [PR #25](https://github.com/VN-Linux-Family/zalo-for-linux/pull/25) / [Issue #23](https://github.com/VN-Linux-Family/zalo-for-linux/issues/23), and [@brucenguyen1102](https://github.com/brucenguyen1102) for [PR #34](https://github.com/VN-Linux-Family/zalo-for-linux/pull/34).

- **Linux Auto-Launch on Startup:**
  - **Issue:** Toggling "Start Zalo on system startup" in Zalo's built-in settings did not work on Linux.
  - **Solution:** Patched the auto-launch IPC handlers to create or remove the standard autostart desktop entry at `~/.config/autostart/zalo.desktop`.
  - **Credits:** Thanks to [@akimiya7742](https://github.com/akimiya7742) and [@DMKha241](https://github.com/DMKha241). See [PR #51](https://github.com/VN-Linux-Family/zalo-for-linux/pull/51), [PR #59](https://github.com/VN-Linux-Family/zalo-for-linux/pull/59), and [PR #61](https://github.com/VN-Linux-Family/zalo-for-linux/pull/61).

- **XDG User Directories & Download Path:**
  - **Issue:** Zalo hardcoded and forcefully created an English `~/Zalo Received Files` directory directly in `$HOME`, disregarding user system locales and XDG standards.
  - **Solution:** Patched file download and saving paths to adhere to standard Linux XDG directories (`$XDG_DOWNLOAD_DIR`).
  - **Credits:** Thanks to [@akimiya7742](https://github.com/akimiya7742). See [PR #52](https://github.com/VN-Linux-Family/zalo-for-linux/pull/52), [Issue #20](https://github.com/VN-Linux-Family/zalo-for-linux/issues/20), and [Issue #48](https://github.com/VN-Linux-Family/zalo-for-linux/issues/48).

- **Unread Message Badge Count:**
  - **Issue:** The application icon on the system dock/taskbar did not show any badge indicator for unread messages.
  - **Solution:** Implemented unread message count badge integration for desktop environments supporting Unity/KDE/GNOME badge protocols.
  - **Credits:** Thanks to [@akimiya7742](https://github.com/akimiya7742). See [PR #43](https://github.com/VN-Linux-Family/zalo-for-linux/pull/43).

- **In-App Screenshot Tool:**
  - **Issue:** The built-in screenshot feature failed on Linux.
  - **Solution:** Integrated with native Linux screenshot utilities (`deepin-screen-recorder`, `spectacle`, `flameshot`, `gnome-screenshot`, `xfce4-screenshooter`, `mate-screenshot`, `ksnapshot`, `scrot`).
  - **Credits:** Thanks to [@hthienloc](https://github.com/hthienloc) for the solution. See [Issue #19](https://github.com/VN-Linux-Family/zalo-for-linux/issues/19).

- **Window Title Bar Controls:**
  - **Issue:** Missing standard minimize, maximize, and close buttons on certain window managers/desktop environments.
  - **Solution:** Patched frame and title bar controls.
  - **Credits:** Thanks to [@NanKillBro](https://github.com/NanKillBro) for the solution. For more details, see [Issue #4](https://github.com/VN-Linux-Family/zalo-for-linux/issues/4).

- **System Tray Icon:**
  - **Issue:** Missing tray menu icon on Linux desktops.
  - **Solution:** Implemented native tray icon with status menu and toggle DevTools options.

- **Freeze on Login Screen:**
  - **Issue:** Application froze upon opening the login screen.
  - **Solution:** Replaced macOS sqlite3 binaries with native Linux builds. See [Issue #13](https://github.com/VN-Linux-Family/zalo-for-linux/issues/13).
