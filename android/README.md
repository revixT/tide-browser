# Tide for Android

A native Android app (Kotlin) built on Android System WebView, which is Chromium. Electron does not run on Android, so the browser code here is new. Tide's own pages (home, history, bookmarks, downloads, settings, warning) are the desktop pages adapted for phones and live in `app/src/main/assets/pages/`.

## Build

You need Android Studio, or its bundled Java plus the Android SDK. From this folder:

```
gradlew assembleDebug      # app/build/outputs/apk/debug/app-debug.apk (package com.tide.browser.debug)
gradlew assembleRelease    # unsigned until keystore.properties exists
```

To sign a release, create `keystore.properties` here (git ignores it) with `storeFile`, `storePassword`, `keyAlias` and `keyPassword`. Keep the keystore safe: Play Store updates must be signed with the same key.

## How it fits together

- `MainActivity.kt`: bottom address bar, address editor with local suggestions, tab grid, menus (bottom sheets), find in page, permissions, downloads prompt, fullscreen video, opening other apps, default browser request, theme.
- `Tab.kt`: one WebView per tab. Ad and tracker blocking, tracking-parameter stripping, HTTPS-only, dangerous-site and certificate warnings, pop-up blocking, long-press link menu. Private tabs use a separate WebView profile that is wiped when the last private tab closes.
- `PageBridge.kt` and `assets/pages/bridge.js`: the `tidePage` API for Tide's own pages. The app injects it only into pages on Tide's internal origin (`appassets.androidplatform.net`), never into websites, and websites cannot open those pages.
- `Store.kt`: settings (SharedPreferences), history and bookmarks (SQLite). Private tabs never write history.
- `Privacy.kt`: the same block list and tracking parameters as desktop `src/privacy.js`, and the same URLhaus malware list as `src/safebrowsing.js`.
- `Features.kt`: Orbits, Trail, Snapshots, Focus and Reader, with the same rules and limits as desktop `src/features.js` and `src/reader.js`. Data is JSON files in the app's private storage. Reader's read-aloud uses Android text-to-speech, because WebView has no speech for pages. The app pushes "sentence finished" events back to the page through the bridge.
- `assets/theme.css` is a copy of desktop `src/theme.css`. Change both together.

## Not in the Android version yet

Password vault, Recall, Constellations, Peek, command bar, import from other browsers, blob and data downloads, GPC and Do Not Track headers, per-site permission memory beyond one session, auto-update (Android updates come from wherever it is installed from).
