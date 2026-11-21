package com.tide.browser

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Environment
import org.json.JSONArray
import org.json.JSONObject

/** Downloads go through Android's DownloadManager into the phone's Downloads folder. */
class Downloads(private val a: MainActivity) {
    private val dm = a.getSystemService(DownloadManager::class.java)

    private fun saved(): JSONArray = try { JSONArray(a.settings.downloads) } catch (_: Exception) { JSONArray() }

    fun start(url: String, name: String, mime: String?, ua: String, cookie: String?) {
        val req = DownloadManager.Request(Uri.parse(url))
            .setTitle(name)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            .addRequestHeader("User-Agent", ua)
        if (!mime.isNullOrBlank()) req.setMimeType(mime)
        if (!cookie.isNullOrBlank()) req.addRequestHeader("Cookie", cookie)
        val id = dm.enqueue(req)
        val list = saved()
        list.put(JSONObject().put("id", id).put("name", name).put("url", url).put("time", System.currentTimeMillis()).put("risky", isRisky(name)))
        // keep the newest 200
        val trimmed = JSONArray()
        for (i in maxOf(0, list.length() - 200) until list.length()) trimmed.put(list.get(i))
        a.settings.downloads = trimmed.toString()
        a.toast("Downloading $name")
    }

    /** Saved entries joined with live status from DownloadManager, newest first. */
    fun list(): JSONArray {
        val items = saved()
        val byId = HashMap<Long, JSONObject>()
        for (i in 0 until items.length()) items.optJSONObject(i)?.let { byId[it.optLong("id")] = it }
        if (byId.isNotEmpty()) {
            dm.query(DownloadManager.Query().setFilterById(*byId.keys.toLongArray()))?.use { c ->
                val iId = c.getColumnIndexOrThrow(DownloadManager.COLUMN_ID)
                val iStatus = c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)
                val iDone = c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)
                val iTotal = c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)
                val iReason = c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)
                while (c.moveToNext()) {
                    val o = byId[c.getLong(iId)] ?: continue
                    o.put("state", when (c.getInt(iStatus)) {
                        DownloadManager.STATUS_SUCCESSFUL -> "done"
                        DownloadManager.STATUS_FAILED -> "failed"
                        DownloadManager.STATUS_PAUSED -> "paused"
                        else -> "running"
                    })
                    o.put("received", c.getLong(iDone)).put("total", c.getLong(iTotal)).put("reason", c.getInt(iReason))
                }
            }
        }
        val out = JSONArray()
        for (i in items.length() - 1 downTo 0) {
            val o = items.optJSONObject(i) ?: continue
            if (!o.has("state")) o.put("state", "gone") // the file or its record was removed outside Tide
            out.put(o)
        }
        return out
    }

    fun open(id: Long) {
        val uri = dm.getUriForDownloadedFile(id) ?: run { a.toast("This file is no longer in Downloads"); return }
        val mime = dm.getMimeTypeForDownloadedFile(id) ?: "*/*"
        try {
            a.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            a.toast("No app on this phone can open this file")
        }
    }

    /** Remove from Tide's list only. The file stays in Downloads. */
    fun forget(id: Long) {
        val items = saved()
        val keep = JSONArray()
        for (i in 0 until items.length()) items.optJSONObject(i)?.let { if (it.optLong("id") != id) keep.put(it) }
        a.settings.downloads = keep.toString()
    }

    fun cancel(id: Long) { dm.remove(id); forget(id) }

    companion object {
        private val RISKY = setOf("apk", "apks", "xapk", "aab", "exe", "msi", "bat", "cmd", "scr", "js", "vbs", "jar", "dex", "sh", "ps1", "dmg", "pkg", "app")
        fun isRisky(name: String) = name.substringAfterLast('.', "").lowercase() in RISKY
    }
}
