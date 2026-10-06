# Zalo for Linux 🐧

[English](../README.md) | **Tiếng Việt**

[![Build Status](https://github.com/VN-Linux-Family/zalo-for-linux/actions/workflows/build.yml/badge.svg)](https://github.com/VN-Linux-Family/zalo-for-linux/actions/workflows/build.yml)

Bản port Zalo desktop không chính thức, do cộng đồng phát triển, **chỉ dành cho Linux**. Ứng dụng được đóng gói lại từ bản Zalo chính thức cho macOS thành một file AppImage tiêu chuẩn, có tích hợp sẵn ZaDark.

Cảm ơn **realdtn2** đã đưa ra giải pháp: [realdtn2/zalo-linux-2026](https://github.com/realdtn2/zalo-linux-2026).

## ⚠️ Lưu ý quan trọng: Các lỗi đã biết

- **➖ Đã khắc phục một phần: Không gọi hoặc nhận cuộc gọi được:** Cảm ơn @collyn đã dựng Wine wrapper để giải quyết vấn đề này. Xem [PR #62](https://github.com/VN-Linux-Family/zalo-for-linux/pull/62) để biết thêm chi tiết. Hiện tại tính năng gọi chưa dùng được trên aarch64, vì `zcall` của Windows chỉ hỗ trợ x86_64.

> 💡 **Danh sách đầy đủ các lỗi đã sửa, cách khắc phục tạm thời và ghi nhận đóng góp của cộng đồng nằm trong [KNOWN_ISSUES.vi.md](./KNOWN_ISSUES.vi.md).**

Dự án này phù hợp nhất với những ai cần một ứng dụng Zalo chạy như ứng dụng gốc trên Linux và không ngại xử lý một vài thao tác kỹ thuật để dùng đầy đủ tính năng.

## ✨ Tính năng bổ sung

Dự án có thêm một số tính năng mà bản Zalo chính thức không có.

✨ **Danh sách đầy đủ các tính năng có trong dự án nằm trong [FEATURES.vi.md](./FEATURES.vi.md).**

## 🚀 Bắt đầu nhanh

### Cài đặt và sử dụng

Chúng mình khuyên bạn nên dùng **Gear Lever** hoặc **AM** để AppImage được tích hợp gọn gàng vào menu ứng dụng của hệ thống.

**Lưu ý:** Zalo for Linux đã có sẵn thông tin cập nhật bên trong, bạn không cần tự cấu hình gì thêm để cập nhật ứng dụng.

#### Nếu bạn dùng AM

1. Cài **AM** theo [hướng dẫn của AM](https://github.com/ivan-hc/AM#using-the-am-installer-script-to-choose-between-local-and-system-wide-installation).
2. Chạy lệnh sau để cài Zalo:
   ```bash
   am -i zalo
   ```
   *Lưu ý: nếu bạn chọn cài `appman` thì thay `am` bằng `appman`.*
3. Một lời nhắc như hình dưới sẽ hiện ra:
   <img width="747" height="600" alt="installer" src="../sample/am-guide.png" />

   *Bạn chọn phiên bản mình muốn, AM sẽ tự tải đúng phiên bản.*
4. Vậy là ứng dụng **đã được cài**. Bạn có thể mở Zalo từ menu ứng dụng của hệ thống.

   Hoặc chạy từ dòng lệnh (terminal):
   ```bash
   zalo
   ```
5. Cách cập nhật:
   Chỉ cần chạy lệnh dưới đây, AM sẽ **tự động cập nhật mọi ứng dụng đã cài qua AM (bao gồm Zalo)**:
   ```bash
   am -u
   ```

#### Nếu bạn dùng Gear Lever

1. Tải file `.AppImage` mới nhất ở trang [**Releases**](https://github.com/VN-Linux-Family/zalo-for-linux/releases).
2. Cài **Gear Lever** từ [Flathub](https://flathub.org/en/apps/it.mijorus.gearlever).
3. Mở **Gear Lever**.
4. Bấm nút **"Open"** ở góc trên bên trái rồi chọn file `.AppImage` vừa tải.
5. Ứng dụng sẽ hiện trong Gear Lever. Bấm nút **"Unlock"**, sau đó chọn **"Move to the app menu"** để đưa Zalo vào menu ứng dụng của hệ thống.
6. Cách cập nhật:
   - Mở **Gear Lever**.
   - Khi có bản cập nhật, nút **No updates available** sẽ chuyển thành **Update**. Bạn chỉ cần bấm vào là Zalo được cập nhật.

#### Chạy thủ công (không khuyến khích)

1. Tải file `.AppImage` mới nhất ở trang [**Releases**](https://github.com/VN-Linux-Family/zalo-for-linux/releases).
2. Cấp quyền thực thi cho file:
   ```bash
   chmod +x <tên-file-đã-tải> # Xem tên file bằng lệnh ls, hoặc dùng trình quản lý file
   ```
3. Chạy ứng dụng bằng lệnh:
   ```bash
   ./<tên-file-đã-tải>
   ```
4. Để cập nhật, bạn chỉ cần **tải lại file `.AppImage` mới nhất** ở trang **Releases**, rồi **làm lại bước 2 và 3**.

*LƯU Ý: Sau khi cập nhật, hãy thoát hẳn ứng dụng rồi mở lại để thay đổi mới được áp dụng.*

### Tự build từ mã nguồn

Yêu cầu:

- Linux x86_64 hoặc aarch64
- Node.js và npm
- 7z (p7zip-full) để giải nén ứng dụng macOS trong bước setup
- C++ build tools (cho các native addon): `build-essential`, `libssl-dev`, `liblzma-dev`
- `zcall` build tools: `gcc-mingw-w64-i686` `gcc-multilib` `libc6-dev-i386` `libx11-dev` `libxcb1-dev` `libx11-dev:i386` `libxcb1-dev:i386` `libxext-dev:i386`

Trên Debian/Ubuntu:

```bash
sudo dpkg --add-architecture i386
sudo apt update && sudo apt install -y liblzma-dev p7zip-full gcc-mingw-w64-i686 gcc gcc-multilib libc6-dev-i386 libx11-dev libxcb1-dev libx11-dev:i386 libxcb1-dev:i386 libxext-dev:i386 zsync
```

Các bước:

```bash
# Clone repository
git clone https://github.com/VN-Linux-Family/zalo-for-linux.git
cd zalo-for-linux
# Khởi tạo hoặc cập nhật submodule
git submodule update --init --recursive

# Chạy setup + build (tải DMG, giải nén, patch, đóng gói)
npm run main
```

File AppImage hoàn chỉnh sẽ nằm trong thư mục `dist/`.

> Hướng dẫn chi tiết về build pipeline, các script, biến môi trường và cách thêm patch mới nằm trong [`DEVELOPMENT.vi.md`](./DEVELOPMENT.vi.md).

## ⚙️ Cách hoạt động

Dự án này không viết lại Zalo từ đầu. Cách làm như sau:

1. Tải file `.dmg` chính thức của Zalo cho macOS.
2. Dùng `7z` để giải nén file `app.asar`, nơi chứa phần logic chính của ứng dụng viết bằng JavaScript.
3. Loại bỏ các file native của macOS không tương thích.
4. Bọc ứng dụng đã giải nén trong một Electron shell tối giản, tương thích với Linux.
5. Dùng `electron-builder`, sau đó là `quick-sharun` để đóng gói tất cả thành một file `AppImage` duy nhất, chạy được trên nhiều bản phân phối Linux.

Tìm hiểu sâu hơn về build pipeline và cách patch trong [`ARCHITECTURE.vi.md`](./ARCHITECTURE.vi.md).

Về các native addon (db-cross-v4, v.v.), xem [`nativelibs.vi.md`](./nativelibs.vi.md).

Về `zcall` bridge, xem [`zcall-bridge/README.md`](../zcall-bridge/README.md).

## 🐛 Xử lý sự cố và gỡ lỗi

Nếu gặp lỗi hoặc muốn xem ứng dụng đang hoạt động thế nào, bạn có thể mở Chrome Developer Tools (DevTools) bằng một trong hai cách:
- **Phím tắt**: nhấn `Ctrl` + `Shift` + `I` khi đang ở cửa sổ Zalo.
- **Menu ở khay hệ thống**: nhấp chuột phải vào biểu tượng Zalo ở khay hệ thống và chọn **"Toggle DevTools"**.

## 📚 Tài liệu khác

- [KNOWN_ISSUES.vi.md](./KNOWN_ISSUES.vi.md): các lỗi đã biết, cách khắc phục tạm thời và lịch sử các lỗi đã sửa
- [ARCHITECTURE.vi.md](./ARCHITECTURE.vi.md): cách build pipeline và các patch hoạt động
- [DEVELOPMENT.vi.md](./DEVELOPMENT.vi.md): build từ mã nguồn, các script, cách thêm patch
- [nativelibs.vi.md](./nativelibs.vi.md): các native addon (db-cross-v4, v.v.)
- [zcall-bridge/README.md](../zcall-bridge/README.md): `zcall` bridge

## 📄 Giấy phép

Dự án được phát hành theo giấy phép MIT. Zalo là thương hiệu của VNG Corporation. Dự án này không liên kết với VNG Corporation và cũng không được VNG Corporation bảo trợ.
