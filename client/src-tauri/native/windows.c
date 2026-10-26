#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincred.h>
#include <wtsapi32.h>
#include <stdlib.h>
#include <string.h>

static volatile LONG sleeping = 0, locked = 1, ready = 0, generation = 0;
static volatile LONG light_theme = 0;

static void read_theme(void) {
    DWORD value = 0, size = sizeof(value);
    RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
        L"SystemUsesLightTheme", RRF_RT_REG_DWORD, NULL, &value, &size);
    InterlockedExchange(&light_theme, value != 0);
}

static void read_session(void) {
    LPWSTR buffer = NULL;
    DWORD bytes = 0;
    if (WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
            WTSSessionInfoEx, &buffer, &bytes)) {
        WTSINFOEXW *info = (WTSINFOEXW *)buffer;
        if (info->Level == 1) {
            InterlockedExchange(&locked, info->Data.WTSInfoExLevel1.SessionFlags != WTS_SESSIONSTATE_UNLOCK);
            InterlockedExchange(&ready, 1);
        }
        WTSFreeMemory(buffer);
    }
}

static LRESULT CALLBACK events(HWND window, UINT message, WPARAM value, LPARAM data) {
    if (message == WM_SETTINGCHANGE || message == WM_THEMECHANGED) {
        read_theme();
    } else if (message == WM_WTSSESSION_CHANGE) {
        if (value == WTS_SESSION_LOCK || value == WTS_REMOTE_DISCONNECT || value == WTS_CONSOLE_DISCONNECT)
            InterlockedExchange(&locked, 1);
        else {
            read_session();
            InterlockedIncrement(&generation);
        }
    } else if (message == WM_POWERBROADCAST) {
        if (value == PBT_APMSUSPEND) InterlockedExchange(&sleeping, 1);
        if (value == PBT_APMRESUMEAUTOMATIC || value == PBT_APMRESUMESUSPEND) {
            InterlockedExchange(&sleeping, 0);
            read_session();
            InterlockedIncrement(&generation);
        }
    }
    return DefWindowProcW(window, message, value, data);
}

static DWORD WINAPI observe(LPVOID unused) {
    (void)unused;
    HINSTANCE instance = GetModuleHandleW(NULL);
    WNDCLASSW cls = {0};
    cls.lpfnWndProc = events;
    cls.hInstance = instance;
    cls.lpszClassName = L"WaterCompanionActivity";
    RegisterClassW(&cls);
    // A hidden top-level window receives power broadcasts; message-only windows do not.
    HWND window = CreateWindowExW(WS_EX_TOOLWINDOW, cls.lpszClassName, L"", 0,
        0, 0, 0, 0, NULL, NULL, instance, NULL);
    if (!window || !WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION)) return 1;
    read_session();
    read_theme();
    MSG message;
    while (GetMessageW(&message, NULL, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    WTSUnRegisterSessionNotification(window);
    DestroyWindow(window);
    return 0;
}

void coaster_windows_start(void) {
    HANDLE thread = CreateThread(NULL, 0, observe, NULL, 0, NULL);
    if (thread) CloseHandle(thread);
}

double coaster_windows_idle(void) {
    LASTINPUTINFO info = {sizeof(LASTINPUTINFO), 0};
    if (!ready || !GetLastInputInfo(&info)) return -1;
    // Both values are 32-bit tick counts; unsigned subtraction handles rollover.
    return (double)((DWORD)GetTickCount() - info.dwTime) / 1000.0;
}

int coaster_windows_suspended(void) { return sleeping || locked || !ready; }
unsigned long coaster_windows_generation(void) { return (unsigned long)generation; }
int coaster_windows_light_theme(void) { return light_theme; }
int coaster_windows_animate(void) {
    BOOL enabled = TRUE;
    SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &enabled, 0);
    return enabled;
}

static WCHAR *credential_name(const char *origin) {
    const WCHAR prefix[] = L"com.watercompanion.client.session/";
    int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, origin, -1, NULL, 0);
    if (!length) return NULL;
    size_t prefix_length = sizeof(prefix) / sizeof(WCHAR) - 1;
    WCHAR *name = calloc(prefix_length + length, sizeof(WCHAR));
    if (!name) return NULL;
    memcpy(name, prefix, prefix_length * sizeof(WCHAR));
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, origin, -1, name + prefix_length, length);
    return name;
}

unsigned long coaster_credential_read(const char *origin, char *token) {
    WCHAR *name = credential_name(origin);
    if (!name) return ERROR_INVALID_PARAMETER;
    PCREDENTIALW credential = NULL;
    DWORD result = 0;
    if (!CredReadW(name, CRED_TYPE_GENERIC, 0, &credential)) result = GetLastError();
    else {
        if (credential->CredentialBlobSize != 64) result = ERROR_INVALID_DATA;
        else memcpy(token, credential->CredentialBlob, 64);
        CredFree(credential);
    }
    free(name);
    return result;
}

unsigned long coaster_credential_save(const char *origin, const char *token) {
    WCHAR *name = credential_name(origin);
    if (!name) return ERROR_INVALID_PARAMETER;
    CREDENTIALW credential = {0};
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = name;
    credential.CredentialBlobSize = 64;
    credential.CredentialBlob = (LPBYTE)token;
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    credential.UserName = L"WaterCompanion";
    DWORD result = CredWriteW(&credential, 0) ? 0 : GetLastError();
    free(name);
    return result;
}

unsigned long coaster_credential_remove(const char *origin) {
    WCHAR *name = credential_name(origin);
    if (!name) return ERROR_INVALID_PARAMETER;
    DWORD result = CredDeleteW(name, CRED_TYPE_GENERIC, 0) ? 0 : GetLastError();
    free(name);
    return result == ERROR_NOT_FOUND ? 0 : result;
}
