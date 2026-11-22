package dev.remagnet.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.remagnet.app.ui.theme.GeistMono
import dev.remagnet.app.ui.theme.RemagnetPalette

@Composable
fun SectionLabel(
    text: String,
    modifier: Modifier = Modifier,
) {
    Text(
        text = text.uppercase(),
        modifier = modifier,
        color = RemagnetPalette.Muted,
        fontFamily = GeistMono,
        fontSize = 10.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 1.2.sp,
    )
}

@Composable
fun Panel(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(RemagnetPalette.Panel)
            .border(1.dp, RemagnetPalette.Line)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        content = content,
    )
}

@Composable
fun Field(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    error: String? = null,
    help: String? = null,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    maxLines: Int = 1,
    trailingContent: (@Composable () -> Unit)? = null,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        SectionLabel(label)
        Spacer(Modifier.height(5.dp))
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth(),
            placeholder = placeholder?.let { { Text(it, color = RemagnetPalette.Muted) } },
            visualTransformation = visualTransformation,
            keyboardOptions = keyboardOptions,
            singleLine = maxLines == 1,
            maxLines = maxLines,
            isError = error != null,
            trailingIcon = trailingContent,
            textStyle = MaterialTheme.typography.bodyLarge.copy(
                color = RemagnetPalette.Text,
                fontFamily = GeistMono,
                fontSize = 13.sp,
            ),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = RemagnetPalette.Accent,
                unfocusedBorderColor = RemagnetPalette.Line,
                disabledBorderColor = RemagnetPalette.Line,
                errorBorderColor = RemagnetPalette.Error,
                focusedContainerColor = RemagnetPalette.Panel,
                unfocusedContainerColor = RemagnetPalette.Panel,
                errorContainerColor = RemagnetPalette.Panel,
                cursorColor = RemagnetPalette.Accent,
                focusedTextColor = RemagnetPalette.Text,
                unfocusedTextColor = RemagnetPalette.Text,
                errorTextColor = RemagnetPalette.Text,
                focusedPlaceholderColor = RemagnetPalette.Muted,
                unfocusedPlaceholderColor = RemagnetPalette.Muted,
            ),
        )
        val note = error ?: help
        if (note != null) {
            Spacer(Modifier.height(4.dp))
            Text(
                text = note,
                color = if (error != null) RemagnetPalette.Error else RemagnetPalette.Muted,
                fontFamily = GeistMono,
                fontSize = 10.sp,
                lineHeight = 14.sp,
            )
        }
    }
}

@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        shape = RectangleShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = RemagnetPalette.Accent,
            contentColor = RemagnetPalette.OnAccent,
            disabledContainerColor = RemagnetPalette.Line,
            disabledContentColor = RemagnetPalette.Muted,
        ),
        contentPadding = ButtonDefaults.ContentPadding,
    ) {
        Text(text, fontFamily = GeistMono, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    danger: Boolean = false,
) {
    val content = if (danger) RemagnetPalette.Error else RemagnetPalette.Text
    OutlinedButton(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        shape = RectangleShape,
        border = BorderStroke(1.dp, if (danger) RemagnetPalette.Error else RemagnetPalette.Line),
        colors = ButtonDefaults.outlinedButtonColors(
            contentColor = content,
            disabledContentColor = RemagnetPalette.Muted,
        ),
        contentPadding = ButtonDefaults.ContentPadding,
    ) {
        Text(text, fontFamily = GeistMono, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}

/** A compact two-state switch used for the authentication mode. */
@Composable
fun SegmentedChoice(
    options: List<Pair<String, Boolean>>,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        options.forEachIndexed { index, (label, selected) ->
            if (selected) {
                PrimaryButton(
                    text = label,
                    onClick = { onSelect(index) },
                    modifier = Modifier.weight(1f),
                )
            } else {
                SecondaryButton(
                    text = label,
                    onClick = { onSelect(index) },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/** A small status square and label, used for connection results. */
@Composable
fun StatusNote(
    text: String,
    tone: StatusTone,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier
                .padding(top = 5.dp)
                .size(6.dp)
                .background(
                    when (tone) {
                        StatusTone.Ok -> RemagnetPalette.Done
                        StatusTone.Warn -> RemagnetPalette.Warn
                        StatusTone.Error -> RemagnetPalette.Error
                        StatusTone.Neutral -> RemagnetPalette.Muted
                    },
                ),
        )
        Text(
            text = text,
            color = when (tone) {
                StatusTone.Ok -> RemagnetPalette.Done
                StatusTone.Warn -> RemagnetPalette.Warn
                StatusTone.Error -> RemagnetPalette.Error
                StatusTone.Neutral -> RemagnetPalette.Muted
            },
            fontFamily = GeistMono,
            fontSize = 11.sp,
            lineHeight = 16.sp,
        )
    }
}

enum class StatusTone { Ok, Warn, Error, Neutral }
