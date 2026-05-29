; Tauri NSIS installer hooks.
;
; Autostart ("launch on Windows login") is managed at runtime by
; tauri-plugin-autostart, which writes an HKCU Run value named after the
; product name. If the user removes the app while autostart is still enabled,
; that Run value would otherwise linger and point at a deleted exe. On
; uninstall we delete it so the autostart state can't outlive the app.
;
; The value name must match what the plugin writes (auto-launch uses
; PackageInfo.name == productName), so we key off ${PRODUCTNAME}. The HKCU Run
; path is the same one the plugin (and Windows) use for per-user startup.

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
!macroend
