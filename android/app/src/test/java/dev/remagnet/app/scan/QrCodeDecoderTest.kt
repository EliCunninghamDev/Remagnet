package dev.remagnet.app.scan

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import java.nio.ByteBuffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Decoder tests render real QR codes with ZXing's writer, then feed the luma
 * plane straight to [QrCodeDecoder] the way CameraX would.
 */
class QrCodeDecoderTest {
    private val decoder = QrCodeDecoder()

    private val contents = "remagnet://pair?code=ABCD-1234-EFGH"

    private fun qrLuma(
        text: String = contents,
        size: Int = 300,
        inverted: Boolean = false,
    ): ByteArray {
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size)
        return ByteArray(size * size) { index ->
            val x = index % size
            val y = index / size
            val dark = matrix[x, y]
            if (dark != inverted) 0 else 255.toByte()
        }
    }

    @Test
    fun decodesBlackOnWhiteQrCode() {
        val luma = qrLuma()

        assertEquals(contents, decoder.decodeLuma(luma, 300, 300))
    }

    @Test
    fun decodesInvertedWhiteOnBlackQrCode() {
        val luma = qrLuma(inverted = true)

        assertEquals(contents, decoder.decodeLuma(luma, 300, 300))
    }

    @Test
    fun copiesPaddedRowsWithoutMovingTheBuffer() {
        val width = 300
        val height = 300
        val rowStride = width + 64
        val luma = qrLuma()
        val padded = ByteBuffer.allocateDirect(rowStride * height)
        for (row in 0 until height) {
            padded.position(row * rowStride)
            padded.put(luma, row * width, width)
        }
        padded.position(0)

        val copied = decoder.copyLumaPlane(
            buffer = padded,
            width = width,
            height = height,
            rowStride = rowStride,
            pixelStride = 1,
        )

        assertArrayEquals(luma, copied)
        assertEquals("copyLumaPlane must not move the caller's buffer", 0, padded.position())
        assertEquals(contents, decoder.decodeLuma(copied, width, height))
    }

    @Test
    fun copiesInterleavedPlane() {
        val width = 300
        val height = 300
        val pixelStride = 2
        val rowStride = width * pixelStride
        val luma = qrLuma()
        val interleaved = ByteBuffer.allocateDirect(rowStride * height)
        for (row in 0 until height) {
            for (column in 0 until width) {
                val index = row * rowStride + column * pixelStride
                interleaved.put(index, luma[row * width + column])
                interleaved.put(index + 1, 0x80.toByte())
            }
        }

        val copied = decoder.copyLumaPlane(
            buffer = interleaved,
            width = width,
            height = height,
            rowStride = rowStride,
            pixelStride = pixelStride,
        )

        assertArrayEquals(luma, copied)
        assertEquals(contents, decoder.decodeLuma(copied, width, height))
    }

    @Test
    fun blankFramesReturnNull() {
        assertNull(decoder.decodeLuma(ByteArray(300 * 300) { 0xFF.toByte() }, 300, 300))
        assertNull(decoder.decodeLuma(ByteArray(300 * 300) { 0 }, 300, 300))
    }

    @Test
    fun invalidFramesReturnNull() {
        assertNull(decoder.decodeLuma(ByteArray(0), 0, 0))
        assertNull(decoder.decodeLuma(ByteArray(10), 300, 300))
    }
}
