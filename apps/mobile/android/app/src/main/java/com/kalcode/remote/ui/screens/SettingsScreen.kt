package com.kalcode.remote.ui.screens

import android.Manifest
import android.content.Intent
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.kalcode.remote.BuildConfig
import com.kalcode.remote.Notifications
import com.kalcode.remote.ui.LocalClient
import com.kalcode.remote.ui.components.AgoText
import com.kalcode.remote.ui.components.ConnectionPill
import com.kalcode.remote.ui.components.Eyebrow
import com.kalcode.remote.ui.components.InfoRow
import com.kalcode.remote.ui.components.KcCard
import com.kalcode.remote.ui.components.SecondaryButton
import com.kalcode.remote.ui.components.SectionHeader
import com.kalcode.remote.ui.components.rememberHaptics
import com.kalcode.remote.ui.headingSemantics
import com.kalcode.remote.ui.theme.Kc
import com.kalcode.remote.ui.theme.SpaceBackground
import com.kalcode.remote.ui.theme.SpaceLevel

@Composable
fun SettingsScreen() {
    val client = LocalClient.current
    val context = LocalContext.current
    val haptics = rememberHaptics()
    val status by client.status.collectAsStateWithLifecycle()
    val ws by client.workstation.collectAsStateWithLifecycle()
    val fleet by client.fleet.collectAsStateWithLifecycle()
    val lastUpdate by client.lastUpdate.collectAsStateWithLifecycle()
    var confirmUnpair by remember { mutableStateOf(false) }
    var permissionTick by remember { mutableIntStateOf(0) }
    val canNotify = remember(permissionTick) { Notifications.canPost(context) }
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { permissionTick++ }

    SpaceBackground(SpaceLevel.QUIET) {
        Column(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .testTag("settings"),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(Modifier.widthIn(max = 720.dp)) {
                Spacer(Modifier.height(16.dp))
                Eyebrow("KalCode Remote", color = Kc.AccentText)
                Spacer(Modifier.height(12.dp))
                Text("Settings", style = MaterialTheme.typography.displaySmall, color = Kc.Starlight, modifier = Modifier.headingSemantics())
                Spacer(Modifier.height(20.dp))

                SectionHeader("Workstation", trailing = { ConnectionPill(status) })
                KcCard(Modifier.fillMaxWidth()) {
                    Text(ws?.name ?: "—", style = MaterialTheme.typography.titleLarge, color = Kc.Starlight)
                    Spacer(Modifier.height(8.dp))
                    val host = fleet.workstation
                    InfoRow("Platform", (host?.platform ?: ws?.hostPlatform).orEmpty().replaceFirstChar { it.uppercase() }.ifBlank { "—" })
                    InfoRow("KalCode", listOfNotNull((host?.version ?: ws?.hostVersion)?.takeIf { it.isNotBlank() }, (host?.build ?: ws?.hostBuild)?.takeIf { it > 0 }?.let { "build $it" }).joinToString(" · ").ifBlank { "—" })
                    InfoRow("Workstation ID", ws?.wid ?: "—", mono = true)
                    InfoRow("This device", ws?.deviceId ?: "—", mono = true)
                    InfoRow("Addresses", ws?.addrs?.joinToString("\n") ?: "—", mono = true)
                    Row(Modifier.padding(vertical = 7.dp)) {
                        Text("Paired", style = MaterialTheme.typography.bodyMedium, color = Kc.Nebula, modifier = Modifier.width(118.dp))
                        AgoText(ws?.pairedAt, color = Kc.Starlight)
                    }
                    Row(Modifier.padding(vertical = 7.dp)) {
                        Text("Last update", style = MaterialTheme.typography.bodyMedium, color = Kc.Nebula, modifier = Modifier.width(118.dp))
                        AgoText(lastUpdate, color = Kc.Starlight)
                    }
                    Spacer(Modifier.height(8.dp))
                    SecondaryButton("Reconnect now", client::retryNow, icon = Icons.Outlined.Refresh, modifier = Modifier.fillMaxWidth())
                }

                Spacer(Modifier.height(14.dp))
                SectionHeader("Notifications")
                KcCard(Modifier.fillMaxWidth()) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            if (canNotify) Icons.Outlined.NotificationsActive else Icons.Outlined.Notifications,
                            contentDescription = null,
                            tint = if (canNotify) Kc.WorkingText else Kc.Nebula,
                            modifier = Modifier.size(22.dp),
                        )
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(if (canNotify) "On" else "Off", style = MaterialTheme.typography.titleMedium, color = Kc.Starlight)
                            Text(
                                "Approvals, questions, failures and finished agents while KalCode Remote is open or recently used.",
                                style = MaterialTheme.typography.bodySmall,
                                color = Kc.Nebula,
                            )
                        }
                    }
                    if (!canNotify) {
                        Spacer(Modifier.height(12.dp))
                        SecondaryButton("Turn on notifications", {
                            val asked = context.getSharedPreferences("ui", 0).getBoolean("askedNotify", false)
                            if (!asked) {
                                context.getSharedPreferences("ui", 0).edit().putBoolean("askedNotify", true).apply()
                                askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                            } else {
                                context.startActivity(
                                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                                )
                            }
                        }, modifier = Modifier.fillMaxWidth())
                    }
                }

                Spacer(Modifier.height(14.dp))
                SectionHeader("Security")
                KcCard(Modifier.fillMaxWidth()) {
                    Text(
                        "This device holds its own key in the Android Keystore and talks to your pinned workstation over an end-to-end encrypted Noise session. No provider credentials ever reach this phone. Approvals are Approve once or Deny only.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Kc.TextSecondary,
                    )
                    Spacer(Modifier.height(14.dp))
                    SecondaryButton(
                        "Unpair this device",
                        { confirmUnpair = true },
                        icon = Icons.Outlined.LinkOff,
                        tone = Kc.FailedText,
                        modifier = Modifier.fillMaxWidth().testTag("unpair"),
                    )
                }

                Spacer(Modifier.height(14.dp))
                SectionHeader("About")
                KcCard(Modifier.fillMaxWidth()) {
                    InfoRow("Version", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
                    InfoRow("Protocol", "KalCode Remote v1", mono = true)
                    InfoRow("Fonts", "Lexend Deca, JetBrains Mono (SIL OFL 1.1)")
                }
                Spacer(Modifier.height(24.dp))
                Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
            }
        }
    }

    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            containerColor = Kc.Overlay,
            title = { Text("Unpair from ${ws?.name ?: "this workstation"}?") },
            text = {
                Text(
                    "This device forgets the workstation and deletes its key. To use Remote again, pair from a new code in KalCode on your desktop.",
                    color = Kc.TextSecondary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmUnpair = false
                    haptics.confirm()
                    client.unpair()
                }, modifier = Modifier.testTag("confirmUnpair")) { Text("Unpair", color = Kc.FailedText) }
            },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel", color = Kc.TextSecondary) } },
        )
    }
}
