package dev.remagnet.app.download

/**
 * A small exponentially weighted speed meter for streaming downloads.
 *
 * The clock is injectable so the tests can drive it without sleeping. Samples
 * closer together than [MIN_INTERVAL_MS] keep the previous value; that keeps a
 * slow 64 KiB stream from producing a noisy number.
 */
class SpeedMeter(
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private var started = false
    private var lastTime = 0L
    private var lastBytes = 0L
    private var speed = 0.0

    fun sample(bytes: Long): Long {
        val now = clock()
        if (!started) {
            started = true
            lastTime = now
            lastBytes = bytes
            return 0
        }

        val elapsed = now - lastTime
        if (elapsed < MIN_INTERVAL_MS) return speed.toLong()

        val delta = (bytes - lastBytes).coerceAtLeast(0)
        val instant = delta.toDouble() * 1000.0 / elapsed
        speed = if (speed <= 0.0) instant else speed * 0.7 + instant * 0.3
        lastTime = now
        lastBytes = bytes
        return speed.toLong()
    }

    /** Slow or stalled transfers fall back toward zero instead of sticking. */
    fun decay(factor: Double = 0.5): Long {
        speed *= factor
        return speed.toLong()
    }

    private companion object {
        const val MIN_INTERVAL_MS = 200L
    }
}
