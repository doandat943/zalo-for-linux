{
  "targets": [{
    "target_name": "db-cross-v4-native",
    "sources": ["src/main.cc"],
    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
    "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
    "cflags!": ["-fno-exceptions"],
    "cflags_cc!": ["-fno-exceptions"],
    "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
    "libraries": ["-llzma", "-lcrypto"],
    "cflags_cc": ["-std=c++17", "-O2"]
  }]
}
