package com.tide.browser

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.graphics.ColorUtils
import androidx.core.graphics.PathParser
import kotlin.math.min

/** Colours from res/values(-night)/colors.xml, which mirror the desktop theme tokens. */
object P {
    var bg = 0; var surface = 0; var surface2 = 0; var line = 0; var border = 0
    var text = 0; var strong = 0; var muted = 0; var accent = 0; var accentBg = 0; var onAccent = 0
    var ok = 0; var bad = 0; var priv = 0; var scrim = 0
    var dark = true

    fun load(c: Context) {
        bg = c.getColor(R.color.bg); surface = c.getColor(R.color.surface); surface2 = c.getColor(R.color.surface2)
        line = c.getColor(R.color.line); border = c.getColor(R.color.border)
        text = c.getColor(R.color.text); strong = c.getColor(R.color.text_strong); muted = c.getColor(R.color.muted)
        accent = c.getColor(R.color.accent); accentBg = c.getColor(R.color.accent_bg); onAccent = c.getColor(R.color.on_accent)
        ok = c.getColor(R.color.ok); bad = c.getColor(R.color.bad); priv = c.getColor(R.color.private_tint); scrim = c.getColor(R.color.scrim)
        dark = ColorUtils.calculateLuminance(bg) < 0.5
    }

    fun alpha(color: Int, a: Float): Int = ColorUtils.setAlphaComponent(color, (a * 255).toInt().coerceIn(0, 255))
}

fun Context.dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()
fun Context.dp(v: Int): Int = dp(v.toFloat())
fun View.dp(v: Int): Int = context.dp(v)

fun rounded(color: Int, radius: Float, stroke: Int = 0, strokeColor: Int = 0): GradientDrawable =
    GradientDrawable().apply {
        setColor(color)
        cornerRadius = radius
        if (stroke > 0) setStroke(stroke, strokeColor)
    }

/** Background with a ripple, so every button gives touch feedback. */
fun ripple(content: Drawable?, radius: Float): RippleDrawable {
    val mask = GradientDrawable().apply { setColor(0xFFFFFFFF.toInt()); cornerRadius = radius }
    return RippleDrawable(ColorStateList.valueOf(P.alpha(P.text, 0.12f)), content, mask)
}

fun lp(w: Int, h: Int, weight: Float = 0f) = LinearLayout.LayoutParams(w, h, weight)
fun flp(w: Int, h: Int, gravity: Int = Gravity.NO_GRAVITY) = FrameLayout.LayoutParams(w, h, gravity)
const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT

fun Context.label(text: CharSequence, size: Float = 15f, color: Int = P.text, bold: Boolean = false): TextView =
    TextView(this).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        setTextColor(color)
        if (bold) typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
        includeFontPadding = false
    }

/** An icon drawn at [sizeDp], centred in whatever box the view is laid out in. */
fun Context.iconView(icon: Icon, color: Int = P.text, sizeDp: Int = 22): ImageView =
    ImageView(this).apply {
        setImageDrawable(IconDrawable(icon, color))
        scaleType = ImageView.ScaleType.FIT_CENTER
        val want = dp(sizeDp)
        addOnLayoutChangeListener { v, l, t, r, b, _, _, _, _ ->
            val ph = ((r - l - want) / 2).coerceAtLeast(0)
            val pv = ((b - t - want) / 2).coerceAtLeast(0)
            if (v.paddingLeft != ph || v.paddingTop != pv) v.post { v.setPadding(ph, pv, ph, pv) }
        }
    }

/** A round icon button with ripple and a small press bounce. */
fun Context.iconButton(icon: Icon, desc: String, color: Int = P.text, sizeDp: Int = 22, onClick: (View) -> Unit): ImageView =
    iconView(icon, color, sizeDp).apply {
        contentDescription = desc
        background = ripple(null, dp(22).toFloat())
        isClickable = true
        isFocusable = true
        setOnClickListener { v -> bounce(v); onClick(v) }
        tooltipText = desc
    }

fun bounce(v: View) {
    v.animate().cancel()
    v.scaleX = 0.86f; v.scaleY = 0.86f
    v.animate().scaleX(1f).scaleY(1f).setDuration(380).setInterpolator(android.view.animation.OvershootInterpolator(3f)).start()
}

// ---------------------------------------------------------------------------------------------
// Icons: the same 24-unit line drawings as the desktop toolbar (src/ui/index.html), drawn as paths.

class Part(val path: Path, val width: Float, val fill: Boolean)
class Icon(vararg val parts: Part)

class IconDrawable(private val icon: Icon, color: Int) : Drawable() {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; this.color = color
    }
    var color: Int
        get() = paint.color
        set(v) { paint.color = v; invalidateSelf() }

    override fun draw(canvas: Canvas) {
        val b = bounds
        val s = min(b.width(), b.height()) / 24f
        canvas.save()
        canvas.translate(b.left + (b.width() - 24 * s) / 2f, b.top + (b.height() - 24 * s) / 2f)
        canvas.scale(s, s)
        for (p in icon.parts) {
            paint.style = if (p.fill) Paint.Style.FILL else Paint.Style.STROKE
            paint.strokeWidth = p.width
            canvas.drawPath(p.path, paint)
        }
        canvas.restore()
    }

    override fun setAlpha(alpha: Int) { paint.alpha = alpha; invalidateSelf() }
    override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter; invalidateSelf() }
    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
    override fun getIntrinsicWidth() = -1
    override fun getIntrinsicHeight() = -1
}

object Icons {
    private fun s(d: String, w: Float = 1.7f) = Part(PathParser.createPathFromPathData(d), w, false)
    private fun f(d: String) = Part(PathParser.createPathFromPathData(d), 0f, true)
    private fun c(cx: Float, cy: Float, r: Float) = "M${cx - r},${cy}a$r,$r 0 1,0 ${2 * r},0a$r,$r 0 1,0 ${-2 * r},0"
    private fun rect(x: Float, y: Float, w: Float, h: Float, r: Float) =
        "M${x + r},${y}h${w - 2 * r}a$r,$r 0 0 1 $r,$r v${h - 2 * r}a$r,$r 0 0 1 -$r,$r h${-(w - 2 * r)}a$r,$r 0 0 1 -$r,-$r v${-(h - 2 * r)}a$r,$r 0 0 1 $r,-$r z"

    val tide = Icon(s(c(12f, 12f, 9.6f), 1.6f), s("M2.6 10.4q2.35-2.4 4.7 0t4.7 0t4.7 0t4.7 0", 1.6f), s("M4 15.4q2.1 2.1 4.2 0t4.2 0t4.2 0t3.4 0", 1.6f))
    val back = Icon(s("M19 12H5M11 5.5L4.5 12l6.5 6.5"))
    val fwd = Icon(s("M5 12h14M13 5.5l6.5 6.5-6.5 6.5"))
    val reload = Icon(s("M19.5 12a7.5 7.5 0 1 1-2.4-5.5M19.5 4v4.5H15"))
    val x = Icon(s("M6 6l12 12M18 6L6 18"))
    val plus = Icon(s("M12 5v14M5 12h14"))
    val search = Icon(s(c(10.5f, 10.5f, 6.5f)), s("M15.5 15.5L20.5 20.5"))
    val home = Icon(s("M3.5 11L12 3.5 20.5 11M5.5 9.5V20h5v-6h3v6h5V9.5", 1.6f))
    val bookmark = Icon(s("M6.5 3.5h11v17L12 16.5l-5.5 4z", 1.6f))
    val bookmarkFilled = Icon(f("M6.5 3.5h11v17L12 16.5l-5.5 4z"), s("M6.5 3.5h11v17L12 16.5l-5.5 4z", 1.6f))
    val clock = Icon(s(c(12f, 12f, 8.5f), 1.6f), s("M12 7v5.2l3.2 2", 1.6f))
    val download = Icon(s("M12 4v11M7.5 10.5L12 15l4.5-4.5M4.5 19.5h15", 1.6f))
    val gear = Icon(s(c(12f, 12f, 3f), 1.6f), s("M12 2.8l1.6 2.2 2.7-.5.9 2.6 2.6.9-.5 2.7 2.2 1.6-2.2 1.6.5 2.7-2.6.9-.9 2.6-2.7-.5L12 21.2 10.4 19l-2.7.5-.9-2.6-2.6-.9.5-2.7L2.5 11.7 4.7 10l-.5-2.7 2.6-.9.9-2.6 2.7.5z", 1.6f))
    val dots = Icon(f(c(12f, 5f, 1.6f)), f(c(12f, 12f, 1.6f)), f(c(12f, 19f, 1.6f)))
    val lock = Icon(s(rect(5f, 10.5f, 14f, 9.5f, 2.2f)), s("M8 10.5V8a4 4 0 0 1 8 0v2.5"))
    val warn = Icon(s("M12 3.5l9 16H3z"), s("M12 10v4.5M12 17.2v.1"))
    val shield = Icon(s("M12 3l7.5 2.7v5.6c0 4.6-3.1 8.2-7.5 9.7-4.4-1.5-7.5-5.1-7.5-9.7V5.7z"))
    val share = Icon(s("M12 15V3.8M7.8 7.8L12 3.6l4.2 4.2M5 12.5v5.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5.5"))
    val find = Icon(s(c(10.5f, 10.5f, 6.5f)), s("M15.5 15.5L20.5 20.5"), s("M8 10.5h5"))
    val desktop = Icon(s(rect(3f, 4.5f, 18f, 12f, 2f), 1.6f), s("M9 20h6M12 16.5V20", 1.6f))
    val mask = Icon(s(c(7f, 15.5f, 3f), 1.6f), s(c(17f, 15.5f, 3f), 1.6f), s("M10 15.2q2-1.3 4 0M3.5 11h17M7 11l1.4-5.5h7.2L17 11", 1.6f))
    val globe = Icon(s(c(12f, 12f, 8.5f), 1.6f), s("M3.5 12h17M12 3.5c2.6 2.4 3.6 5.2 3.6 8.5s-1 6.1-3.6 8.5c-2.6-2.4-3.6-5.2-3.6-8.5s1-6.1 3.6-8.5z", 1.6f))
    val arrowUpLeft = Icon(s("M17 17L7 7M7 15V7h8"))
    val chevUp = Icon(s("M6 15l6-6 6 6"))
    val chevDown = Icon(s("M6 9l6 6 6-6"))
    val homeAdd = Icon(s(rect(6f, 2.5f, 12f, 19f, 2.5f), 1.6f), s("M12 9v6M9 12h6", 1.6f))
    val link = Icon(s("M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"))
    val copy = Icon(s(rect(8.5f, 8.5f, 11.5f, 11.5f, 2f)), s("M15.5 5.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h.5"))
    val image = Icon(s(rect(3.5f, 4.5f, 17f, 15f, 2.5f), 1.6f), s(c(9f, 10f, 1.8f), 1.6f), s("M20.5 16l-4.5-4.5-8.5 8", 1.6f))
    val star = Icon(s("M12 3.2l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.5l6-.8z", 1.5f))
    val tabs = Icon(s(rect(4f, 4f, 16f, 16f, 4f), 1.7f))
    val orbit = Icon(f(c(12f, 12f, 3.2f)), s("M3.39,16.01a9.5,4.2 -25 1,0 17.22,-8.02a9.5,4.2 -25 1,0 -17.22,8.02", 1.4f), f(c(19.2f, 6.2f, 1.7f)))
    val trail = Icon(s("M6 18.5c0-5 5-4 6-6.5s0-6 6-6.5", 1.6f), f(c(6f, 18.5f, 2.2f)), f(c(12f, 12f, 1.8f)), f(c(18f, 5.5f, 2.2f)))
    val camera = Icon(s("M3.5 8.5a2 2 0 0 1 2-2h2l1.3-2h6.4l1.3 2h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z", 1.6f), s(c(12f, 13f, 3.6f), 1.6f))
    val focus = Icon(s(c(12f, 12f, 8.5f), 1.6f), s(c(12f, 12f, 4.6f), 1.6f), f(c(12f, 12f, 1.5f)))
    val book = Icon(s("M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5z"), s("M12 6.5V19.5"))
}

/** Centre-cropped square with the first letter, used when a site has no icon yet. */
fun Context.letterBadge(text: String, sizeDp: Int = 28): TextView = label(text.take(1).uppercase(), 13f, P.strong, true).apply {
    gravity = Gravity.CENTER
    background = rounded(P.surface2, dp(8).toFloat(), 1, P.border)
    layoutParams = lp(dp(sizeDp), dp(sizeDp))
}
