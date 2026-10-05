# nativelibs

[English](../nativelibs/README.md) | **Tiếng Việt**

Các bản viết lại cho Linux của những native addon độc quyền mà Zalo dùng trên macOS.

## Vì sao cần?

Ứng dụng Zalo desktop chính thức cho macOS dùng các native addon mã nguồn đóng
(file `.node`) cho nhiều tính năng khác nhau. Một số addon trong đó là thiết yếu
(gửi/nhận tin nhắn, giải mã bản sao lưu). Bản macOS là file nhị phân Mach-O
nên không thể nạp được trên Linux.

Vì không có mã nguồn gốc, chúng mình dùng phương pháp **clean-room reverse
engineering** (dịch ngược "phòng sạch") dựa trên việc disassemble các file
nhị phân macOS. Mỗi bản viết lại đều được build lại từ mã nguồn trong quá
trình build — không có file nhị phân độc quyền nào được commit vào repository
này.

## Cấu trúc thư mục

```
nativelibs/
├── README.md                       # File này
├── builder.js                      # Công cụ hỗ trợ build qua dòng lệnh
└── <addon-name>/                   # Mỗi addon một thư mục
    ├── .gitignore                  # bỏ qua node_modules/, build/
    ├── README.md                   # tài liệu riêng của addon
    ├── binding.gyp                 # cấu hình node-gyp
    ├── package.json                # manifest của Node package
    └── src/
        └── main.cc                 # mã nguồn C++
```

`builder.js` ở thư mục gốc là công cụ build dùng chung cho tất cả các addon.
Ngoài ra, mỗi addon đều độc lập, tự chứa mọi thứ mình cần.

## Các addon hiện có

| Addon | Trạng thái | Mô tả |
|-------|--------|-------------|
| [db-cross-v4](../nativelibs/db-cross-v4) | ✅ Đã hoàn thành | Giải mã bản sao lưu và đồng bộ tin nhắn mã hóa đầu cuối (E2EE) |
| [file-utilities](../nativelibs/file-utilities) | ✅ Đã hoàn thành | Quét hệ thống file bất đồng bộ và so khớp mẫu |
| [file-utils](../nativelibs/file-utils) | ✅ Đã hoàn thành | Các tiện ích truy cập hệ thống file và quản lý file |
| [mp4thumb](../nativelibs/mp4thumb) | ✅ Đã hoàn thành | Trích xuất ảnh thumbnail từ file video MP4 |
| [zimage](../nativelibs/zimage) | ✅ Đã hoàn thành | Xử lý ảnh, thay đổi kích thước và chuyển đổi định dạng |
| [zjxl](../nativelibs/zjxl) | ✅ Đã hoàn thành | Hỗ trợ giải mã và mã hóa ảnh JPEG XL (JXL) |

## Build một addon

```bash
node nativelibs/builder.js nativelibs/<addon-name>
```

File nhị phân sau khi biên dịch sẽ nằm tại:
`<project-root>/nativelibs/<addon-name>/build/Release/*.node`

Đường dẫn này khớp với cấu trúc mà các JS binding của ứng dụng Zalo mong đợi.

## Công cụ hỗ trợ build

`builder.js` là một script chạy từ dòng lệnh (terminal):

```bash
node nativelibs/builder.js <addon-path>
```

Script tự động đọc phiên bản Electron từ file `package.json` ở thư mục gốc của dự án.

## Thêm một addon mới

Để thêm một bản viết lại mới:

1. **Tạo cấu trúc thư mục** — sao chép một addon có sẵn làm mẫu:
   ```bash
   cp -r nativelibs/db-cross-v4 nativelibs/<new-addon>
   ```

2. **Cập nhật các file tĩnh**:
   - `binding.gyp` — đổi `target_name` và `sources`
   - `package.json` — đổi `name` và `description`
   - `src/main.cc` — thay bằng phần cài đặt C++ của bạn

3. **Cập nhật `README.md`** — mô tả addon làm gì và các lưu ý riêng
   cho từng nền tảng (nếu có)

4. **Thêm patch script** — thông thường mỗi addon cần một patch script trong
   `scripts/patches/` để lo phần build và patch các JS binding liên quan

## Yêu cầu

Để build các addon, bạn cần:

- Node.js (đúng phiên bản dự án đang dùng)
- Trình biên dịch C++ (gcc/clang)
- `node-gyp` (cài qua npm)
- Header phát triển của OpenSSL (`libssl-dev`) — cho các addon mã hóa
- Header phát triển của LZMA (`liblzma-dev`) — cho các addon nén dữ liệu

Trên Debian/Ubuntu:

```bash
sudo apt install -y build-essential libssl-dev liblzma-dev
```

## Mã nguồn hay file nhị phân

**Chúng mình không commit các file nhị phân `.node` build sẵn.** Thư mục
`build/` và `node_modules/` trong mỗi addon đều nằm trong gitignore. File nhị
phân luôn được build lại từ mã nguồn trong build pipeline.

Cách làm này đảm bảo:
- Bản build **tái tạo được** — ai cũng có thể tạo lại đúng file nhị phân đó
  từ mã nguồn C++
- **Không có mã độc quyền** nào nằm trong repository của chúng mình
- **Không có rủi ro chuỗi cung ứng** do commit một khối nhị phân không rõ
  nguồn gốc
- Các nhà nghiên cứu bảo mật có thể **xem xét mã nguồn**

## Ghi nhận

Các bản viết lại dựa trên công sức dịch ngược của
[realdtn2](https://github.com/realdtn2/zalo-linux-2026). Xem `README.md` của
từng addon để biết ghi nhận cụ thể.
