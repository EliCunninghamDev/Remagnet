package dev.remagnet.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.remagnet.app.ui.components.SecondaryButton
import dev.remagnet.app.ui.components.isLargeText

/**
 * The wordmark and one screen-level action.
 *
 * Below the large-font threshold they share a row. Above it the action moves
 * under the wordmark, because at 2x text the action otherwise collapses into a
 * one-character-wide column at the edge of the screen.
 */
@Composable
fun ScreenHeader(
    surface: String,
    actionText: String,
    onAction: () -> Unit,
) {
    if (isLargeText()) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            RemagnetWordmark(surface = surface)
            SecondaryButton(
                text = actionText,
                onClick = onAction,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    } else {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RemagnetWordmark(surface = surface)
            Spacer(Modifier.weight(1f))
            SecondaryButton(text = actionText, onClick = onAction)
        }
    }
}
