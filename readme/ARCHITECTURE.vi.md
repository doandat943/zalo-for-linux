# Kiến trúc

[English](../ARCHITECTURE.md) | **Tiếng Việt**

Tài liệu này giải thích cách Zalo for Linux hoạt động bên trong.

## Tổng quan

Dự án này không viết lại Zalo từ đầu. Thay vào đó, dự án:

1. Tải file `.dmg` chính thức của Zalo cho macOS.
2. Dùng `7z` để giải nén file `app.asar`, nơi chứa phần logic chính của ứng dụng viết bằng JavaScript.
3. Loại bỏ các file native của macOS không tương thích.
4. Bọc ứng dụng đã giải nén trong một Electron shell tối giản, tương thích với Linux.
5. Dùng `electron-builder` để đóng gói tất cả thành một file `AppImage` duy nhất, chạy được ở nhiều nơi.

## Cấu trúc thư mục

```
zalo-for-linux/
├── ARCHITECTURE.md # Giải thích cách Zalo for Linux hoạt động bên trong
├── DEVELOPMENT.md # Hướng dẫn build Zalo for Linux từ mã nguồn
├── KNOWN_ISSUES.md # Theo dõi các hạn chế hiện tại, các lỗi đã được xử lý trước đây và ghi nhận đóng góp
├── LICENSE # File giấy phép, kèm tuyên bố miễn trừ trách nhiệm
├── main.js # Điểm khởi chạy của Electron
├── nativelibs # Các native addon của Zalo được viết lại cho Linux
│   ├── builder.js # Công cụ hỗ trợ build qua dòng lệnh
│   ├── builder-rust.js # Công cụ hỗ trợ build qua dòng lệnh, cho các addon viết bằng Rust
│   ├── db-cross-v4 # Addon giải mã bản sao lưu và đồng bộ tin nhắn mã hóa đầu cuối (E2EE)
│   ├── file-utilities # Addon quét hệ thống file bất đồng bộ và so khớp mẫu
│   ├── file-utils # Addon tiện ích truy cập hệ thống file và quản lý file
│   ├── mp4thumb # Addon trích xuất ảnh thu nhỏ từ file video MP4
│   ├── README.md # Thông tin về thư mục này
│   ├── zimage # Addon xử lý ảnh, thay đổi kích thước và chuyển đổi định dạng
│   └── zjxl # Hỗ trợ giải mã và mã hóa ảnh JPEG XL (JXL)
├── package.json  # Thông tin dự án + cấu hình build
├── package-lock.json  # File khóa phiên bản dependency của dự án
├── plugins # Các submodule/plugin của Zalo
│   ├── launcher-badge # Hiển thị số tin nhắn chưa đọc
│   ├── screenshot # Gọi module chụp màn hình native để chụp màn hình
│   ├── start-hidden # Cho phép ứng dụng khởi động ẩn trong khay hệ thống
│   ├── tray-host # Kiểm tra máy có khay hệ thống hay không, nếu không có thì thoát ứng dụng ngay
│   ├── userscripts # Trình quản lý userscript
│   ├── window-state # Kiểm tra trạng thái cửa sổ để tránh cửa sổ bị biến mất
│   ├── zadark # Tiện ích mở rộng cho chế độ tối, tính năng riêng tư và các chức năng bổ sung
│   └── zcall # Cửa sổ gọi và trình khởi động của engine gọi điện native
├── README.md # Thông tin về dự án
├── sample # Hình ảnh dùng cho hướng dẫn
├── scripts
│   ├── build.js 
│   ├── build-stage2.sh
│   ├── check-versions.js # Kiểm tra phiên bản Zalo mới hơn
│   ├── download-dmg.js # Tải file DMG cho macOS
│   ├── main.js # Script điều phối (chạy setup + build)
│   ├── patches # Các script patch riêng lẻ
│   ├── prepare-app.js # Giải nén app.asar + áp dụng các patch
│   ├── prepare-zadark.js # Build plugin ZaDark
│   └── utils # Các tiện ích
│       └── logger.js # File ghi log
└── zcall-native # Engine gọi điện native (không Wine): tín hiệu, media ZRTP / SRTP, âm thanh Opus
│   ├── native-engine # zcall-native.js (do main process đã patch khởi chạy), audio-io.py
│   ├── README.md # Cách engine hoạt động
│   └── tools # Tiện ích Python dùng chung (phát Opus)
├── app/                     # Ứng dụng đã giải nén (bị gitignore, được tạo lại khi build)
├── temp/                    # Bộ nhớ đệm cho file DMG đã tải
└── dist/                    # Kết quả build (AppImage, v.v.)

```

## Build pipeline

`npm run main` chạy toàn bộ pipeline:

1. **check-versions**: So sánh phiên bản hiện có với bản Zalo mới nhất
2. **download-dmg**: Tải `ZaloSetup-universal-<version>.dmg` về `temp/`
3. **prepare-zadark**: Build các tài nguyên của ZaDark (lấy từ submodule)
4. **prepare-app**: Giải nén `app.asar` vào `app/` và áp dụng các patch
   thông qua `scripts/patches/`
5. **build**: Đóng gói tất cả thành một AppImage trong `dist/`

## Các patch cho ứng dụng đã giải nén

Sau khi giải nén `app.asar` của macOS, cần chỉnh sửa một số chỗ
để tương thích với Linux. Các chỉnh sửa này được áp dụng trong `scripts/prepare-app.js`

Để biết thêm chi tiết về các native addon, xem [nativelibs.vi.md](./nativelibs.vi.md).

## Vì sao cần Electron shell?

Ứng dụng Zalo sau khi giải nén là một ứng dụng Electron được thiết kế cho macOS. Chúng mình:

1. Cung cấp một file `main.js` tối giản, có nhiệm vụ:
   - Nạp các plugin
   - Nạp `app/main-dist/main.js` từ ứng dụng đã giải nén
2. Dùng file `package.json` riêng, với cấu hình `electron-builder` dành cho Linux
3. Đổi tên file `package.json` đã giải nén thành `package.json.bak` để tránh xung đột

## Bên trong thư mục app/ đã giải nén có gì?

Mọi thứ trong `app/` đều được build pipeline **tạo lại** và bị
gitignore. Thư mục này chứa:

- `main-dist/main.js`: Bundle cho main process của Zalo
- `main-dist/preload-*.js`: Các preload script
- `main-dist/compact-app.js`: Utility process
- `pc-dist/`: Các bundle cho renderer/giao diện
- `native/nativelibs/`: Các native addon (một số được thay bằng phiên bản cho Linux)

Mã nguồn đã giải nén thuộc sở hữu của VNG/Zalo. Chúng mình không chỉnh sửa trực tiếp
mã này trong hệ thống quản lý phiên bản. Thay vào đó, các patch được áp dụng mỗi lần build thông qua `prepare-app.js`.
