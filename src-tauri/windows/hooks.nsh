; Tauri NSIS installer hooks.
;
; The launch-on-login feature (formerly tauri-plugin-autostart) has been
; removed, but earlier versions wrote an HKCU Run value named after the product
; name. We delete it here so that value can't outlive the feature: an upgrade
; install runs the previous version's uninstaller (firing this hook), and a
; plain uninstall clears it too. Without this, users who had enabled autostart
; would keep auto-launching the app at login after upgrading.
;
; The value name matches what the old plugin wrote (auto-launch used
; PackageInfo.name == productName), so we key off ${PRODUCTNAME}. The HKCU Run
; path is the standard per-user startup location.

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
!macroend
