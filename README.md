# Zalo for Linux 🐧

[![Build Status](https://github.com/doandat943/zalo-for-linux/actions/workflows/build.yml/badge.svg)](https://github.com/doandat943/zalo-for-linux/actions/workflows/build.yml)

An unofficial, community-driven port of the Zalo desktop application for **Linux only**, created by repackaging the official macOS client into a standard AppImage with integrated ZaDark.

Thanks **realdtn2** for the solution: [realdtn2/zalo-linux-unofficial-2024](https://github.com/realdtn2/zalo-linux-unofficial-2024).

## ⚠️ Important: Known Issues

- **Message Synchronization (E2EE):** Zalo uses a proprietary native module (`db-cross-v4`) for End-to-End Encryption operations. This module only ships as a macOS binary (Mach-O) and cannot be loaded on Linux, so E2EE message sync will fail. **Workaround:** use **Wine** to run the Windows version of Zalo to perform the initial data sync, then migrate the data to this Linux version. For more details, see [issue #1](https://github.com/realdtn2/zalo-linux-unofficial-2024/issues/1) and [issue #2](https://github.com/realdtn2/zalo-linux-unofficial-2024/issues/2).
- **Can't make or receive calls:** The call module (`zcall`) only ships as a macOS native binary.
- **Can't see message reactions:** You won't see reactions in the UI (no badges/counters), but reacting still works and others can see your reaction.
- **No Photos/Videos, Files and Links on the Conversation Info panel** for some reason (you can still view images/videos, files or links normally, they just don't appear on the conversation info panel).
- Crash when clicking **Screenshot without Zalo window button**
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

## ⚡ Quick Start (CLI)

### Option 1: ZaDark Variant (Dark Mode + Privacy)

```sh
# 1. Download AppImage
# ZADARK_WGET
wget https://github.com/doandat943/zalo-for-linux/releases/download/v1.0.0/Zalo-1.0.0+ZaDark-1.0.0-abcdef.AppImage

# 2. Integrate with Gear Lever
# ZADARK_INTEGRATE
flatpak run it.mijorus.gearlever --integrate Zalo-1.0.0+ZaDark-1.0.0-abcdef.AppImage --yes

# 3. Configure auto-updates
flatpak run it.mijorus.gearlever --set-update-source ~/AppImages/zalo.appimage \
    --manager GithubUpdater \
    repo_url=https://github.com/doandat943/zalo-for-linux \
    repo_filename="Zalo-*+ZaDark-*-*.AppImage" \
    allow_prereleases=false
```

### Option 2: Original Variant (Standard)

```sh
# 1. Download AppImage
# ORIGINAL_WGET
wget https://github.com/doandat943/zalo-for-linux/releases/download/v1.0.0/Zalo-1.0.0-abcdef.AppImage

# 2. Integrate with Gear Lever
# ORIGINAL_INTEGRATE
flatpak run it.mijorus.gearlever --integrate Zalo-1.0.0-abcdef.AppImage --yes

# 3. Configure auto-updates
flatpak run it.mijorus.gearlever --set-update-source ~/AppImages/zalo.appimage \
    --manager GithubUpdater \
    repo_url=https://github.com/doandat943/zalo-for-linux \
    repo_filename="Zalo-*-*.AppImage" \
    allow_prereleases=false
```

### Build from Source

Prerequisites:

- Linux x86_64
- Node.js and npm
- 7z (p7zip-full) for extracting the macOS app during setup

On Debian/Ubuntu:

```bash
sudo apt-get update && sudo apt-get install -y p7zip-full
```

Steps:

```bash
# Clone the repository
git clone https://github.com/doandat943/zalo-for-linux.git
cd zalo-for-linux
# Then initialize or update submodules
git submodule update --init --recursive

# Option 1: Auto-download latest version (recommended)
npm run main:setup

# Option 2: Download specific version
ZALO_VERSION="25.11.20" npm run main:setup

# Build AppImage
npm run main:build
```

> ⚠️ Notes:
>
> - `npm run main` runs setup + build (equivalent to `SETUP=true BUILD=true node scripts/main.js`).
> - `npm run main:setup` runs check-versions + download-dmg + prepare-zadark + prepare-app.
> - `npm run main:build` runs build stage only.

The final AppImage will be in the `dist/` directory!

## 🛠️ Development Scripts

| **Command** | **Description** |
| --- | --- |
| `npm run main:setup` | `SETUP=true node scripts/main.js` (check + download + prepare) |
| `npm run main:build` | `BUILD=true node scripts/main.js` (build AppImage) |
| `npm run start` | Runs the app in development mode |
| `npm run build` | Builds AppImage (calls `scripts/build.js`) |
| `npm run download-dmg`* | Download Zalo DMG |
| `npm run prepare-app`* | Extract Zalo DMG |
| `npm run prepare-zadark` | Clones and builds ZaDark assets for later integration |

## 🌍 Environment Variables

| **Variable** | **Description** | **Example** |
| --- | --- | --- |
| `ZALO_VERSION` | Specify exact Zalo version to download/extract | `ZALO_VERSION="25.11.20"` |
| `ZADARK_VERSION` | Specify exact ZaDark version to download/integrate | `ZADARK_VERSION="v8.3.4"` |
| `FORCE_DOWNLOAD` | Force re-download even if file exists | `FORCE_DOWNLOAD=true` |

## Example

**🆕 Auto using latest version (Default - Meant without any environtment variable):**

```bash
# Automatically downloads the latest Zalo version from https://zalo.me/download/zalo-pc
npm run download-dmg

# If only one DMG file in `temp/` directory, auto select that file and extract
# If multiple DMG file in `temp/` directory, show DMG selection menu
npm run prepare-app

# Automatically downloads the latest Zalo version from https://zalo.me/download/zalo-pc
# Extract DMG version selected from previous step
# Prepare ZaDark
npm run main:setup
```

**🎯 Version Mode (Meant with environtment variable):**

```bash
# Just specify the version number! Script constructs the URL automatically
# Uses pattern: https://res-download-pc.zadn.vn/mac/ZaloSetup-universal-{ZALO_VERSION}.dmg
# Zalo servers handle redirect to the actual download location
ZALO_VERSION="25.8.2" npm run download-dmg

# Extract DMG version specificed
ZALO_VERSION="25.8.2" npm run prepare-app

# Forces re-download even if file already exists
FORCE_DOWNLOAD=true npm run download-dmg

# Example: Specific version with force re-download
ZALO_VERSION="25.8.2" FORCE_DOWNLOAD=true npm run download-dmg
ZALO_VERSION="25.8.2" FORCE_DOWNLOAD=true npm run main:setup
```

### 🎯 Interactive DMG Selection

When running `npm run prepare-app` with multiple DMG files in the `temp/` directory:

- **📋 Modern interface**: Arrow key navigation with radio button selection
- **🔍 Smart sorting**: Files ordered by version (highest first), then by date
- **📊 Detailed info**: Displays version, file size, and download date for each option
- **⚡ Intuitive controls**: Use ↑↓ arrows to navigate, Enter to select, Esc to cancel
- **🎯 Single file**: Auto-selects if only one DMG file exists

**Example interactive session:**

```text
📋 Available DMG files:
   Use ↑↓ arrow keys to navigate, Enter to select, Esc to cancel

  ● ZaloSetup-universal-26.1.0.dmg
    Version: v26.1.0 | Size: 198.5MB | Date: 12/20/2024, 3:45:12 PM

  ○ ZaloSetup-universal-25.8.2.dmg
    Version: v25.8.2 | Size: 195.2MB | Date: 12/15/2024, 10:23:45 AM

  ○ ZaloSetup-universal-25.5.3.dmg
    Version: v25.5.3 | Size: 192.1MB | Date: 12/10/2024, 2:15:30 PM

🎯 Selected: ZaloSetup-universal-26.1.0.dmg (v26.1.0)
```

**Navigation:**

- **↑↓** Arrow keys to move selection
- **Enter** to confirm selection
- **Esc** or **Ctrl+C** to cancel

## ⚙️ How It Works

This project is not a from-scratch rewrite of Zalo. It works by:

1. Downloading the official macOS `.dmg` file.
2. Using `7z` to extract the `app.asar` archive, which contains the main application logic written in JavaScript.
3. Removing incompatible native macOS files.
4. Wrapping the extracted application in a minimal, Linux-compatible Electron shell.
5. Using `electron-builder` to package everything into a single, portable `AppImage` file.

## 🐛 Troubleshooting & Debugging

If you encounter issues or want to inspect the app's behavior, you can easily open Chrome Developer Tools (DevTools) using the following methods:

- **Keyboard Shortcut**: Press `Ctrl` + `Shift` + `I` while the Zalo window is focused.
- **Tray Menu**: Right-click the Zalo tray icon and select **"Toggle DevTools"**.

## 🤝 Contributing

Contributions are welcome, especially for improving Linux integration, fixing bugs, and enhancing the build scripts.

1. Fork the repository.
2. Create your feature branch.
3. Commit your changes.
4. Submit a Pull Request.

## 📄 License

This project is licensed under the MIT License. Zalo is a trademark of VNG Corporation. This project is not affiliated with or endorsed by VNG Corporation.
