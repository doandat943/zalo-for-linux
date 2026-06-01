# db-cross-v4

Linux reimplementation of Zalo's macOS `db-cross-v4-native.node` addon, used
for backup decryption and message synchronization.

## Origin

This is a clean-room reimplementation based on reverse engineering of the
macOS binary. The original work was done by
[realdtn2](https://github.com/realdtn2/zalo-linux-2026) and documented in
their repository's `reverse-engineering/` directory.

## Files

| File | Purpose |
|------|---------|
| `src/main.cc` | C++ source for the Linux addon |
| `binding.gyp` | node-gyp build config |
| `package.json` | Node package manifest |

Generated directories (gitignored):
- `node_modules/` — installed by `npm install`
- `build/Release/db-cross-v4-native.node` — compiled addon

## Building

```bash
node nativelibs/builder.js nativelibs/db-cross-v4
```

The compiled binary stays in:
`nativelibs/db-cross-v4/build/Release/db-cross-v4-native.node`

Copying to the final location is handled by the project build pipeline
(`scripts/prepare-app.js`).

## Requirements

- Node.js (matches project version)
- C++ compiler (gcc/clang)
- OpenSSL development headers (`libssl-dev`)
- LZMA development headers (`liblzma-dev`)

On Debian/Ubuntu:

```bash
sudo apt install build-essential libssl-dev liblzma-dev
```

## Notes

The addon is linked against:
- `-lcrypto` (OpenSSL, for AES-256-CBC decryption)
- `-llzma` (XZ/LZMA, for backup decompression)

Both are standard Linux libraries.