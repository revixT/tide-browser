package com.tide.browser

import android.app.DownloadManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * Commands from Tide's own pages (assets/pages/bridge.js). Messages are JSON {id, cmd, args}
 * and every reply is {id, result} or {id, error}. Only pages on Tide's internal origin can send them.
 */
class PageBridge(private val a: MainActivity) {
    private var introSeen = false
    /** The last reply channel for each tab, so the app can also push events (such as speech progress) to the page. */
    private val proxies = HashMap<Long, JavaScriptReplyProxy>()

    fun event(tab: Tab?, name: String, data: JSONObject) {
        val p = proxies[tab?.id ?: return] ?: return
        try { p.postMessage(JSONObject().put("event", name).put("data", data).toString()) } catch (_: Exception) {}
    }

    fun forget(tab: Tab) { proxies.remove(tab.id) }

    fun handle(tab: Tab, data: String?, reply: JavaScriptReplyProxy) {
        proxies[tab.id] = reply
        val msg = try { JSONObject(data ?: return) } catch (_: Exception) { return }
        val id = msg.optInt("id")
        val args = msg.optJSONObject("args") ?: JSONObject()
        val out = JSONObject().put("id", id)
        try {
            out.put("result", run(tab, msg.optString("cmd"), args) ?: JSONObject.NULL)
        } catch (e: Exception) {
            out.put("error", e.message ?: "error")
        }
        try { reply.postMessage(out.toString()) } catch (_: Exception) { /* page went away */ }
    }

    private fun run(tab: Tab, cmd: String, a1: JSONObject): Any? = when (cmd) {
        "introSeen" -> JSONObject().put("seen", introSeen.also { introSeen = true }).put("reduce", a.settings.reduceMotion)
        "navigate" -> { a.navigate(tab, a1.optString("q")); true }
        "openTab" -> { a.newTab(Urls.fromInput(a1.optString("q"), a.settings.search), tab.private); true }
        "isPrivate" -> if (tab.panel) a.currentTab()?.private ?: false else tab.private
        "closePanel" -> { a.closePanel(); true }

        "getShortcuts" -> a.settings.shortcuts?.let { JSONArray(it) }
        "getSettings" -> a.settings.toJson()
        "setSettings" -> { a.onSettingsChanged(a.settings.update(a1)); a.settings.toJson() }

        "getHistory" -> a.db.history()
        "removeHistory" -> { a.db.removeHistory(a1.getString("url"), a1.getLong("time")); true }
        "clearHistory" -> { a.db.clearHistory(); true }

        "getBookmarks" -> a.db.bookmarks()
        "removeBookmark" -> { a.db.removeBookmark(a1.getString("url")); true }
        "renameBookmark" -> { a.db.renameBookmark(a1.getString("url"), a1.getString("title").take(200)); true }

        "getDownloads" -> a.downloads.list()
        "openDownload" -> { a.downloads.open(a1.getLong("id")); true }
        "removeDownload" -> { a.downloads.forget(a1.getLong("id")); true }
        "cancelDownload" -> { a.downloads.cancel(a1.getLong("id")); true }
        "showDownloadsFolder" -> { a.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true }

        "clearData" -> { a.clearData(a1.optBoolean("history"), a1.optBoolean("cookies"), a1.optBoolean("cache")); true }
        "openDefaultApps" -> { a.askDefaultBrowser(); true }
        "openUrl" -> { a.newTab(a1.getString("url"), false); true }
        "allowSite" -> {
            val kind = a1.optString("kind")
            val host = Urls.host(a1.optString("url"))
            if (host.isNotEmpty()) when (kind) {
                "cert" -> a.allowedCert += host
                "focus" -> a.features.allowFocus(host)
                else -> a.allowedDangerous += host
            }
            true
        }

        // Orbits, Trail, Snapshots, Focus, Reader (same names as desktop)
        "orbitsList" -> a.features.orbitsList()
        "orbitSweep" -> { a.features.sweepOrbits(true) { n -> event(tab, "orbitSwept", JSONObject().put("n", n)) }; true }
        "orbitRestore" -> a.features.orbitRestore(a1.getString("id"))
        "orbitRemove" -> { a.features.orbitRemove(a1.getString("id")); true }
        "orbitClear" -> { a.features.orbitClear(); true }
        "trailGet" -> a.features.trailGet()
        "trailClear" -> { a.features.trailClear(); true }
        "snapshotsList" -> a.features.snapshotsList()
        "snapshotSave" -> { val s = a.features.takeSnapshot("manual"); if (s != null) a.toast("Snapshot saved") else a.toast("No web pages open to save"); s != null }
        "snapshotDelete" -> { a.features.snapshotDelete(a1.getString("id")); true }
        "snapshotRestore" -> a.features.snapshotRestore(a1.getString("id"), if (a1.has("index") && !a1.isNull("index")) a1.getInt("index") else null)
        "focusGet" -> a.features.focusGet()
        "focusSet" -> a.features.focusSet(a1)
        "focusStart" -> a.features.focusStart(a1.optInt("minutes", 25))
        "focusStop" -> a.features.focusStop()
        "readerDoc" -> a.features.readerDoc(tab)
        "speak" -> { a.features.speak(tab, a1.getString("text"), a1.optDouble("rate", 1.0).toFloat(), a1.getString("id")); true }
        "speechStop" -> { a.features.stopSpeech(); true }
        "info" -> {
            val wv = WebViewCompat.getCurrentWebViewPackage(a)
            JSONObject()
                .put("version", a.packageManager.getPackageInfo(a.packageName, 0).versionName)
                .put("webview", wv?.versionName ?: "unknown")
                .put("android", Build.VERSION.RELEASE)
                .put("isDefault", a.isDefaultBrowser())
                .put("canSetTheme", Build.VERSION.SDK_INT >= 31)
                .put("privateTabs", MainActivity.privateSupported())
                .put("malwareHosts", a.safe.hosts.size)
                .put("malwareUpdated", a.settings.malwareUpdated)
                .put("blockList", Privacy.blockedCount)
                .put("engines", JSONArray().apply { Urls.ENGINES.forEach { put(JSONObject().put("id", it.id).put("name", it.name)) } })
        }
        else -> throw IllegalArgumentException("unknown command $cmd")
    }
}
