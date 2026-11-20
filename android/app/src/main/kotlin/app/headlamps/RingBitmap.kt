package app.headlamps

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.Icon
import android.os.Build
import android.widget.RemoteViews
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/** Colours of the text and the tracks inside a ring bitmap. */
data class RingNeutrals(val text: Int, val textMuted: Int)

/** Largest edge of a ring bitmap in pixels. */
const val RING_MAX_EDGE_PX = 600

/**
 * Draws one usage ring into a bitmap. The code only follows the numbers of [ringGeometry].
 * The bitmap is exactly [diameterDp] times [density] pixels wide, so that nothing scales it.
 */
fun renderRing(
    ring: PanelRing,
    shortLabel: String,
    diameterDp: Double,
    density: Float,
    dark: Boolean,
    neutrals: RingNeutrals,
): Bitmap {
    val px = (diameterDp * density).roundToInt().coerceIn(1, RING_MAX_EDGE_PX)
    val pxPerDp = px / diameterDp
    val geometry = ringGeometry(ring, diameterDp, dark)
    val bitmap = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val centre = px / 2f
    val radius = px / 2f
    val trackColour = (neutrals.text and 0x00FFFFFF) or (0x1F shl 24)

    fun ringRect(fraction: Double): RectF {
        val r = (fraction * radius).toFloat()
        return RectF(centre - r, centre - r, centre + r, centre + r)
    }

    val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.BUTT
    }

    fun drawBand(band: Band, start: Double, sweep: Double, colour: Int) {
        stroke.color = colour
        stroke.strokeWidth = ((band.outer - band.inner) * radius).toFloat()
        val rect = ringRect(band.mid)
        if (sweep >= 360.0 - 1e-6) {
            canvas.drawOval(rect, stroke)
        } else {
            canvas.drawArc(rect, (start - 90.0).toFloat(), sweep.toFloat(), false, stroke)
        }
    }

    drawBand(geometry.track, 0.0, 360.0, trackColour)
    drawBand(geometry.statusBand, 0.0, 360.0, trackColour)
    if (geometry.statusSweepDeg > 0.0) drawBand(geometry.statusBand, 0.0, geometry.statusSweepDeg, geometry.statusColour)
    for (arc in geometry.arcs) drawBand(arc.band, arc.startDeg, arc.sweepDeg, arc.colour)

    if (geometry.separators.isNotEmpty()) {
        val clear = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.BUTT
            strokeWidth = pxPerDp.toFloat()
            xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
        }
        for (separator in geometry.separators) {
            val angle = Math.toRadians(separator.angleDeg - 90.0)
            val dx = cos(angle).toFloat()
            val dy = sin(angle).toFloat()
            canvas.drawLine(
                centre + dx * (separator.inner * radius).toFloat(),
                centre + dy * (separator.inner * radius).toFloat(),
                centre + dx * (separator.outer * radius).toFloat(),
                centre + dy * (separator.outer * radius).toFloat(),
                clear,
            )
        }
    }

    drawCentre(canvas, centre, radius, usedPercentText(ring), shortLabel, neutrals)
    return bitmap
}

private fun drawCentre(canvas: Canvas, centre: Float, radius: Float, top: String, bottom: String, neutrals: RingNeutrals) {
    val topPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = neutrals.text
        typeface = Typeface.DEFAULT_BOLD
        textAlign = Paint.Align.CENTER
        textSize = (CENTRE_TOP_HEIGHT * radius).toFloat()
    }
    val bottomPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = neutrals.textMuted
        textAlign = Paint.Align.CENTER
        textSize = (CENTRE_BOTTOM_HEIGHT * radius).toFloat()
    }
    val topBounds = Rect().also { topPaint.getTextBounds(top, 0, top.length, it) }
    val bottomBounds = Rect().also { bottomPaint.getTextBounds(bottom, 0, bottom.length, it) }
    val gap = 0.06 * radius
    val scale = centreFitScale(
        topBounds.width().toDouble(), topBounds.height().toDouble(),
        bottomBounds.width().toDouble(), bottomBounds.height().toDouble(),
        gap, CENTRE_RADIUS * radius,
    ).toFloat()
    topPaint.textSize *= scale
    bottomPaint.textSize *= scale
    topPaint.getTextBounds(top, 0, top.length, topBounds)
    bottomPaint.getTextBounds(bottom, 0, bottom.length, bottomBounds)
    val gapScaled = gap.toFloat() * scale
    val block = topBounds.height() + gapScaled + bottomBounds.height()
    val blockTop = centre - block / 2
    // Rect bounds are relative to the baseline: top is negative, bottom is the descent.
    canvas.drawText(top, centre, blockTop - topBounds.top, topPaint)
    canvas.drawText(bottom, centre, blockTop + topBounds.height() + gapScaled - bottomBounds.top, bottomPaint)
}

private fun isNight(context: Context): Boolean =
    (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

/** Neutral colours of one mode. API 31 and later read the system neutrals, as GlanceTheme does. */
private fun neutralsFor(context: Context, dark: Boolean): RingNeutrals =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        if (dark) {
            RingNeutrals(context.getColor(android.R.color.system_neutral1_100), context.getColor(android.R.color.system_neutral2_200))
        } else {
            RingNeutrals(context.getColor(android.R.color.system_neutral1_900), context.getColor(android.R.color.system_neutral2_700))
        }
    } else {
        // Below API 31 the resources already follow the current mode.
        RingNeutrals(context.getColor(R.color.preview_text), context.getColor(R.color.preview_text_muted))
    }

/**
 * The RemoteViews of one ring. API 31 and later hold a light and a dark bitmap, so that the
 * launcher can switch the theme without the app. Older versions hold one bitmap for the current mode.
 */
fun ringRemoteViews(context: Context, ring: PanelRing, shortLabel: String, diameterDp: Double): RemoteViews {
    val density = context.resources.displayMetrics.density
    val views = RemoteViews(context.packageName, R.layout.ring_image)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val light = renderRing(ring, shortLabel, diameterDp, density, false, neutralsFor(context, false))
        val dark = renderRing(ring, shortLabel, diameterDp, density, true, neutralsFor(context, true))
        views.setIcon(R.id.ring, "setImageIcon", Icon.createWithBitmap(light), Icon.createWithBitmap(dark))
    } else {
        val night = isNight(context)
        views.setImageViewBitmap(R.id.ring, renderRing(ring, shortLabel, diameterDp, density, night, neutralsFor(context, night)))
    }
    views.setContentDescription(R.id.ring, ringDescription(shortLabel, ring))
    return views
}
