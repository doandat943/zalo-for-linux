/* COM interception point for Wine's VFW camera filter in PE32 ZaloCall.
 * The original Zalo/Qt DLLs and Wine's qcap.dll stay untouched.
 */
#define COBJMACROS
#include <winsock2.h>
#include <windows.h>
#include <objbase.h>
#include <wchar.h>
#include <dbt.h>

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
    BOOL devices;
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
#include "camera-devices.c"

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
    struct hook_factory *hook=CONTAINING_RECORD(iface,struct hook_factory,iface);
    if(hook->devices)return camera_devices_create(outer,iid,object);
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

static HRESULT register_cameras(BOOL remove_only)
{
    static const WCHAR instances[] = L"CLSID\\{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\Instance";
    static const WCHAR prefix[] = L"ZcallPipeWire_";
    WCHAR key_name[256], friendly[512];
    char variable[64], count_value[16], *end;
    HKEY key;
    DWORD size, ordinal=0, index, length;
    unsigned long count=0, i;
    LONG status;
    IFilterMapper2 *mapper=NULL;
    HRESULT result=S_OK, initialized;
    REGPINTYPES media={&MEDIATYPE_Video,&MEDIASUBTYPE_RGB24};
    REGFILTERPINS2 pin={0};
    REGFILTER2 filter={0};

    if(!remove_only) {
        length=GetEnvironmentVariableA("ZCALL_CAMERA_COUNT",count_value,sizeof(count_value));
        if(length) {
            if(length>=sizeof(count_value))return E_INVALIDARG;
            count=strtoul(count_value,&end,10);
            if(*end || count>128)return E_INVALIDARG;
        }
    }
    status=RegOpenKeyExW(HKEY_CLASSES_ROOT,instances,0,KEY_READ|KEY_WRITE,&key);
    if(!status) {
        for(;;) {
            size=sizeof(key_name)/sizeof(*key_name);
            status=RegEnumKeyExW(key,ordinal,key_name,&size,NULL,NULL,NULL,NULL);
            if(status==ERROR_NO_MORE_ITEMS)break;
            if(status){RegCloseKey(key);return HRESULT_FROM_WIN32(status);}
            if(!wcsncmp(key_name,prefix,wcslen(prefix))) {
                status=RegDeleteTreeW(key,key_name);
                if(status){RegCloseKey(key);return HRESULT_FROM_WIN32(status);}
            } else ++ordinal;
        }
        RegCloseKey(key);
    } else if(status!=ERROR_FILE_NOT_FOUND)return HRESULT_FROM_WIN32(status);
    if(!count){SendNotifyMessageW(HWND_BROADCAST,WM_DEVICECHANGE,DBT_DEVNODES_CHANGED,0);return S_OK;}

    initialized=CoInitializeEx(NULL,COINIT_MULTITHREADED);
    if(FAILED(initialized) && initialized!=RPC_E_CHANGED_MODE)return initialized;
    result=CoCreateInstance(&CLSID_FilterMapper2,NULL,CLSCTX_INPROC_SERVER,
                           &IID_IFilterMapper2,(void **)&mapper);
    pin.dwFlags=REG_PINFLAG_B_OUTPUT;pin.cInstances=1;pin.nMediaTypes=1;pin.lpMediaType=&media;
    filter.dwVersion=2;filter.dwMerit=MERIT_DO_NOT_USE;filter.cPins2=1;filter.rgPins2=&pin;
    for(i=0;SUCCEEDED(result) && i<count;++i) {
        IMoniker *moniker=NULL;
        IPropertyBag *bag=NULL;
        VARIANT value;
        struct camera_source format={0};
        char encoded[128],extra;
        snprintf(variable,sizeof(variable),"ZCALL_CAMERA_%lu_INDEX",i);
        if(!format_number(variable,&index)){result=E_INVALIDARG;break;}
        snprintf(variable,sizeof(variable),"ZCALL_CAMERA_%lu_FORMAT",index);
        length=GetEnvironmentVariableA(variable,encoded,sizeof(encoded));
        if(!length || length>=sizeof(encoded) ||
           sscanf(encoded,"%lu,%lu,%lu,%lu%c",&format.width,&format.height,&format.fps_num,
                  &format.fps_den,&extra)!=4 || FAILED(source_format(&format))){result=E_INVALIDARG;break;}
        swprintf(key_name,sizeof(key_name)/sizeof(*key_name),L"ZCALL_CAMERA_%lu_NAME",index);
        length=GetEnvironmentVariableW(key_name,friendly,sizeof(friendly)/sizeof(*friendly));
        if(!length || length>=sizeof(friendly)/sizeof(*friendly)){result=E_INVALIDARG;break;}
        swprintf(key_name,sizeof(key_name)/sizeof(*key_name),L"ZcallPipeWire_%lu",index);
        result=IFilterMapper2_RegisterFilter(mapper,&capture_class,friendly,&moniker,
                   &CLSID_VideoInputDeviceCategory,key_name,&filter);
        if(SUCCEEDED(result))result=IMoniker_BindToStorage(moniker,NULL,NULL,&IID_IPropertyBag,(void **)&bag);
        if(SUCCEEDED(result)) {
            VariantInit(&value);V_VT(&value)=VT_I4;V_I4(&value)=index;
            result=IPropertyBag_Write(bag,L"VFWIndex",&value);
            {
                const WCHAR *names[]={L"ZcallWidth",L"ZcallHeight",L"ZcallFpsNum",L"ZcallFpsDen"};
                DWORD values[]={format.width,format.height,format.fps_num,format.fps_den};
                unsigned j;
                for(j=0;j<4 && SUCCEEDED(result);++j) {
                    V_I4(&value)=values[j];result=IPropertyBag_Write(bag,names[j],&value);
                }
            }
        }
        if(bag)IPropertyBag_Release(bag);
        if(moniker)IMoniker_Release(moniker);
    }
    if(mapper)IFilterMapper2_Release(mapper);
    if(SUCCEEDED(initialized))CoUninitialize();
    if(SUCCEEDED(result))SendNotifyMessageW(HWND_BROADCAST,WM_DEVICECHANGE,DBT_DEVNODES_CHANGED,0);
    return result;
}

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
    if (!IsEqualGUID(clsid, &capture_class) && !IsEqualGUID(clsid,&CLSID_SystemDeviceEnum))
        return CLASS_E_CLASSNOTAVAILABLE;
    trace_hook(IsEqualGUID(clsid,&CLSID_SystemDeviceEnum) ?
               "camera-hook: camera device enumerator requested\r\n" :
               "camera-hook: VFW capture class requested\r\n");

    hook = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*hook));
    if (!hook) return E_OUTOFMEMORY;
    hook->iface.lpVtbl = &factory_vtable;
    hook->refs = 1;
    hook->devices=IsEqualGUID(clsid,&CLSID_SystemDeviceEnum);
    result = factory_query(&hook->iface, iid, object);
    factory_release(&hook->iface);
    return result;
}

static HRESULT redirect_class(const WCHAR *key_path, const WCHAR *original_name, BOOL restore)
{
    HKEY key;
    WCHAR path[MAX_PATH], current[MAX_PATH], original[MAX_PATH];
    DWORD size=sizeof(current), type=0, length=GetModuleFileNameW(self,path,MAX_PATH);
    LONG status;
    if(!length || length==MAX_PATH)return E_FAIL;
    status=RegOpenKeyExW(HKEY_LOCAL_MACHINE,key_path,0,KEY_QUERY_VALUE|KEY_SET_VALUE,&key);
    if(status)return HRESULT_FROM_WIN32(status);
    status=RegQueryValueExW(key,NULL,NULL,&type,(BYTE *)current,&size);
    if(!status && (type!=REG_SZ || size<sizeof(WCHAR) || size>sizeof(current) ||
                   current[size/sizeof(WCHAR)-1]))status=ERROR_INVALID_DATA;
    if(!status && (restore || lstrcmpW(current,path))) {
        if(!restore && has_name(current,original_name)) {
            status=RegSetValueExW(key,backup_name,0,REG_SZ,(BYTE *)current,size);
        } else if(has_name(current,L"camera-hook.dll")) {
            size=sizeof(original);
            status=RegQueryValueExW(key,backup_name,NULL,&type,(BYTE *)original,&size);
            if(!status && (type!=REG_SZ || size<sizeof(WCHAR) || size>sizeof(original) ||
                           original[size/sizeof(WCHAR)-1] || !has_name(original,original_name)))
                status=ERROR_INVALID_DATA;
        } else status=ERROR_ALREADY_EXISTS;
    }
    if(!status) {
        if(restore) {
            status=RegSetValueExW(key,NULL,0,REG_SZ,(BYTE *)original,size);
            if(!status)status=RegDeleteValueW(key,backup_name);
        } else status=RegSetValueExW(key,NULL,0,REG_SZ,(BYTE *)path,(lstrlenW(path)+1)*sizeof(WCHAR));
    }
    RegCloseKey(key);
    return status?HRESULT_FROM_WIN32(status):S_OK;
}
static const WCHAR devices_key[]=
    L"Software\\Classes\\Wow6432Node\\CLSID\\{62BE5D10-60EB-11D0-BD3B-00A0C911CE86}\\InprocServer32";

HRESULT WINAPI DllRegisterServer(void)
{
    HRESULT result=redirect_class(key_name,L"qcap.dll",FALSE);
    if(SUCCEEDED(result))result=redirect_class(devices_key,L"devenum.dll",FALSE);
    return FAILED(result)?result:register_cameras(FALSE);
}

HRESULT WINAPI DllUnregisterServer(void)
{
    HRESULT result=register_cameras(TRUE);
    if(SUCCEEDED(result))result=redirect_class(devices_key,L"devenum.dll",TRUE);
    if(SUCCEEDED(result))result=redirect_class(key_name,L"qcap.dll",TRUE);
    return result;
}
