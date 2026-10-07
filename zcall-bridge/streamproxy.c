/*
 * streamproxy.c — LD_PRELOAD shim that redirects the screen-capture reads of
 * a wine app (ZaloCall) from its real X display to the bridge display (:99),
 * where the Wayland screen is rendered by the screen bridge.
 *
 * ZaloCall runs natively on the real display (its call UI is a normal
 * window), but when it captures the screen for "share screen" it reads the
 * root window — which is black/unsupported on rootless XWayland. This shim
 * intercepts the three capture APIs (libX11 XGetImage, XShmGetImage, xcb
 * xcb_get_image) and, for root grabs, serves the same region from the
 * bridge display instead. Everything else passes through untouched.
 *
 * The shim is inert when the bridge display is not reachable, so it can be
 * preloaded unconditionally. When a capture happens and the bridge display
 * is down, it touches ZCALL_PROXY_REQUEST — the plugin watches that file
 * and starts the bridge (popping the compositor's permission dialog), so
 * the user never has to prepare the bridge manually.
 *
 * Build (64-bit — WoW64's Unix process is 64-bit; ZaloCall remains PE32):
 *   gcc -m64 -shared -fPIC -O2 streamproxy.c -ldl -lX11 -lxcb -o streamproxy.so
 * Debug: set ZCALL_PROXY_LOG=<file> to trace which API the app uses.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <xcb/xcb.h>
#include <xcb/xproto.h>

static FILE *logf = NULL;

static void plog(const char *fmt, ...) {
    if (!logf) {
        const char *p = getenv("ZCALL_PROXY_LOG");
        if (!p) return;
        logf = fopen(p, "a");
        if (!logf) return;
    }
    va_list ap;
    va_start(ap, fmt);
    vfprintf(logf, fmt, ap);
    va_end(ap);
    fflush(logf);
}

/* ------------------------------------------------------------------ */
/* lazy connections to the bridge display                              */
/* ------------------------------------------------------------------ */

static Display *src_dpy = NULL;
static xcb_connection_t *src_c = NULL;
static xcb_window_t src_root = 0;

/* The app starts capturing (user clicked "share screen"): if the bridge
 * display is not up, ask the plugin to start the bridge by touching the
 * request file. The plugin watches it and pops the compositor's
 * permission dialog. */
static void signal_request(void) {
    const char *p = getenv("ZCALL_PROXY_REQUEST");
    if (!p) return;
    FILE *f = fopen(p, "w");
    if (f) fclose(f);
}

/* If the bridge display dies mid-capture, Xlib's default IO error handler
 * would kill the whole app. Instead drop the cached connection (next grab
 * re-opens or falls through) and chain anything else to the original
 * handler. */
static int (*orig_io_handler)(Display *) = NULL;

static int src_io_handler(Display *d) {
    if (d == src_dpy) {
        plog("streamproxy: src connection broken, dropping cache\n");
        src_dpy = NULL;
        return 0;
    }
    if (orig_io_handler) return orig_io_handler(d);
    return 1;
}

/* Xlib calls exit() once an IO error handler returns, so the handler above
 * alone still killed ZaloCall (and dropped the call) on the first grab after
 * the bridge display went away. libX11 >= 1.7 lets a per-display exit
 * handler replace that exit(); looked up at runtime so older libX11 still
 * loads the shim. */
typedef void (*io_exit_handler_fn)(Display *, void *);
typedef void (*set_io_exit_handler_fn)(Display *, io_exit_handler_fn, void *);

static void src_io_exit_handler(Display *d, void *unused) {
    (void)d;
    (void)unused;
    plog("streamproxy: src display gone, continuing without it\n");
}

static void keep_alive_on_src_loss(Display *d) {
    static set_io_exit_handler_fn set_exit = NULL;
    static int looked_up = 0;
    if (!looked_up) {
        set_exit = (set_io_exit_handler_fn)dlsym(RTLD_DEFAULT, "XSetIOErrorExitHandler");
        looked_up = 1;
        if (!set_exit)
            plog("streamproxy: libX11 has no XSetIOErrorExitHandler; losing the bridge display will end the app\n");
    }
    if (set_exit) set_exit(d, src_io_exit_handler, NULL);
}

static Display *ensure_src_dpy(void) {
    if (!src_dpy) {
        const char *n = getenv("ZCALL_PROXY_SRC");
        if (!n) n = ":99";
        src_dpy = XOpenDisplay(n);
        if (src_dpy) {
            keep_alive_on_src_loss(src_dpy);
            /* Once only: a reopen after a lost bridge must not chain the
             * handler to itself. */
            static int io_handler_set = 0;
            if (!io_handler_set) {
                orig_io_handler = XSetIOErrorHandler(src_io_handler);
                io_handler_set = 1;
            }
            plog("streamproxy: libX11 src %s opened\n", n);
        } else {
            plog("streamproxy: cannot open src %s (not proxying)\n", n);
            signal_request();
        }
    }
    return src_dpy;
}

static xcb_connection_t *ensure_src_c(void) {
    /* The bridge display went away: drop the dead connection and retry. */
    if (src_c && xcb_connection_has_error(src_c)) {
        plog("streamproxy: xcb src connection broken, dropping cache\n");
        xcb_disconnect(src_c);
        src_c = NULL;
    }
    if (!src_c) {
        const char *n = getenv("ZCALL_PROXY_SRC");
        if (!n) n = ":99";
        int scr = 0;
        src_c = xcb_connect(n, &scr);
        if (src_c && !xcb_connection_has_error(src_c)) {
            xcb_screen_iterator_t it =
                xcb_setup_roots_iterator(xcb_get_setup(src_c));
            if (it.rem) src_root = it.data->root;
            plog("streamproxy: xcb src %s opened\n", n);
        } else {
            if (src_c) xcb_disconnect(src_c);
            src_c = NULL;
            plog("streamproxy: cannot open xcb src %s\n", n);
            signal_request();
        }
    }
    return src_c;
}

/* ------------------------------------------------------------------ */
/* libX11: XGetImage / XShmGetImage                                    */
/* ------------------------------------------------------------------ */

typedef XImage *(*XGetImage_fn)(Display *, Drawable, int, int, unsigned int,
                                unsigned int, unsigned long, int);
typedef Bool (*XShmGetImage_fn)(Display *, Drawable, XImage *, int, int,
                                unsigned long);

static XGetImage_fn real_XGetImage = NULL;
static XShmGetImage_fn real_XShmGetImage = NULL;

static int is_root(Display *dpy, Drawable d) {
    return d == (Drawable)DefaultRootWindow(dpy);
}

XImage *XGetImage(Display *dpy, Drawable d, int x, int y, unsigned int w,
                  unsigned int h, unsigned long plane_mask, int format) {
    if (!real_XGetImage)
        real_XGetImage = (XGetImage_fn)dlsym(RTLD_NEXT, "XGetImage");
    if (ensure_src_dpy() && dpy != src_dpy && is_root(dpy, d)) {
        XImage *im = real_XGetImage(src_dpy, (Drawable)DefaultRootWindow(src_dpy),
                                    x, y, w, h, plane_mask, format);
        plog("streamproxy: XGetImage root %ux%u+%d+%d -> %s\n", w, h, x, y,
             im ? "proxied" : "src-failed, fell through");
        if (im) return im;
    }
    return real_XGetImage(dpy, d, x, y, w, h, plane_mask, format);
}

Bool XShmGetImage(Display *dpy, Drawable d, XImage *image, int x, int y,
                  unsigned long plane_mask) {
    if (!real_XShmGetImage)
        real_XShmGetImage = (XShmGetImage_fn)dlsym(RTLD_NEXT, "XShmGetImage");
    if (ensure_src_dpy() && dpy != src_dpy && is_root(dpy, d) && image) {
        XImage *im = real_XGetImage(src_dpy, (Drawable)DefaultRootWindow(src_dpy),
                                    x, y, image->width, image->height,
                                    plane_mask, ZPixmap);
        if (im) {
            size_t copy = im->bytes_per_line < image->bytes_per_line
                              ? (size_t)im->bytes_per_line
                              : (size_t)image->bytes_per_line;
            unsigned int rows = (unsigned int)im->height < (unsigned int)image->height
                                    ? (unsigned int)im->height
                                    : (unsigned int)image->height;
            for (unsigned int r = 0; r < rows; r++)
                memcpy(image->data + (size_t)r * image->bytes_per_line,
                       im->data + (size_t)r * im->bytes_per_line, copy);
            XDestroyImage(im);
            plog("streamproxy: XShmGetImage root %dx%d -> proxied\n",
                 image->width, image->height);
            return True;
        }
    }
    return real_XShmGetImage(dpy, d, image, x, y, plane_mask);
}

/* ------------------------------------------------------------------ */
/* xcb: xcb_get_image / xcb_get_image_reply (Qt QScreen::grabWindow)   */
/* ------------------------------------------------------------------ */

typedef xcb_get_image_cookie_t (*xcb_get_image_fn)(xcb_connection_t *, uint8_t,
                                                   xcb_drawable_t, int16_t,
                                                   int16_t, uint16_t, uint16_t,
                                                   uint32_t);
typedef xcb_get_image_reply_t *(*xcb_get_image_reply_fn)(
    xcb_connection_t *, xcb_get_image_cookie_t, xcb_generic_error_t **);

static xcb_get_image_fn real_xcb_get_image = NULL;
static xcb_get_image_reply_fn real_xcb_get_image_reply = NULL;

#define PROXY_MAP_SIZE 64
static struct {
    uint64_t seq;
    int valid;
    int16_t x, y;
    uint16_t w, h;
} proxy_map[PROXY_MAP_SIZE];

static xcb_window_t conn_root(xcb_connection_t *c) {
    xcb_screen_iterator_t it = xcb_setup_roots_iterator(xcb_get_setup(c));
    return it.rem ? it.data->root : 0;
}

xcb_get_image_cookie_t xcb_get_image(xcb_connection_t *c, uint8_t format,
                                     xcb_drawable_t drawable, int16_t x,
                                     int16_t y, uint16_t width, uint16_t height,
                                     uint32_t plane_mask) {
    if (!real_xcb_get_image)
        real_xcb_get_image = (xcb_get_image_fn)dlsym(RTLD_NEXT, "xcb_get_image");
    xcb_get_image_cookie_t cookie =
        real_xcb_get_image(c, format, drawable, x, y, width, height, plane_mask);
    if (ensure_src_c() && c != src_c && drawable == conn_root(c)) {
        unsigned int slot = cookie.sequence % PROXY_MAP_SIZE;
        for (unsigned int i = 0; i < PROXY_MAP_SIZE; i++) {
            unsigned int s = (slot + i) % PROXY_MAP_SIZE;
            if (!proxy_map[s].valid) {
                proxy_map[s].valid = 1;
                proxy_map[s].seq = cookie.sequence;
                proxy_map[s].x = x;
                proxy_map[s].y = y;
                proxy_map[s].w = width;
                proxy_map[s].h = height;
                plog("streamproxy: xcb_get_image root %ux%u+%d+%d queued\n",
                     width, height, x, y);
                break;
            }
        }
    }
    return cookie;
}

xcb_get_image_reply_t *xcb_get_image_reply(xcb_connection_t *c,
                                           xcb_get_image_cookie_t cookie,
                                           xcb_generic_error_t **e) {
    if (!real_xcb_get_image_reply)
        real_xcb_get_image_reply =
            (xcb_get_image_reply_fn)dlsym(RTLD_NEXT, "xcb_get_image_reply");
    unsigned int slot = cookie.sequence % PROXY_MAP_SIZE;
    for (unsigned int i = 0; i < PROXY_MAP_SIZE; i++) {
        unsigned int s = (slot + i) % PROXY_MAP_SIZE;
        if (proxy_map[s].valid && proxy_map[s].seq == cookie.sequence) {
            proxy_map[s].valid = 0;
            /* swallow the real reply (BadMatch on rootless XWayland) */
            xcb_generic_error_t *lerr = NULL;
            xcb_get_image_reply_t *rr = real_xcb_get_image_reply(c, cookie, &lerr);
            free(rr);
            /* fetch the same region from the bridge display */
            xcb_get_image_cookie_t c2 =
                real_xcb_get_image(src_c, XCB_IMAGE_FORMAT_Z_PIXMAP, src_root,
                                   proxy_map[s].x, proxy_map[s].y,
                                   proxy_map[s].w, proxy_map[s].h, ~0);
            xcb_get_image_reply_t *r2 = real_xcb_get_image_reply(src_c, c2, NULL);
            if (r2) {
                uint8_t *data = (uint8_t *)(r2 + 1);
                size_t len = (size_t)r2->length * 4;
                xcb_get_image_reply_t *out =
                    malloc(sizeof(xcb_get_image_reply_t) + len);
                if (!out) {
                    free(r2);
                    plog("streamproxy: out-of-memory allocating xcb reply\n");
                    return NULL;
                }
                memset(out, 0, sizeof(xcb_get_image_reply_t));
                out->response_type = 1;
                out->depth = r2->depth;
                out->sequence = (uint16_t)cookie.sequence;
                out->visual = r2->visual;
                out->length = r2->length;
                memcpy(out + 1, data, len);
                free(r2);
                plog("streamproxy: xcb root grab %ux%u -> proxied\n",
                     proxy_map[s].w, proxy_map[s].h);
                return out;
            }
            plog("streamproxy: xcb src grab failed\n");
            return NULL;
        }
    }
    return real_xcb_get_image_reply(c, cookie, e);
}
