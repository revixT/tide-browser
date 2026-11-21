package com.tide.browser

import android.net.Uri
import android.util.Patterns

/** Address handling: what the user typed becomes a URL or a search, and Tide's own pages get short names. */
object Urls {
    const val HOST = "appassets.androidplatform.net"
    const val ORIGIN = "https://$HOST"
    private const val BASE = "$ORIGIN/assets/pages/"
    val PAGES = setOf("newtab", "history", "bookmarks", "downloads", "settings", "warning", "orbits", "trail", "snapshots", "focus", "reader")

    val NEWTAB = page("newtab")

    /** Tide pages that open in the panel over the browser instead of in a tab. */
    val PANEL_PAGES = setOf("history", "bookmarks", "downloads", "settings", "orbits", "trail", "snapshots", "focus")
    fun isPanelPage(url: String?): Boolean = pageName(url) in PANEL_PAGES
    val TITLES = mapOf("history" to "History", "bookmarks" to "Bookmarks", "downloads" to "Downloads", "settings" to "Settings",
        "orbits" to "Orbits", "trail" to "Trail", "snapshots" to "Snapshots", "focus" to "Focus")

    fun page(name: String, query: String = ""): String = "$BASE$name.html$query"

    fun isInternal(url: String?): Boolean = url != null && url.startsWith("$ORIGIN/")

    /** The internal page name for a URL, such as "settings", or null for a website. */
    fun pageName(url: String?): String? {
        if (!isInternal(url)) return null
        val path = Uri.parse(url).path ?: return null
        return path.substringAfterLast('/').removeSuffix(".html").takeIf { it in PAGES }
    }

    fun isNewTab(url: String?): Boolean = pageName(url) == "newtab"

    /** What the address bar shows. The new tab page shows nothing so the placeholder appears. */
    fun display(url: String?): String {
        if (url.isNullOrEmpty()) return ""
        val name = pageName(url)
        if (name != null) return if (name == "newtab") "" else "tide://$name"
        return url
    }

    /** Short form for the address pill: just the host, without "www.". */
    fun shortHost(url: String?): String {
        if (url.isNullOrEmpty()) return ""
        pageName(url)?.let { return if (it == "newtab") "" else "tide://$it" }
        val host = Uri.parse(url).host ?: return url
        return host.removePrefix("www.")
    }

    fun host(url: String?): String = try { Uri.parse(url ?: "").host?.lowercase() ?: "" } catch (_: Exception) { "" }

    data class Engine(val id: String, val name: String, val url: String)

    val ENGINES = listOf(
        Engine("google", "Google", "https://www.google.com/search?q="),
        Engine("duckduckgo", "DuckDuckGo", "https://duckduckgo.com/?q="),
        Engine("bing", "Bing", "https://www.bing.com/search?q="),
        Engine("brave", "Brave Search", "https://search.brave.com/search?q="),
        Engine("startpage", "Startpage", "https://www.startpage.com/do/search?q="),
        Engine("ecosia", "Ecosia", "https://www.ecosia.org/search?q="),
    )

    fun engine(id: String): Engine = ENGINES.firstOrNull { it.id == id } ?: ENGINES[0]

    fun searchUrl(q: String, engineId: String): String = engine(engineId).url + Uri.encode(q)

    /** Does this text look like an address rather than a search? */
    fun looksLikeUrl(input: String): Boolean {
        val t = input.trim()
        if (t.isEmpty() || t.contains(' ')) return false
        if (Regex("^(https?|tide|browser|about|data|file)://", RegexOption.IGNORE_CASE).containsMatchIn(t)) return true
        if (t.startsWith("about:") || t.startsWith("data:")) return true
        val host = t.substringBefore('/').substringBefore('?').substringBefore('#')
        val bare = host.substringBefore(':')
        if (bare.equals("localhost", true)) return true
        if (Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(bare)) return true
        if (!bare.contains('.')) return false
        val tld = bare.substringAfterLast('.')
        return tld.length >= 2 && tld.all { it.isLetter() } && Patterns.DOMAIN_NAME.matcher(bare).matches()
    }

    /** Turn typed text into something to load. */
    fun fromInput(input: String, engineId: String): String {
        val t = input.trim()
        val internal = Regex("^(tide|browser)://([a-z]+)(.*)$", RegexOption.IGNORE_CASE).find(t)
        if (internal != null) {
            val name = internal.groupValues[2].lowercase()
            return if (name in PAGES) page(name, internal.groupValues[3].let { if (it.startsWith("#")) it else "" }) else NEWTAB
        }
        if (!looksLikeUrl(t)) return searchUrl(t, engineId)
        if (Regex("^[a-z][a-z0-9+.-]*:", RegexOption.IGNORE_CASE).containsMatchIn(t) && !Regex("^[^/:]+:\\d+", RegexOption.IGNORE_CASE).containsMatchIn(t)) {
            // Has a scheme. Only web addresses load directly; file:// stays blocked.
            return if (t.startsWith("http://", true) || t.startsWith("https://", true) || t.startsWith("about:") || t.startsWith("data:")) t
            else searchUrl(t, engineId)
        }
        val bare = t.substringBefore('/').substringBefore(':')
        val local = bare.equals("localhost", true) || Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(bare)
        return (if (local) "http://" else "https://") + t
    }

    /** First web link in a block of shared text, if any. */
    fun firstLink(text: String): String? {
        val m = Patterns.WEB_URL.matcher(text)
        while (m.find()) {
            val u = m.group()
            if (u.startsWith("http://", true) || u.startsWith("https://", true)) return u
        }
        return null
    }
}
