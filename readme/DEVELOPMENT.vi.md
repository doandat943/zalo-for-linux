# Phát triển

[English](../DEVELOPMENT.md) | **Tiếng Việt**

Tài liệu này hướng dẫn build Zalo for Linux từ mã nguồn, bao gồm
bộ công cụ build, các script và cách thêm patch hoặc native addon mới.

Để nắm tổng quan cách dự án hoạt động, xem
[ARCHITECTURE.vi.md](./ARCHITECTURE.vi.md). Để biết thông tin về việc viết lại
các native addon, xem [nativelibs.vi.md](./nativelibs.vi.md).

## Yêu cầu

- Linux x86_64
- Node.js và npm
- `7z` (`p7zip-full`) để giải nén ứng dụng macOS
- C++ build tools cho các native addon (xem [nativelibs.vi.md](./nativelibs.vi.md#yêu-cầu))

Trên Debian/Ubuntu:

```bash
sudo apt-get update && sudo apt-get install -y p7zip-full build-essential libssl-dev liblzma-dev
```

## Bắt đầu nhanh

```bash
# Clone
git clone https://github.com/VN-Linux-Family/zalo-for-linux.git
cd zalo-for-linux

# Khởi tạo các submodule (ZaDark, v.v.)
git submodule update --init --recursive

# Setup + build (tải DMG, giải nén, patch, đóng gói)
npm run main
```

Kết quả: `dist/Zalo-<version>.AppImage`

## Build hai giai đoạn

Bạn có thể chạy setup và build riêng:

```bash
# Giai đoạn 1: tải + giải nén (ghi vào app/ và temp/)
npm run main:setup

# Giai đoạn 2: đóng gói thành AppImage (dùng app/)
npm run main:build
```

## Các script phát triển

| Lệnh | Mô tả |
|---------|-------------|
| `npm run main:setup` | `SETUP=true node scripts/main.js` (kiểm tra + tải + chuẩn bị) |
| `npm run main:build` | `BUILD=true node scripts/main.js` (build AppImage) |
| `npm run start` | Chạy ứng dụng ở chế độ phát triển (sau khi đã setup) |
| `npm run build` | Chỉ build AppImage (gọi `scripts/build.js`) |
| `npm run download-dmg` | Tải file DMG của Zalo |
| `npm run prepare-app` | Giải nén file DMG của Zalo và áp dụng các patch cho Linux |
| `npm run prepare-zadark` | Build các tài nguyên chế độ tối của ZaDark |

## Biến môi trường

| Biến | Mô tả | Ví dụ |
|----------|-------------|---------|
| `ZALO_VERSION` | Chỉ định chính xác phiên bản Zalo cần tải/giải nén | `ZALO_VERSION="25.11.20"` |
| `ZADARK_VERSION` | Chỉ định chính xác phiên bản ZaDark cần tải/tích hợp | `ZADARK_VERSION="v8.3.4"` |
| `FORCE_DOWNLOAD` | Buộc tải lại kể cả khi file đã có sẵn | `FORCE_DOWNLOAD=true` |

## Ví dụ chọn phiên bản cụ thể

```bash
# Tải một phiên bản Zalo cụ thể
ZALO_VERSION="25.8.2" npm run download-dmg

# Giải nén đúng phiên bản đó
ZALO_VERSION="25.8.2" npm run prepare-app

# Buộc tải lại kể cả khi đã có trong bộ nhớ đệm
FORCE_DOWNLOAD=true npm run download-dmg
```

## Chọn file DMG tương tác

Nếu trong `temp/` có nhiều file DMG, `npm run prepare-app` sẽ hiện một
menu để bạn chọn:

```
📋 Available DMG files:
   Use ↑↓ arrow keys to navigate, Enter to select, Esc to cancel

  ● ZaloSetup-universal-26.1.0.dmg
    Version: v26.1.0 | Size: 198.5MB | Date: 12/20/2024, 3:45:12 PM

  ○ ZaloSetup-universal-25.8.2.dmg
    Version: v25.8.2 | Size: 195.2MB | Date: 12/15/2024, 10:23:45 AM
```

Nếu chỉ có một file DMG, file đó sẽ được chọn tự động.

## Thêm patch mới

Các patch nằm trong `scripts/patches/`, mỗi patch là một file riêng. Để thêm patch mới:

1. Tạo file `scripts/patches/patch-<name>.js`:

```javascript
const fs = require('fs-extra');
const path = require('path');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

async function main() {
  console.log('🔧 Patching...');

  const targetPath = path.join(APP_DIR, 'main-dist', 'main.js');
  if (!fs.existsSync(targetPath)) {
    console.log('⚠️  File not found, skipping');
    return;
  }

  let content = fs.readFileSync(targetPath, 'utf8');
  if (content.includes('OLD_PATTERN')) {
    content = content.replace(/OLD_PATTERN/g, 'NEW_PATTERN');
    fs.writeFileSync(targetPath, content, 'utf8');
    console.log('✅ Applied my-patch');
  }
}

module.exports = { main };
```

2. Thêm vào `scripts/prepare-app.js`:

```javascript
const { main: patchName } = require('./patches/patch-<name>');
await patchName();
```

Luôn kiểm tra xem đoạn mã cần tìm có tồn tại không trước khi thay thế, vì mỗi phiên bản Zalo có thể thay đổi và đoạn mã đó có thể bị xê dịch.

## Gỡ lỗi ứng dụng đã giải nén

- **DevTools**: Nhấn `Ctrl+Shift+I` khi đang ở cửa sổ Zalo
- **Menu ở khay hệ thống**: Nhấp chuột phải vào biểu tượng ở khay hệ thống → "Toggle DevTools"
- **Log**: Xem trong `~/.config/Zalo/logs/` hoặc chạy kèm `ELECTRON_ENABLE_LOGGING=1`

## Phát triển plugin

Dự án hỗ trợ các plugin nằm trong `plugins/`:

- `zadark/`: Tiện ích mở rộng chế độ tối (git submodule từ
  [quaric/zadark](https://github.com/quaric/zadark))
- `zalux/`: Các cải tiến trải nghiệm trên Linux (nút chụp màn hình, v.v.)

Mỗi plugin được nạp trong `main.js`. Bạn có thể tham khảo các plugin hiện có để làm ví dụ.
