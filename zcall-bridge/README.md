# zcall-bridge — cuộc gọi Zalo trên Linux qua Wine

Chạy engine gọi điện (voice/video) của Zalo trên Linux.

## Vấn đề

Zalo PC 26.x thực hiện cuộc gọi bằng helper **ZaloCall.exe** (app Qt, chỉ có
bản Windows/macOS). Trên Linux không có helper tương ứng, và Wine ≥ 9.9 đã
bỏ hỗ trợ AF_UNIX socket (nhánh macOS dùng unix socket).

## Giải pháp

Chạy **ZaloCall.exe bản Windows** dưới Wine, bắc cầu kênh giao tiếp bằng
named pipes (thứ Wine hỗ trợ tốt):

```
┌── Zalo app (Linux, đã patch) ────────────────────────────────┐
│  main process: listen TCP 127.0.0.1:29631 (recv) / 29632 (send)
│  spawn: wine pipebridge.exe 29631 29632
│  spawn: wine ZaloCall.exe \\.\pipe\PipeZCallRecv \\.\pipe\PipeZCallSend
└──────────────┬───────────────────────────────────────────────┘
               │ TCP loopback
┌──────────────▼───────────────────────────────────────────────┐
│  WINE prefix                                                  │
│  pipebridge.exe (C, 252KB, không cần runtime)                │
│    named pipes ⇄ TCP, pump dữ liệu 2 chiều                   │
│  ZaloCall.exe — engine gọi thật (Qt5)                        │
└──────────────────────────────────────────────────────────────┘
```

Transport: AES-128-CBC (key cố định trong app), message JSON phân tách `$`.

## Các patch (scripts/patches/)

| Patch | Mục đích |
|---|---|
| `patch-zcall-callv2.js` | Nhánh Linux cho call-v2: TCP ports, spawn qua Wine + pipebridge, **gửi lại init trước mỗi makeCall** (chống lỗi -11 init_error), **fix cờ F kẹt queue gửi** của Zalo, bỏ qua unlink/verifyMd5 không áp dụng |
| `patch-zcall-callgate.js` | Mở 2 gate UI: bỏ check `os.release() < 17` (viết cho Darwin kernel, trên Linux kernel 7.x luôn fail) và bật default `enableCall`/`enableVideoCall` |

## Cài đặt

```bash
node scripts/setup-zcall-bridge.js
```

- Tải installer Windows chính thức, tách `plugins/capture/` →
  `app/native/qt-call-and-cap/` (ZaloCall.exe + ZaviMeet.exe + Qt DLLs +
  plugins, sau khi tỉa còn ~67MB)
- Compile `pipebridge.c` bằng mingw — máy build cần
  `gcc-mingw-w64-i686` (`sudo apt install gcc-mingw-w64-i686`); exe không
  được commit theo chính sách repo (`*.exe` trong .gitignore)

Yêu cầu: Wine chạy được 32-bit (wow64 như Wine 11). Khi app thoát, plugin
kill toàn bộ phiên wine của prefix (`wineserver -k` + hard-kill
wineserver/winedevice còn sót).

## Trải nghiệm người dùng: tự động cài wine

Người dùng **không cần cài gì thủ công**. Ngay lần mở app đầu tiên:

1. App **tự kiểm tra** wine tìm thấy có chạy được app 32-bit không (chạy thử
   `pipebridge.exe --version` — chính là exe 32-bit của cầu nối):
   - Wine hoạt động tốt → **dùng im lặng, không hiện dialog nào**
   - Chưa có wine, hoặc wine có nhưng **không tương thích** (không hỗ trợ
     32-bit / quá cũ) → hiện cửa sổ hỏi **luôn nổi trên cửa sổ chính**
     (không bị che), kèm lý do cụ thể — nút **"Tải và bật ngay"** /
     **"Để sau"**, link nguồn tải minh bạch và checkbox
     **"Không hỏi lại lần sau nếu không tải"**
2. Chọn tải → cửa sổ tiến trình *"Đang tải Wine WoW64…"* với % trực quan
   → tự giải nén → tự khởi tạo prefix (mất ~1-2 phút tổng cộng)
3. Xong → thông báo *"Tính năng gọi điện đã sẵn sàng!"* — gọi được ngay,
   không cần khởi động lại, không cần quyền quản trị
4. Chọn "Để sau" → **hỏi lại vào lần mở app sau**; tick "không hỏi lại" →
   không bao giờ tự hỏi nữa. Cả hai trường hợp đều bật lại được qua
   **menu khay hệ thống → "Cài đặt gọi điện…"**

Wine tải về được lưu tại `<userData>/zcall-wine-runtime/` — hoàn toàn trong
dữ liệu của app, không đụng hệ thống, gỡ app là sạch.

Popup báo Wine không hỗ trợ WoW64 hoặc không khởi động được có nút
**"Tải Wine"**, mở thẳng cửa sổ tiến trình tải bản tương thích.

### Biến thể Full (wine đi kèm sẵn)

Release có 2 biến thể **Full** cho cả 2 flavor: portable wine
được đóng gói sẵn **bên trong AppImage** (`app/native/wine-runtime/`):

- `Zalo-<ver>-<hash>-Full.AppImage` — không ZaDark
- `Zalo-<ver>+ZaDark-<zdv>-<hash>-Full.AppImage` — có ZaDark

Mở app lần đầu là gọi được ngay — không cần mạng, không cần tải wine.
Bản thường vẫn giữ luồng tự tải ở trên; tất cả chạy từ cùng
một code, chỉ khác phần wine đi kèm.

## Chế độ gọi điện (không muốn chạy Wine?)

Khay hệ thống → **Cài đặt gọi điện…** → **Chế độ gọi điện** (lưu ở
`<userData>/zcall-config.json`, khóa `callMode`, áp dụng từ lần mở app sau):

| Chế độ | Khi mở app | Khi bấm gọi |
|---|---|---|
| **Chuẩn bị sẵn** (`auto`, mặc định) | dò + kiểm tra wine, tạo prefix | gọi ngay |
| **Chỉ chuẩn bị khi bấm gọi** (`lazy`) | không chạy wine | dò + kiểm tra wine ở nền (không khởi động wine, không đơ app), chuẩn bị Wine/camera khi cần gọi; kết thúc cuộc gọi thì dừng toàn bộ Wine và bridge, cuộc gọi sau tự khởi động lại |
| **Tắt** (`off`) | không chạy wine | hiện thông báo hướng dẫn bật lại cho gọi đi và thao tác cục bộ; chặn im lặng tín hiệu gọi đến |

Phù hợp cho ai chỉ dùng Zalo để nhắn tin/xem tin nhắn cũ mà máy đã có wine
(bản Full hoặc wine hệ thống) (#80). `ZCALL_DISABLE=1` tương đương chế độ `off`.

Cơ chế (`patch-zcall-callv2.js`):
- Bước 13: main-dist chờ `global.__zcallPrepare()` của plugin ngay trước khi
  khởi động ZaloCall — `lazy` chuẩn bị wine lúc này, `off` từ chối.
- Bước 14: server Zalo có cờ `call.launch_native_in_startup` khiến ZaloCall
  được khởi động ngay lúc mở app (tin nhắn `init` không có `_optional`).
  Ở `lazy`/`off` plugin đặt `global.__zcallDeferStartup` và main-dist bỏ qua
  tin nhắn đó; dữ liệu init vẫn được gửi lại trước mỗi `makeCall` (bước 6).
  Cuộc gọi đi và cuộc gọi đến đều khởi động ZaloCall bình thường.

## Cấu hình Wine (custom path)

Người dùng nâng cao có thể chỉ định wine riêng. Khi app khởi động, plugin
tự dò theo thứ tự ưu tiên:

```
1. Biến môi trường ZCALL_WINE          ← ưu tiên cao nhất (user tự chỉ định)
2. Wine đi kèm app (biến thể Full)    ← app/native/wine-runtime/bin/wine
                                          trong AppImage — mở là dùng được
                                          ngay, không cần tải gì thêm
3. Wine đã tải tự động                ← <userData>/zcall-wine-runtime/bin/wine
                                          (bản app kiểm soát + đã test — nên
                                          dùng để có trải nghiệm đồng nhất)
4. Lệnh `wine` trong PATH              ← wine hệ thống (apt/dnf install wine...)
5. Runner Bottles (flatpak)            ← ~/.var/app/com.usebottles.bottles/
                                          data/bottles/runners/kron4ek-wine-*/
                                          bin/wine (chọn bản mới nhất)
```

App thử lần lượt từng ứng viên và chọn bản đầu tiên **chạy được app 32-bit**;
wine hỏng tự động bỏ qua sang bản tiếp theo.

Nếu không tìm thấy wine: app vẫn chạy bình thường, chỉ **không có tính năng
gọi** — và hộp thoại hỏi tải wine ở trên sẽ xuất hiện.

### Các biến môi trường

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `ZCALL_WINE` | Đường dẫn tuyệt đối tới binary `wine` | tự dò (xem thứ tự trên) |
| `ZCALL_WINEPREFIX` | Prefix wine dành riêng cho app | `<userData>/zcall-wine` |
| `ZCALL_DISABLE` | Set bất kỳ giá trị nào để tắt hẳn tính năng gọi (như chế độ `off`) | — |
| `ZCALL_AUTO_SETUP` | `'1'` = tải wine tự động, không hỏi (dùng khi triển khai hàng loạt/script) | — |
| `ZCALL_WINE_DOWNLOAD_URL` | Ghi đè URL tải wine portable | URL kron4ek 11.14 trên GitHub |

WoW64 là mặc định: prefix `<userData>/zcall-wine`, runtime tải về
`wine-11.14-amd64-wow64.tar.xz`, shim màn hình 64 bit dưới tên `streamproxy.so`.

`camera-hook.dll` PE32 thay class factory camera trong prefix Wine. Các DLL
Zalo/Qt gốc được giữ nguyên. Hook trả camera source của bridge và không nạp
`qcap.dll` để capture. GStreamer 64 bit dùng `pipewiresrc` nhận webcam,
giải mã/đổi định dạng và chuyển khung BGR qua TCP loopback có token ngẫu
nhiên cho DLL PE32. Source chỉ mở khi Qt chạy/preview camera và đóng khi
filter dừng. Lỗi PipeWire được trả về.

Bản hiện tại dùng camera PipeWire có ưu tiên cao nhất và lấy mode native có
độ phân giải cao hơn gần nhất hoặc bằng 720p nếu camera support từ 720p trờ lên, thấp hơn sẽ lấy cao nhất, ưu tiên fps cao hơn ở cùng độ phân giải. Độ phân giải
và fps được đọc từ `EnumFormat` của camera; pipeline không scale hay nhân fps.
Qt vẫn dùng COM facade PE32 để nhận khung hình, còn truy cập thiết bị và xử lý
pixel nằm ở tiến trình native.
Log hook: `~/.config/ZaloData/zcall-camera-hook.log`.

## Cài thư viện cho từng distro (copy-paste)

Bản wine tải tự động dùng WoW64 với thư viện Linux **64-bit**;
ZaloCall và DLL hook vẫn là PE32. Có 2 mức:

- **Tối thiểu (gọi thoại — loa + mic)**: base libs + driver âm thanh
- **Đầy đủ (thoại + video)**: thêm GStreamer + PipeWire

App cũng tự hiện dialog hướng dẫn chọn Wine khi runtime không khởi động được.

### Ubuntu / Debian

```bash
sudo apt update

# Tối thiểu — gọi thoại
sudo apt install -y libc6 libx11-6 libxext6 libfreetype6 \
  libgl1 libpulse0 libasound2 zlib1g

# Đầy đủ — thêm cho video call
sudo apt install -y libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \
  gstreamer1.0-plugins-good gstreamer1.0-tools \
  gstreamer1.0-pipewire pipewire-bin

# Khuyến nghị — decode H.264 video từ đầu bên kia
sudo apt install -y gstreamer1.0-libav
```

### Fedora / RHEL

```bash
# Tối thiểu — gọi thoại
sudo dnf install -y glibc libX11 libXext freetype \
  mesa-libGL pulseaudio-libs alsa-lib zlib-ng-compat

# Đầy đủ — thêm cho video call
sudo dnf install -y gstreamer1 gstreamer1-plugins-base \
  gstreamer1-plugins-good pipewire-gstreamer pipewire-utils

# Khuyến nghị — decode H.264 (cần RPM Fusion)
sudo dnf install https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm
sudo dnf install gstreamer1-plugin-libav
```

### Arch

```bash
# Tối thiểu — gọi thoại
sudo pacman -S --needed glibc libx11 libxext \
  freetype2 mesa libpulse alsa-lib zlib

# Đầy đủ — thêm cho video call
sudo pacman -S --needed gstreamer gst-plugins-base \
  gst-plugins-good pipewire wireplumber gst-plugin-pipewire

# Khuyến nghị — decode H.264
sudo pacman -S --needed gst-libav
```

> `gstreamer1.0-plugins-bad` (Ubuntu) / `gstreamer1-plugins-bad-free` (Fedora)
> chỉ cần khi không dùng libav — không bắt buộc nếu đã cài libav.

### Đường tắt: cài wine hệ thống

`sudo apt install wine` / `sudo dnf install wine` / `sudo pacman -S wine` —
trình quản lý gói tự kéo đủ thư viện. App tự phát hiện và dùng wine hệ thống.

### Kiểm tra sau khi cài

```bash
# Mic được hệ thống nhận chưa?
pactl list sources short | grep -i input
# Loa?
pactl list sinks short
# Camera?
ls /dev/video*          # rỗng = chưa nhận phần cứng; thiếu quyền: sudo usermod -aG video $USER
```

### Camera bị xanh/nhòe (lệch định dạng pixel)

Bridge PipeWire thực hiện đổi định dạng trong tiến trình native. Kiểm tra
`gst-inspect-1.0 pipewiresrc`, `videoconvert` và `videoflip`, rồi xem
`zcall-camera-hook.log` cùng các dòng `camera:` trong `zcall-debug.log`.

### Share screen trên Wayland (bridge)

Trên Wayland, XWayland không nhìn thấy desktop nên ZaloCall (wine) chụp được
màn hình đen. App có sẵn **bridge riêng**:

1. Cài thành phần (một lần — nếu thiếu, app tự hiện dialog với đúng lệnh cho
   distro của bạn khi bấm Share screen):
   ```bash
   # Fedora:  sudo dnf install xorg-x11-server-Xvfb xdotool python3-dbus \
   #            gstreamer1-plugins-base gstreamer1-plugins-bad-free
   # Ubuntu:  sudo apt install xvfb xdotool python3-dbus \
   #            gstreamer1.0-plugins-base gstreamer1.0-plugins-bad
   # Arch:    sudo pacman -S xorg-server-xvfb xdotool python-dbus \
   #            gst-plugins-base gst-plugins-bad
   ```
   (`streamproxy.so` được build sẵn vào app — không cần cài gì thêm.)
2. Gọi video **hoàn toàn như bình thường** — giao diện cuộc gọi là cửa sổ
   native trên desktop, không có gì thay đổi
3. Bấm **Share screen** như thường → **hộp thoại xin quyền ghi màn hình
   (portal chuẩn) tự hiện ra** → chọn màn hình → Cho phép → hình chia sẻ
   được lấy từ màn hình Wayland thật qua bridge ✓

Bridge chạy **Xvfb headless** làm màn hình render (`:99`): màn hình Wayland
được đưa vào đó qua XDG ScreenCast portal + GStreamer. ZaloCall **vẫn chạy
native trên màn hình thật**; `streamproxy.so` (shim LD_PRELOAD, build sẵn
theo app) chặn đúng các lời gọi chụp màn hình của ZaloCall
(`XGetImage`/`XShmGetImage`/`xcb_get_image` trên root) và **trả về nội dung
từ `:99`** — nên phần còn lại của app (giao diện, âm thanh, video) không
đổi, chỉ riêng hình ảnh chia sẻ đi qua bridge. Shim cũng **tự báo hiệu**
(bằng file request) khi phát hiện lần chụp màn hình đầu tiên — app theo
dõi và tự khởi động bridge, nên không cần thao tác nào thêm. Nếu người
dùng từ chối hộp thoại quyền, app không hỏi lại trong 90 giây (bấm lại Share
screen để thử lại). Bridge tự tắt khi thoát app.

Trên **phiên X11**, share screen hoạt động trực tiếp — không cần bridge.

### Lưu ý giới hạn

- Bản kron4ek **amd64-wow64** là runtime mặc định; ZaloCall vẫn là PE32.
- Công cụ xwaylandvideobridge của KDE chỉ chạy trên KDE Plasma (KWin); trên
  GNOME dùng bridge tích hợp của app (mục trên).

### Ví dụ chạy với wine tự chọn

**Dev mode:**

```bash
# Wine hệ thống bạn tự cài (ví dụ apt install wine)
ZCALL_WINE=/usr/bin/wine npm start

# Wine build riêng tải từ internet
ZCALL_WINE=/opt/wine-10.0/bin/wine npm start

# Kèm prefix riêng
ZCALL_WINE=/usr/bin/wine ZCALL_WINEPREFIX=~/zalo-call-prefix npm start

# Tắt hẳn tính năng gọi
ZCALL_DISABLE=1 npm start
```

**AppImage (bản đóng gói):**

```bash
# Chạy từ terminal, env áp dụng cho phiên đó
ZCALL_WINE=/usr/bin/wine ./Zalo-<version>.AppImage
```

Muốn áp vĩnh viễn: sửa file `.desktop` của app (do Gear Lever/trình đơn tạo),
thêm biến vào dòng `Exec`:

```ini
Exec=env ZCALL_WINE=/usr/bin/wine /đường/dẫn/tới/Zalo.AppImage
```

### Kiểm tra wine có chạy được không

```bash
# 1. Wine hoạt động?
/đường/dẫn/wine --version          # in ra phiên bản, ví dụ wine-11.14

# 2. Chạy được app 32-bit? (tạo prefix thử — lần đầu mất ~30s)
test_dir=$(mktemp -d)
WINEARCH=wow64 WINEPREFIX="$test_dir/prefix" /đường/dẫn/wine wineboot -u
ls "$test_dir/prefix/drive_c"        # có Program Files/ = OK
rm -rf "$test_dir"

# 3. Mở app với env, gọi thử một cuộc thoại. Lần gọi đầu tiên hơi chậm
#    (wine khởi động nguội + tạo prefix nếu chưa có ~5-15s).
```

### Prefix nằm ở đâu

- Mặc định: `<userData>/zcall-wine` — `userData` của app là
  `~/.config/ZaloData/` (hoặc theo env `XDG_CONFIG_HOME`).
- App **chỉ thao tác wine trong đúng prefix này** — không đụng tới
  `~/.wine` hay các prefix Bottles khác của bạn.
- Khi app thoát, toàn bộ tiến trình wine của prefix này bị dọn sạch
  (`wineserver -k` + hard-kill `wineserver`/`winedevice.exe` còn sót).
- Muốn reset trạng thái gọi: xóa thư mục prefix rồi mở lại app —
  plugin sẽ tự tạo lại prefix mới.

## Đã xác minh

- ✅ ZaloCall.exe chạy dưới Wine (wow64), kết nối đủ 2 kênh. Các bản đã test
  trước đây qua replay (init → makeCall → incall → success → sendSignal):
  **11.14 classic** (96MB/852MB — video call đã xác minh thật),
  **8.6** (54MB/565MB — nhẹ hơn nhưng video call crash `msvcp140._Throw_C_error`
  thiếu hàm CRT khi gặp lỗi decode), **8.0.1**, **7.22**
- ✅ Trước đây **video call hoạt động** trên Fedora (wine 11.14 classic + GStreamer 32-bit +
  libv4l) — camera đôi khi cần ép format: `v4l2-ctl --set-fmt-video=width=640,height=480,pixelformat=MJPG`
- ✅ **Share screen trên Wayland** qua bridge tích hợp (XDG ScreenCast
  portal → PipeWire → GStreamer → Xvfb headless `:99` → streamproxy shim
  64-bit → ZaloCall) — **người dùng xác nhận share hoạt động** trên KDE
  Wayland; ZaloCall chạy native, giao diện cuộc gọi không đổi; hộp thoại
  quyền tự hiện khi bấm Share screen (shim báo hiệu qua file request)
- ⚠️ Trên phiên X11 không cần bridge — share screen hoạt động trực tiếp.
- ✅ `native-ready` → `init` → `makeCall` → `callState: incall`, `show success`,
  `sendSignal 401` — engine thực hiện cuộc gọi thật (voice + video signaling)
- ✅ **Người dùng xác nhận cuộc gọi thoại hoạt động** trong app
- ✅ pipebridge C (252KB) hoạt động trong app thật
- ✅ Thư mục engine đã tỉa 196MB → **67MB** (bỏ pdbs, translations, Qt plugins
  thừa, opengl32sw, Qt5Sql/Xml) — call 1-1 vẫn chạy
- ✅ Tắt app → wine session được dọn sạch (wineserver + winedevice)
- ✅ Camera preview có hình và gọi video không crash trên Wine staging 11.17
  WoW64 + PipeWire 64 bit.
- ✅ Bài thử PE32 nhận ít nhất 3 khung webcam thật qua COM SampleGrabber,
  kiểm tra capabilities/frame-rate list và xác nhận không nạp `qcap.dll`.
- ✅ Đã thử trường hợp nhiều camera qua PipeWire.
- ⚠️ Chưa test: Camera portal trong Flatpak.
