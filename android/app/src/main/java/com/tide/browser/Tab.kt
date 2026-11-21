package com.tide.browser

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.View
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream

/** One browser tab. The WebView is created only when the tab is first shown, so restored tabs cost nothing. */
class Tab(private val a: MainActivity, val private: Boolean, val panel: Boolean = false) {
    val id = nextId++
    var url: String = ""
    var title: String = ""
    var progress = 100
    var loading = false
    var favicon: Bitmap? = null
    var thumb: Bitmap? = null
    var desktop = false
    var opener: Tab? = null
    var pendingUrl: String? = null
    /** When you last looked at this tab, for Orbits. */
    var lastActive = System.currentTimeMillis()
    /** This tab's current page in Trail, and the page that opened the tab. */
    var trailNode: String? = null
    var openerNode: String? = null
    /** Ads and trackers blocked on the current page. */
    @Volatile var blocked = 0
    /** Read from WebView's network thread, so it is kept separately from [url]. */
    @Volatile var ioUrl: String = ""
    var web: WebView? = null
        private set

    val displayUrl get() = Urls.display(url.ifEmpty { pendingUrl ?: "" })
    val secure get() = url.startsWith("https://") && !Urls.isInternal(url)
    val isNewTab get() = Urls.isNewTab(url.ifEmpty { pendingUrl }) || (url.isEmpty() && pendingUrl == null)

    fun ensureWeb(): WebView {
        web?.let { return it }
        val w = WebView(a)
        if (private) {
            androidx.webkit.ProfileStore.getInstance().getOrCreateProfile(MainActivity.PRIVATE_PROFILE)
            WebViewCompat.setProfile(w, MainActivity.PRIVATE_PROFILE)
        }
        web = w
        setup(w)
        pendingUrl?.let { pendingUrl = null; load(it) }
        return w
    }

    fun load(u: String) {
        val w = web
        if (w == null) { pendingUrl = u; return }
        // Settings, Focus and the other Tide pages open in the panel, never in a tab.
        if (!panel && Urls.isPanelPage(u)) { a.openPanel(u); return }
        url = u
        ioUrl = u
        if (Urls.isInternal(u)) { w.loadUrl(u); return }
        val host = Urls.host(u)
        if (a.safe.isDangerous(host) && host !in a.allowedDangerous) { showWarning("malware", u); return }
        a.features.focusBlock(host).takeIf { it > 0 }?.let { showWarning("focus", u, it.toString()); return }
        w.loadUrl(upgrade(u))
    }

    private fun upgrade(u: String): String {
        var out = Uri.parse(u)
        if (a.settings.stripTracking) Privacy.strip(out)?.let { out = it }
        if (a.settings.httpsOnly && out.scheme == "http" && !Privacy.isLocal(out.host ?: "")) out = out.buildUpon().scheme("https").build()
        return out.toString()
    }

    fun showWarning(kind: String, target: String, detail: String = "") {
        val q = "?kind=" + Uri.encode(kind) + "&url=" + Uri.encode(target) + "&host=" + Uri.encode(Urls.host(target)) + "&detail=" + Uri.encode(detail)
        val page = Urls.page("warning", q)
        url = page; ioUrl = page
        web?.loadUrl(page)
    }

    fun cookies(): CookieManager =
        if (private) WebViewCompat.getProfile(ensureWeb()).cookieManager else CookieManager.getInstance()

    fun applySettings() {
        val w = web ?: return
        cookies().setAcceptThirdPartyCookies(w, !a.settings.blockThirdPartyCookies)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) WebSettingsCompat.setSafeBrowsingEnabled(w.settings, a.settings.googleSafeBrowsing)
    }

    fun setDesktopMode(on: Boolean) {
        desktop = on
        val w = web ?: return
        w.settings.userAgentString = userAgent(w)
        w.reload()
    }

    private fun userAgent(w: WebView): String {
        val base = WebSettings.getDefaultUserAgent(a)
        val chrome = Regex("Chrome/[\\d.]+").find(base)?.value ?: "Chrome/140.0.0.0"
        return if (desktop) "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) $chrome Safari/537.36"
        // WebView adds "; wv" and "Version/4.0", which make some sites treat Tide as an in-app view. Drop them.
        else base.replace("; wv", "").replace(Regex(" Version/[\\d.]+"), "").replace(Regex(" Build/[^;)]+"), "")
    }

    fun capture() {
        val w = web ?: return
        if (w.width <= 0 || w.height <= 0 || w.parent == null) return
        try {
            val s = 0.42f
            val bmp = Bitmap.createBitmap((w.width * s).toInt().coerceAtLeast(1), (w.height * s).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
            val c = Canvas(bmp)
            c.scale(s, s)
            c.translate(-w.scrollX.toFloat(), -w.scrollY.toFloat())
            w.draw(c)
            thumb = bmp
        } catch (_: Throwable) { /* low memory: keep the old thumbnail */ }
    }

    fun destroy() {
        web?.let { w ->
            (w.parent as? android.view.ViewGroup)?.removeView(w)
            w.stopLoading()
            w.webChromeClient = null
            w.destroy()
        }
        web = null
        thumb = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setup(w: WebView) {
        w.setBackgroundColor(P.bg)
        w.isVerticalScrollBarEnabled = false
        w.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
        with(w.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = true
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true // onCreateWindow still blocks popups without a tap
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setGeolocationEnabled(true)
            userAgentString = userAgent(w)
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
            WebSettingsCompat.setRequestedWithHeaderOriginAllowList(w.settings, emptySet())
        }
        applySettings()

        // Tide's own pages talk to the app through this object. It is injected only into
        // pages served from Tide's internal origin, never into websites.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(w, "tideBridge", setOf(Urls.ORIGIN)) { view, message, origin, isMainFrame, reply ->
                if (isMainFrame && origin.toString() == Urls.ORIGIN && Urls.isInternal(view.url)) a.bridge.handle(this, message.data, reply)
            }
        }

        w.webViewClient = Client()
        w.webChromeClient = Chrome()
        w.setDownloadListener { dlUrl, ua, disposition, mime, length -> a.askDownload(this, dlUrl, ua, disposition, mime, length) }
        w.setOnLongClickListener { onLongPress(w) }
        w.setFindListener { active, count, done -> if (done) a.onFindResult(this, active, count) }
    }

    private fun onLongPress(w: WebView): Boolean {
        val r = w.hitTestResult
        val extra = r.extra ?: return false
        return when (r.type) {
            WebView.HitTestResult.SRC_ANCHOR_TYPE -> { a.showLinkMenu(this, extra, null); true }
            WebView.HitTestResult.IMAGE_TYPE -> { a.showLinkMenu(this, null, extra); true }
            WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE -> {
                val h = Handler(Looper.getMainLooper()) { msg -> a.showLinkMenu(this, msg.data.getString("url"), extra); true }
                w.requestFocusNodeHref(h.obtainMessage())
                true
            }
            else -> false
        }
    }

    private fun siteAllowed(): Boolean = Urls.host(ioUrl) in a.settings.siteAllow

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            when (uri.scheme?.lowercase()) {
                "http", "https" -> {
                    if (uri.host == Urls.HOST) return !Urls.isInternal(view.url) // websites cannot open Tide's own pages
                    if (!request.isForMainFrame) return false
                    // A web link inside the panel opens in your current tab.
                    if (panel) { a.closePanel(); a.currentTab()?.let { a.navigate(it, uri.toString()) }; return true }
                    val host = uri.host?.lowercase() ?: ""
                    if (a.safe.isDangerous(host) && host !in a.allowedDangerous) { showWarning("malware", uri.toString()); return true }
                    a.features.focusBlock(host).takeIf { it > 0 }?.let { showWarning("focus", uri.toString(), it.toString()); return true }
                    val up = upgrade(uri.toString())
                    if (up != uri.toString() && request.method == "GET") { view.loadUrl(up); return true }
                    return false
                }
                "about", "data", "blob", "javascript" -> return false
                else -> { a.openExternal(this@Tab, uri, request.hasGesture(), request.isRedirect); return true }
            }
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val uri = request.url
            val host = uri.host?.lowercase()
            if (host == Urls.HOST) {
                return if (request.isForMainFrame || Urls.isInternal(ioUrl)) a.assets.shouldInterceptRequest(uri)
                else empty(403, "Forbidden")
            }
            if (request.isForMainFrame) {
                if (a.safe.isDangerous(host) && host !in a.allowedDangerous) {
                    val target = uri.toString()
                    view.post { showWarning("malware", target) }
                    return empty(204, "No Content")
                }
                val left = a.features.focusBlock(host)
                if (left > 0) {
                    val target = uri.toString()
                    view.post { showWarning("focus", target, left.toString()) }
                    return empty(204, "No Content")
                }
                return null
            }
            if (a.settings.blockAds && Privacy.hostBlocked(host) && !siteAllowed()) {
                blocked++
                view.post { a.onTabUpdated(this@Tab) }
                return empty(204, "No Content")
            }
            return null
        }

        override fun onPageStarted(view: WebView, u: String, icon: Bitmap?) {
            if (!Urls.isInternal(u) || Urls.pageName(u) != Urls.pageName(url)) blocked = 0
            url = u; ioUrl = u; loading = true
            favicon = icon
            a.onTabUpdated(this@Tab)
        }

        override fun onPageFinished(view: WebView, u: String) {
            loading = false
            url = view.url ?: u
            ioUrl = url
            a.onPageLoaded(this@Tab)
        }

        override fun doUpdateVisitedHistory(view: WebView, u: String, isReload: Boolean) {
            url = u; ioUrl = u
            if (!isReload) a.features.trailAdd(this@Tab, u)
            a.onTabUpdated(this@Tab)
        }

        @SuppressLint("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            val host = Urls.host(error.url)
            // Continue only when the user chose to on Tide's warning page for this exact host.
            if (host.isNotEmpty() && host in a.allowedCert) { handler.proceed(); return }
            handler.cancel()
            if (error.url == view.url || error.url == url || Urls.host(url) == host) {
                val why = when (error.primaryError) {
                    SslError.SSL_EXPIRED -> "The site's security certificate has expired."
                    SslError.SSL_IDMISMATCH -> "The certificate belongs to a different site."
                    SslError.SSL_UNTRUSTED -> "The certificate is not from a trusted authority."
                    SslError.SSL_NOTYETVALID -> "The certificate is not valid yet."
                    SslError.SSL_DATE_INVALID -> "The certificate date is invalid."
                    else -> "The certificate is not valid."
                }
                view.post { showWarning("cert", error.url, why) }
            }
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            a.onTabCrashed(this@Tab)
            return true
        }
    }

    private fun empty(code: Int, reason: String) =
        WebResourceResponse("text/plain", "utf-8", code, reason, emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private inner class Chrome : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            progress = newProgress
            a.onTabUpdated(this@Tab)
        }

        override fun onReceivedTitle(view: WebView, t: String?) {
            title = t ?: ""
            if (!private && !Urls.isInternal(url) && url.startsWith("http")) { a.db.updateTitle(url, title); a.features.trailTitle(this@Tab) }
            a.onTabUpdated(this@Tab)
        }

        override fun onReceivedIcon(view: WebView, icon: Bitmap?) {
            favicon = icon
            a.onTabUpdated(this@Tab)
        }

        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            if (!isUserGesture) { a.toast("Tide blocked a pop-up"); return false }
            val t = a.newTab(null, private, switch = true, opener = this@Tab, blank = true)
            val transport = resultMsg.obj as WebView.WebViewTransport
            transport.webView = t.ensureWeb()
            resultMsg.sendToTarget()
            return true
        }

        override fun onCloseWindow(window: WebView) { a.closeTab(this@Tab) }

        override fun onPermissionRequest(request: PermissionRequest) { a.askSitePermission(this@Tab, request) }
        override fun onPermissionRequestCanceled(request: PermissionRequest) { a.dismissSheet() }

        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
            a.askLocation(this@Tab, origin, callback)
        }

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean =
            a.openFileChooser(callback, params)

        override fun onShowCustomView(view: View, callback: CustomViewCallback) { a.enterFullscreen(view, callback) }
        override fun onHideCustomView() { a.exitFullscreen() }

        // Without this, videos show a grey play icon before they load.
        override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    }

    companion object {
        private var nextId = 1L
    }
}
