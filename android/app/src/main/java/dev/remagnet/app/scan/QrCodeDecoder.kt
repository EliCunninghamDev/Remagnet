package dev.remagnet.app.scan

import androidx.camera.core.ImageProxy
import com.google.zxing.BinaryBitmap
import com.google.zxing.ChecksumException
import com.google.zxing.DecodeHintType
import com.google.zxing.FormatException
import com.google.zxing.LuminanceSource
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.Result
import com.google.zxing.common.GlobalHistogramBinarizer
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.nio.ByteBuffer

/**
 * Decodes QR codes from the luma plane of a CameraX frame.
 *
 * zxing-android-embedded used to bring its own capture activity; this keeps only
 * the decoding half of ZXing and lets [dev.remagnet.app.ui.QrScannerScreen] own
 * the camera. Camera frames are already available as a single luminance plane,
 * so they can be handed straight to ZXing without a JPEG round trip.
 */
class QrCodeDecoder {
    private val reader = QRCodeReader()

    private val hints: Map<DecodeHintType, Any> = mapOf(
        DecodeHintType.CHARACTER_SET to "UTF-8",
        DecodeHintType.TRY_HARDER to true,
        // QRCodeReader is not a multi-format reader, so the inverted pass is
        // performed explicitly below. The hint documents the intent and keeps
        // the decoder configuration in one place.
        DecodeHintType.ALSO_INVERTED to true,
    )

    /**
     * Decodes a full-frame luminance buffer.
     *
     * A screen showing a pairing code can be either dark-on-light or
     * light-on-dark, so both polarities are attempted. Each polarity tries the
     * hybrid binarizer first and falls back to the global histogram binarizer,
     * which copes with uneven lighting better than a single threshold.
     */
    fun decodeLuma(luma: ByteArray, width: Int, height: Int): String? {
        if (width <= 0 || height <= 0 || luma.size < width * height) return null
        val source = PlanarYUVLuminanceSource(
            luma,
            width,
            height,
            0,
            0,
            width,
            height,
            false,
        )
        return try {
            decode(source) ?: decode(source.invert())
        } finally {
            reader.reset()
        }
    }

    private fun decode(source: LuminanceSource): String? {
        val binarizers = listOf<() -> BinaryBitmap>(
            { BinaryBitmap(HybridBinarizer(source)) },
            { BinaryBitmap(GlobalHistogramBinarizer(source)) },
        )
        for (binarizer in binarizers) {
            try {
                val result: Result = reader.decode(binarizer(), hints)
                val text = result.text?.trim()
                if (!text.isNullOrEmpty()) return text
            } catch (error: Exception) {
                if (!isRecoverable(error)) throw error
            } finally {
                reader.reset()
            }
        }
        return null
    }

    /** The three failures ZXing raises for frames that simply contain no code. */
    private fun isRecoverable(error: Exception): Boolean =
        error is NotFoundException ||
            error is ChecksumException ||
            error is FormatException

    /**
     * Copies the luminance plane out of a camera buffer.
     *
     * ImageProxy rows are often padded (`rowStride > width`) and some devices
     * interleave the plane (`pixelStride > 1`), so indexing by width alone
     * corrupts the image. A duplicate is used for the fast path to leave the
     * caller's position untouched.
     */
    fun copyLumaPlane(
        buffer: ByteBuffer,
        width: Int,
        height: Int,
        rowStride: Int,
        pixelStride: Int,
    ): ByteArray {
        require(width >= 0 && height >= 0) { "Image dimensions must not be negative." }
        val luma = ByteArray(width * height)
        if (luma.isEmpty()) return luma
        require(rowStride > 0 && pixelStride > 0) { "Image strides must be positive." }

        val source = buffer.duplicate()
        val limit = source.limit()
        if (pixelStride == 1 && rowStride == width) {
            source.get(luma, 0, minOf(luma.size, limit))
            return luma
        }

        for (row in 0 until height) {
            val rowStart = row * rowStride
            if (rowStart >= limit) break
            val outputRow = row * width
            for (column in 0 until width) {
                val index = rowStart + column * pixelStride
                if (index >= limit) return luma
                luma[outputRow + column] = source.get(index)
            }
        }
        return luma
    }

    /** Decodes the first (luminance) plane of a CameraX frame. */
    fun decodeImageProxy(image: ImageProxy): String? {
        val plane = image.planes.firstOrNull() ?: return null
        val luma = copyLumaPlane(
            buffer = plane.buffer,
            width = image.width,
            height = image.height,
            rowStride = plane.rowStride,
            pixelStride = plane.pixelStride,
        )
        return decodeLuma(luma, image.width, image.height)
    }
}
