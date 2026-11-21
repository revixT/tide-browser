package com.tide.browser

import android.content.Context
import android.net.Uri
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/** Ad and tracker blocking and tracking-parameter stripping. Same lists as desktop src/privacy.js. */
object Privacy {
    private val BLOCKED = hashSetOf(
        // advertising
        "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com", "googletagservices.com",
        "adnxs.com", "adsrvr.org", "advertising.com", "taboola.com", "outbrain.com", "criteo.com", "criteo.net",
        "pubmatic.com", "rubiconproject.com", "openx.net", "casalemedia.com", "33across.com", "smartadserver.com",
        "yieldmo.com", "mathtag.com", "adform.net", "bidswitch.net", "sharethrough.com", "lijit.com", "indexww.com",
        "amazon-adsystem.com", "moatads.com", "adsafeprotected.com", "serving-sys.com", "contextweb.com", "media.net",
        "revcontent.com", "mgid.com", "zedo.com", "teads.tv", "tapad.com", "ads-twitter.com", "ads.linkedin.com",
        // analytics and tracking
        "google-analytics.com", "googletagmanager.com", "scorecardresearch.com", "quantserve.com", "hotjar.com",
        "mixpanel.com", "fullstory.com", "crazyegg.com", "mouseflow.com", "segment.io", "amplitude.com",
        "bluekai.com", "krxd.net", "demdex.net", "everesttech.net", "omtrdc.net", "chartbeat.net", "newrelic.com",
        "branch.io", "adjust.com", "appsflyer.com", "analytics.twitter.com", "px.ads.linkedin.com", "bat.bing.com",
        "clarity.ms", "ct.pinterest.com", "analytics.tiktok.com", "pixel.facebook.com",
    )
    val blockedCount get() = BLOCKED.size

    fun hostBlocked(host: String?): Boolean {
        var h = host?.lowercase() ?: return false
        while (h.isNotEmpty()) {
            if (h in BLOCKED) return true
            val i = h.indexOf('.')
            if (i < 0) return false
            h = h.substring(i + 1)
        }
        return false
    }

    private val TRACKING = setOf("fbclid", "gclid", "gclsrc", "dclid", "msclkid", "twclid", "yclid", "mc_eid", "mc_cid", "_hsenc", "_hsmi",
        "igshid", "ttclid", "wickedid", "vero_id", "oly_enc_id", "oly_anon_id", "ck_subscriber_id", "mkt_tok", "srsltid", "_ga", "_gl")

    private fun isTracking(k: String) = k.lowercase() in TRACKING || k.lowercase().startsWith("utm_")

    /** The same address without tracking parameters, or null if there were none. */
    fun strip(uri: Uri): Uri? {
        val names = try { uri.queryParameterNames } catch (_: Exception) { return null }
        if (names.none { isTracking(it) }) return null
        val b = uri.buildUpon().clearQuery()
        for (n in names) if (!isTracking(n)) for (v in uri.getQueryParameters(n)) b.appendQueryParameter(n, v)
        return b.build()
    }

    fun isLocal(host: String): Boolean = host == "localhost" || Regex("^\\d+\\.\\d+\\.\\d+\\.\\d+$").matches(host) ||
        host.endsWith(".local") || host.endsWith(".localhost") || host.contains(':')
}

/**
 * Dangerous-site warnings. Downloads a public list of hosts that currently serve malware
 * (a community mirror of abuse.ch URLhaus data, the same list as desktop), caches it and checks
 * navigations against it. The list is only downloaded; nothing about your browsing is sent.
 */
class SafeList(private val c: Context, private val settings: Settings) {
    private val file = File(c.filesDir, "malware-hosts.txt")
    @Volatile var hosts: Set<String> = emptySet(); private set

    private val never = setOf("github.com", "raw.githubusercontent.com", "githubusercontent.com", "gitlab.com", "drive.google.com", "docs.google.com",
        "dropbox.com", "onedrive.live.com", "discord.com", "cdn.discordapp.com", "mega.nz", "sourceforge.net", "archive.org", "google.com", "microsoft.com")

    fun start() {
        thread(name = "tide-safelist", isDaemon = true) {
            try { if (file.exists()) hosts = file.readLines().filter { it.isNotBlank() }.toHashSet() } catch (_: Exception) {}
            if (System.currentTimeMillis() - settings.malwareUpdated > 12 * 3600_000L) refresh()
        }
    }

    private fun refresh() {
        try {
            val conn = URL(LIST_URL).openConnection() as HttpURLConnection
            conn.connectTimeout = 15000; conn.readTimeout = 20000
            conn.useCaches = false
            if (conn.responseCode != 200) return
            val set = HashSet<String>()
            val re = Regex("^\\s*(?:0\\.0\\.0\\.0|127\\.0\\.0\\.1)\\s+(\\S+)\\s*$")
            conn.inputStream.bufferedReader().useLines { lines ->
                for (line in lines) re.find(line)?.let { val h = it.groupValues[1].lowercase(); if (h !in never) set += h }
            }
            if (set.size < 20) return // a cut-off or error response must not wipe a good list
            hosts = set
            file.writeText(set.joinToString("\n"))
            settings.malwareUpdated = System.currentTimeMillis()
        } catch (_: Exception) { /* offline: keep the cached list */ }
    }

    fun isDangerous(host: String?): Boolean = settings.malwareWarnings && host != null && host.lowercase() in hosts

    companion object {
        const val LIST_URL = "https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-hosts-online.txt"
    }
}
