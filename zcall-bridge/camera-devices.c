/* Keep Wine's enumerator for other devices; expose only bridge cameras for video. */
struct camera_monikers {
    IEnumMoniker iface;
    LONG refs;
    IEnumMoniker *native;
};

static HRESULT monikers_create(IEnumMoniker *, IEnumMoniker **);

static HRESULT WINAPI monikers_query(IEnumMoniker *p, REFIID id, void **out)
{
    if(!out)return E_POINTER;
    *out=NULL;
    if(!IsEqualGUID(id,&IID_IUnknown) && !IsEqualGUID(id,&IID_IEnumMoniker))return E_NOINTERFACE;
    *out=p;IEnumMoniker_AddRef(p);return S_OK;
}
static ULONG WINAPI monikers_addref(IEnumMoniker *p)
{ return InterlockedIncrement(&CONTAINING_RECORD(p,struct camera_monikers,iface)->refs); }
static ULONG WINAPI monikers_release(IEnumMoniker *p)
{
    struct camera_monikers *e=CONTAINING_RECORD(p,struct camera_monikers,iface);
    ULONG refs=InterlockedDecrement(&e->refs);
    if(!refs){IEnumMoniker_Release(e->native);HeapFree(GetProcessHeap(),0,e);}
    return refs;
}
static HRESULT WINAPI monikers_next(IEnumMoniker *p, ULONG count, IMoniker **out, ULONG *fetched)
{
    struct camera_monikers *e=CONTAINING_RECORD(p,struct camera_monikers,iface);
    ULONG got=0;
    HRESULT result=S_OK;
    if(!out || (!fetched && count!=1))return E_POINTER;
    if(fetched)*fetched=0;
    while(got<count) {
        IMoniker *moniker;
        LPOLESTR name=NULL;
        BOOL camera;
        result=IEnumMoniker_Next(e->native,1,&moniker,NULL);
        if(result!=S_OK)break;
        result=IMoniker_GetDisplayName(moniker,NULL,NULL,&name);
        camera=SUCCEEDED(result) && wcsstr(name,L"\\ZcallPipeWire_")!=NULL;
        CoTaskMemFree(name);
        if(camera)out[got++]=moniker;
        else IMoniker_Release(moniker);
        if(FAILED(result))break;
    }
    if(fetched)*fetched=got;
    return FAILED(result)?result:(got==count?S_OK:S_FALSE);
}
static HRESULT WINAPI monikers_skip(IEnumMoniker *p, ULONG count)
{
    IMoniker *moniker;
    HRESULT result;
    while(count--){result=monikers_next(p,1,&moniker,NULL);if(result!=S_OK)return result;IMoniker_Release(moniker);}
    return S_OK;
}
static HRESULT WINAPI monikers_reset(IEnumMoniker *p)
{ return IEnumMoniker_Reset(CONTAINING_RECORD(p,struct camera_monikers,iface)->native); }
static HRESULT WINAPI monikers_clone(IEnumMoniker *p, IEnumMoniker **out)
{
    IEnumMoniker *native;
    HRESULT result;
    if(!out)return E_POINTER;
    *out=NULL;
    result=IEnumMoniker_Clone(CONTAINING_RECORD(p,struct camera_monikers,iface)->native,&native);
    if(SUCCEEDED(result)){result=monikers_create(native,out);IEnumMoniker_Release(native);}
    return result;
}
static IEnumMonikerVtbl monikers_vtable={monikers_query,monikers_addref,monikers_release,
    monikers_next,monikers_skip,monikers_reset,monikers_clone};
static HRESULT monikers_create(IEnumMoniker *native, IEnumMoniker **out)
{
    struct camera_monikers *e=HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,sizeof(*e));
    if(!e)return E_OUTOFMEMORY;
    e->iface.lpVtbl=&monikers_vtable;e->refs=1;e->native=native;IEnumMoniker_AddRef(native);
    *out=&e->iface;return S_OK;
}

struct camera_devices {
    ICreateDevEnum iface;
    LONG refs;
    ICreateDevEnum *native;
};
static HRESULT WINAPI devices_query(ICreateDevEnum *p, REFIID id, void **out)
{
    if(!out)return E_POINTER;
    *out=NULL;
    if(!IsEqualGUID(id,&IID_IUnknown) && !IsEqualGUID(id,&IID_ICreateDevEnum))return E_NOINTERFACE;
    *out=p;ICreateDevEnum_AddRef(p);return S_OK;
}
static ULONG WINAPI devices_addref(ICreateDevEnum *p)
{ return InterlockedIncrement(&CONTAINING_RECORD(p,struct camera_devices,iface)->refs); }
static ULONG WINAPI devices_release(ICreateDevEnum *p)
{
    struct camera_devices *e=CONTAINING_RECORD(p,struct camera_devices,iface);
    ULONG refs=InterlockedDecrement(&e->refs);
    if(!refs){ICreateDevEnum_Release(e->native);HeapFree(GetProcessHeap(),0,e);}
    return refs;
}
static HRESULT WINAPI devices_enumerate(ICreateDevEnum *p, REFCLSID category, IEnumMoniker **out, DWORD flags)
{
    struct camera_devices *e=CONTAINING_RECORD(p,struct camera_devices,iface);
    IEnumMoniker *native;
    IMoniker *first;
    HRESULT result;
    if(!out)return E_POINTER;
    *out=NULL;
    if(!IsEqualGUID(category,&CLSID_VideoInputDeviceCategory))
        return ICreateDevEnum_CreateClassEnumerator(e->native,category,out,flags);
    result=ICreateDevEnum_CreateClassEnumerator(e->native,category,&native,flags);
    if(result!=S_OK)return result;
    result=monikers_create(native,out);IEnumMoniker_Release(native);
    if(FAILED(result))return result;
    result=IEnumMoniker_Next(*out,1,&first,NULL);
    if(result==S_OK){IMoniker_Release(first);return IEnumMoniker_Reset(*out);}
    IEnumMoniker_Release(*out);*out=NULL;return result;
}
static ICreateDevEnumVtbl devices_vtable={devices_query,devices_addref,devices_release,devices_enumerate};
static INIT_ONCE devices_once=INIT_ONCE_STATIC_INIT;
static HMODULE devices_module;
static BOOL CALLBACK load_devices(PINIT_ONCE once, void *parameter, void **context)
{ (void)once;(void)parameter;(void)context;devices_module=LoadLibraryW(L"devenum.dll");return devices_module!=NULL; }
static HRESULT camera_devices_create(IUnknown *outer, REFIID id, void **out)
{
    HRESULT (WINAPI *get_class)(REFCLSID,REFIID,void **);
    IClassFactory *factory;
    struct camera_devices *e;
    HRESULT result;
    if(!out)return E_POINTER;
    *out=NULL;
    if(outer)return CLASS_E_NOAGGREGATION;
    if(!InitOnceExecuteOnce(&devices_once,load_devices,NULL,NULL))return E_FAIL;
    get_class=(void *)GetProcAddress(devices_module,"DllGetClassObject");
    if(!get_class)return E_FAIL;
    result=get_class(&CLSID_SystemDeviceEnum,&IID_IClassFactory,(void **)&factory);
    if(FAILED(result))return result;
    e=HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,sizeof(*e));
    if(!e){IClassFactory_Release(factory);return E_OUTOFMEMORY;}
    e->iface.lpVtbl=&devices_vtable;e->refs=1;
    result=IClassFactory_CreateInstance(factory,NULL,&IID_ICreateDevEnum,(void **)&e->native);
    IClassFactory_Release(factory);
    if(FAILED(result)){HeapFree(GetProcessHeap(),0,e);return result;}
    result=devices_query(&e->iface,id,out);devices_release(&e->iface);return result;
}
