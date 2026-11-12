; Extra install steps for Tide Browser (per-user install, so everything goes under HKCU).
; This registers Tide with Windows as a web browser, so it appears in Settings > Default apps
; and can be chosen for http, https and .html files. It does not take over your defaults by itself.

!macro customInstall
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TideBrowser" "" "Tide Browser"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TideBrowser\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TideBrowser\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'

  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TideBrowser\Capabilities" "ApplicationName" "Tide Browser"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TideBrowser\Capabilities" "ApplicationDescription" "A fast, private browser built on Chromium."
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TideBrowser\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TideBrowser\Capabilities\URLAssociations" "http" "TideBrowserURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TideBrowser\Capabilities\URLAssociations" "https" "TideBrowserURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TideBrowser\Capabilities\FileAssociations" ".htm" "TideBrowserHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TideBrowser\Capabilities\FileAssociations" ".html" "TideBrowserHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TideBrowser\Capabilities\FileAssociations" ".xhtml" "TideBrowserHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TideBrowser\Capabilities\FileAssociations" ".xht" "TideBrowserHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TideBrowser\Capabilities\MIMEAssociations" "text/html" "TideBrowserHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TideBrowser\Capabilities\MIMEAssociations" "application/xhtml+xml" "TideBrowserHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TideBrowser\Capabilities\URLAssociations" "ftp" "TideBrowserURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TideBrowser\Capabilities\StartMenu" "StartMenuInternet" "TideBrowser"
  WriteRegDWORD HKCU "Software\Clients\StartMenuInternet\TideBrowser\InstallInfo" "IconsVisible" 1
  WriteRegStr HKCU "Software\Classes\TideBrowserURL\Application" "AppUserModelId" "com.tide.browser"
  WriteRegStr HKCU "Software\Classes\TideBrowserURL\Application" "ApplicationName" "Tide Browser"
  WriteRegStr HKCU "Software\Classes\TideBrowserURL\Application" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\TideBrowserURL\Application" "ApplicationDescription" "A fast, private browser built on Chromium."
  WriteRegStr HKCU "Software\Classes\TideBrowserURL\Application" "ApplicationCompany" "Tide Browser"
  WriteRegStr HKCU "Software\Classes\TideBrowserHTML\Application" "AppUserModelId" "com.tide.browser"
  WriteRegStr HKCU "Software\Classes\TideBrowserHTML\Application" "ApplicationName" "Tide Browser"
  WriteRegStr HKCU "Software\Classes\TideBrowserHTML\Application" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\TideBrowserHTML\Application" "ApplicationDescription" "A fast, private browser built on Chromium."
  WriteRegStr HKCU "Software\Classes\TideBrowserHTML\Application" "ApplicationCompany" "Tide Browser"
  WriteRegStr HKCU "Software\RegisteredApplications" "TideBrowser" "Software\Clients\StartMenuInternet\TideBrowser\Capabilities"

  WriteRegStr HKCU "Software\Classes\TideBrowserURL" "" "Tide Browser URL"
  WriteRegStr HKCU "Software\Classes\TideBrowserURL" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\TideBrowserURL\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\TideBrowserURL\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr HKCU "Software\Classes\TideBrowserHTML" "" "Tide Browser HTML Document"
  WriteRegStr HKCU "Software\Classes\TideBrowserHTML\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\TideBrowserHTML\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\RegisteredApplications" "TideBrowser"
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\TideBrowser"
  DeleteRegKey HKCU "Software\Classes\TideBrowserURL"
  DeleteRegKey HKCU "Software\Classes\TideBrowserHTML"
!macroend
