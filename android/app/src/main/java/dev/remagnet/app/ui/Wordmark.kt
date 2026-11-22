package dev.remagnet.app.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.remagnet.app.R
import dev.remagnet.app.ui.theme.DepartureMono
import dev.remagnet.app.ui.theme.GeistMono

/**
 * The Remagnet wordmark, shared by Android screens.
 *
 * The mark uses the bundled Departure Mono face and the same 1em icon lockup as
 * the browser clients, so the product keeps one identity across platforms.
 */
@Composable
fun RemagnetWordmark(
    modifier: Modifier = Modifier,
    surface: String? = null,
) {
    Row(
        modifier = modifier.semantics(mergeDescendants = true) { },
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Image(
                painter = painterResource(R.drawable.ic_remagnet_logo),
                contentDescription = null,
                modifier = Modifier.size(22.dp),
            )
            Text(
                text = "Remagnet",
                color = MaterialTheme.colorScheme.onBackground,
                fontFamily = DepartureMono,
                fontSize = 22.sp,
                fontWeight = FontWeight.Normal,
                lineHeight = 22.sp,
                letterSpacing = 0.2.sp,
            )
        }
        if (surface != null) {
            Text(
                text = surface.uppercase(),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontFamily = GeistMono,
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 10.sp,
                letterSpacing = 1.2.sp,
                modifier = Modifier.padding(bottom = 2.dp),
            )
        }
    }
}
