# Zalo for Linux 🐧

[![Build Status](https://github.com/doandat943/zalo-for-linux/actions/workflows/build.yml/badge.svg)](https://github.com/doandat943/zalo-for-linux/actions/workflows/build.yml)

An unofficial, community-driven port of the Zalo desktop application for **Linux only**, created by repackaging the official macOS client into a standard AppImage with integrated ZaDark.

Thanks **realdtn2** for the solution: [realdtn2/zalo-linux-unofficial-2024](https://github.com/realdtn2/zalo-linux-unofficial-2024).

## ⚠️ Important: Known Issues

- **Message Synchronization (E2EE):** Zalo uses a proprietary native module (`db-cross-v4`) for End-to-End Encryption operations. This module only ships as a macOS binary (Mach-O) and cannot be loaded on Linux, so E2EE message sync will fail. **Workaround:** use **Wine** to run the Windows version of Zalo to perform the initial data sync, then migrate the data to this Linux version. For more details, see [issue #1](https://github.com/realdtn2/zalo-linux-unofficial-2024/issues/1) and [issue #2](https://github.com/realdtn2/zalo-linux-unofficial-2024/issues/2).
- **Can't make or receive calls:** The call module (`zcall`) only ships as a macOS native binary.
- **Can't see message reactions:** You won't see reactions in the UI (no badges/counters), but reacting still works and others can see your reaction.
- **No Photos/Videos, Files and Links on the Conversation Info panel** for some reason (you can still view images/videos, files or links normally, they just don't appear on the conversation info panel).
- **✅ Fixed: Screenshot without/with Zalo window button** - Uses native Linux screenshot tools (see [issue #19](https://github.com/doandat943/zalo-for-linux/issues/19)). Supported tools: deepin-screen-recorder, spectacle, flameshot, gnome-screenshot, xfce4-screenshooter, mate-screenshot, ksnapshot, scrot. Thanks to [@hthienloc](https://github.com/hthienloc) for the solution.
- **✅ Fixed: No title bar with minimize/maximize/close buttons** - Thanks to [@NanKillBro](https://github.com/NanKillBro) for the solution. For more details, see [issue #4](https://github.com/doandat943/zalo-for-linux/issues/4)
- **✅ Fixed: No tray menu icon**
- **✅ Fixed: Freeze on login screen** - Replaced macOS sqlite3 binaries with native Linux builds. See [issue #13](https://github.com/doandat943/zalo-for-linux/issues/13).

This project is best suited for users who need a native-feeling Zalo client on Linux and are comfortable with the technical workarounds required for full functionality.

## 🌙 ZaDark Integration

This project includes integrated [ZaDark](https://github.com/quaric/zadark), ZaDark is an extension that helps you enable Dark Mode, more privacy features, and additional functionality.

**ZaDark helps you experience Zalo 🔒 more privately ✨ more personalized.**

### Features

- 🌙 **Dark Mode optimized specifically for Zalo** - Complete dark theme tailored for Zalo interface
- 🆃 **Customize fonts and font sizes** - Personalize text appearance to your preference
- 🖼️ **Custom chat backgrounds** - Set personalized backgrounds for conversations
- 🔤 **Quick message translation** - Instantly translate messages to your preferred language
- 😊 **Express emotions with 80+ Emojis** - Enhanced emoji reactions for messages
- 🔒 **Anti-message peeking protection** - Prevent others from secretly viewing your messages
- 👁️ **Hide status indicators** - Hide "typing", "delivered" and "read" status from others
- 📱 **Native Integration** - Seamlessly integrated during build process

> **Note:** ZaDark is licensed under MPL-2.0 and is developed by [Quaric](https://zadark.com). The setup process automatically prepares ZaDark, and build process integrates it seamlessly!

## 🚀 Quick Start

### Usage

We strongly recommend using **Gear Lever** to integrate the AppImage perfectly into your system menu.

**Note:** Zalo for Linux comes with a built-in updater. Whenever a new release is available, you will be prompted within the Zalo app to download and apply the update seamlessly without leaving the application.

1.  Download the latest `.AppImage` file from the [**Releases**](https://github.com/doandat943/zalo-for-linux/releases) page.
2.  Install **Gear Lever** from [Flathub](https://flathub.org/en/apps/it.mijorus.gearlever).
3.  Open **Gear Lever**.
4.  Click the **"Open"** button in the top-left corner and select the `.AppImage` file you downloaded.
5.  The app will now appear in Gear Lever. Click the **"Unlock"** button, then choose **"Move to the app menu"** to integrate it into your system's application launcher.

### Build from Source

Prerequisites:

- Linux x86_64
- Node.js and npm
- 7z (p7zip-full) for extracting the macOS app during setup
- C++ build tools (for native addons): `build-essential`, `libssl-dev`, `liblzma-dev`

On Debian/Ubuntu:

```bash
sudo apt-get update && sudo apt-get install -y p7zip-full build-essential libssl-dev liblzma-dev
```

Steps:

```bash
# Clone the repository
git clone https://github.com/doandat943/zalo-for-linux.git
cd zalo-for-linux
# Then initialize or update submodules
git submodule update --init --recursive

# Run setup + build (downloads DMG, extracts, patches, packages)
npm run main
```

The final AppImage will be in the `dist/` directory.

> For a detailed walkthrough of the build pipeline, scripts, environment
> variables, and how to add new patches, see
> [DEVELOPMENT.md](./DEVELOPMENT.md).

## ⚙️ How It Works

This project is not a from-scratch rewrite of Zalo. It works by:

1.  Downloading the official macOS `.dmg` file.
2.  Using `7z` to extract the `app.asar` archive, which contains the main application logic written in JavaScript.
3.  Removing incompatible native macOS files.
4.  Wrapping the extracted application in a minimal, Linux-compatible Electron shell.
5.  Using `electron-builder` to package everything into a single, portable `AppImage` file.

For a deeper dive into the build pipeline and patching strategy, see
[ARCHITECTURE.md](./ARCHITECTURE.md).

For native addons (db-cross-v4, etc.), see
[`nativelibs/README.md`](./nativelibs/README.md).

## 🐛 Troubleshooting & Debugging

If you encounter issues or want to inspect the app's behavior, you can easily open Chrome Developer Tools (DevTools) using the following methods:
- **Keyboard Shortcut**: Press `Ctrl` + `Shift` + `I` while the Zalo window is focused.
- **Tray Menu**: Right-click the Zalo tray icon and select **"Toggle DevTools"**.

## 📚 More Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — How the build pipeline and patches work
- [DEVELOPMENT.md](./DEVELOPMENT.md) — Building from source, scripts, adding patches
- [nativelibs/README.md](./nativelibs/README.md) — Native addons (db-cross-v4, etc.)

## 📄 License

This project is licensed under the MIT License. Zalo is a trademark of VNG Corporation. This project is not affiliated with or endorsed by VNG Corporation.
