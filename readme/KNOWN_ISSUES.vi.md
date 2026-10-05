# Các lỗi đã biết và cách khắc phục tạm thời 🛠️

[English](../KNOWN_ISSUES.md) | **Tiếng Việt**

Tài liệu này ghi lại những hạn chế hiện tại và các lỗi trước đây đã được xử lý trong **Zalo for Linux**, kèm lời cảm ơn tới các bạn trong cộng đồng đã góp công giải quyết.

---

## ⚠️ Các lỗi và hạn chế hiện tại

- **Đã khắc phục một phần: Gọi thoại/gọi video trên ARM64:** 
  Tính năng gọi thoại/gọi video đã hoạt động trên x86_64 nhờ cơ chế chuyển đổi TCP sang named pipe qua Wine (`zcall-bridge`). Tuy nhiên, hiện tại **chưa gọi được trên aarch64 (ARM64)**, vì file `ZaloCall.exe` chính thức cho Windows và các file native hỗ trợ đi kèm chỉ chạy trên kiến trúc x86 32-bit/64-bit. Xem [PR #62](https://github.com/doandat943/zalo-for-linux/pull/62) và [Issue #70](https://github.com/doandat943/zalo-for-linux/issues/70).

---

## ✅ Các lỗi đã sửa và cách khắc phục tạm thời

- **Chủ đề theo hệ thống/tự động không hoạt động:** 
  - **Lỗi:** Ứng dụng không đổi theo chế độ sáng/tối của hệ thống. Cả ZaDark lẫn Zalo đều bỏ qua `prefers-color-scheme`. 
  - **Cách giải quyết:** Giờ đây ứng dụng có thể nhận biết thay đổi theo thời gian thực qua GNOME D-Bus (org.gnome.desktop.interface color-scheme), XDG Desktop Portal (org.freedesktop.appearane) hoặc gtk-theme. Ứng dụng tự động đồng bộ `nativeTheme.themeSource` và class `.dark` trong DOM mà không can thiệp hay làm thay đổi thanh tiêu đề mặc định của hệ điều hành.
  - **Ghi nhận:** Cảm ơn [@nct88](https://github.com/nct88). Xem [PR #87](https://github.com/VN-Linux-Family/zalo-for-linux/pull/87), [Issue #22](https://github.com/VN-Linux-Family/zalo-for-linux/issues/22) và [Issue #21](https://github.com/VN-Linux-Family/zalo-for-linux/issues/21#issuecomment-4437302799).


- **Đồng bộ tin nhắn (E2EE):**
  - **Lỗi:** Thiếu module native `db-cross-v4` khiến tin nhắn mã hóa đầu cuối (E2EE) không đồng bộ được trên Linux.
  - **Cách giải quyết:** Viết lại `db-cross-v4` bằng C++. Giờ đây tin nhắn E2EE đồng bộ trực tiếp trên Linux mà không cần đến Wine.
  - **Ghi nhận:** Cảm ơn [@realdtn2](https://github.com/realdtn2) đã viết phần triển khai và [@DMKha2k7](https://github.com/DMKha2k7) đã gửi PR tích hợp. Xem [PR #24](https://github.com/doandat943/zalo-for-linux/pull/24) và [Issue #15](https://github.com/doandat943/zalo-for-linux/issues/15).

- **Bảng thông tin hội thoại (Ảnh/Video, File và Link):**
  - **Lỗi:** Ảnh/video, file và link trong bảng thông tin bên phải không tải được.
  - **Cách giải quyết:** Đã xử lý nhờ bổ sung module native `db-cross-v4`.

- **Bày tỏ cảm xúc với tin nhắn:**
  - **Lỗi:** Không xem được hoặc không thả được biểu tượng cảm xúc (emoji) cho tin nhắn.
  - **Cách giải quyết:** Đã xử lý nhờ bổ sung module native `db-cross-v4`.

- **Dán và gửi ảnh:**
  - **Lỗi:** Sao chép ảnh trên Linux rồi nhấn `Ctrl+V` vào khung chat không hoạt động, và ảnh gửi đi thường bị chuyển thành file đính kèm thô thay vì hiện xem trước như ảnh.
  - **Cách giải quyết:** Giờ bạn có thể dán file ảnh (`.png`, `.jpg`, `.jpeg`, v.v.) vào khung chat bằng `Ctrl+V` (Wayland dùng `wl-clipboard`, X11 dùng `xclip`), và ảnh gửi từ hộp thoại chọn file được nhận diện đúng là ảnh thay vì file đính kèm thông thường.
  - **Ghi nhận:** Cảm ơn [@realdtn2](https://github.com/realdtn2) với giải pháp clipboard ban đầu, [@DMKha2k7](https://github.com/DMKha2k7) với [PR #25](https://github.com/doandat943/zalo-for-linux/pull/25) / [Issue #23](https://github.com/doandat943/zalo-for-linux/issues/23), và [@brucenguyen1102](https://github.com/brucenguyen1102) với [PR #34](https://github.com/doandat943/zalo-for-linux/pull/34).

- **Tự khởi động cùng hệ thống trên Linux:**
  - **Lỗi:** Bật tùy chọn "Start Zalo on system startup" trong phần cài đặt có sẵn của Zalo không có tác dụng trên Linux.
  - **Cách giải quyết:** Patch các IPC handler xử lý tự khởi động để tạo hoặc xóa file desktop entry tự khởi động tiêu chuẩn tại `~/.config/autostart/zalo.desktop`.
  - **Ghi nhận:** Cảm ơn [@akimiya7742](https://github.com/akimiya7742) và [@DMKha241](https://github.com/DMKha241). Xem [PR #51](https://github.com/doandat943/zalo-for-linux/pull/51), [PR #59](https://github.com/doandat943/zalo-for-linux/pull/59) và [PR #61](https://github.com/doandat943/zalo-for-linux/pull/61).

- **Thư mục người dùng XDG và đường dẫn tải về:**
  - **Lỗi:** Zalo gán cứng và luôn tự tạo thư mục tiếng Anh `~/Zalo Received Files` ngay trong `$HOME`, bỏ qua ngôn ngữ hệ thống của người dùng và chuẩn XDG.
  - **Cách giải quyết:** Patch đường dẫn tải về và lưu file để tuân theo các thư mục XDG tiêu chuẩn của Linux (`$XDG_DOWNLOAD_DIR`).
  - **Ghi nhận:** Cảm ơn [@akimiya7742](https://github.com/akimiya7742). Xem [PR #52](https://github.com/doandat943/zalo-for-linux/pull/52), [Issue #20](https://github.com/doandat943/zalo-for-linux/issues/20) và [Issue #48](https://github.com/doandat943/zalo-for-linux/issues/48).

- **Huy hiệu đếm tin nhắn chưa đọc:**
  - **Lỗi:** Biểu tượng ứng dụng trên dock/thanh tác vụ không hiện huy hiệu báo số tin nhắn chưa đọc.
  - **Cách giải quyết:** Bổ sung huy hiệu đếm tin nhắn chưa đọc cho các môi trường desktop hỗ trợ giao thức huy hiệu của Unity/KDE/GNOME.
  - **Ghi nhận:** Cảm ơn [@akimiya7742](https://github.com/akimiya7742). Xem [PR #43](https://github.com/doandat943/zalo-for-linux/pull/43).

- **Công cụ chụp màn hình trong ứng dụng:**
  - **Lỗi:** Tính năng chụp màn hình có sẵn không hoạt động trên Linux.
  - **Cách giải quyết:** Tích hợp với các công cụ chụp màn hình sẵn có trên Linux (`deepin-screen-recorder`, `spectacle`, `flameshot`, `gnome-screenshot`, `xfce4-screenshooter`, `mate-screenshot`, `ksnapshot`, `scrot`).
  - **Ghi nhận:** Cảm ơn [@hthienloc](https://github.com/hthienloc) đã đưa ra giải pháp. Xem [Issue #19](https://github.com/doandat943/zalo-for-linux/issues/19).

- **Các nút điều khiển trên thanh tiêu đề cửa sổ:**
  - **Lỗi:** Thiếu các nút thu nhỏ, phóng to và đóng tiêu chuẩn trên một số trình quản lý cửa sổ/môi trường desktop.
  - **Cách giải quyết:** Patch khung cửa sổ và các nút điều khiển trên thanh tiêu đề.
  - **Ghi nhận:** Cảm ơn [@NanKillBro](https://github.com/NanKillBro) đã đưa ra giải pháp. Xem thêm chi tiết tại [Issue #4](https://github.com/doandat943/zalo-for-linux/issues/4).

- **Biểu tượng ở khay hệ thống:**
  - **Lỗi:** Không có biểu tượng và menu ở khay hệ thống trên các môi trường desktop Linux.
  - **Cách giải quyết:** Bổ sung biểu tượng khay hệ thống native, kèm menu trạng thái và tùy chọn bật/tắt DevTools.

- **Treo ở màn hình đăng nhập:**
  - **Lỗi:** Ứng dụng bị treo khi mở màn hình đăng nhập.
  - **Cách giải quyết:** Thay các file sqlite3 dành cho macOS bằng bản build native cho Linux. Xem [Issue #13](https://github.com/doandat943/zalo-for-linux/issues/13).
