# zjxl

`zjxl` is a native Node.js addon for JPEG XL image processing. It is
re-implemented in Rust and exports a Node-API v5 (`napi5`) interface as
`jxl.node`.

The implementation uses pure-Rust crates for JPEG XL decoding and encoding,
JPEG encoding, and image resizing. No `libjxl`, `OpenCV`, `TurboJPEG`, or
`node-addon-api` dependency (original dpendency/libraries) is required by this module.

## Exported API

The addon keeps the names exposed by the original native module:

- `moduleReady()`
- `getJxlInfo(buffer)`
- `jxlToJpeg(options)`
- `jxlToJpegFromLocalPath(options)`
- `bitmapToJxl(options)`
- `resizeJxl(options)`
- `jxlDecompressMulti(options)`

## Source-file responsibilities

| File | Responsibility |
| --- | --- |
| `src/lib.rs` | Node-API boundary only. Declares the modules and exposes the seven JavaScript functions. |
| `src/types.rs` | N-API object definitions for options, metadata, tasks, and return values. |
| `src/service.rs` | Application workflows for each export: input handling, file I/O, conversion orchestration, preview generation, and multi-task processing. |
| `src/image.rs` | Image-domain operations: JPEG XL decode/encode, JPEG encode, pixel-layout conversion, metadata extraction, and resizing. |
| `Cargo.toml` | Rust package metadata, `cdylib` target, and pure-Rust dependencies. |
| `build.rs` | Initializes the `napi-rs` build integration. |
| `build.js` | Module-local build utility. Builds the Rust release library and copies it to `linux_x64/jxl.node`. |
| `package.json` | Node.js package metadata and `build` / `test` commands. |
| `LICENSE` | Module license. |

## Repository layout

```text
├── Cargo.toml
├── LICENSE
├── README.md
├── build.js
├── build.rs
├── package.json
└── src/
    ├── image.rs
    ├── lib.rs
    ├── service.rs
    └── types.rs
```

## Build

Run commands from this module directory:

```bash
npm run build
```

