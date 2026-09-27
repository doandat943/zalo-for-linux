# Zalo for Linux 🐧

[![Build Status](https://github.com/doandat943/zalo-for-linux/actions/workflows/build.yml/badge.svg)](https://github.com/doandat943/zalo-for-linux/actions/workflows/build.yml)

An unofficial, community-driven port of the Zalo desktop application for **Linux only**, created by repackaging the official macOS client into a standard AppImage with integrated ZaDark.

Thanks **realdtn2** for the solution: [realdtn2/zalo-linux-2026](https://github.com/realdtn2/zalo-linux-2026).

## ⚠️ Important: Known Issues

- **➖ Partly-fixed: Can't make or receive calls:** Thanks to @collyn for setting up a Wine wrapper to solve this. See [PR #62](https://github.com/doandat943/zalo-for-linux/pull/62) for more info, but currently calling is not available on aarch64, because Windows `zcall` only supports x86_64.

> 💡 **For the full list of resolved issues, workarounds, and community credits, see [KNOWN_ISSUES.md](./KNOWN_ISSUES.md).**

This project is best suited for users who need a native-feeling Zalo client on Linux and are comfortable with the technical workarounds required for full functionality.

## 🙈 Start hidden in the tray

When **Settings → Launch Zalo on startup** is enabled, Zalo starts minimized
to the system tray at login. The autostart entry it writes to
`~/.config/autostart/` launches it with `--hidden`. If you enabled the setting
with an older build, turn it off and on again to update the entry.

You can also pass the flag yourself (`--start-hidden` works too):

```bash
/path/to/zalo --hidden
```

Open the window from the tray icon, by clicking a notification, or by launching
Zalo again. If no system tray is available, the flag is ignored so the window
is never unreachable.

## 🧩 Userscripts manager

Open **Settings → Userscripts manager** to create, paste, edit, import, delete,
and enable or disable scripts that run inside Zalo. Tampermonkey-style metadata
such as `@name`, `@description`, `@version`, `@match`, `@include`, and
`@exclude` is recognized. Imported scripts may use the `.js` or `.user.js`
extension.

The compatibility layer currently provides `GM_info`, `GM_addStyle`,
`GM_getValue`, `GM_setValue`, `GM_deleteValue`, `GM_listValues`, and
`unsafeWindow`. Changes take effect the next time the Zalo page is loaded.

> **Security:** Userscripts execute with access to the current Zalo page and
> messages displayed in it. Only install scripts whose source you trust.

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

We strongly recommend using **Gear Lever** or **AM** to integrate the AppImage perfectly into your system menu.

**Note:** Zalo for Linux comes with embed update info. you can 

- For AM users:

1. Install **AM** from [AM's guide](https://github.com/ivan-hc/AM#using-the-am-installer-script-to-choose-between-local-and-system-wide-installation)
2. Run this command to install Zalo:
   ```bash
   am -i zalo
   ```
   *Note: Replace `am` with `appman` if you chose to install `appman`.*
3. A prompt like this will appear:
   <img width="747" height="600" alt="installer" src="https://raw.githubusercontent.com/VN-Linux-Family/zalo-for-linux/refs/heads/main/sample/am-guide.png" />

   *You can choose what variants you like from this, AM will download the correct version for you.*
4. The app is now installed. You can now go to your system's application launcher to launch Zalo.

   Or run from the command line:
   ```bash
   zalo
   ```

- For Gear Lever users:

1.  Download the latest `.AppImage` file from the [**Releases**](https://github.com/doandat943/zalo-for-linux/releases) page.
2.  Install **Gear Lever** from [Flathub](https://flathub.org/en/apps/it.mijorus.gearlever).
3.  Open **Gear Lever**.
4.  Click the **"Open"** button in the top-left corner and select the `.AppImage` file you downloaded.
5.  The app will now appear in Gear Lever. Click the **"Unlock"** button, then choose **"Move to the app menu"** to integrate it into your system's application launcher.

### Build from Source

Prerequisites:

- Linux x86_64 or aarch64
- Node.js and npm
- 7z (p7zip-full) for extracting the macOS app during setup
- C++ build tools (for native addons): `build-essential`, `libssl-dev`, `liblzma-dev`
- `zcall` build tools: `gcc-mingw-w64-i686` `gcc-multilib` `libc6-dev-i386` `libx11-dev` `libxcb1-dev` `libx11-dev:i386` `libxcb1-dev:i386` `libxext-dev:i386`

On Debian/Ubuntu:

```bash
sudo dpkg --add-architecture i386
sudo apt update && sudo apt install -y liblzma-dev p7zip-full gcc-mingw-w64-i686 gcc gcc-multilib libc6-dev-i386 libx11-dev libxcb1-dev libx11-dev:i386 libxcb1-dev:i386 libxext-dev:i386 zsync
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
5.  Using `electron-builder`, then `quick-sharun` to package everything into a single, portable `AppImage` file.

For a deeper dive into the build pipeline and patching strategy, see
[ARCHITECTURE.md](./ARCHITECTURE.md).

For native addons (db-cross-v4, etc.), see
[`nativelibs/README.md`](./nativelibs/README.md).

For the `zcall` bridge, see
- [zcall-bridge/README.md](./zcall-bridge/README.md)

## 🐛 Troubleshooting & Debugging

If you encounter issues or want to inspect the app's behavior, you can easily open Chrome Developer Tools (DevTools) using the following methods:
- **Keyboard Shortcut**: Press `Ctrl` + `Shift` + `I` while the Zalo window is focused.
- **Tray Menu**: Right-click the Zalo tray icon and select **"Toggle DevTools"**.

## 📚 More Documentation

- [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) — Known issues, workarounds, and resolved bug history
- [ARCHITECTURE.md](./ARCHITECTURE.md) — How the build pipeline and patches work
- [DEVELOPMENT.md](./DEVELOPMENT.md) — Building from source, scripts, adding patches
- [nativelibs/README.md](./nativelibs/README.md) — Native addons (db-cross-v4, etc.)
- [zcall-bridge/README.md](./zcall-bridge/README.md) — `zcall` bridge

## 📄 License

This project is licensed under the MIT License. Zalo is a trademark of VNG Corporation. This project is not affiliated with or endorsed by VNG Corporation.
