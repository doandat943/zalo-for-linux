"""Screenshot portal client using the Flatpak runtime's GIO (no PyGObject)."""

import ctypes as c
import uuid
import sys
from pathlib import Path

gio = c.CDLL('libgio-2.0.so.0')
glib = c.CDLL('libglib-2.0.so.0')
ptr = c.c_void_p
string = c.c_char_p
uint = c.c_uint


def bind(lib, name, result, *args):
    fn = getattr(lib, name)
    fn.restype = result
    fn.argtypes = args
    return fn


bus_get = bind(gio, 'g_bus_get_sync', ptr, c.c_int, ptr, ptr)
unique_name = bind(gio, 'g_dbus_connection_get_unique_name', string, ptr)
call = bind(gio, 'g_dbus_connection_call_sync', ptr,
            ptr, string, string, string, string, ptr, ptr, c.c_int, c.c_int, ptr, ptr)
subscribe = bind(gio, 'g_dbus_connection_signal_subscribe', uint,
                 ptr, string, string, string, string, string, c.c_int, ptr, ptr, ptr)
parse = bind(glib, 'g_variant_parse', ptr, ptr, string, ptr, ptr, ptr)
child = bind(glib, 'g_variant_get_child_value', ptr, ptr, c.c_size_t)
get_uint = bind(glib, 'g_variant_get_uint32', uint, ptr)
get_string = bind(glib, 'g_variant_get_string', string, ptr, ptr)
lookup = bind(glib, 'g_variant_lookup_value', ptr, ptr, string, ptr)
unref = bind(glib, 'g_variant_unref', None, ptr)
loop_new = bind(glib, 'g_main_loop_new', ptr, ptr, c.c_int)
loop_run = bind(glib, 'g_main_loop_run', None, ptr)
loop_quit = bind(glib, 'g_main_loop_quit', None, ptr)
timeout_add = bind(glib, 'g_timeout_add', uint, uint, ptr, ptr)

bus = bus_get(2, None, None)  # G_BUS_TYPE_SESSION; keep this connection alive.
if not bus:
    raise RuntimeError('Cannot connect to the session bus')

if len(sys.argv) == 3 and sys.argv[1] == '--spectacle':
    output = Path(sys.argv[2])
    loop = loop_new(None, False)
    callback_type = c.CFUNCTYPE(None, ptr, string, string, string, string, ptr, ptr)
    timer_type = c.CFUNCTYPE(c.c_int, ptr)

    @callback_type
    def owner_changed(connection, sender, object_path, interface, signal, parameters, data):
        owner = child(parameters, 2)
        if not get_string(owner, None):
            loop_quit(loop)  # Spectacle exits on cancellation.
        unref(owner)

    @timer_type
    def image_ready(data):
        try:
            # Wait for the complete PNG, not just creation of its output file.
            with output.open('rb') as image:
                image.seek(-12, 2)
                complete = image.read() == b'\x00\x00\x00\x00IEND\xaeB`\x82'
            if complete:
                loop_quit(loop)
                return False
        except OSError:
            pass
        return True

    subscribe(bus, b'org.freedesktop.DBus', b'org.freedesktop.DBus', b'NameOwnerChanged',
              b'/org/freedesktop/DBus', b'org.kde.Spectacle', 0, owner_changed, None, None)
    # GVariant text strings need single quotes/backslashes escaped.
    escaped = str(output).replace('\\', '\\\\').replace("'", "\\'")
    parameters = parse(None, (
        "(['spectacle', '--background', '--region', '--nonotify', '--output', '%s'], '', @a{sv} {})" % escaped
    ).encode(), None, None, None)
    error = ptr()
    reply = call(bus, b'org.kde.Spectacle', b'/org/kde/spectacle',
                 b'org.kde.KDBusService', b'CommandLine', parameters, None, 0, 10000, None, c.byref(error))
    if not reply:
        if error:
            class GError(c.Structure):
                _fields_ = [('domain', uint), ('code', c.c_int), ('message', string)]
            print(c.cast(error, c.POINTER(GError)).contents.message.decode(), file=sys.stderr)
        sys.exit(3)  # Not installed, not permitted, or incompatible API: portal fallback.
    status = child(reply, 0)
    get_int = bind(glib, 'g_variant_get_int32', c.c_int, ptr)
    if get_int(status) != 0:
        sys.exit(2)
    unref(status)
    unref(reply)
    timeout_add(100, image_ready, None)
    loop_run(loop)
    if output.is_file():
        print(output.as_uri())
    sys.exit(0)

destination = b'org.freedesktop.portal.Desktop'
token = 'zalo_screenshot_' + uuid.uuid4().hex
sender = unique_name(bus).decode()[1:].replace('.', '_')
request = f'/org/freedesktop/portal/desktop/request/{sender}/{token}'.encode()
loop = loop_new(None, False)
uri = None
callback_type = c.CFUNCTYPE(None, ptr, string, string, string, string, ptr, ptr)


@callback_type
def on_response(connection, sender_name, object_path, interface, signal, parameters, data):
    global uri
    if object_path != request:
        return
    response = child(parameters, 0)
    if get_uint(response) == 0:
        results = child(parameters, 1)
        value = lookup(results, b'uri', None)
        if value:
            uri = get_string(value, None).decode()
            unref(value)
        unref(results)
    unref(response)
    loop_quit(loop)


# Subscribe before calling to avoid losing a fast Response signal.
subscribe(bus, destination, b'org.freedesktop.portal.Request', b'Response',
          None, None, 0, on_response, None, None)
parameters = parse(None, (
    "('', {'handle_token': <'%s'>, 'interactive': <true>})" % token
).encode(), None, None, None)
reply = call(bus, destination, b'/org/freedesktop/portal/desktop',
             b'org.freedesktop.portal.Screenshot', b'Screenshot',
             parameters, None, 0, 10000, None, None)
if not reply:
    raise RuntimeError('Screenshot portal request failed')
handle = child(reply, 0)
request = get_string(handle, None)
unref(handle)
unref(reply)
loop_run(loop)
if uri:
    print(uri)
