package dev.remagnet.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.remagnet.app.ui.RemagnetWordmark

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        setContent {
            RemagnetTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    RemagnetHome()
                }
            }
        }
    }
}

@Composable
private fun RemagnetHome() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .padding(horizontal = 24.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RemagnetWordmark(surface = "Android")
        Text(
            text = "Client scaffold",
            style = MaterialTheme.typography.titleLarge,
        )
        Text(
            text = "early scaffold",
            color = MaterialTheme.colorScheme.primary,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            letterSpacing = 1.sp,
        )
        Text(
            text = "Magnet review and the qBittorrent proxy flow land here next. " +
                "The browser extension remains the primary client while this app grows.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(top = 14.dp),
        )
    }
}

private val RemagnetColors = darkColorScheme(
    primary = Color(0xFF70A3D2),
    onPrimary = Color(0xFF10161B),
    background = Color(0xFF141517),
    onBackground = Color(0xFFCFD1D3),
    surface = Color(0xFF181A1C),
    onSurface = Color(0xFFCFD1D3),
    surfaceVariant = Color(0xFF1D1F21),
    onSurfaceVariant = Color(0xFF7D8286),
)

@Composable
private fun RemagnetTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = RemagnetColors, content = content)
}

@Preview(showBackground = true, backgroundColor = 0xFF141517)
@Composable
private fun RemagnetHomePreview() {
    RemagnetTheme {
        Surface(color = MaterialTheme.colorScheme.background) {
            RemagnetHome()
        }
    }
}
