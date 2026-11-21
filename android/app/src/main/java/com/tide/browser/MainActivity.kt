package com.tide.browser

import android.Manifest
import android.annotation.SuppressLint
import android.app.SearchManager
import android.app.UiModeManager
import android.app.role.RoleManager
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings as SysSettings
import android.text.Editable
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.text.format.Formatter
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebStorage
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min

class MainActivity : ComponentActivity() {
    lateinit var settings: Settings
    lateinit var db: Db
    lateinit var safe: SafeList
    lateinit var bridge: PageBridge
    lateinit var downloads: Downloads
    lateinit var features: Features
    lateinit var assets: WebViewAssetLoader
    /** Hosts the user chose to visit despite a warning, for this run only. */
    val allowedDangerous: MutableSet<String> = java.util.Collections.synchronizedSet(HashSet())
    val allowedCert: MutableSet<String> = java.util.Collections.synchronizedSet(HashSet())
    private val allowedMedia = HashMap<String, MutableSet<String>>()

    private val tabs = mutableListOf<Tab>()
    private var current: Tab? = null

    // views
    private lateinit var root: FrameLayout
    private lateinit var column: LinearLayout
    private lateinit var webHolder: FrameLayout
    private lateinit var bar: LinearLayout
    private lateinit var progressFill: View
    private lateinit var backBtn: ImageView
    private lateinit var pill: LinearLayout
    private lateinit var pillIcon: ImageView
    private lateinit var pillText: TextView
    private lateinit var reloadBtn: ImageView
    private lateinit var tabsCount: TextView
    private lateinit var findBar: LinearLayout
    private lateinit var findInput: EditText
    private lateinit var findCount: TextView
    private lateinit var editLayer: LinearLayout
    private lateinit var editInput: EditText
    private lateinit var suggestList: LinearLayout
    private lateinit var tabsLayer: FrameLayout
    /** Tide's own pages (Settings, Focus, History...) slide in here, over the browser, instead of opening as tabs. */
    private lateinit var panelLayer: FrameLayout
    private var panelTab: Tab? = null
    private var panelOpen = false
    /** Set when the panel opens, so Back inside it never returns to pages from an earlier visit. */
    private var panelFresh = false
    private lateinit var sheetLayer: FrameLayout
    private lateinit var fullLayer: FrameLayout

    private var sysTop = 0; private var sysBottom = 0; private var sysLeft = 0; private var sysRight = 0; private var imeBottom = 0
    private var lastNight = false
    private var tabsPrivateMode = false

    private var sheetCard: View? = null
    private var sheetOnDismiss: (() -> Unit)? = null

    private var fullView: View? = null
    private var fullCallback: WebChromeClient.CustomViewCallback? = null

    private var permDone: ((Map<String, Boolean>) -> Unit)? = null
    private val permLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { r -> permDone?.invoke(r); permDone = null }
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val fileLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }
    private val roleLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        (if (panelOpen) panelTab?.web else current?.web)?.evaluateJavascript("dispatchEvent(new Event('tide:refresh'))", null)
    }

    // ------------------------------------------------------------------------------------------
    // lifecycle

    override fun onCreate(savedInstanceState: Bundle?) {
        settings = Settings(this)
        applyTheme()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        db = Db(this)
        safe = SafeList(this, settings).also { it.start() }
        bridge = PageBridge(this)
        downloads = Downloads(this)
        features = Features(this)
        assets = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        deleteLeftoverPrivateData()

        root = FrameLayout(this)
        setContentView(root)
        lastNight = isNight(resources.configuration)
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, ins ->
            val sb = ins.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            sysTop = sb.top; sysBottom = sb.bottom; sysLeft = sb.left; sysRight = sb.right
            imeBottom = ins.getInsets(WindowInsetsCompat.Type.ime()).bottom
            applyInsets()
            WindowInsetsCompat.CONSUMED
        }
        buildUi()

        restoreSession()
        if (!handleIntent(intent) && tabs.isEmpty()) newTab(Urls.NEWTAB, false)
        if (current == null) switchTo(tabs.last())

        startTimers()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { if (!handleBack()) moveTaskToBack(true) }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (handleIntent(intent)) { closeEditor(); closeTabs(); dismissSheet() }
    }

    override fun onPause() {
        super.onPause()
        current?.web?.onPause()
        android.webkit.CookieManager.getInstance().flush()
        saveSession()
        features.pauseAll()
    }

    override fun onResume() {
        super.onResume()
        current?.web?.onResume()
    }

    override fun onStop() {
        super.onStop()
        if (settings.snapshotsAuto) features.takeSnapshot("quit")
    }

    /** Orbits and Focus check once a minute. Snapshots save every 30 minutes, the first one 2 minutes after start. */
    private val ticker = Handler(Looper.getMainLooper())
    private var lastSnap = System.currentTimeMillis() - 28 * 60_000L
    private fun startTimers() {
        ticker.postDelayed(object : Runnable {
            override fun run() {
                features.refreshFocusCache()
                features.sweepOrbits(false)
                if (settings.snapshotsAuto && System.currentTimeMillis() - lastSnap >= 30 * 60_000L) {
                    lastSnap = System.currentTimeMillis()
                    features.takeSnapshot("auto")
                }
                ticker.postDelayed(this, 60_000)
            }
        }, 60_000)
    }

    fun currentTab(): Tab? = current
    fun allTabs(): List<Tab> = tabs.toList()

    override fun onDestroy() {
        ticker.removeCallbacksAndMessages(null)
        features.shutdown()
        val hadPrivate = tabs.any { it.private }
        tabs.forEach { it.destroy() }
        tabs.clear()
        if (hadPrivate) deleteLeftoverPrivateData()
        super.onDestroy()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        val night = isNight(newConfig)
        if (night != lastNight) {
            lastNight = night
            val wasTabs = tabsLayer.visibility == View.VISIBLE
            buildUi()
            tabs.forEach { it.web?.setBackgroundColor(P.bg) }
            if (wasTabs) openTabs(animate = false)
        } else if (tabsLayer.visibility == View.VISIBLE) {
            openTabs(animate = false) // rotation: re-flow the grid
        }
    }

    private fun isNight(c: Configuration) = (c.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    private fun applyTheme() {
        if (Build.VERSION.SDK_INT >= 31) {
            getSystemService(UiModeManager::class.java).setApplicationNightMode(
                when (settings.theme) { "dark" -> UiModeManager.MODE_NIGHT_YES; "light" -> UiModeManager.MODE_NIGHT_NO; else -> UiModeManager.MODE_NIGHT_AUTO }
            )
        }
    }

    fun onSettingsChanged(keys: Set<String>) {
        if ("theme" in keys) applyTheme()
        if (keys.any { it == "blockThirdPartyCookies" || it == "googleSafeBrowsing" }) tabs.forEach { it.applySettings() }
    }

    // ------------------------------------------------------------------------------------------
    // building the interface

    private fun buildUi() {
        P.load(this)
        root.removeAllViews()
        root.setBackgroundColor(P.bg)
        WindowInsetsControllerCompat(window, root).apply {
            isAppearanceLightStatusBars = !P.dark
            isAppearanceLightNavigationBars = !P.dark
        }

        column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        webHolder = FrameLayout(this).apply { setBackgroundColor(P.bg) }
        column.addView(webHolder, lp(MATCH, 0, 1f))
        findBar = buildFindBar()
        column.addView(findBar, lp(MATCH, WRAP))
        bar = buildBar()
        column.addView(bar, lp(MATCH, WRAP))
        root.addView(column, flp(MATCH, MATCH))

        editLayer = buildEditLayer()
        root.addView(editLayer, flp(MATCH, MATCH))
        tabsLayer = FrameLayout(this).apply { visibility = View.GONE; setBackgroundColor(P.bg); isClickable = true }
        root.addView(tabsLayer, flp(MATCH, MATCH))
        panelLayer = FrameLayout(this).apply { visibility = if (panelOpen) View.VISIBLE else View.GONE; setBackgroundColor(P.bg); isClickable = true }
        root.addView(panelLayer, flp(MATCH, MATCH))
        panelTab?.web?.let { w -> (w.parent as? ViewGroup)?.removeView(w); w.setBackgroundColor(P.bg); panelLayer.addView(w, flp(MATCH, MATCH)) }
        sheetLayer = FrameLayout(this).apply { visibility = View.GONE }
        root.addView(sheetLayer, flp(MATCH, MATCH))
        fullLayer = FrameLayout(this).apply { visibility = View.GONE; setBackgroundColor(0xFF000000.toInt()) }
        root.addView(fullLayer, flp(MATCH, MATCH))

        applyInsets()
        current?.let { attach(it, fade = false) }
        refreshBar()
    }

    private fun applyInsets() {
        if (!::column.isInitialized) return
        val imeUp = imeBottom > sysBottom
        webHolder.setPadding(0, sysTop, 0, 0)
        column.setPadding(sysLeft, 0, sysRight, if (imeUp) imeBottom else 0)
        bar.setPadding(0, 0, 0, if (imeUp) 0 else sysBottom)
        editLayer.setPadding(sysLeft, sysTop, sysRight, max(imeBottom, sysBottom))
        tabsLayer.setPadding(sysLeft, sysTop, sysRight, sysBottom)
        panelLayer.setPadding(sysLeft, sysTop, sysRight, max(imeBottom, sysBottom))
        sheetCard?.let { it.setPadding(it.paddingLeft, it.paddingTop, it.paddingRight, sysBottom + dp(14)) }
    }

    private fun buildBar(): LinearLayout {
        val b = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(P.bg)
        }
        // hairline on top, with the load progress drawn over it
        val track = FrameLayout(this).apply { setBackgroundColor(P.line) }
        progressFill = View(this).apply {
            setBackgroundColor(P.accent); pivotX = 0f; scaleX = 0f; alpha = 0f
        }
        track.addView(progressFill, flp(MATCH, dp(2)))
        b.addView(track, lp(MATCH, dp(2)))

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), dp(6), dp(6), dp(6))
        }
        backBtn = iconButton(Icons.back, "Back") { goBack() }
        row.addView(backBtn, lp(dp(44), dp(44)))

        pill = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), 0, dp(2), 0)
            isClickable = true
            setOnClickListener { openEditor() }
            setOnLongClickListener { current?.let { if (!it.isNewTab) copyText(Urls.display(it.url), "Link copied") }; true }
        }
        pillIcon = iconView(Icons.search, P.muted, 18).apply {
            setOnClickListener { showSiteInfo() }
            background = ripple(null, dp(16).toFloat())
        }
        pill.addView(pillIcon, lp(dp(34), dp(34)))
        pillText = label("", 15f, P.text).apply {
            setSingleLine(); ellipsize = TextUtils.TruncateAt.END
            setPadding(dp(2), 0, dp(4), 0)
        }
        pill.addView(pillText, lp(0, WRAP, 1f))
        reloadBtn = iconButton(Icons.reload, "Reload", P.muted, 18) { reloadOrStop() }
        pill.addView(reloadBtn, lp(dp(38), dp(38)))
        row.addView(pill, lp(0, dp(44), 1f).apply { setMargins(dp(4), 0, dp(4), 0) })

        val tabsBtn = FrameLayout(this).apply {
            contentDescription = "Tabs"
            background = ripple(null, dp(22).toFloat())
            isClickable = true
            setOnClickListener { v -> bounce(v); openTabs() }
            setOnLongClickListener { showTabsQuickMenu(); true }
        }
        tabsCount = label("1", 12f, P.text, true).apply {
            gravity = Gravity.CENTER
            background = rounded(0, dp(6).toFloat(), dp(1.6f), P.text)
        }
        tabsBtn.addView(tabsCount, flp(dp(22), dp(22), Gravity.CENTER))
        row.addView(tabsBtn, lp(dp(44), dp(44)))
        row.addView(iconButton(Icons.dots, "Menu") { showMenu() }, lp(dp(44), dp(44)))
        b.addView(row, lp(MATCH, WRAP))
        return b
    }

    private fun buildFindBar(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        visibility = View.GONE
        setBackgroundColor(P.bg)
        setPadding(dp(12), dp(6), dp(6), dp(2))
        findInput = EditText(this@MainActivity).apply {
            hint = "Find in page"
            setHintTextColor(P.muted); setTextColor(P.text); setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setSingleLine(); imeOptions = EditorInfo.IME_ACTION_SEARCH
            background = rounded(P.surface2, dp(20).toFloat(), 1, P.line)
            setPadding(dp(16), 0, dp(16), 0)
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun afterTextChanged(s: Editable?) {
                    val q = s?.toString() ?: ""
                    if (q.isEmpty()) { current?.web?.clearMatches(); findCount.text = "" } else current?.web?.findAllAsync(q)
                }
            })
            setOnEditorActionListener { _, _, _ -> current?.web?.findNext(true); true }
        }
        addView(findInput, lp(0, dp(40), 1f))
        findCount = label("", 13f, P.muted).apply { setPadding(dp(10), 0, dp(4), 0) }
        addView(findCount, lp(WRAP, WRAP))
        addView(iconButton(Icons.chevUp, "Previous match") { current?.web?.findNext(false) }, lp(dp(44), dp(44)))
        addView(iconButton(Icons.chevDown, "Next match") { current?.web?.findNext(true) }, lp(dp(44), dp(44)))
        addView(iconButton(Icons.x, "Close find") { closeFind() }, lp(dp(44), dp(44)))
    }

    private fun buildEditLayer(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        visibility = View.GONE
        setBackgroundColor(P.bg)
        isClickable = true

        val scroll = ScrollView(this@MainActivity).apply { isFillViewport = true; isVerticalScrollBarEnabled = false }
        suggestList = LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.BOTTOM
            setPadding(0, dp(8), 0, dp(8))
        }
        scroll.addView(suggestList, FrameLayout.LayoutParams(MATCH, WRAP))
        addView(scroll, lp(MATCH, 0, 1f))

        val row = LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(8), dp(6), dp(10))
        }
        val field = LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = rounded(P.surface2, dp(23).toFloat(), dp(1), P.alpha(P.accent, 0.55f))
            setPadding(dp(6), 0, dp(2), 0)
        }
        field.addView(iconView(Icons.search, P.muted, 18), lp(dp(34), dp(34)))
        editInput = EditText(this@MainActivity).apply {
            hint = "Search or type a web address"
            setHintTextColor(P.muted); setTextColor(P.strong); setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            background = null
            setSingleLine()
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            imeOptions = EditorInfo.IME_ACTION_GO or EditorInfo.IME_FLAG_NO_EXTRACT_UI
            setSelectAllOnFocus(true)
            setPadding(dp(2), 0, dp(2), 0)
            setOnEditorActionListener { v, actionId, ev ->
                if (actionId == EditorInfo.IME_ACTION_GO || (ev != null && ev.keyCode == KeyEvent.KEYCODE_ENTER && ev.action == KeyEvent.ACTION_DOWN)) { go(v.text.toString()); true } else false
            }
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun afterTextChanged(s: Editable?) { updateSuggestions() }
            })
        }
        field.addView(editInput, lp(0, dp(46), 1f))
        field.addView(iconButton(Icons.x, "Clear", P.muted, 16) { editInput.setText("") }, lp(dp(40), dp(40)))
        row.addView(field, lp(0, dp(46), 1f))
        val cancel = label("Cancel", 15f, P.accent).apply {
            setPadding(dp(14), dp(12), dp(10), dp(12))
            background = ripple(null, dp(20).toFloat())
            isClickable = true
            setOnClickListener { closeEditor() }
        }
        row.addView(cancel, lp(WRAP, WRAP))
        addView(row, lp(MATCH, WRAP))
    }

    // ------------------------------------------------------------------------------------------
    // tabs

    fun newTab(url: String?, private: Boolean, switch: Boolean = true, opener: Tab? = null, blank: Boolean = false): Tab {
        if (private && !privateSupported()) {
            toast("Private tabs need a newer Android System WebView. Update it from the Play Store.")
            return current ?: newTab(url, false, switch, opener, blank)
        }
        val t = Tab(this, private)
        t.opener = opener
        t.openerNode = opener?.trailNode
        val at = opener?.let { o -> tabs.indexOf(o).takeIf { it >= 0 }?.plus(1) } ?: tabs.size
        tabs.add(at, t)
        if (!blank) t.pendingUrl = url ?: Urls.NEWTAB
        if (switch) switchTo(t) else { t.ensureWeb(); t.web?.onPause() }
        bumpTabs()
        return t
    }

    /** Open one of Tide's pages in the panel. [url] is the page's address; a #fragment is kept. */
    fun openPanel(url: String) {
        val name = Urls.pageName(url) ?: return
        val frag = Uri.parse(url).fragment?.let { "#$it" } ?: ""
        val target = Urls.page(name, "?panel=1$frag")
        closeEditor(); closeTabs(); dismissSheet(); closeFind()
        val p = panelTab ?: Tab(this, false, panel = true).also { panelTab = it }
        val w = p.ensureWeb()
        if (w.parent == null) { w.setBackgroundColor(P.bg); panelLayer.addView(w, flp(MATCH, MATCH)) }
        p.load(target)
        if (!panelOpen) {
            panelFresh = true
            panelOpen = true
            panelLayer.visibility = View.VISIBLE
            panelLayer.alpha = 0f
            panelLayer.translationX = root.width * 0.18f
            panelLayer.animate().alpha(1f).translationX(0f).setDuration(320).setInterpolator(DecelerateInterpolator(2.2f)).start()
        }
        w.onResume()
    }

    fun closePanel() {
        if (!panelOpen) return
        panelOpen = false
        getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(panelLayer.windowToken, 0)
        panelLayer.animate().alpha(0f).translationX(root.width * 0.18f).setDuration(220).setInterpolator(DecelerateInterpolator()).withEndAction {
            if (!panelOpen) {
                panelLayer.visibility = View.GONE
                panelTab?.web?.let { it.loadUrl("about:blank"); it.clearHistory(); it.onPause() }
            }
        }.start()
        refreshBar() // the page under the panel may have changed while it was open
    }

    private fun switchTo(t: Tab) {
        closePanel()
        if (current !== t) {
            current?.let { it.capture(); it.web?.onPause(); it.lastActive = System.currentTimeMillis() }
            t.lastActive = System.currentTimeMillis()
            closeFind()
            current = t
        }
        attach(t, fade = true)
        t.web?.onResume()
        refreshBar()
    }

    private fun attach(t: Tab, fade: Boolean) {
        val w = t.ensureWeb()
        (w.parent as? ViewGroup)?.removeView(w)
        webHolder.removeAllViews()
        webHolder.addView(w, flp(MATCH, MATCH))
        if (fade) { w.alpha = 0f; w.animate().alpha(1f).setDuration(180).start() } else w.alpha = 1f
    }

    fun closeTab(t: Tab) {
        val i = tabs.indexOf(t)
        if (i < 0) return
        val lastPrivate = t.private && tabs.count { it.private } == 1
        if (lastPrivate) wipePrivate(t)
        tabs.removeAt(i)
        tabs.forEach { if (it.opener === t) it.opener = null }
        if (current === t) {
            current = null
            val same = tabs.filter { it.private == t.private }
            val next = t.opener?.takeIf { it in tabs } ?: same.getOrNull(min(i, same.size - 1).coerceAtLeast(0)).takeIf { same.isNotEmpty() } ?: tabs.lastOrNull { !it.private }
            if (next != null) switchTo(next) else newTab(Urls.NEWTAB, false)
        }
        features.forget(t)
        bridge.forget(t)
        t.destroy()
        if (lastPrivate) Handler(Looper.getMainLooper()).postDelayed({ deleteLeftoverPrivateData() }, 800)
        bumpTabs()
        refreshBar()
    }

    private fun wipePrivate(t: Tab) {
        val w = t.web ?: return
        try {
            val profile = WebViewCompat.getProfile(w)
            profile.cookieManager.removeAllCookies(null)
            profile.webStorage.deleteAllData()
            w.clearCache(true)
        } catch (_: Exception) {}
    }

    private fun deleteLeftoverPrivateData() {
        if (!privateSupported() || tabs.any { it.private }) return
        try { ProfileStore.getInstance().deleteProfile(PRIVATE_PROFILE) } catch (_: Exception) { /* still in use; retried next start */ }
    }

    private fun bumpTabs() {
        if (!::tabsCount.isInitialized) return
        val t = current
        val n = tabs.count { it.private == (t?.private ?: false) }
        val s = if (n > 99) ":)" else n.toString()
        if (tabsCount.text.toString() != s) { tabsCount.text = s; bounce(tabsCount) }
    }

    private fun saveSession() {
        val list = tabs.filter { !it.private }
        val arr = JSONArray()
        var cur = 0
        list.forEachIndexed { i, t ->
            val u = t.url.ifEmpty { t.pendingUrl ?: "" }
            if (u.isEmpty() || Urls.pageName(u) == "warning" || Urls.pageName(u) == "reader" || Urls.isPanelPage(u)) return@forEachIndexed
            if (t === current) cur = arr.length()
            arr.put(JSONObject().put("url", u).put("title", t.title))
        }
        settings.session = JSONObject().put("current", cur).put("tabs", arr).toString()
    }

    private fun restoreSession() {
        if (!settings.restoreTabs) return
        val s = settings.session ?: return
        try {
            val o = JSONObject(s)
            val arr = o.getJSONArray("tabs")
            for (i in 0 until arr.length()) {
                val e = arr.getJSONObject(i)
                val t = Tab(this, false)
                // Tabs saved by older builds may hold a Tide page that now lives in the panel.
                t.pendingUrl = e.getString("url").let { if (Urls.isPanelPage(it)) Urls.NEWTAB else it }
                t.title = e.optString("title")
                tabs.add(t)
            }
            if (tabs.isNotEmpty()) switchTo(tabs[o.optInt("current").coerceIn(0, tabs.size - 1)])
        } catch (_: Exception) {}
    }

    private fun handleIntent(i: Intent?): Boolean {
        when (i?.action) {
            Intent.ACTION_VIEW -> {
                val d = i.dataString ?: return false
                if (!d.startsWith("http://", true) && !d.startsWith("https://", true)) return false
                openFromOutside(d); return true
            }
            Intent.ACTION_WEB_SEARCH -> {
                val q = i.getStringExtra(SearchManager.QUERY)?.takeIf { it.isNotBlank() } ?: return false
                openFromOutside(Urls.fromInput(q, settings.search)); return true
            }
            Intent.ACTION_SEND -> {
                val text = i.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() } ?: return false
                openFromOutside(Urls.firstLink(text) ?: Urls.searchUrl(text.trim(), settings.search)); return true
            }
        }
        return false
    }

    private fun openFromOutside(url: String) {
        val c = current
        if (c != null && !c.private && c.isNewTab && !c.loading) { c.ensureWeb(); c.load(url); refreshBar() }
        else newTab(url, false)
    }

    fun navigate(tab: Tab, q: String) {
        if (q.isBlank()) return
        val url = Urls.fromInput(q, settings.search)
        if (tab.panel) {
            // From a panel page: another Tide page stays in the panel, anything else opens in your tab.
            if (Urls.isPanelPage(url)) { openPanel(url); return }
            closePanel()
            current?.let { it.load(url); refreshBar() }
            return
        }
        tab.load(url)
        if (tab === current) refreshBar()
    }

    private fun goBack() {
        val t = current ?: return
        val w = t.web
        when {
            w != null && w.canGoBack() -> w.goBack()
            t.opener != null -> closeTab(t)
        }
    }

    private fun reloadOrStop() {
        val t = current ?: return
        val w = t.web ?: return
        if (t.loading) w.stopLoading() else w.reload()
    }

    private fun handleBack(): Boolean {
        when {
            fullView != null -> { fullCallback?.onCustomViewHidden(); exitFullscreen() }
            sheetLayer.visibility == View.VISIBLE -> dismissSheet()
            panelOpen -> { val w = panelTab?.web; if (w != null && w.canGoBack()) w.goBack() else closePanel() }
            editLayer.visibility == View.VISIBLE -> closeEditor()
            tabsLayer.visibility == View.VISIBLE -> closeTabs()
            findBar.visibility == View.VISIBLE -> closeFind()
            current?.web?.canGoBack() == true -> current?.web?.goBack()
            current?.opener != null -> closeTab(current!!)
            else -> return false
        }
        return true
    }

    // ------------------------------------------------------------------------------------------
    // events from tabs

    fun onTabUpdated(t: Tab) { if (t === current) refreshBar() }

    fun onPageLoaded(t: Tab) {
        if (t.panel) {
            if (panelFresh && Urls.isInternal(t.url)) { t.web?.clearHistory(); panelFresh = false }
            return
        }
        if (!t.private && t.url.startsWith("http") && !Urls.isInternal(t.url)) db.addVisit(t.url, t.title)
        onTabUpdated(t)
    }

    fun onTabCrashed(t: Tab) {
        if (t.panel) { t.destroy(); panelTab = null; closePanel(); return }
        val u = t.url
        t.destroy()
        t.pendingUrl = u.ifEmpty { Urls.NEWTAB }
        if (t === current) { attach(t, fade = true); refreshBar() }
        toast("That page stopped working, so Tide reloaded it")
    }

    fun onFindResult(t: Tab, active: Int, count: Int) {
        if (t !== current) return
        findCount.text = if (count == 0) "0/0" else "${active + 1}/$count"
    }

    private fun refreshBar() {
        if (!::pillText.isInitialized) return
        val t = current ?: return
        val canBack = t.web?.canGoBack() == true || t.opener != null
        backBtn.alpha = if (canBack) 1f else 0.35f
        val internal = Urls.isInternal(t.url) && !t.isNewTab
        when {
            t.isNewTab -> { pillText.text = if (t.private) "Private tab" else "Search or type a web address"; pillText.setTextColor(if (t.private) P.priv else P.muted) }
            else -> { pillText.text = Urls.shortHost(t.url.ifEmpty { t.pendingUrl }); pillText.setTextColor(P.text) }
        }
        val (icon, color) = when {
            t.private -> Icons.mask to P.priv
            t.isNewTab -> Icons.search to P.muted
            internal -> Icons.tide to P.accent
            t.secure -> Icons.lock to P.muted
            t.url.startsWith("http://") -> Icons.warn to P.bad
            else -> Icons.globe to P.muted
        }
        pillIcon.setImageDrawable(IconDrawable(icon, color))
        pill.background = ripple(
            rounded(if (t.private) P.alpha(P.priv, 0.13f) else P.surface2, dp(22).toFloat(), 1, if (t.private) P.alpha(P.priv, 0.4f) else P.line),
            dp(22).toFloat()
        )
        reloadBtn.setImageDrawable(IconDrawable(if (t.loading) Icons.x else Icons.reload, P.muted))
        reloadBtn.visibility = if (t.isNewTab) View.GONE else View.VISIBLE
        val showing = t.loading && t.progress < 100
        if (showing) {
            if (progressFill.alpha < 1f) { progressFill.animate().cancel(); progressFill.alpha = 1f; if (t.progress < 15) progressFill.scaleX = 0f }
            progressFill.animate().scaleX(max(0.06f, t.progress / 100f)).setDuration(220).setInterpolator(DecelerateInterpolator()).start()
        } else if (progressFill.alpha > 0f) {
            progressFill.animate().scaleX(1f).setDuration(160).withEndAction {
                progressFill.animate().alpha(0f).setDuration(260).withEndAction { progressFill.scaleX = 0f }.start()
            }.start()
        }
        bumpTabs()
    }

    // ------------------------------------------------------------------------------------------
    // address editor

    private fun openEditor() {
        val t = current ?: return
        if (editLayer.visibility == View.VISIBLE) return
        editLayer.visibility = View.VISIBLE
        editLayer.alpha = 0f
        editLayer.animate().alpha(1f).setDuration(160).start()
        val row = editLayer.getChildAt(1)
        row.translationY = dp(28).toFloat()
        row.animate().translationY(0f).setDuration(320).setInterpolator(DecelerateInterpolator(2.2f)).start()
        editInput.setText(if (t.isNewTab) "" else Urls.display(t.url.ifEmpty { t.pendingUrl }))
        editInput.requestFocus()
        editInput.selectAll()
        editInput.post {
            getSystemService(InputMethodManager::class.java).showSoftInput(editInput, InputMethodManager.SHOW_IMPLICIT)
        }
        updateSuggestions()
    }

    private fun closeEditor() {
        if (editLayer.visibility != View.VISIBLE) return
        getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(editInput.windowToken, 0)
        editInput.clearFocus()
        editLayer.animate().alpha(0f).setDuration(140).withEndAction { editLayer.visibility = View.GONE }.start()
    }

    private fun go(text: String) {
        val t = current ?: return
        if (text.isBlank()) return
        closeEditor()
        navigate(t, text)
    }

    private fun updateSuggestions() {
        val q = editInput.text.toString()
        val rows = mutableListOf<View>()
        if (q.isBlank()) {
            val t = current
            if (t != null && !t.isNewTab && !Urls.isInternal(t.url)) {
                rows += suggestionRow(Icons.link, t.title.ifBlank { Urls.shortHost(t.url) }, t.url, null) { copyText(t.url, "Link copied"); closeEditor() }
            }
            val seen = HashSet<String>()
            val recent = db.history(40)
            val items = mutableListOf<JSONObject>()
            for (i in 0 until recent.length()) {
                val h = recent.getJSONObject(i)
                if (seen.add(h.getString("url")) && items.size < 6) items += h
            }
            if (items.isNotEmpty()) rows += sectionLabel("Recent")
            items.forEach { h -> rows += suggestionRow(Icons.clock, h.optString("title").ifBlank { h.getString("url") }, h.getString("url"), h.getString("url")) { go(h.getString("url")) } }
        } else {
            val list = db.suggest(q, 6)
            list.forEach { s -> rows += suggestionRow(if (s.bookmark) Icons.star else Icons.clock, s.title.ifBlank { s.url }, s.url, s.url) { go(s.url) } }
            val engine = Urls.engine(settings.search).name
            rows += suggestionRow(Icons.search, q, "Search with $engine", q) { closeEditor(); current?.let { it.load(Urls.searchUrl(q.trim(), settings.search)); refreshBar() } }
            if (Urls.looksLikeUrl(q)) {
                val u = Urls.fromInput(q, settings.search)
                rows += suggestionRow(Icons.globe, q.trim(), "Go to this address", null) { go(u) }
            }
        }
        // The best match sits at the bottom, next to your thumb and the text field.
        suggestList.removeAllViews()
        rows.forEach { suggestList.addView(it) }
    }

    private fun sectionLabel(text: String) = label(text.uppercase(), 11f, P.muted, true).apply {
        letterSpacing = 0.12f
        setPadding(dp(20), dp(14), dp(20), dp(6))
    }

    private fun suggestionRow(icon: Icon, title: String, sub: String, fill: String?, onClick: () -> Unit): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), 0, dp(6), 0)
            background = ripple(null, 0f)
            isClickable = true
            setOnClickListener { onClick() }
            addView(iconView(icon, P.muted, 18), lp(dp(40), dp(40)))
            val col = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(6), 0, dp(6), 0)
                addView(label(title, 15f, P.text).apply { setSingleLine(); ellipsize = TextUtils.TruncateAt.END })
                addView(label(sub, 12f, P.muted).apply { setSingleLine(); ellipsize = TextUtils.TruncateAt.MIDDLE; setPadding(0, dp(3), 0, 0) })
            }
            addView(col, lp(0, WRAP, 1f))
            if (fill != null) addView(iconButton(Icons.arrowUpLeft, "Edit this", P.muted, 18) {
                editInput.setText(fill); editInput.setSelection(editInput.text.length)
            }, lp(dp(44), dp(44)))
            layoutParams = lp(MATCH, dp(60))
        }

    // ------------------------------------------------------------------------------------------
    // find in page

    private fun openFind() {
        val t = current ?: return
        if (t.web == null) return
        findBar.visibility = View.VISIBLE
        findBar.alpha = 0f; findBar.translationY = dp(12).toFloat()
        findBar.animate().alpha(1f).translationY(0f).setDuration(220).start()
        findInput.setText("")
        findCount.text = ""
        findInput.requestFocus()
        findInput.post { getSystemService(InputMethodManager::class.java).showSoftInput(findInput, InputMethodManager.SHOW_IMPLICIT) }
    }

    private fun closeFind() {
        if (!::findBar.isInitialized || findBar.visibility != View.VISIBLE) return
        current?.web?.clearMatches()
        getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(findInput.windowToken, 0)
        findBar.visibility = View.GONE
    }

    // ------------------------------------------------------------------------------------------
    // tab grid

    private fun openTabs(animate: Boolean = true) {
        val cur = current
        if (animate) { cur?.capture(); tabsPrivateMode = cur?.private ?: false }
        tabsLayer.removeAllViews()
        tabsLayer.visibility = View.VISIBLE

        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        // header: mode switch and Done
        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(10), dp(8), dp(8))
        }
        val seg = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            background = rounded(P.surface2, dp(20).toFloat(), 1, P.line)
            setPadding(dp(3), dp(3), dp(3), dp(3))
        }
        fun segBtn(text: String, private: Boolean) = label(text, 14f, if (tabsPrivateMode == private) (if (private) P.onAccent else P.strong) else P.muted, tabsPrivateMode == private).apply {
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(8), dp(16), dp(8))
            if (tabsPrivateMode == private) background = rounded(if (private) privFill() else P.surface, dp(17).toFloat(), if (private) 0 else 1, P.border)
            isClickable = true
            setOnClickListener { if (tabsPrivateMode != private) { tabsPrivateMode = private; openTabs(animate = false) } }
        }
        val normalCount = tabs.count { !it.private }
        val privateCount = tabs.count { it.private }
        seg.addView(segBtn("Tabs  $normalCount", false))
        if (privateSupported()) seg.addView(segBtn("Private  $privateCount", true))
        head.addView(seg, lp(WRAP, WRAP))
        head.addView(View(this), lp(0, 1, 1f))
        head.addView(label("Done", 15f, P.accent, true).apply {
            setPadding(dp(14), dp(10), dp(14), dp(10)); background = ripple(null, dp(20).toFloat()); isClickable = true
            setOnClickListener { closeTabs() }
        })
        col.addView(head, lp(MATCH, WRAP))

        val shown = tabs.filter { it.private == tabsPrivateMode }
        val scroll = ScrollView(this).apply { isVerticalScrollBarEnabled = false; clipToPadding = false; setPadding(0, 0, 0, dp(96)) }
        val grid = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(10), dp(4), dp(10), 0) }
        if (shown.isEmpty()) {
            grid.addView(label(
                if (tabsPrivateMode) "No private tabs.\n\nPrivate tabs keep no history. Their cookies and site data are deleted when you close the last one."
                else "No tabs open.", 15f, P.muted
            ).apply { gravity = Gravity.CENTER; setLineSpacing(0f, 1.25f); setPadding(dp(32), dp(80), dp(32), 0) })
        }
        val width = resources.displayMetrics.widthPixels - sysLeft - sysRight
        val cols = if (width > dp(700)) 3 else 2
        val cardW = (width - dp(20)) / cols - dp(12)
        var n = 0
        shown.chunked(cols).forEach { rowTabs ->
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            rowTabs.forEach { t ->
                val card = tabCard(t, cardW, t === cur)
                if (animate) {
                    card.alpha = 0f; card.translationY = dp(30).toFloat(); card.scaleX = 0.94f; card.scaleY = 0.94f
                    card.animate().alpha(1f).translationY(0f).scaleX(1f).scaleY(1f).setStartDelay(30L * n++).setDuration(420)
                        .setInterpolator(OvershootInterpolator(0.9f)).start()
                }
                row.addView(card, lp(0, WRAP, 1f).apply { setMargins(dp(6), dp(6), dp(6), dp(6)) })
            }
            repeat(cols - rowTabs.size) { row.addView(View(this), lp(0, 1, 1f).apply { setMargins(dp(6), 0, dp(6), 0) }) }
            grid.addView(row, lp(MATCH, WRAP))
        }
        scroll.addView(grid)
        col.addView(scroll, lp(MATCH, 0, 1f))
        tabsLayer.addView(col, flp(MATCH, MATCH))

        // bottom: close all, new tab
        val foot = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(10), dp(16), dp(14))
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(P.bg, P.bg, P.alpha(P.bg, 0f)))
        }
        val closeAll = label(if (shown.isEmpty()) "" else "Close all", 15f, P.muted).apply {
            setPadding(dp(8), dp(10), dp(8), dp(10)); background = ripple(null, dp(18).toFloat()); isClickable = shown.isNotEmpty()
            setOnClickListener { closeAllIn(tabsPrivateMode) }
        }
        foot.addView(closeAll, lp(0, WRAP, 1f))
        val fab = FrameLayout(this).apply {
            background = ripple(rounded(if (tabsPrivateMode) privFill() else P.accentBg, dp(28).toFloat()), dp(28).toFloat())
            elevation = dp(6).toFloat()
            isClickable = true
            contentDescription = if (tabsPrivateMode) "New private tab" else "New tab"
            setOnClickListener { v -> bounce(v); val p = tabsPrivateMode; closeTabs(); newTab(Urls.NEWTAB, p) }
            addView(iconView(Icons.plus, P.onAccent, 24), flp(dp(56), dp(56), Gravity.CENTER))
        }
        foot.addView(fab, lp(dp(56), dp(56)))
        foot.addView(View(this), lp(0, 1, 1f))
        tabsLayer.addView(foot, flp(MATCH, WRAP, Gravity.BOTTOM))

        if (animate) {
            tabsLayer.alpha = 0f
            tabsLayer.animate().alpha(1f).setDuration(200).start()
            fab.scaleX = 0f; fab.scaleY = 0f
            fab.animate().scaleX(1f).scaleY(1f).setStartDelay(120).setDuration(420).setInterpolator(OvershootInterpolator(2f)).start()
        }
    }

    private fun tabCard(t: Tab, cardW: Int, selected: Boolean): View {
        val thumbH = dp(200)
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val border = if (selected) (if (t.private) P.priv else P.accent) else P.line
            background = rounded(P.surface, dp(18).toFloat(), if (selected) dp(2) else 1, border)
            clipToOutline = true
            elevation = dp(1).toFloat()
            isClickable = true
            setOnClickListener { closeTabs(); switchTo(t) }
        }
        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(4), dp(2), dp(2))
        }
        val title = t.title.ifBlank { if (t.isNewTab) "New tab" else Urls.shortHost(t.url.ifEmpty { t.pendingUrl }) }
        val fav = t.favicon
        if (fav != null) head.addView(ImageView(this).apply { setImageBitmap(fav) }, lp(dp(16), dp(16)))
        else head.addView(IconDrawable(if (t.isNewTab) Icons.tide else Icons.globe, P.muted).let { d -> ImageView(this).apply { setImageDrawable(d) } }, lp(dp(16), dp(16)))
        head.addView(label(title, 13f, P.text).apply { setSingleLine(); ellipsize = TextUtils.TruncateAt.END; setPadding(dp(8), 0, dp(2), 0) }, lp(0, WRAP, 1f))
        head.addView(iconButton(Icons.x, "Close tab", P.muted, 15) {
            card.animate().alpha(0f).scaleX(0.8f).scaleY(0.8f).setDuration(200).withEndAction {
                closeTab(t)
                if (tabs.none { it.private == tabsPrivateMode } && !tabsPrivateMode) { closeTabs() } else openTabs(animate = false)
            }.start()
        }, lp(dp(40), dp(40)))
        card.addView(head, lp(MATCH, WRAP))

        val thumb = t.thumb
        if (thumb != null && !t.isNewTab) {
            val ratio = thumbH.toFloat() / cardW
            val h = min(thumb.height, (thumb.width * ratio).toInt()).coerceAtLeast(1)
            val crop = try { Bitmap.createBitmap(thumb, 0, 0, thumb.width, h) } catch (_: Exception) { thumb }
            card.addView(ImageView(this).apply { setImageBitmap(crop); scaleType = ImageView.ScaleType.CENTER_CROP }, lp(MATCH, thumbH))
        } else {
            val ph = FrameLayout(this).apply { setBackgroundColor(if (t.private) P.alpha(P.priv, 0.08f) else P.bg) }
            ph.addView(iconView(if (t.isNewTab) Icons.tide else Icons.globe, if (t.private) P.priv else P.alpha(P.muted, 0.7f), 36), flp(dp(64), dp(64), Gravity.CENTER))
            card.addView(ph, lp(MATCH, thumbH))
        }
        return card
    }

    /** Solid purple for private-mode buttons; readable white text in both themes. */
    private fun privFill(): Int = if (P.dark) 0xFF5B3FA8.toInt() else P.priv

    private fun closeTabs() {
        if (!::tabsLayer.isInitialized || tabsLayer.visibility != View.VISIBLE) return
        tabsLayer.animate().alpha(0f).setDuration(160).withEndAction { tabsLayer.visibility = View.GONE; tabsLayer.removeAllViews() }.start()
    }

    private fun closeAllIn(private: Boolean) {
        val list = tabs.filter { it.private == private }
        if (list.isEmpty()) return
        if (private) list.firstOrNull { it.web != null }?.let { wipePrivate(it) }
        val n = list.size
        tabs.removeAll(list)
        val wasCurrent = list.contains(current)
        list.forEach { it.destroy() }
        if (wasCurrent) {
            current = null
            val next = tabs.lastOrNull { !it.private }
            if (next != null) switchTo(next) else newTab(Urls.NEWTAB, false)
        }
        if (private) Handler(Looper.getMainLooper()).postDelayed({ deleteLeftoverPrivateData() }, 800)
        toast(if (n == 1) "Closed 1 tab" else "Closed $n tabs")
        if (!private && tabs.none { !it.private }) newTab(Urls.NEWTAB, false)
        closeTabs()
        refreshBar()
    }

    private fun showTabsQuickMenu() = sheet {
        sheetRow(Icons.plus, "New tab") { dismissSheet(); newTab(Urls.NEWTAB, false) }
        if (privateSupported()) sheetRow(Icons.mask, "New private tab", tint = P.priv) { dismissSheet(); newTab(Urls.NEWTAB, true) }
        current?.let { t -> sheetRow(Icons.x, "Close this tab") { dismissSheet(); closeTab(t) } }
    }

    // ------------------------------------------------------------------------------------------
    // sheets (menus and prompts slide up from the bottom)

    fun sheet(onDismiss: (() -> Unit)? = null, build: LinearLayout.() -> Unit) {
        sheetOnDismiss?.invoke()
        sheetOnDismiss = onDismiss
        sheetLayer.animate().cancel()
        sheetLayer.removeAllViews()
        sheetLayer.visibility = View.VISIBLE
        sheetLayer.alpha = 1f
        val scrim = View(this).apply {
            setBackgroundColor(P.scrim)
            alpha = 0f
            setOnClickListener { dismissSheet() }
        }
        sheetLayer.addView(scrim, flp(MATCH, MATCH))
        scrim.animate().alpha(1f).setDuration(220).start()

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val r = dp(26).toFloat()
            background = GradientDrawable().apply {
                setColor(P.surface)
                cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
                setStroke(1, P.line)
            }
            setPadding(dp(8), dp(10), dp(8), sysBottom + dp(14))
            isClickable = true
            elevation = dp(12).toFloat()
        }
        card.addView(View(this).apply { background = rounded(P.alpha(P.muted, 0.45f), dp(2).toFloat()) },
            lp(dp(36), dp(4)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(10) })
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        content.build()
        val scroll = ScrollView(this).apply { isVerticalScrollBarEnabled = false; addView(content) }
        card.addView(scroll, lp(MATCH, WRAP))
        val maxW = min(resources.displayMetrics.widthPixels, dp(560))
        sheetLayer.addView(card, flp(maxW, WRAP, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))
        sheetCard = card
        // keep tall sheets below the status bar
        card.post {
            val maxH = root.height - sysTop - dp(24)
            if (card.height > maxH) { scroll.layoutParams = lp(MATCH, maxH - dp(40) - card.paddingBottom); card.requestLayout() }
        }
        card.translationY = dp(420).toFloat()
        card.animate().translationY(0f).setDuration(420).setInterpolator(OvershootInterpolator(0.7f)).start()
    }

    fun dismissSheet() {
        if (!::sheetLayer.isInitialized || sheetLayer.visibility != View.VISIBLE) return
        val cb = sheetOnDismiss
        sheetOnDismiss = null
        cb?.invoke()
        val card = sheetCard
        sheetCard = null
        card?.animate()?.translationY(card.height.toFloat() + dp(40))?.setDuration(220)?.setInterpolator(DecelerateInterpolator())?.start()
        sheetLayer.animate().alpha(0f).setDuration(240).withEndAction {
            sheetLayer.visibility = View.GONE; sheetLayer.removeAllViews(); sheetLayer.alpha = 1f
        }.start()
    }

    /** Marks a prompt as answered so closing the sheet does not also run its "no" path. */
    private fun answered() { sheetOnDismiss = null }

    private fun LinearLayout.sheetTitle(text: String, sub: String? = null) {
        addView(label(text, 17f, P.strong, true).apply { setPadding(dp(16), dp(4), dp(16), 0); maxLines = 2; ellipsize = TextUtils.TruncateAt.END })
        if (sub != null) addView(label(sub, 13.5f, P.muted).apply { setPadding(dp(16), dp(6), dp(16), dp(4)); setLineSpacing(0f, 1.2f) })
        addView(View(context), lp(MATCH, dp(8)))
    }

    private fun LinearLayout.sheetRow(icon: Icon, text: String, sub: String? = null, tint: Int = P.text, enabled: Boolean = true, onClick: () -> Unit) {
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8), 0, dp(12), 0)
            background = ripple(null, dp(14).toFloat())
            isClickable = enabled
            alpha = if (enabled) 1f else 0.4f
            setOnClickListener { onClick() }
            addView(iconView(icon, tint, 22), lp(dp(44), dp(44)))
            val col = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(8), 0, 0, 0)
                addView(label(text, 15.5f, if (tint == P.text) P.text else tint))
                if (sub != null) addView(label(sub, 12.5f, P.muted).apply { setPadding(0, dp(3), 0, 0); maxLines = 2; ellipsize = TextUtils.TruncateAt.END })
            }
            addView(col, lp(0, WRAP, 1f))
        }
        addView(row, lp(MATCH, if (sub == null) dp(52) else dp(62)))
    }

    private fun LinearLayout.sheetSwitch(icon: Icon, text: String, sub: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
        val sw = Switch(context).apply { isChecked = checked; isClickable = false; isFocusable = false }
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8), 0, dp(12), 0)
            background = ripple(null, dp(14).toFloat())
            isClickable = true
            setOnClickListener { sw.isChecked = !sw.isChecked; onChange(sw.isChecked) }
            addView(iconView(icon, P.text, 22), lp(dp(44), dp(44)))
            val col = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(8), 0, dp(8), 0)
                addView(label(text, 15.5f, P.text))
                if (sub != null) addView(label(sub, 12.5f, P.muted).apply { setPadding(0, dp(3), 0, 0) })
            }
            addView(col, lp(0, WRAP, 1f))
            addView(sw)
        }
        addView(row, lp(MATCH, if (sub == null) dp(52) else dp(62)))
    }

    private fun LinearLayout.sheetIcons(vararg items: Triple<Icon, String, Pair<Boolean, () -> Unit>>) {
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(4), 0, dp(4), dp(6))
        }
        items.forEach { (icon, text, act) ->
            val (enabled, onClick) = act
            val cell = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(0, dp(10), 0, dp(8))
                background = ripple(rounded(P.surface2, dp(16).toFloat()), dp(16).toFloat())
                isClickable = enabled
                alpha = if (enabled) 1f else 0.35f
                setOnClickListener { v -> bounce(v); onClick() }
                addView(iconView(icon, P.text, 22), lp(dp(32), dp(32)))
                addView(label(text, 11.5f, P.muted).apply { gravity = Gravity.CENTER; setPadding(0, dp(4), 0, 0) })
            }
            row.addView(cell, lp(0, WRAP, 1f).apply { setMargins(dp(4), 0, dp(4), 0) })
        }
        addView(row, lp(MATCH, WRAP))
    }

    private fun LinearLayout.sheetDivider() {
        addView(View(context).apply { setBackgroundColor(P.line) }, lp(MATCH, 1).apply { setMargins(dp(12), dp(6), dp(12), dp(6)) })
    }

    private fun LinearLayout.sheetButtons(no: String, onNo: () -> Unit, yes: String, danger: Boolean = false, onYes: () -> Unit) {
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            setPadding(dp(12), dp(14), dp(12), dp(2))
        }
        fun btn(text: String, primary: Boolean, click: () -> Unit) = label(text, 15f, if (primary) P.onAccent else P.text, true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(22), 0, dp(22), 0)
            background = ripple(
                if (primary) rounded(if (danger) P.bad else P.accentBg, dp(22).toFloat()) else rounded(0, dp(22).toFloat(), 1, P.border),
                dp(22).toFloat()
            )
            if (primary && danger) setTextColor(if (P.dark) 0xFF1A0B0B.toInt() else 0xFFFFFFFF.toInt())
            isClickable = true
            setOnClickListener { click() }
        }
        row.addView(btn(no, false, onNo), lp(WRAP, dp(44)).apply { marginEnd = dp(10) })
        row.addView(btn(yes, true, onYes), lp(WRAP, dp(44)))
        addView(row, lp(MATCH, WRAP))
    }

    private fun LinearLayout.sheetNote(text: String, color: Int = P.muted) {
        addView(label(text, 13.5f, color).apply { setPadding(dp(16), dp(2), dp(16), dp(6)); setLineSpacing(0f, 1.2f) })
    }

    // ------------------------------------------------------------------------------------------
    // main menu and site info

    private fun showMenu() {
        val t = current ?: return
        val web = t.web
        val site = !Urls.isInternal(t.url) && t.url.startsWith("http")
        val marked = site && db.isBookmarked(t.url)
        sheet {
            sheetIcons(
                Triple(Icons.fwd, "Forward", (web?.canGoForward() == true) to { dismissSheet(); web?.goForward(); Unit }),
                Triple(if (marked) Icons.bookmarkFilled else Icons.bookmark, if (marked) "Saved" else "Bookmark", site to {
                    if (marked) { db.removeBookmark(t.url); toast("Bookmark removed") } else { db.addBookmark(t.url, t.title); toast("Bookmarked") }
                    dismissSheet()
                }),
                Triple(Icons.reload, "Reload", (web != null) to { dismissSheet(); web?.reload(); Unit }),
                Triple(Icons.share, "Share", site to { dismissSheet(); share(t.url, t.title) }),
            )
            if (site) {
                val host = Urls.host(t.url)
                val off = host in settings.siteAllow || !settings.blockAds
                sheetRow(Icons.shield,
                    if (off) "Protection is off for $host" else if (t.blocked == 0) "Shield is on" else "Shield blocked ${t.blocked} ad${if (t.blocked == 1) "" else "s"} and trackers",
                    "Tap for site settings", tint = if (off) P.muted else P.accent) { dismissSheet(); showSiteInfo() }
            }
            sheetIcons(
                Triple(Icons.orbit, "Orbits", true to { dismissSheet(); openPage("orbits") }),
                Triple(Icons.trail, "Trail", true to { dismissSheet(); openPage("trail", t.trailNode?.let { "#n=$it" } ?: "") }),
                Triple(Icons.camera, "Snapshots", true to { dismissSheet(); openPage("snapshots") }),
                Triple(Icons.focus, if (features.focusActive()) "Focus on" else "Focus", true to { dismissSheet(); openPage("focus") }),
            )
            sheetDivider()
            if (site) sheetRow(Icons.book, "Reader view", "A clean page with read aloud") { dismissSheet(); features.openReader(t) }
            sheetRow(Icons.plus, "New tab") { dismissSheet(); newTab(Urls.NEWTAB, false) }
            if (privateSupported()) sheetRow(Icons.mask, "New private tab", tint = P.priv) { dismissSheet(); newTab(Urls.NEWTAB, true) }
            sheetRow(Icons.bookmark, "Bookmarks") { dismissSheet(); openPage("bookmarks") }
            sheetRow(Icons.clock, "History") { dismissSheet(); openPage("history") }
            sheetRow(Icons.download, "Downloads") { dismissSheet(); openPage("downloads") }
            sheetRow(Icons.find, "Find in page", enabled = web != null && !t.isNewTab) { dismissSheet(); openFind() }
            if (site || t.desktop) sheetSwitch(Icons.desktop, "Desktop site", null, t.desktop) { on -> t.setDesktopMode(on); Handler(Looper.getMainLooper()).postDelayed({ dismissSheet() }, 180) }
            if (site) sheetRow(Icons.homeAdd, "Add to home screen") { dismissSheet(); addToHome(t) }
            sheetRow(Icons.gear, "Settings") { dismissSheet(); openPage("settings") }
        }
    }

    /** Open one of Tide's pages: reuse an empty new tab, otherwise open a new one. */
    private fun openPage(name: String, hash: String = "") = openPanel(Urls.page(name) + hash)

    private fun showSiteInfo() {
        val t = current ?: return
        if (t.isNewTab) { openEditor(); return }
        if (Urls.isInternal(t.url)) { sheet { sheetTitle("Tide page", "This page is part of Tide and runs on your phone.") }; return }
        val host = Urls.host(t.url)
        sheet {
            sheetTitle(host.removePrefix("www."),
                when {
                    t.secure -> "Connection is secure. What you send to this site is encrypted."
                    t.url.startsWith("http://") -> "Connection is not secure. Don't enter passwords or card details on this site."
                    else -> null
                })
            val blockOn = host !in settings.siteAllow
            if (settings.blockAds) {
                sheetNote(if (!blockOn) "Ad and tracker blocking is off for this site." else if (t.blocked == 0) "Nothing blocked on this page yet." else "${t.blocked} ad and tracker request${if (t.blocked == 1) "" else "s"} blocked on this page.",
                    if (blockOn && t.blocked > 0) P.accent else P.muted)
                sheetSwitch(Icons.shield, "Block ads and trackers here", null, blockOn) { on ->
                    settings.siteAllow = if (on) settings.siteAllow - host else settings.siteAllow + host
                    t.web?.reload()
                }
            } else sheetNote("Ad and tracker blocking is off in Settings.")
            sheetRow(Icons.x, "Forget this site", "Delete its cookies and stored data") {
                dismissSheet()
                forgetSite(t)
            }
            sheetRow(Icons.copy, "Copy link") { dismissSheet(); copyText(t.url, "Link copied") }
        }
    }

    private fun forgetSite(t: Tab) {
        val url = t.url
        val host = Urls.host(url)
        val cm = t.cookies()
        cm.getCookie(url)?.split(";")?.map { it.substringBefore('=').trim() }?.filter { it.isNotEmpty() }?.forEach { name ->
            for (d in listOf("", "; Domain=$host", "; Domain=.${host.removePrefix("www.")}")) {
                cm.setCookie(url, "$name=; Max-Age=0; Path=/$d")
            }
        }
        cm.flush()
        val origin = Uri.parse(url).let { "${it.scheme}://${it.authority}" }
        try {
            if (t.private) t.web?.let { WebViewCompat.getProfile(it).webStorage.deleteOrigin(origin) } else WebStorage.getInstance().deleteOrigin(origin)
        } catch (_: Exception) {}
        t.web?.reload()
        toast("Tide forgot $host")
    }

    fun showLinkMenu(t: Tab, link: String?, image: String?) {
        val target = link ?: image ?: return
        sheet {
            sheetTitle(target.take(300))
            if (link != null) {
                sheetRow(Icons.plus, "Open in new tab") { dismissSheet(); newTab(link, t.private, switch = false, opener = t); toast("Opened in a new tab") }
                if (!t.private && privateSupported()) sheetRow(Icons.mask, "Open in private tab", tint = P.priv) { dismissSheet(); newTab(link, true) }
                sheetRow(Icons.copy, "Copy link") { dismissSheet(); copyText(link, "Link copied") }
                sheetRow(Icons.share, "Share link") { dismissSheet(); share(link, null) }
            }
            if (image != null && (image.startsWith("http://") || image.startsWith("https://"))) {
                if (link != null) sheetDivider()
                sheetRow(Icons.image, "Open image in new tab") { dismissSheet(); newTab(image, t.private, switch = false, opener = t); toast("Opened in a new tab") }
                sheetRow(Icons.download, "Download image") { dismissSheet(); askDownload(t, image, t.web?.settings?.userAgentString ?: "", null, null, -1) }
                if (link == null) sheetRow(Icons.copy, "Copy image link") { dismissSheet(); copyText(image, "Link copied") }
            }
        }
    }

    // ------------------------------------------------------------------------------------------
    // things websites ask for

    fun openExternal(t: Tab, uri: Uri, gesture: Boolean, redirect: Boolean) {
        if (!gesture && !redirect) return
        val intent = try {
            if (uri.scheme == "intent") Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME) else Intent(Intent.ACTION_VIEW, uri)
        } catch (_: Exception) { return }
        intent.addCategory(Intent.CATEGORY_BROWSABLE)
        intent.component = null
        intent.selector = null
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val fallback = intent.getStringExtra("browser_fallback_url")?.takeIf { it.startsWith("https://") || it.startsWith("http://") }
        val launch = {
            try { startActivity(intent) } catch (_: ActivityNotFoundException) {
                when {
                    fallback != null -> t.load(fallback)
                    intent.`package` != null -> try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=${intent.`package`}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) { toast("No app on this phone can open this link") }
                    else -> toast("No app on this phone can open this link")
                }
            } catch (_: SecurityException) { toast("That app can't be opened from a link") }
        }
        if (gesture) { launch(); return }
        // The page tried to leave Tide on its own (a redirect). Ask first.
        sheet {
            sheetTitle("Open another app?", "${Urls.shortHost(t.url).ifEmpty { "This page" }} wants to open a ${uri.scheme}: link outside Tide.")
            sheetButtons("Stay here", { dismissSheet() }, "Open") { dismissSheet(); launch() }
        }
    }

    fun askDownload(t: Tab, url: String, ua: String, disposition: String?, mime: String?, length: Long) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) { toast("Tide can't save this kind of download yet"); return }
        val name = URLUtil.guessFileName(url, disposition, mime)
        val risky = Downloads.isRisky(name)
        sheet {
            sheetTitle("Download file?", name + if (length > 0) "  ·  " + Formatter.formatShortFileSize(this@MainActivity, length) else "")
            sheetNote("From ${Urls.host(url)}")
            if (risky) sheetNote("This kind of file can install apps or run code. Only open it if you trust where it came from.", P.bad)
            sheetButtons("Cancel", { dismissSheet() }, "Download") {
                dismissSheet()
                val cookie = try { t.cookies().getCookie(url) } catch (_: Exception) { null }
                val start = { downloads.start(url, name, mime, ua.ifEmpty { t.web?.settings?.userAgentString ?: "" }, cookie) }
                if (Build.VERSION.SDK_INT < 29) withAllPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE)) { ok -> if (ok) start() else toast("Tide needs storage access to save downloads") }
                else start()
            }
        }
    }

    private fun withPermissions(perms: Array<String>, done: (Map<String, Boolean>) -> Unit) {
        val missing = perms.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) { done(perms.associateWith { true }); return }
        permDone = { r -> done(perms.associateWith { r[it] == true || checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) }
        permLauncher.launch(missing.toTypedArray())
    }

    private fun withAllPermissions(perms: Array<String>, done: (Boolean) -> Unit) = withPermissions(perms) { m -> done(m.values.all { it }) }

    fun askSitePermission(t: Tab, req: PermissionRequest) {
        val wanted = req.resources.filter { it == PermissionRequest.RESOURCE_VIDEO_CAPTURE || it == PermissionRequest.RESOURCE_AUDIO_CAPTURE || it == PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID }
        if (wanted.isEmpty() || t !== current) { req.deny(); return }
        val origin = req.origin.toString()
        val host = Urls.host(origin)
        val grant = {
            val osNeeded = buildList {
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE in wanted) add(Manifest.permission.CAMERA)
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE in wanted) add(Manifest.permission.RECORD_AUDIO)
            }.toTypedArray()
            withPermissions(osNeeded) { m: Map<String, Boolean> ->
                val ok = wanted.filter {
                    when (it) {
                        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> m[Manifest.permission.CAMERA] == true
                        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> m[Manifest.permission.RECORD_AUDIO] == true
                        else -> true
                    }
                }
                if (ok.isEmpty()) { req.deny(); toast("Turn on the permission for Tide in Android settings") } else req.grant(ok.toTypedArray())
            }
        }
        if (allowedMedia[origin]?.containsAll(wanted) == true) { grant(); return }
        val what = when {
            PermissionRequest.RESOURCE_VIDEO_CAPTURE in wanted && PermissionRequest.RESOURCE_AUDIO_CAPTURE in wanted -> "use your camera and microphone"
            PermissionRequest.RESOURCE_VIDEO_CAPTURE in wanted -> "use your camera"
            PermissionRequest.RESOURCE_AUDIO_CAPTURE in wanted -> "use your microphone"
            else -> "play protected content"
        }
        sheet(onDismiss = { try { req.deny() } catch (_: Exception) {} }) {
            sheetTitle("$host wants to $what", "Only allow sites you trust. Tide remembers your answer until you close the app.")
            sheetButtons("Block", { dismissSheet() }, "Allow") {
                answered(); dismissSheet()
                allowedMedia.getOrPut(origin) { mutableSetOf() }.addAll(wanted)
                grant()
            }
        }
    }

    fun askLocation(t: Tab, origin: String, cb: GeolocationPermissions.Callback) {
        val host = Urls.host(origin)
        if (t.private) { cb.invoke(origin, false, false); return }
        sheet(onDismiss = { cb.invoke(origin, false, false) }) {
            sheetTitle("$host wants to know your location", "Only allow sites you trust. Tide remembers your answer until you close the app.")
            sheetButtons("Block", { dismissSheet() }, "Allow") {
                answered(); dismissSheet()
                withPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) { m: Map<String, Boolean> ->
                    val ok = m.values.any { it }
                    cb.invoke(origin, ok, false)
                    if (!ok) toast("Turn on location for Tide in Android settings")
                }
            }
        }
    }

    fun openFileChooser(cb: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        fileCallback?.onReceiveValue(null)
        fileCallback = cb
        return try {
            val i = params.createIntent()
            if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            fileLauncher.launch(i)
            true
        } catch (_: ActivityNotFoundException) {
            fileCallback = null
            cb.onReceiveValue(null)
            toast("No app on this phone can pick files")
            true
        }
    }

    fun enterFullscreen(v: View, cb: WebChromeClient.CustomViewCallback) {
        if (fullView != null) { cb.onCustomViewHidden(); return }
        fullView = v; fullCallback = cb
        fullLayer.addView(v, flp(MATCH, MATCH))
        fullLayer.visibility = View.VISIBLE
        WindowInsetsControllerCompat(window, root).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    fun exitFullscreen() {
        val v = fullView ?: return
        fullView = null
        fullCallback = null
        fullLayer.removeView(v)
        fullLayer.visibility = View.GONE
        WindowInsetsControllerCompat(window, root).show(WindowInsetsCompat.Type.systemBars())
    }

    // ------------------------------------------------------------------------------------------
    // settings actions

    fun clearData(history: Boolean, cookies: Boolean, cache: Boolean) {
        if (history) db.clearHistory()
        if (cookies) {
            android.webkit.CookieManager.getInstance().removeAllCookies(null)
            WebStorage.getInstance().deleteAllData()
        }
        if (cache) (tabs.firstOrNull { it.web != null && !it.private }?.web ?: current?.web)?.clearCache(true)
        toast("Browsing data cleared")
    }

    fun isDefaultBrowser(): Boolean {
        if (Build.VERSION.SDK_INT >= 29) {
            val rm = getSystemService(RoleManager::class.java)
            if (rm != null && rm.isRoleAvailable(RoleManager.ROLE_BROWSER)) return rm.isRoleHeld(RoleManager.ROLE_BROWSER)
        }
        val r = packageManager.resolveActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com")), PackageManager.MATCH_DEFAULT_ONLY)
        return r?.activityInfo?.packageName == packageName
    }

    fun askDefaultBrowser() {
        if (Build.VERSION.SDK_INT >= 29) {
            val rm = getSystemService(RoleManager::class.java)
            if (rm != null && rm.isRoleAvailable(RoleManager.ROLE_BROWSER) && !rm.isRoleHeld(RoleManager.ROLE_BROWSER)) {
                try { roleLauncher.launch(rm.createRequestRoleIntent(RoleManager.ROLE_BROWSER)); return } catch (_: Exception) {}
            }
        }
        try { startActivity(Intent(SysSettings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)) } catch (_: Exception) { startActivity(Intent(SysSettings.ACTION_SETTINGS)) }
    }

    private fun addToHome(t: Tab) {
        if (!ShortcutManagerCompat.isRequestPinShortcutSupported(this)) { toast("Your home screen doesn't support this"); return }
        val icon = t.favicon?.let { IconCompat.createWithBitmap(siteIcon(it)) } ?: IconCompat.createWithResource(this, R.mipmap.ic_launcher)
        val label = t.title.ifBlank { Urls.shortHost(t.url) }.take(40)
        val info = ShortcutInfoCompat.Builder(this, "site-" + t.url.hashCode())
            .setShortLabel(label.ifBlank { "Site" })
            .setIcon(icon)
            .setIntent(Intent(this, MainActivity::class.java).setAction(Intent.ACTION_VIEW).setData(Uri.parse(t.url)))
            .build()
        ShortcutManagerCompat.requestPinShortcut(this, info, null)
    }

    private fun siteIcon(fav: Bitmap): Bitmap {
        val size = 192
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFF4F5F8.toInt() }
        c.drawCircle(size / 2f, size / 2f, size / 2f, p)
        val inner = Bitmap.createScaledBitmap(fav, 104, 104, true)
        c.drawBitmap(inner, (size - 104) / 2f, (size - 104) / 2f, Paint(Paint.FILTER_BITMAP_FLAG))
        return out
    }

    // ------------------------------------------------------------------------------------------
    // small helpers

    fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()

    private fun copyText(text: String, done: String) {
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("link", text))
        if (Build.VERSION.SDK_INT < 33) toast(done) // Android 13 and later show their own notice
    }

    private fun share(url: String, title: String?) {
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url)
        if (!title.isNullOrBlank()) send.putExtra(Intent.EXTRA_TITLE, title)
        startActivity(Intent.createChooser(send, null))
    }

    companion object {
        const val PRIVATE_PROFILE = "tide-private"
        fun privateSupported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
    }
}
