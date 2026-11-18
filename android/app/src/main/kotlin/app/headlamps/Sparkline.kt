package app.headlamps

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path

/**
 * Scales values to pixel positions, oldest on the left. Y grows downward.
 * A flat series draws a line in the middle. Fewer than two points give an empty list.
 */
fun sparklinePoints(values: List<Double>, width: Float, height: Float, pad: Float = 2f): List<Pair<Float, Float>> {
    if (values.size < 2) return emptyList()
    val min = values.min()
    val max = values.max()
    val span = max - min
    val usableW = width - 2 * pad
    val usableH = height - 2 * pad
    return values.mapIndexed { i, v ->
        val x = pad + usableW * i / (values.size - 1)
        val y = if (span == 0.0) height / 2 else pad + usableH * (1 - ((v - min) / span).toFloat())
        x to y
    }
}

/** Draws a line chart without axes. Glance has no canvas, so the widget shows this bitmap. */
fun renderSparkline(values: List<Double>, argb: Int, width: Int = 480, height: Int = 96): Bitmap? {
    val points = sparklinePoints(values, width.toFloat(), height.toFloat(), pad = 4f)
    if (points.isEmpty()) return null
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = argb
        style = Paint.Style.STROKE
        strokeWidth = 4f
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    val path = Path()
    points.forEachIndexed { i, (x, y) -> if (i == 0) path.moveTo(x, y) else path.lineTo(x, y) }
    canvas.drawPath(path, paint)
    return bitmap
}
