/* COM interception point for Wine's VFW camera filter in PE32 ZaloCall.
 * The original Zalo/Qt DLLs and Wine's qcap.dll stay untouched.
 */
#define COBJMACROS
#include <winsock2.h>
#include <windows.h>
#include <objbase.h>
#include <wchar.h>

static HMODULE self;
static const GUID capture_class =
    {0x1b544c22, 0xfd0b, 0x11ce, {0x8c, 0x63, 0x00, 0xaa, 0x00, 0x44, 0xb5, 0x1e}};
static const GUID factory_iid =
    {1, 0, 0, {0xc0, 0, 0, 0, 0, 0, 0, 0x46}};
static const GUID unknown_iid =
    {0, 0, 0, {0xc0, 0, 0, 0, 0, 0, 0, 0x46}};
static const WCHAR key_name[] =
    L"Software\\Classes\\Wow6432Node\\CLSID\\{1B544C22-FD0B-11CE-8C63-00AA0044B51E}\\InprocServer32";
static const WCHAR backup_name[] = L"ZcallCameraHookOriginal";

static BOOL has_name(const WCHAR *path, const WCHAR *name)
{
    const WCHAR *base = wcsrchr(path, L'\\');
    return base && !lstrcmpiW(base + 1, name);
}

struct hook_factory {
    IClassFactory iface;
    LONG refs;
};

static void trace_hook(const char *line)
{
    char path[MAX_PATH];
    DWORD length = GetEnvironmentVariableA("ZCALL_CAMERA_HOOK_LOG", path, sizeof(path));
    if (length && length < sizeof(path)) {
        HANDLE file = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                  NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        if (file != INVALID_HANDLE_VALUE) {
            DWORD written;
            WriteFile(file, line, lstrlenA(line), &written, NULL);
            CloseHandle(file);
        }
    }
}

#include "camera-source.c"

static HRESULT WINAPI factory_query(IClassFactory *iface, REFIID iid, void **object)
{
    struct hook_factory *hook = CONTAINING_RECORD(iface, struct hook_factory, iface);
    if (!object) return E_POINTER;
    *object = NULL;
    if (!IsEqualGUID(iid, &factory_iid) && !IsEqualGUID(iid, &unknown_iid))
        return E_NOINTERFACE;
    InterlockedIncrement(&hook->refs);
    *object = iface;
    return S_OK;
}

static ULONG WINAPI factory_addref(IClassFactory *iface)
{
    struct hook_factory *hook = CONTAINING_RECORD(iface, struct hook_factory, iface);
    return InterlockedIncrement(&hook->refs);
}

static ULONG WINAPI factory_release(IClassFactory *iface)
{
    struct hook_factory *hook = CONTAINING_RECORD(iface, struct hook_factory, iface);
    ULONG refs = InterlockedDecrement(&hook->refs);
    if (!refs) {
        HeapFree(GetProcessHeap(), 0, hook);
    }
    return refs;
}

static HRESULT WINAPI factory_create(IClassFactory *iface, IUnknown *outer,
                                     REFIID iid, void **object)
{
    (void)iface;
    trace_hook("camera-hook: native PipeWire camera facade created\r\n");
    return camera_source_create(outer, iid, object);
}

static HRESULT WINAPI factory_lock(IClassFactory *iface, BOOL lock)
{
    (void)iface; (void)lock;
    return S_OK;
}

static IClassFactoryVtbl factory_vtable = {
    factory_query, factory_addref, factory_release, factory_create, factory_lock
};

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        self = instance;
        DisableThreadLibraryCalls(instance);
    }
    return TRUE;
}

HRESULT WINAPI DllGetClassObject(REFCLSID clsid, REFIID iid, void **object)
{
    struct hook_factory *hook;
    HRESULT result;

    if (!object) return E_POINTER;
    *object = NULL;
    if (!IsEqualGUID(clsid, &capture_class)) return CLASS_E_CLASSNOTAVAILABLE;
    trace_hook("camera-hook: VFW capture class requested\r\n");

    hook = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*hook));
    if (!hook) return E_OUTOFMEMORY;
    hook->iface.lpVtbl = &factory_vtable;
    hook->refs = 1;
    result = factory_query(&hook->iface, iid, object);
    factory_release(&hook->iface);
    return result;
}

HRESULT WINAPI DllRegisterServer(void)
{
    HKEY key;
    WCHAR path[MAX_PATH], original[MAX_PATH];
    DWORD length = GetModuleFileNameW(self, path, MAX_PATH);
    DWORD size = sizeof(original), type = 0;
    LONG status;
    if (!length || length == MAX_PATH) return E_FAIL;
    status = RegOpenKeyExW(HKEY_LOCAL_MACHINE, key_name, 0,
                           KEY_QUERY_VALUE | KEY_SET_VALUE, &key);
    if (status) return HRESULT_FROM_WIN32(status);
    status = RegQueryValueExW(key, NULL, NULL, &type, (BYTE *)original, &size);
    if (!status && (type != REG_SZ || size < sizeof(WCHAR) ||
                    size > sizeof(original) || original[size / sizeof(WCHAR) - 1]))
        status = ERROR_INVALID_DATA;
    if (!status && lstrcmpiW(original, path)) {
        if (has_name(original, L"qcap.dll")) {
            status = RegSetValueExW(key, backup_name, 0, REG_SZ,
                                    (const BYTE *)original, size);
        } else if (has_name(original, L"camera-hook.dll")) {
            size = sizeof(original);
            status = RegQueryValueExW(key, backup_name, NULL, NULL,
                                      (BYTE *)original, &size);
            if (!status && (size < sizeof(WCHAR) || size > sizeof(original) ||
                            original[size / sizeof(WCHAR) - 1] ||
                            !has_name(original, L"qcap.dll"))) status = ERROR_INVALID_DATA;
        } else status = ERROR_ALREADY_EXISTS;
    }
    if (!status) status = RegSetValueExW(key, NULL, 0, REG_SZ, (const BYTE *)path,
                                        (lstrlenW(path) + 1) * sizeof(WCHAR));
    RegCloseKey(key);
    return status ? HRESULT_FROM_WIN32(status) : S_OK;
}

HRESULT WINAPI DllUnregisterServer(void)
{
    HKEY key;
    WCHAR original[MAX_PATH], current[MAX_PATH];
    DWORD size = sizeof(original), current_size = sizeof(current);
    LONG status = RegOpenKeyExW(HKEY_LOCAL_MACHINE, key_name, 0,
                                KEY_QUERY_VALUE | KEY_SET_VALUE, &key);
    if (status) return HRESULT_FROM_WIN32(status);
    if (!status) status = RegQueryValueExW(key, NULL, NULL, NULL,
                                           (BYTE *)current, &current_size);
    if (!status && (current_size < sizeof(WCHAR) || current_size > sizeof(current) ||
                    current[current_size / sizeof(WCHAR) - 1] ||
                    !has_name(current, L"camera-hook.dll")))
        status = ERROR_INVALID_DATA;
    if (!status) status = RegQueryValueExW(key, backup_name, NULL, NULL,
                                           (BYTE *)original, &size);
    if (!status && (size < sizeof(WCHAR) || size > sizeof(original) ||
                    original[size / sizeof(WCHAR) - 1] ||
                    !has_name(original, L"qcap.dll"))) status = ERROR_INVALID_DATA;
    if (!status) status = RegSetValueExW(key, NULL, 0, REG_SZ,
                                        (const BYTE *)original, size);
    if (!status) status = RegDeleteValueW(key, backup_name);
    RegCloseKey(key);
    return status ? HRESULT_FROM_WIN32(status) : S_OK;
}
