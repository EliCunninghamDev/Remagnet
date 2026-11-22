package dev.remagnet.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import dev.remagnet.app.magnet.MagnetIntake
import dev.remagnet.app.magnet.magnetIntakeFromIntent
import dev.remagnet.app.ui.RemagnetApp
import dev.remagnet.app.ui.RemagnetViewModel
import dev.remagnet.app.ui.theme.RemagnetTheme

class MainActivity : ComponentActivity() {
    private val viewModel: RemagnetViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )

        // On recreation the ViewModel restores the pending magnet from saved
        // state; re-reading the original intent would restart that flow.
        if (savedInstanceState == null) handleIntake(intent)

        setContent {
            RemagnetTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    RemagnetApp(viewModel = viewModel)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntake(intent)
    }

    private fun handleIntake(intent: Intent?) {
        val intake = magnetIntakeFromIntent(intent)
        if (intake != MagnetIntake.None) viewModel.acceptIntake(intake)
    }
}
