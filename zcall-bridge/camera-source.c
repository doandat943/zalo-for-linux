/* PE32 COM facade. Camera access, decoding and conversion happen in the
 * native 64-bit PipeWire/GStreamer process. This file never opens V4L2.
 */
#define COBJMACROS
#include <winsock2.h>
#include <windows.h>
#include <dshow.h>
#include <ocidl.h>
#include <stdio.h>

struct camera_source {
    IBaseFilter filter;
    IPin pin;
    IAMStreamConfig config;
    IAMVideoControl video;
    IPersistPropertyBag bag;
    IKsPropertySet properties;
    LONG refs;
    DWORD width, height, frame_bytes, fps_num, fps_den, bit_rate;
    REFERENCE_TIME interval;
    volatile FILTER_STATE state;
    IFilterGraph *graph; /* graph owns the filter, so this is a weak reference */
    WCHAR name[128];
    IReferenceClock *clock;
    IPin *peer;
    IMemInputPin *input;
    IMemAllocator *allocator;
    HANDLE stop, thread;
    SOCKET socket;
};

static HRESULT source_query(struct camera_source *, REFIID, void **);
static ULONG source_release(struct camera_source *);
static HRESULT source_stop(struct camera_source *);

#define SOURCE(view, ptr) CONTAINING_RECORD(ptr, struct camera_source, view)
#define VIEW_UNKNOWN(view, type) \
static HRESULT WINAPI view##_query(type *p, REFIID id, void **out) { return source_query(SOURCE(view,p),id,out); } \
static ULONG WINAPI view##_addref(type *p) { return InterlockedIncrement(&SOURCE(view,p)->refs); } \
static ULONG WINAPI view##_release(type *p) { return source_release(SOURCE(view,p)); }
VIEW_UNKNOWN(filter, IBaseFilter)
VIEW_UNKNOWN(pin, IPin)
VIEW_UNKNOWN(config, IAMStreamConfig)
VIEW_UNKNOWN(video, IAMVideoControl)
VIEW_UNKNOWN(bag, IPersistPropertyBag)
VIEW_UNKNOWN(properties, IKsPropertySet)

static BOOL format_number(const char *name, DWORD *out)
{
    char value[32], *end;
    DWORD length=GetEnvironmentVariableA(name,value,sizeof(value));
    unsigned long number;
    if(!length || length>=sizeof(value))return FALSE;
    number=strtoul(value,&end,10);
    if(*end || !number || number>MAXLONG)return FALSE;
    *out=(DWORD)number;return TRUE;
}

static HRESULT source_format(struct camera_source *source)
{
    ULONGLONG bytes,interval,bit_rate;
    if(!format_number("ZCALL_CAMERA_WIDTH",&source->width) ||
       !format_number("ZCALL_CAMERA_HEIGHT",&source->height) ||
       !format_number("ZCALL_CAMERA_FPS_NUM",&source->fps_num) ||
       !format_number("ZCALL_CAMERA_FPS_DEN",&source->fps_den) ||
       source->fps_num>1000000 || source->fps_den>1000000)return VFW_E_INVALIDMEDIATYPE;
    bytes=(((ULONGLONG)source->width*3+3)&~3ULL)*source->height;
    interval=(10000000ULL*source->fps_den+source->fps_num/2)/source->fps_num;
    if(bytes>256*1024*1024 || !interval || interval>MAXLONG)return VFW_E_INVALIDMEDIATYPE;
    source->frame_bytes=(DWORD)bytes;source->interval=(REFERENCE_TIME)interval;
    bit_rate=bytes*8*source->fps_num/source->fps_den;
    source->bit_rate=bit_rate>MAXLONG?MAXLONG:(DWORD)bit_rate;
    return S_OK;
}

static void media_free(AM_MEDIA_TYPE *type)
{
    if (type->pUnk) IUnknown_Release(type->pUnk);
    CoTaskMemFree(type->pbFormat);
    memset(type, 0, sizeof(*type));
}

static HRESULT media_make(struct camera_source *source, AM_MEDIA_TYPE *type)
{
    VIDEOINFOHEADER *video;
    memset(type, 0, sizeof(*type));
    video = CoTaskMemAlloc(sizeof(*video));
    if (!video) return E_OUTOFMEMORY;
    memset(video, 0, sizeof(*video));
    type->majortype = MEDIATYPE_Video;
    type->subtype = MEDIASUBTYPE_RGB24;
    type->bFixedSizeSamples = TRUE;
    type->lSampleSize = source->frame_bytes;
    type->formattype = FORMAT_VideoInfo;
    type->cbFormat = sizeof(*video);
    type->pbFormat = (BYTE *)video;
    video->AvgTimePerFrame = source->interval;
    video->dwBitRate = source->bit_rate;
    video->bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    video->bmiHeader.biWidth = source->width;
    video->bmiHeader.biHeight = source->height;
    video->bmiHeader.biPlanes = 1;
    video->bmiHeader.biBitCount = 24;
    video->bmiHeader.biCompression = BI_RGB;
    video->bmiHeader.biSizeImage = source->frame_bytes;
    return S_OK;
}

static BOOL media_accept(struct camera_source *source, const AM_MEDIA_TYPE *type)
{
    const VIDEOINFOHEADER *video;
    if (!type || !IsEqualGUID(&type->majortype, &MEDIATYPE_Video) ||
        !IsEqualGUID(&type->subtype, &MEDIASUBTYPE_RGB24) ||
        !IsEqualGUID(&type->formattype, &FORMAT_VideoInfo) ||
        type->cbFormat < sizeof(*video) || !type->pbFormat) return FALSE;
    video = (const VIDEOINFOHEADER *)type->pbFormat;
    return video->bmiHeader.biWidth == (LONG)source->width &&
           video->bmiHeader.biHeight == (LONG)source->height && video->bmiHeader.biBitCount == 24 &&
           video->bmiHeader.biCompression == BI_RGB &&
           (!video->AvgTimePerFrame || video->AvgTimePerFrame == source->interval);
}

struct camera_enum {
    union { IEnumPins pins; IEnumMediaTypes media; } iface;
    LONG refs;
    ULONG position;
    struct camera_source *source;
    BOOL media;
};
static HRESULT WINAPI enum_query(void *iface, REFIID id, void **out)
{
    struct camera_enum *e = iface;
    if (!out) return E_POINTER;
    *out = NULL;
    if (!IsEqualGUID(id, &IID_IUnknown) &&
        !IsEqualGUID(id, e->media ? &IID_IEnumMediaTypes : &IID_IEnumPins)) return E_NOINTERFACE;
    InterlockedIncrement(&e->refs); *out = iface; return S_OK;
}
static ULONG WINAPI enum_addref(void *iface) { return InterlockedIncrement(&((struct camera_enum *)iface)->refs); }
static ULONG WINAPI enum_release(void *iface)
{
    struct camera_enum *e = iface;
    ULONG refs = InterlockedDecrement(&e->refs);
    if (!refs) { source_release(e->source); HeapFree(GetProcessHeap(), 0, e); }
    return refs;
}
static HRESULT WINAPI enum_skip(void *iface, ULONG count)
{
    struct camera_enum *e = iface;
    ULONG available = e->position ? 0 : 1;
    if (count) e->position = 1;
    return count <= available ? S_OK : S_FALSE;
}
static HRESULT WINAPI enum_reset(void *iface) { ((struct camera_enum *)iface)->position = 0; return S_OK; }
static HRESULT enum_new(struct camera_source *, BOOL, ULONG, void **);
static HRESULT WINAPI enum_clone(void *iface, void **out)
{
    struct camera_enum *e = iface;
    return enum_new(e->source, e->media, e->position, out);
}
static HRESULT WINAPI enum_pins_next(IEnumPins *iface, ULONG count, IPin **out, ULONG *fetched)
{
    struct camera_enum *e = (struct camera_enum *)iface;
    if (!out || (count > 1 && !fetched)) return E_POINTER;
    if (fetched) *fetched = 0;
    if (!count) return S_OK;
    if (e->position) return S_FALSE;
    *out = &e->source->pin; pin_addref(*out); e->position = 1;
    if (fetched) *fetched = 1;
    return count == 1 ? S_OK : S_FALSE;
}
static HRESULT WINAPI enum_media_next(IEnumMediaTypes *iface, ULONG count, AM_MEDIA_TYPE **out, ULONG *fetched)
{
    struct camera_enum *e = (struct camera_enum *)iface;
    HRESULT result;
    if (!out || (count > 1 && !fetched)) return E_POINTER;
    if (fetched) *fetched = 0;
    if (!count) return S_OK;
    if (e->position) return S_FALSE;
    *out = CoTaskMemAlloc(sizeof(**out));
    if (!*out) return E_OUTOFMEMORY;
    result = media_make(e->source, *out);
    if (FAILED(result)) { CoTaskMemFree(*out); *out = NULL; return result; }
    e->position = 1; if (fetched) *fetched = 1;
    return count == 1 ? S_OK : S_FALSE;
}
static IEnumPinsVtbl pins_vtable = {
    (void *)enum_query, (void *)enum_addref, (void *)enum_release, enum_pins_next,
    (void *)enum_skip, (void *)enum_reset, (void *)enum_clone
};
static IEnumMediaTypesVtbl media_vtable = {
    (void *)enum_query, (void *)enum_addref, (void *)enum_release, enum_media_next,
    (void *)enum_skip, (void *)enum_reset, (void *)enum_clone
};
static HRESULT enum_new(struct camera_source *source, BOOL media, ULONG position, void **out)
{
    struct camera_enum *e;
    if (!out) return E_POINTER;
    *out = NULL;
    e = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*e));
    if (!e) return E_OUTOFMEMORY;
    e->refs = 1; e->source = source; e->media = media; e->position = position;
    if (media) e->iface.media.lpVtbl = &media_vtable;
    else e->iface.pins.lpVtbl = &pins_vtable;
    InterlockedIncrement(&source->refs); *out = e; return S_OK;
}

static BOOL socket_read(SOCKET socket, BYTE *data, int size)
{
    while (size > 0) {
        int got = recv(socket, (char *)data, size, 0);
        if (got <= 0) return FALSE;
        data += got; size -= got;
    }
    return TRUE;
}
static HRESULT camera_connect(struct camera_source *source)
{
    char port[16], token[80];
    struct sockaddr_in address;
    DWORD timeout = 10000, header[6];
    WSADATA data;
    char *end;
    unsigned long number;
    DWORD token_length = GetEnvironmentVariableA("ZCALL_CAMERA_TOKEN", token, sizeof(token) - 2);
    DWORD port_length = GetEnvironmentVariableA("ZCALL_CAMERA_PORT", port, sizeof(port));
    if (!token_length || token_length >= sizeof(token) - 2 ||
        !port_length || port_length >= sizeof(port)) return VFW_E_NOT_CONNECTED;
    number = strtoul(port, &end, 10);
    if (*end || !number || number > 65535) return E_INVALIDARG;
    if (WSAStartup(MAKEWORD(2,2), &data)) return E_FAIL;
    source->socket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (source->socket == INVALID_SOCKET) { WSACleanup(); return E_FAIL; }
    setsockopt(source->socket, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout, sizeof(timeout));
    memset(&address, 0, sizeof(address)); address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK); address.sin_port = htons((u_short)number);
    token[token_length++] = '\n';
    if (connect(source->socket, (struct sockaddr *)&address, sizeof(address)) ||
        send(source->socket, token, token_length, 0) != (int)token_length ||
        !socket_read(source->socket, (BYTE *)header, sizeof(header)) ||
        memcmp(header, "ZCA2", 4) || header[1] != source->width ||
        header[2] != source->height || header[3] != source->frame_bytes ||
        header[4] != source->fps_num || header[5] != source->fps_den) {
        closesocket(source->socket); source->socket = INVALID_SOCKET; WSACleanup(); return E_FAIL;
    }
    return S_OK;
}

static DWORD WINAPI camera_thread(void *arg)
{
    struct camera_source *source = arg;
    REFERENCE_TIME start = 0, end;
    CoInitializeEx(NULL, COINIT_MULTITHREADED);
    while (WaitForSingleObject(source->stop, 0) == WAIT_TIMEOUT) {
        IMediaSample *sample = NULL;
        BYTE *buffer = NULL;
        HRESULT result = IMemAllocator_GetBuffer(source->allocator, &sample, NULL, NULL, 0);
        if (FAILED(result)) break;
        result = IMediaSample_GetPointer(sample, &buffer);
        if (FAILED(result) || IMediaSample_GetSize(sample) < (LONG)source->frame_bytes ||
            !socket_read(source->socket, buffer, source->frame_bytes)) { IMediaSample_Release(sample); break; }
        if (source->state == State_Running || source->state == State_Paused) {
            end = start + source->interval;
            IMediaSample_SetActualDataLength(sample, source->frame_bytes);
            IMediaSample_SetTime(sample, &start, &end);
            IMediaSample_SetSyncPoint(sample, TRUE);
            IMediaSample_SetDiscontinuity(sample, start == 0);
            result = IMemInputPin_Receive(source->input, sample);
            start = end;
        }
        IMediaSample_Release(sample);
        if (FAILED(result)) break;
    }
    if (WaitForSingleObject(source->stop, 0) == WAIT_TIMEOUT && source->graph) {
        IMediaEventSink *events = NULL;
        if (SUCCEEDED(IFilterGraph_QueryInterface(source->graph, &IID_IMediaEventSink, (void **)&events))) {
            IMediaEventSink_Notify(events, EC_ERRORABORT, E_FAIL, 0);
            IMediaEventSink_Release(events);
        }
    }
    CoUninitialize();
    return 0;
}

static HRESULT source_stop(struct camera_source *source)
{
    source->state = State_Stopped;
    if (source->thread) {
        SetEvent(source->stop);
        shutdown(source->socket, SD_BOTH);
        if (source->peer) IPin_BeginFlush(source->peer);
        if (source->allocator) IMemAllocator_Decommit(source->allocator);
        WaitForSingleObject(source->thread, INFINITE);
        CloseHandle(source->thread); source->thread = NULL;
        closesocket(source->socket); source->socket = INVALID_SOCKET; WSACleanup();
        if (source->peer) IPin_EndFlush(source->peer);
    }
    return S_OK;
}
static ULONG source_release(struct camera_source *source)
{
    ULONG refs = InterlockedDecrement(&source->refs);
    if (!refs) {
        source_stop(source);
        if (source->peer) IPin_Release(source->peer);
        if (source->input) IMemInputPin_Release(source->input);
        if (source->allocator) IMemAllocator_Release(source->allocator);
        if (source->clock) IReferenceClock_Release(source->clock);
        CloseHandle(source->stop); HeapFree(GetProcessHeap(), 0, source);
    }
    return refs;
}
static HRESULT source_query(struct camera_source *source, REFIID iid, void **out)
{
    if (!out) return E_POINTER;
    *out = NULL;
    if (IsEqualGUID(iid,&IID_IUnknown) || IsEqualGUID(iid,&IID_IBaseFilter) ||
        IsEqualGUID(iid,&IID_IMediaFilter) || IsEqualGUID(iid,&IID_IPersist)) *out = &source->filter;
    else if (IsEqualGUID(iid,&IID_IPin)) *out = &source->pin;
    else if (IsEqualGUID(iid,&IID_IAMStreamConfig)) *out = &source->config;
    else if (IsEqualGUID(iid,&IID_IAMVideoControl)) *out = &source->video;
    else if (IsEqualGUID(iid,&IID_IPersistPropertyBag)) *out = &source->bag;
    else if (IsEqualGUID(iid,&IID_IKsPropertySet)) *out = &source->properties;
    else return E_NOINTERFACE;
    InterlockedIncrement(&source->refs); return S_OK;
}

static HRESULT WINAPI filter_class(IBaseFilter *p, CLSID *out)
{ (void)p; if (!out) return E_POINTER; *out = capture_class; return S_OK; }
static HRESULT WINAPI filter_stop(IBaseFilter *p) { return source_stop(SOURCE(filter,p)); }
static HRESULT source_start(struct camera_source *source)
{
    HRESULT result;
    if (!source->input || !source->allocator) return VFW_E_NOT_CONNECTED;
    if (source->thread) return S_OK;
    result = camera_connect(source);
    if (FAILED(result)) { source->state = State_Stopped; return result; }
    result = IMemAllocator_Commit(source->allocator);
    if (FAILED(result)) { closesocket(source->socket); source->socket = INVALID_SOCKET; WSACleanup(); source->state = State_Stopped; return result; }
    ResetEvent(source->stop);
    IPin_NewSegment(source->peer, 0, MAXLONGLONG, 1.0);
    source->thread = CreateThread(NULL, 0, camera_thread, source, 0, NULL);
    if (!source->thread) {
        IMemAllocator_Decommit(source->allocator); closesocket(source->socket);
        source->socket = INVALID_SOCKET; WSACleanup(); source->state = State_Stopped; return E_FAIL;
    }
    trace_hook("camera-hook: receiving native 64-bit PipeWire frames\r\n");
    return S_OK;
}
static HRESULT WINAPI filter_pause(IBaseFilter *p)
{ struct camera_source *s=SOURCE(filter,p);trace_hook("camera-hook: pause\r\n");s->state=State_Paused;return source_start(s); }
static HRESULT WINAPI filter_run(IBaseFilter *p, REFERENCE_TIME start)
{ struct camera_source *s=SOURCE(filter,p);(void)start;trace_hook("camera-hook: run\r\n");s->state=State_Running;return source_start(s); }
static HRESULT WINAPI filter_state(IBaseFilter *p, DWORD timeout, FILTER_STATE *out)
{ (void)timeout; if (!out) return E_POINTER; *out = SOURCE(filter,p)->state; return S_OK; }
static HRESULT WINAPI filter_setclock(IBaseFilter *p, IReferenceClock *clock)
{ struct camera_source *s=SOURCE(filter,p); if(clock) IReferenceClock_AddRef(clock); if(s->clock) IReferenceClock_Release(s->clock); s->clock=clock; return S_OK; }
static HRESULT WINAPI filter_getclock(IBaseFilter *p, IReferenceClock **out)
{ if(!out)return E_POINTER; *out=SOURCE(filter,p)->clock; if(*out)IReferenceClock_AddRef(*out); return S_OK; }
static HRESULT WINAPI filter_pins(IBaseFilter *p, IEnumPins **out) { return enum_new(SOURCE(filter,p),FALSE,0,(void **)out); }
static HRESULT WINAPI filter_find(IBaseFilter *p, LPCWSTR id, IPin **out)
{ if(!out)return E_POINTER; *out=NULL; if(!id || lstrcmpW(id,L"Capture"))return VFW_E_NOT_FOUND; *out=&SOURCE(filter,p)->pin; pin_addref(*out); return S_OK; }
static HRESULT WINAPI filter_info(IBaseFilter *p, FILTER_INFO *out)
{ struct camera_source *s=SOURCE(filter,p); if(!out)return E_POINTER; memset(out,0,sizeof(*out)); lstrcpynW(out->achName,s->name,128); out->pGraph=s->graph; if(out->pGraph)IFilterGraph_AddRef(out->pGraph); return S_OK; }
static HRESULT WINAPI filter_join(IBaseFilter *p, IFilterGraph *graph, LPCWSTR name)
{ struct camera_source *s=SOURCE(filter,p); s->graph=graph; lstrcpynW(s->name,name?name:L"PipeWire camera",128); return S_OK; }
static HRESULT WINAPI filter_vendor(IBaseFilter *p, LPWSTR *out)
{ (void)p; if(!out)return E_POINTER; *out=NULL; return E_NOTIMPL; }
static IBaseFilterVtbl filter_vtable = {
    filter_query,filter_addref,filter_release,filter_class,filter_stop,filter_pause,filter_run,
    filter_state,filter_setclock,filter_getclock,filter_pins,filter_find,filter_info,filter_join,filter_vendor
};

static HRESULT WINAPI pin_accept(IPin *p, const AM_MEDIA_TYPE *type)
{ return media_accept(SOURCE(pin,p),type) ? S_OK : S_FALSE; }
static HRESULT WINAPI pin_connect(IPin *p, IPin *peer, const AM_MEDIA_TYPE *requested)
{
    struct camera_source *s = SOURCE(pin,p);
    AM_MEDIA_TYPE type;
    ALLOCATOR_PROPERTIES wanted = {3, s->frame_bytes, 1, 0}, actual;
    HRESULT result;
    if (!peer) return E_POINTER;
    if (s->peer) return VFW_E_ALREADY_CONNECTED;
    if (requested && !media_accept(s, requested)) return VFW_E_TYPE_NOT_ACCEPTED;
    result = media_make(s, &type); if (FAILED(result)) return result;
    result = IPin_ReceiveConnection(peer, p, &type); media_free(&type);
    if (FAILED(result)) return result;
    result = IPin_QueryInterface(peer, &IID_IMemInputPin, (void **)&s->input);
    if (SUCCEEDED(result)) {
        result = IMemInputPin_GetAllocator(s->input, &s->allocator);
        if (FAILED(result)) result = CoCreateInstance(&CLSID_MemoryAllocator,NULL,CLSCTX_INPROC_SERVER,
                                                       &IID_IMemAllocator,(void **)&s->allocator);
    }
    if (SUCCEEDED(result)) result = IMemAllocator_SetProperties(s->allocator,&wanted,&actual);
    if (SUCCEEDED(result) && (actual.cbBuffer < (LONG)s->frame_bytes || actual.cBuffers < 1)) result = E_FAIL;
    if (SUCCEEDED(result)) result = IMemInputPin_NotifyAllocator(s->input,s->allocator,FALSE);
    if (FAILED(result)) {
        if(s->allocator)IMemAllocator_Release(s->allocator);
        s->allocator=NULL;
        if(s->input)IMemInputPin_Release(s->input);
        s->input=NULL;
        IPin_Disconnect(peer); return result;
    }
    {
        PIN_INFO info;
        if (SUCCEEDED(IPin_QueryPinInfo(peer,&info)) && info.pFilter) {
            FILTER_INFO filter;
            if (SUCCEEDED(IBaseFilter_QueryFilterInfo(info.pFilter,&filter))) {
                char name[128]={0},line[256];
                if(!WideCharToMultiByte(CP_UTF8,0,filter.achName,-1,name,sizeof(name),NULL,NULL))
                    lstrcpyA(name,"unknown");
                snprintf(line,sizeof(line),"camera-hook: RGB24 %lux%lu connected to %s\r\n",s->width,s->height,name);
                trace_hook(line);
                if(filter.pGraph)IFilterGraph_Release(filter.pGraph);
            }
            IBaseFilter_Release(info.pFilter);
        }
    }
    s->peer=peer; IPin_AddRef(peer); return S_OK;
}
static HRESULT WINAPI pin_receive(IPin *p, IPin *peer, const AM_MEDIA_TYPE *type)
{ (void)p;(void)peer;(void)type; return VFW_E_INVALID_DIRECTION; }
static HRESULT WINAPI pin_disconnect(IPin *p)
{
    struct camera_source *s=SOURCE(pin,p);
    if(s->state!=State_Stopped)return VFW_E_NOT_STOPPED;
    if(!s->peer)return S_FALSE;
    source_stop(s); IPin_Release(s->peer); s->peer=NULL;
    IMemInputPin_Release(s->input); s->input=NULL;
    IMemAllocator_Release(s->allocator); s->allocator=NULL; return S_OK;
}
static HRESULT WINAPI pin_connected(IPin *p, IPin **out)
{ if(!out)return E_POINTER; *out=SOURCE(pin,p)->peer; if(!*out)return VFW_E_NOT_CONNECTED; IPin_AddRef(*out); return S_OK; }
static HRESULT WINAPI pin_media(IPin *p, AM_MEDIA_TYPE *out)
{ if(!out)return E_POINTER; if(!SOURCE(pin,p)->peer){memset(out,0,sizeof(*out));return VFW_E_NOT_CONNECTED;}return media_make(SOURCE(pin,p),out); }
static HRESULT WINAPI pin_info(IPin *p, PIN_INFO *out)
{ if(!out)return E_POINTER; memset(out,0,sizeof(*out)); out->pFilter=&SOURCE(pin,p)->filter;filter_addref(out->pFilter);out->dir=PINDIR_OUTPUT;lstrcpyW(out->achName,L"Capture");return S_OK; }
static HRESULT WINAPI pin_direction(IPin *p, PIN_DIRECTION *out)
{ (void)p;if(!out)return E_POINTER;*out=PINDIR_OUTPUT;return S_OK; }
static HRESULT WINAPI pin_id(IPin *p, LPWSTR *out)
{ (void)p;if(!out)return E_POINTER;*out=CoTaskMemAlloc(8*sizeof(WCHAR));if(!*out)return E_OUTOFMEMORY;lstrcpyW(*out,L"Capture");return S_OK; }
static HRESULT WINAPI pin_types(IPin *p, IEnumMediaTypes **out) { return enum_new(SOURCE(pin,p),TRUE,0,(void **)out); }
static HRESULT WINAPI pin_internal(IPin *p, IPin **pins, ULONG *count) { (void)p;(void)pins;(void)count;return E_NOTIMPL; }
static HRESULT WINAPI pin_event(IPin *p) { (void)p;return S_OK; }
static HRESULT WINAPI pin_segment(IPin *p, REFERENCE_TIME start, REFERENCE_TIME end, double rate)
{ (void)p;(void)start;(void)end;(void)rate;return S_OK; }
static IPinVtbl pin_vtable = {
    pin_query,pin_addref,pin_release,pin_connect,pin_receive,pin_disconnect,pin_connected,
    pin_media,pin_info,pin_direction,pin_id,pin_accept,pin_types,pin_internal,pin_event,pin_event,pin_event,pin_segment
};

static HRESULT WINAPI config_set(IAMStreamConfig *p, AM_MEDIA_TYPE *type)
{
    struct camera_source *s=SOURCE(config,p);
    BOOL accepted=media_accept(s,type);
    if(type && type->pbFormat && type->cbFormat>=sizeof(VIDEOINFOHEADER)) {
        VIDEOINFOHEADER *video=(VIDEOINFOHEADER *)type->pbFormat;
        char line[192];
        snprintf(line,sizeof(line),"camera-hook: requested %ldx%ld %u bpp interval=%lld accepted=%d\r\n",
                 video->bmiHeader.biWidth,video->bmiHeader.biHeight,video->bmiHeader.biBitCount,
                 video->AvgTimePerFrame,accepted);
        trace_hook(line);
    }
    if(s->state!=State_Stopped)return VFW_E_NOT_STOPPED;
    return accepted?S_OK:VFW_E_INVALIDMEDIATYPE;
}
static HRESULT WINAPI config_get(IAMStreamConfig *p, AM_MEDIA_TYPE **out)
{ HRESULT result;if(!out)return E_POINTER;*out=CoTaskMemAlloc(sizeof(**out));if(!*out)return E_OUTOFMEMORY;result=media_make(SOURCE(config,p),*out);if(FAILED(result)){CoTaskMemFree(*out);*out=NULL;}return result; }
static HRESULT WINAPI config_count(IAMStreamConfig *p, int *count, int *size)
{ (void)p;if(!count||!size)return E_POINTER;*count=1;*size=sizeof(VIDEO_STREAM_CONFIG_CAPS);return S_OK; }
static HRESULT WINAPI config_caps(IAMStreamConfig *p, int index, AM_MEDIA_TYPE **out, BYTE *data)
{
    struct camera_source *source=SOURCE(config,p);
    VIDEO_STREAM_CONFIG_CAPS *caps=(VIDEO_STREAM_CONFIG_CAPS *)data;
    if(!out||!data)return E_POINTER;
    *out=NULL;if(index!=0)return S_FALSE;
    memset(caps,0,sizeof(*caps));caps->guid=FORMAT_VideoInfo;
    caps->InputSize.cx=source->width;caps->InputSize.cy=source->height;
    caps->MinCroppingSize=caps->MaxCroppingSize=caps->InputSize;
    caps->MinOutputSize=caps->MaxOutputSize=caps->InputSize;
    caps->CropGranularityX=caps->CropGranularityY=1;
    caps->OutputGranularityX=caps->OutputGranularityY=1;
    caps->MinFrameInterval=caps->MaxFrameInterval=source->interval;
    caps->MinBitsPerSecond=caps->MaxBitsPerSecond=(LONG)source->bit_rate;
    return config_get(p,out);
}
static IAMStreamConfigVtbl config_vtable = {config_query,config_addref,config_release,config_set,config_get,config_count,config_caps};

static HRESULT WINAPI video_caps(IAMVideoControl *p, IPin *pin, LONG *out)
{ (void)p;(void)pin;if(!out)return E_POINTER;*out=0;return S_OK; }
static HRESULT WINAPI video_setmode(IAMVideoControl *p, IPin *pin, LONG mode)
{ (void)p;(void)pin;return mode?E_NOTIMPL:S_OK; }
static HRESULT WINAPI video_rate(IAMVideoControl *p, IPin *pin, LONGLONG *out)
{ (void)pin;if(!out)return E_POINTER;*out=SOURCE(video,p)->interval;return S_OK; }
static HRESULT WINAPI video_max(IAMVideoControl *p, IPin *pin, LONG index, SIZE size, LONGLONG *out)
{ (void)size;if(index!=0)return E_INVALIDARG;return video_rate(p,pin,out); }
static HRESULT WINAPI video_rates(IAMVideoControl *p, IPin *pin, LONG index, SIZE size, LONG *count, LONGLONG **out)
{ (void)pin;(void)size;if(!count||!out)return E_POINTER;*count=0;*out=NULL;if(index!=0)return E_INVALIDARG;*out=CoTaskMemAlloc(sizeof(**out));if(!*out)return E_OUTOFMEMORY;**out=SOURCE(video,p)->interval;*count=1;return S_OK; }
static IAMVideoControlVtbl video_vtable = {video_query,video_addref,video_release,video_caps,video_setmode,video_caps,video_rate,video_max,video_rates};

static HRESULT WINAPI bag_class(IPersistPropertyBag *p, CLSID *out)
{ return filter_class(&SOURCE(bag,p)->filter,out); }
static HRESULT WINAPI bag_init(IPersistPropertyBag *p) { (void)p;return S_OK; }
static HRESULT WINAPI bag_load(IPersistPropertyBag *p, IPropertyBag *bag, IErrorLog *log)
{ (void)p;(void)bag;(void)log;return S_OK; }
static HRESULT WINAPI bag_save(IPersistPropertyBag *p, IPropertyBag *bag, BOOL clear, BOOL all)
{ (void)p;(void)bag;(void)clear;(void)all;return E_NOTIMPL; }
static IPersistPropertyBagVtbl bag_vtable = {bag_query,bag_addref,bag_release,bag_class,bag_init,bag_load,bag_save};

static HRESULT WINAPI properties_set(IKsPropertySet *p, REFGUID set, DWORD id, void *instance, DWORD instance_size, void *data, DWORD size)
{ (void)p;(void)set;(void)id;(void)instance;(void)instance_size;(void)data;(void)size;return E_NOTIMPL; }
static HRESULT WINAPI properties_get(IKsPropertySet *p, REFGUID set, DWORD id, void *instance, DWORD instance_size, void *data, DWORD size, DWORD *written)
{ (void)p;(void)instance;(void)instance_size;if(written)*written=0;if(!IsEqualGUID(set,&AMPROPSETID_Pin)||id!=AMPROPERTY_PIN_CATEGORY)return E_PROP_ID_UNSUPPORTED;if(written)*written=sizeof(GUID);if(!data)return S_OK;if(size<sizeof(GUID))return E_INVALIDARG;*(GUID *)data=PIN_CATEGORY_CAPTURE;return S_OK; }
static HRESULT WINAPI properties_supported(IKsPropertySet *p, REFGUID set, DWORD id, DWORD *out)
{ (void)p;if(!out)return E_POINTER;*out=0;if(!IsEqualGUID(set,&AMPROPSETID_Pin)||id!=AMPROPERTY_PIN_CATEGORY)return E_PROP_ID_UNSUPPORTED;*out=KSPROPERTY_SUPPORT_GET;return S_OK; }
static IKsPropertySetVtbl properties_vtable = {properties_query,properties_addref,properties_release,properties_set,properties_get,properties_supported};

static HRESULT camera_source_create(IUnknown *outer, REFIID iid, void **out)
{
    struct camera_source *s;
    HRESULT result;
    if(!out)return E_POINTER;
    *out=NULL;if(outer)return CLASS_E_NOAGGREGATION;
    s=HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,sizeof(*s));if(!s)return E_OUTOFMEMORY;
    result=source_format(s);
    if(FAILED(result)){HeapFree(GetProcessHeap(),0,s);return result;}
    s->filter.lpVtbl=&filter_vtable;s->pin.lpVtbl=&pin_vtable;
    s->config.lpVtbl=&config_vtable;s->video.lpVtbl=&video_vtable;
    s->bag.lpVtbl=&bag_vtable;s->properties.lpVtbl=&properties_vtable;
    s->refs=1;s->socket=INVALID_SOCKET;s->stop=CreateEventW(NULL,TRUE,FALSE,NULL);
    if(!s->stop){HeapFree(GetProcessHeap(),0,s);return E_FAIL;}
    lstrcpyW(s->name,L"PipeWire camera");
    result=source_query(s,iid,out);source_release(s);return result;
}
