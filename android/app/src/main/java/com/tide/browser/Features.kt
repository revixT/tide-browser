package com.tide.browser

import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Calendar
import java.util.UUID

/**
 * Orbits, Trail, Snapshots, Focus and Reader for Android. Same rules and limits as desktop
 * src/features.js and src/reader.js. Data is JSON files in the app's private storage.
 */
class Features(private val a: MainActivity) {
    private val dir = a.filesDir
    private val main = Handler(Looper.getMainLooper())
    private fun uuid() = UUID.randomUUID().toString()
    /** A real website. Tide's own pages are https too, so they are excluded here. */
    private fun isWeb(u: String?) = u != null && (u.startsWith("http://") || u.startsWith("https://")) && !Urls.isInternal(u)

    private fun load(name: String): JSONArray = try { JSONArray(File(dir, name).readText()) } catch (_: Exception) { JSONArray() }
    private fun save(name: String, arr: JSONArray) {
        try { val f = File(dir, "$name.tmp"); f.writeText(arr.toString()); f.renameTo(File(dir, name)) } catch (_: Exception) {}
    }

    // =========================================================================================
    // Orbits: tabs you have not used for a while move to a searchable shelf.

    private var orbits = load("orbits.json")

    fun orbitsList() = orbits

    private fun archive(t: Tab): Boolean {
        val url = t.url
        if (!isWeb(url)) return false
        val o = JSONObject().put("id", uuid()).put("url", url).put("title", t.title.ifBlank { url })
            .put("summary", "").put("archivedAt", System.currentTimeMillis()).put("lastActive", t.lastActive)
        val next = JSONArray().put(o)
        for (i in 0 until minOf(orbits.length(), 499)) next.put(orbits.get(i))
        orbits = next
        save("orbits.json", orbits)
        a.closeTab(t)
        return true
    }

    private fun eligible(t: Tab) = t !== a.currentTab() && !t.private && !t.loading && isWeb(t.url)

    /** Moves idle tabs. [force] moves every tab you are not looking at. Calls [done] with the count. */
    fun sweepOrbits(force: Boolean, done: (Int) -> Unit = {}) {
        val mins = a.settings.orbitMinutes
        if (!force && mins <= 0) { done(0); return }
        val now = System.currentTimeMillis()
        val candidates = a.allTabs().filter { eligible(it) && (force || now - it.lastActive >= mins * 60_000L) }
        if (candidates.isEmpty()) { done(0); return }
        var pending = candidates.size
        var moved = 0
        for (t in candidates) {
            // A tab still playing sound or video stays where it is.
            val w = t.web
            val finish = { playing: Boolean ->
                if (!playing && t in a.allTabs() && a.allTabs().size > 1 && archive(t)) moved++
                if (--pending == 0) { if (moved > 0) a.toast("Moved $moved tab${if (moved > 1) "s" else ""} to Orbits"); done(moved) }
            }
            if (w == null) finish(false)
            else w.evaluateJavascript("[...document.querySelectorAll('video,audio')].some(m=>!m.paused&&!m.muted)") { r -> finish(r == "true") }
        }
    }

    fun orbitRestore(id: String): Boolean {
        for (i in 0 until orbits.length()) {
            val o = orbits.getJSONObject(i)
            if (o.optString("id") == id) {
                orbits.remove(i)
                save("orbits.json", orbits)
                a.newTab(o.getString("url"), false)
                return true
            }
        }
        return false
    }

    fun orbitRemove(id: String) {
        val keep = JSONArray()
        for (i in 0 until orbits.length()) orbits.getJSONObject(i).let { if (it.optString("id") != id) keep.put(it) }
        orbits = keep; save("orbits.json", orbits)
    }

    fun orbitClear() { orbits = JSONArray(); save("orbits.json", orbits) }

    // =========================================================================================
    // Trail: every page links to the one you came from.

    private var trail = load("trail.json")
    private val trailIndex = HashMap<String, JSONObject>().apply { for (i in 0 until trail.length()) trail.getJSONObject(i).let { put(it.getString("id"), it) } }
    private var trailDirty = false

    fun trailAdd(t: Tab, url: String) {
        if (t.private || !isWeb(url)) return
        val cur = t.trailNode?.let { trailIndex[it] }
        if (cur != null && cur.optString("url") == url) return // reload
        val node = JSONObject().put("id", uuid()).put("url", url).put("title", "").put("time", System.currentTimeMillis())
            .put("parent", cur?.getString("id") ?: t.openerNode ?: JSONObject.NULL)
        trail.put(node)
        trailIndex[node.getString("id")] = node
        t.trailNode = node.getString("id")
        if (trail.length() > 1500) {
            val next = JSONArray()
            for (i in 0 until trail.length()) {
                val n = trail.getJSONObject(i)
                if (i < 200) trailIndex.remove(n.getString("id")) else next.put(n)
            }
            trail = next
        }
        saveTrailSoon()
    }

    fun trailTitle(t: Tab) {
        val n = t.trailNode?.let { trailIndex[it] } ?: return
        if (t.title.isNotBlank() && n.optString("title") != t.title) { n.put("title", t.title.take(200)); saveTrailSoon() }
    }

    private fun saveTrailSoon() {
        if (trailDirty) return
        trailDirty = true
        main.postDelayed({ trailDirty = false; save("trail.json", trail) }, 1500)
    }

    fun trailGet() = trail
    fun trailClear() { trail = JSONArray(); trailIndex.clear(); save("trail.json", trail) }

    // =========================================================================================
    // Snapshots: open tabs saved every 30 minutes when something changed, and when you leave Tide.

    private var snaps = load("snapshots.json")
    private var lastSig = ""

    fun takeSnapshot(reason: String): JSONObject? {
        val items = JSONArray()
        val urls = StringBuilder()
        for (t in a.allTabs()) {
            if (t.private) continue
            val u = t.url.ifEmpty { t.pendingUrl ?: "" }
            if (!isWeb(u)) continue
            items.put(JSONObject().put("url", u).put("title", t.title))
            urls.append(u).append('\n')
        }
        if (items.length() == 0) return null
        val sig = urls.toString()
        if (reason != "manual" && sig == lastSig) return null
        lastSig = sig
        val s = JSONObject().put("id", uuid()).put("time", System.currentTimeMillis()).put("reason", reason).put("tabs", items)
        val next = JSONArray().put(s)
        for (i in 0 until minOf(snaps.length(), 39)) next.put(snaps.get(i))
        snaps = next
        save("snapshots.json", snaps)
        return s
    }

    fun snapshotsList() = snaps

    fun snapshotDelete(id: String) {
        val keep = JSONArray()
        for (i in 0 until snaps.length()) snaps.getJSONObject(i).let { if (it.optString("id") != id) keep.put(it) }
        snaps = keep; save("snapshots.json", snaps)
    }

    fun snapshotRestore(id: String, index: Int?): Int {
        val s = (0 until snaps.length()).map { snaps.getJSONObject(it) }.firstOrNull { it.optString("id") == id } ?: return 0
        val tabs = s.getJSONArray("tabs")
        val list = if (index != null) listOfNotNull(tabs.optJSONObject(index)) else (0 until tabs.length()).map { tabs.getJSONObject(it) }
        list.forEachIndexed { i, t -> a.newTab(t.getString("url"), false, switch = i == list.size - 1) }
        return list.size
    }

    // =========================================================================================
    // Focus: block distracting sites for a while or on a schedule.

    private val allowUntil = java.util.concurrent.ConcurrentHashMap<String, Long>()
    /** Read on WebView's network thread, so the parts the check needs are copied here. */
    @Volatile private var focusSites: List<String> = emptyList()
    @Volatile private var focusEndCache = 0L

    init { refreshFocusCache() }

    private fun hhmm(s: String): Int {
        val m = Regex("^(\\d{1,2}):(\\d{2})$").find(s) ?: return 0
        return m.groupValues[1].toInt().coerceIn(0, 23) * 60 + m.groupValues[2].toInt().coerceIn(0, 59)
    }

    private fun schedule(): JSONObject = try { JSONObject(a.settings.focusSchedule) } catch (_: Exception) { defaultSchedule() }
    private fun defaultSchedule() = JSONObject().put("enabled", false).put("days", JSONArray(listOf(1, 2, 3, 4, 5))).put("start", "09:00").put("end", "17:00")

    private fun scheduleEnd(): Long {
        val sc = schedule()
        if (!sc.optBoolean("enabled")) return 0
        val days = sc.optJSONArray("days") ?: return 0
        val c = Calendar.getInstance()
        val mins = c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE)
        val s = hhmm(sc.optString("start")); val e = hhmm(sc.optString("end"))
        val inside = if (s <= e) mins in s until e else mins >= s || mins < e
        val today = c.get(Calendar.DAY_OF_WEEK) - 1 // Sunday = 0, same as JavaScript
        if (!inside || (0 until days.length()).none { days.optInt(it) == today }) return 0
        val endMins = if (e <= mins) e + 1440 else e
        c.set(Calendar.HOUR_OF_DAY, 0); c.set(Calendar.MINUTE, 0); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0)
        return c.timeInMillis + endMins * 60_000L
    }

    private fun focusEnd(): Long {
        val now = System.currentTimeMillis()
        val ends = mutableListOf<Long>()
        if (a.settings.focusUntil > now) ends += a.settings.focusUntil
        val sched = scheduleEnd()
        if (sched > 0 && now >= a.settings.focusSnoozeUntil) ends += sched
        return ends.maxOrNull() ?: 0
    }

    fun refreshFocusCache() {
        focusSites = try { JSONArray(a.settings.focusSites).let { arr -> (0 until arr.length()).map { arr.getString(it) } } } catch (_: Exception) { emptyList() }
        focusEndCache = focusEnd()
    }

    fun focusActive(): Boolean = focusEndCache > System.currentTimeMillis()

    /** Minutes of focus left if this host should be blocked now, otherwise -1. Safe on any thread. */
    fun focusBlock(host: String?): Int {
        val h = host?.lowercase()?.removePrefix("www.") ?: return -1
        val end = focusEndCache
        val now = System.currentTimeMillis()
        if (end <= now || focusSites.none { h == it || h.endsWith(".$it") }) return -1
        if ((allowUntil[h] ?: 0) > now) return -1
        return maxOf(1, ((end - now) / 60_000).toInt())
    }

    fun allowFocus(host: String) { allowUntil[host.lowercase().removePrefix("www.")] = System.currentTimeMillis() + 10 * 60_000L }

    private fun status() = JSONObject().put("active", focusActive()).put("until", if (focusActive()) focusEndCache else 0)

    fun focusGet(): JSONObject {
        refreshFocusCache()
        return status().put("sites", JSONArray(focusSites)).put("schedule", schedule())
    }

    private fun cleanHost(v: String): String {
        val h = v.trim().lowercase().replace(Regex("^https?://"), "").removePrefix("www.").split('/', '?', '#', ':')[0]
        return if (Regex("^[a-z0-9.-]+\\.[a-z]{2,}$").matches(h)) h else ""
    }

    fun focusSet(patch: JSONObject): JSONObject {
        patch.optJSONArray("sites")?.let { arr ->
            val set = LinkedHashSet<String>()
            for (i in 0 until arr.length()) cleanHost(arr.optString(i)).takeIf { it.isNotEmpty() }?.let { set += it }
            a.settings.focusSites = JSONArray(set.take(100)).toString()
        }
        patch.optJSONObject("schedule")?.let { sc ->
            val days = JSONArray()
            sc.optJSONArray("days")?.let { d -> for (i in 0 until d.length()) d.optInt(i, -1).takeIf { it in 0..6 }?.let { days.put(it) } }
            val t = Regex("^\\d{1,2}:\\d{2}$")
            a.settings.focusSchedule = JSONObject().put("enabled", sc.optBoolean("enabled")).put("days", days)
                .put("start", sc.optString("start").takeIf { t.matches(it) } ?: "09:00")
                .put("end", sc.optString("end").takeIf { t.matches(it) } ?: "17:00").toString()
            a.settings.focusSnoozeUntil = 0
        }
        refreshFocusCache()
        return status()
    }

    fun focusStart(minutes: Int): JSONObject {
        val m = minutes.coerceIn(1, 600)
        a.settings.focusUntil = System.currentTimeMillis() + m * 60_000L
        refreshFocusCache()
        a.toast("Focus on for $m minutes")
        return status()
    }

    fun focusStop(): JSONObject {
        a.settings.focusUntil = 0
        val sched = scheduleEnd()
        if (sched > 0) a.settings.focusSnoozeUntil = sched // also ends today's scheduled session
        refreshFocusCache()
        return status()
    }

    // =========================================================================================
    // Reader: find the main article and draw it as plain blocks (never raw HTML).

    private val readerDocs = HashMap<Long, JSONObject>()

    fun openReader(t: Tab) {
        val w = t.web ?: return
        val source = t.url
        w.evaluateJavascript(EXTRACT_SRC) { raw ->
            val doc = try { JSONObject(raw) } catch (_: Exception) { null }
            if (doc == null || !doc.optBoolean("ok")) { a.toast("Tide couldn't find an article on this page"); return@evaluateJavascript }
            doc.put("sourceUrl", source)
            readerDocs[t.id] = doc
            t.load(Urls.page("reader"))
        }
    }

    fun readerDoc(t: Tab): JSONObject? = readerDocs[t.id]
    fun forget(t: Tab) { readerDocs.remove(t.id) }

    // Read aloud uses Android's text-to-speech, because WebView has no speech for pages.
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var ttsTab: Tab? = null
    private val ttsQueue = mutableListOf<() -> Unit>()

    private fun withTts(run: () -> Unit) {
        if (ttsReady) { run(); return }
        ttsQueue += run
        if (tts != null) return
        tts = TextToSpeech(a) { status ->
            main.post {
                if (status == TextToSpeech.SUCCESS) {
                    ttsReady = true
                    tts?.language = java.util.Locale.getDefault()
                    tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                        override fun onStart(id: String?) {}
                        override fun onDone(id: String?) { main.post { a.bridge.event(ttsTab, "speechDone", JSONObject().put("id", id)) } }
                        @Deprecated("Deprecated in Java")
                        override fun onError(id: String?) { main.post { a.bridge.event(ttsTab, "speechDone", JSONObject().put("id", id)) } }
                    })
                    ttsQueue.forEach { it() }
                } else a.toast("Text-to-speech isn't available on this phone")
                ttsQueue.clear()
            }
        }
    }

    fun speak(t: Tab, text: String, rate: Float, id: String) {
        ttsTab = t
        withTts {
            tts?.setSpeechRate(rate.coerceIn(0.5f, 2.5f))
            tts?.speak(text.take(TextToSpeech.getMaxSpeechInputLength() - 1), TextToSpeech.QUEUE_FLUSH, null, id)
        }
    }

    fun stopSpeech() { tts?.stop() }
    fun pauseAll() { tts?.stop() }
    fun shutdown() { tts?.shutdown(); tts = null; ttsReady = false }

    companion object {
        // Same extractor as desktop src/reader.js.
        const val EXTRACT_SRC = """(() => {
  const BAD = 'script,style,noscript,nav,aside,footer,header,form,iframe,svg,button,select,dialog,[role="navigation"],[role="banner"],[role="complementary"],[aria-hidden="true"],.ad,.ads,.advert,.advertisement,.cookie,.popup,.newsletter,.share,.social,.related,.comments,.sidebar,.menu';
  const inBad = (el) => !!el.closest(BAD);
  const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const score = new Map();
  for (const p of document.querySelectorAll('p')) {
    if (inBad(p)) continue;
    const t = text(p);
    if (t.length < 25) continue;
    let node = p.parentElement;
    let weight = 1;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      score.set(node, (score.get(node) || 0) + t.length * weight);
      weight *= 0.5;
    }
  }
  let best = null;
  let bestScore = 0;
  for (const [el, s] of score) {
    const links = [...el.querySelectorAll('a')].reduce((n, a) => n + text(a).length, 0);
    const total = text(el).length || 1;
    const adjusted = s * (1 - Math.min(0.9, links / total));
    const boost = el.matches('article, main, [role="main"], [itemprop="articleBody"]') ? 1.3 : 1;
    if (adjusted * boost > bestScore) { bestScore = adjusted * boost; best = el; }
  }
  if (!best || bestScore < 300) return { ok: false };
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
  const blocks = [];
  let last = '';
  for (const el of best.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,pre,img')) {
    if (inBad(el)) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') {
      const src = abs(el.currentSrc || el.src || '');
      const w = el.naturalWidth || el.width || 0;
      if (/^https?:/.test(src) && w >= 200) blocks.push({ t: 'img', src, alt: (el.alt || '').slice(0, 200) });
      continue;
    }
    if (tag === 'p' && el.closest('blockquote')) continue;
    if (tag === 'li' && el.querySelector('p')) continue;
    const t = text(el);
    if (t.length < 2 || t === last) continue;
    last = t;
    const type = tag === 'h1' || tag === 'h2' ? 'h2' : tag === 'h3' || tag === 'h4' ? 'h3' : tag === 'blockquote' ? 'quote' : tag;
    blocks.push({ t: type, text: t.slice(0, 4000) });
    if (blocks.length >= 500) break;
  }
  if (blocks.filter((b) => b.t === 'p').length < 2) return { ok: false };
  const meta = (n) => (document.querySelector('meta[name="' + n + '"], meta[property="' + n + '"]') || {}).content || '';
  const h1 = document.querySelector('h1');
  return {
    ok: true,
    title: (meta('og:title') || (h1 ? text(h1) : '') || document.title || '').slice(0, 300),
    byline: (meta('author') || meta('article:author') || '').slice(0, 200),
    site: location.hostname.replace(/^www\./, ''),
    blocks,
  };
})()"""
    }
}
