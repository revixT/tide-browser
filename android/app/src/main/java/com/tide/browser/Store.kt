package com.tide.browser

import android.content.ContentValues
import android.content.Context
import android.content.SharedPreferences
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject

/** Settings live in SharedPreferences. Keys and defaults match the desktop settings where they overlap. */
class Settings(c: Context) {
    private val p: SharedPreferences = c.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var theme: String get() = p.getString("theme", "system")!!; set(v) = p.edit().putString("theme", v).apply()
    var search: String get() = p.getString("search", "google")!!; set(v) = p.edit().putString("search", v).apply()
    var blockAds: Boolean get() = p.getBoolean("blockAds", true); set(v) = p.edit().putBoolean("blockAds", v).apply()
    var stripTracking: Boolean get() = p.getBoolean("stripTracking", true); set(v) = p.edit().putBoolean("stripTracking", v).apply()
    var httpsOnly: Boolean get() = p.getBoolean("httpsOnly", false); set(v) = p.edit().putBoolean("httpsOnly", v).apply()
    var blockThirdPartyCookies: Boolean get() = p.getBoolean("blockThirdPartyCookies", true); set(v) = p.edit().putBoolean("blockThirdPartyCookies", v).apply()
    var malwareWarnings: Boolean get() = p.getBoolean("malwareWarnings", true); set(v) = p.edit().putBoolean("malwareWarnings", v).apply()
    var googleSafeBrowsing: Boolean get() = p.getBoolean("googleSafeBrowsing", true); set(v) = p.edit().putBoolean("googleSafeBrowsing", v).apply()
    var restoreTabs: Boolean get() = p.getBoolean("restoreTabs", true); set(v) = p.edit().putBoolean("restoreTabs", v).apply()
    var reduceMotion: Boolean get() = p.getBoolean("reduceMotion", false); set(v) = p.edit().putBoolean("reduceMotion", v).apply()

    /** Home page shortcut tiles as a JSON array of {title, url}. Null means the defaults. */
    var shortcuts: String? get() = p.getString("shortcuts", null); set(v) = p.edit().putString("shortcuts", v).apply()

    /** Sites where ad and tracker blocking is turned off. */
    var siteAllow: Set<String>
        get() = p.getStringSet("siteAllow", emptySet())!!.toSet()
        set(v) = p.edit().putStringSet("siteAllow", v).apply()

    /** Open tabs from last time: {current, tabs: [{url, title}]}. */
    var session: String? get() = p.getString("session", null); set(v) = p.edit().putString("session", v).apply()

    /** Downloads Tide started: JSON array of {id, name, url, time}. */
    var downloads: String get() = p.getString("downloads", "[]")!!; set(v) = p.edit().putString("downloads", v).apply()

    var malwareUpdated: Long get() = p.getLong("malwareUpdated", 0); set(v) = p.edit().putLong("malwareUpdated", v).apply()

    /** Move tabs you have not used for this many minutes into Orbits. 0 = never. Same choices as desktop. */
    var orbitMinutes: Int get() = p.getInt("orbitMinutes", 480); set(v) = p.edit().putInt("orbitMinutes", v).apply()
    var snapshotsAuto: Boolean get() = p.getBoolean("snapshotsAuto", true); set(v) = p.edit().putBoolean("snapshotsAuto", v).apply()
    var focusSites: String get() = p.getString("focusSites", "[]")!!; set(v) = p.edit().putString("focusSites", v).apply()
    var focusSchedule: String get() = p.getString("focusSchedule", "")!!; set(v) = p.edit().putString("focusSchedule", v).apply()
    var focusUntil: Long get() = p.getLong("focusUntil", 0); set(v) = p.edit().putLong("focusUntil", v).apply()
    var focusSnoozeUntil: Long get() = p.getLong("focusSnoozeUntil", 0); set(v) = p.edit().putLong("focusSnoozeUntil", v).apply()

    fun toJson(): JSONObject = JSONObject().apply {
        put("theme", theme); put("search", search); put("blockAds", blockAds); put("stripTracking", stripTracking)
        put("httpsOnly", httpsOnly); put("blockThirdPartyCookies", blockThirdPartyCookies); put("malwareWarnings", malwareWarnings)
        put("googleSafeBrowsing", googleSafeBrowsing); put("restoreTabs", restoreTabs); put("reduceMotion", reduceMotion)
        put("orbitMinutes", orbitMinutes); put("snapshotsAuto", snapshotsAuto)
    }

    /** Apply a partial update from the settings page. Unknown keys are ignored. Returns the keys that changed. */
    fun update(o: JSONObject): Set<String> {
        val changed = mutableSetOf<String>()
        for (k in o.keys()) {
            when (k) {
                "theme" -> o.getString(k).takeIf { it in setOf("system", "dark", "light") }?.let { theme = it; changed += k }
                "search" -> o.getString(k).takeIf { id -> Urls.ENGINES.any { it.id == id } }?.let { search = it; changed += k }
                "blockAds" -> { blockAds = o.getBoolean(k); changed += k }
                "stripTracking" -> { stripTracking = o.getBoolean(k); changed += k }
                "httpsOnly" -> { httpsOnly = o.getBoolean(k); changed += k }
                "blockThirdPartyCookies" -> { blockThirdPartyCookies = o.getBoolean(k); changed += k }
                "malwareWarnings" -> { malwareWarnings = o.getBoolean(k); changed += k }
                "googleSafeBrowsing" -> { googleSafeBrowsing = o.getBoolean(k); changed += k }
                "restoreTabs" -> { restoreTabs = o.getBoolean(k); changed += k }
                "reduceMotion" -> { reduceMotion = o.getBoolean(k); changed += k }
                "orbitMinutes" -> o.getInt(k).takeIf { it in setOf(0, 60, 240, 480, 1440, 4320) }?.let { orbitMinutes = it; changed += k }
                "snapshotsAuto" -> { snapshotsAuto = o.getBoolean(k); changed += k }
                "shortcuts" -> {
                    val arr = o.getJSONArray(k)
                    val clean = JSONArray()
                    for (i in 0 until minOf(arr.length(), 12)) {
                        val s = arr.optJSONObject(i) ?: continue
                        val url = s.optString("url")
                        if (!url.startsWith("http://") && !url.startsWith("https://")) continue
                        clean.put(JSONObject().put("title", s.optString("title").take(80)).put("url", url.take(2000)))
                    }
                    shortcuts = clean.toString(); changed += k
                }
            }
        }
        return changed
    }
}

/** History and bookmarks in SQLite. Private tabs never write here. */
class Db(c: Context) : SQLiteOpenHelper(c, "tide.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, title TEXT, time INTEGER NOT NULL)")
        db.execSQL("CREATE INDEX history_time ON history(time)")
        db.execSQL("CREATE INDEX history_url ON history(url)")
        db.execSQL("CREATE TABLE bookmarks (url TEXT PRIMARY KEY, title TEXT, time INTEGER NOT NULL)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    fun addVisit(url: String, title: String) {
        val db = writableDatabase
        val now = System.currentTimeMillis()
        // A reload or quick return to the same page updates the last entry instead of adding another.
        db.rawQuery("SELECT id, time FROM history WHERE url = ? ORDER BY time DESC LIMIT 1", arrayOf(url)).use { c ->
            if (c.moveToFirst() && now - c.getLong(1) < 30 * 60_000) {
                db.update("history", ContentValues().apply { put("time", now); if (title.isNotBlank()) put("title", title) }, "id = ?", arrayOf(c.getLong(0).toString()))
                return
            }
        }
        db.insert("history", null, ContentValues().apply { put("url", url); put("title", title); put("time", now) })
        if (now % 50 == 0L) db.execSQL("DELETE FROM history WHERE id IN (SELECT id FROM history ORDER BY time DESC LIMIT -1 OFFSET 20000)")
    }

    fun updateTitle(url: String, title: String) {
        if (title.isBlank()) return
        writableDatabase.execSQL("UPDATE history SET title = ? WHERE id = (SELECT id FROM history WHERE url = ? ORDER BY time DESC LIMIT 1)", arrayOf(title, url))
    }

    fun history(limit: Int = 2000): JSONArray {
        val out = JSONArray()
        readableDatabase.rawQuery("SELECT url, title, time FROM history ORDER BY time DESC LIMIT ?", arrayOf(limit.toString())).use { c ->
            while (c.moveToNext()) out.put(JSONObject().put("url", c.getString(0)).put("title", c.getString(1) ?: "").put("time", c.getLong(2)))
        }
        return out
    }

    fun removeHistory(url: String, time: Long) { writableDatabase.delete("history", "url = ? AND time = ?", arrayOf(url, time.toString())) }
    fun clearHistory() { writableDatabase.delete("history", null, null) }

    fun bookmarks(): JSONArray {
        val out = JSONArray()
        readableDatabase.rawQuery("SELECT url, title, time FROM bookmarks ORDER BY time DESC", null).use { c ->
            while (c.moveToNext()) out.put(JSONObject().put("url", c.getString(0)).put("title", c.getString(1) ?: "").put("time", c.getLong(2)))
        }
        return out
    }

    fun isBookmarked(url: String): Boolean =
        readableDatabase.rawQuery("SELECT 1 FROM bookmarks WHERE url = ?", arrayOf(url)).use { it.moveToFirst() }

    fun addBookmark(url: String, title: String) {
        writableDatabase.insertWithOnConflict("bookmarks", null, ContentValues().apply {
            put("url", url); put("title", title.ifBlank { url }); put("time", System.currentTimeMillis())
        }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun removeBookmark(url: String) { writableDatabase.delete("bookmarks", "url = ?", arrayOf(url)) }

    fun renameBookmark(url: String, title: String) {
        writableDatabase.update("bookmarks", ContentValues().apply { put("title", title) }, "url = ?", arrayOf(url))
    }

    data class Suggestion(val url: String, val title: String, val bookmark: Boolean)

    /** Address bar suggestions from bookmarks and history only. Nothing typed leaves the phone. */
    fun suggest(q: String, limit: Int = 8): List<Suggestion> {
        val t = q.trim().lowercase()
        if (t.isEmpty()) return emptyList()
        val like = "%" + t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        val seen = LinkedHashMap<String, Suggestion>()
        readableDatabase.rawQuery(
            "SELECT url, title FROM bookmarks WHERE lower(url) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\' ORDER BY time DESC LIMIT ?",
            arrayOf(like, like, limit.toString())
        ).use { c -> while (c.moveToNext()) seen[c.getString(0)] = Suggestion(c.getString(0), c.getString(1) ?: "", true) }
        readableDatabase.rawQuery(
            "SELECT url, title, COUNT(*) AS n, MAX(time) AS last FROM history WHERE lower(url) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\' " +
                "GROUP BY url ORDER BY (lower(url) LIKE ? OR lower(url) LIKE ?) DESC, n DESC, last DESC LIMIT ?",
            arrayOf(like, like, "%://$t%", "%://www.$t%", (limit * 2).toString())
        ).use { c ->
            while (c.moveToNext() && seen.size < limit) {
                val u = c.getString(0)
                if (!seen.containsKey(u)) seen[u] = Suggestion(u, c.getString(1) ?: "", false)
            }
        }
        return seen.values.take(limit)
    }
}
