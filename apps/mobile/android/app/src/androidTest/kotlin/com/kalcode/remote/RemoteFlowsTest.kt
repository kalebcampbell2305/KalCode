package com.kalcode.remote

import android.Manifest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.kalcode.remote.client.ConnectionStatus
import com.kalcode.remote.protocol.AgentState
import com.kalcode.remote.protocol.DeepLink
import com.kalcode.remote.testing.FakeHost
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.runner.RunWith

/**
 * Core flows on a device: the real app, client and Noise session against [FakeHost], a Kotlin
 * workstation speaking the real protocol on the device's loopback.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class RemoteFlowsTest {
    private val compose = createAndroidComposeRule<MainActivity>()

    @get:Rule
    val rules: RuleChain = RuleChain
        .outerRule(GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS))
        .around(compose)

    private lateinit var host: FakeHost
    private val app get() = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as KalCodeRemoteApp

    @Before
    fun setUp() {
        app.getSharedPreferences("ui", 0).edit().putBoolean("askedNotify", true).commit()
        app.client.unpair()
        host = FakeHost(agentCount = 6)
    }

    @After
    fun tearDown() {
        app.client.unpair()
        host.close()
    }

    private fun waitFor(timeout: Long = 15_000, provider: SemanticsNodeInteractionsProvider = compose, matcher: () -> androidx.compose.ui.test.SemanticsMatcher) {
        compose.waitUntilAtLeastOneExists(matcher(), timeout)
        assertTrue(provider.onAllNodes(matcher()).fetchSemanticsNodes().isNotEmpty())
    }

    private fun waitForText(text: String, timeout: Long = 15_000) = waitFor(timeout) { hasText(text, substring = true) }
    private fun waitForTag(tag: String, timeout: Long = 15_000) = waitFor(timeout) { hasTestTag(tag) }
    private fun waitUntil(timeout: Long = 15_000, condition: () -> Boolean) = compose.waitUntil(timeout, condition)

    /** Pairs through the real UI: link → confirm card → Pair → Mission Control. */
    private fun pair() {
        app.pendingLink.value = DeepLink.Pair(host.pairingLink())
        waitForText("Pair with Test Workstation?")
        compose.onNodeWithTag("pairButton").performClick()
        try {
            waitUntil { app.client.status.value == ConnectionStatus.Online }
        } catch (e: Throwable) {
            throw AssertionError(
                "not online: ${app.client.status.value}; screen: " + compose.onRoot().printToString(),
                e,
            )
        }
        waitForTag("fleetList")
    }

    private fun scrollFleetTo(tag: String) {
        compose.onNodeWithTag("fleetList").performScrollToNode(hasTestTag(tag))
    }

    @Test
    fun pairingLandsOnMissionControlWithLiveAgents() {
        pair()
        waitForText("Test Workstation")
        scrollFleetTo("agent:thr_0002")
        compose.onNodeWithTag("agent:thr_0002").assertExists()
        // A live patch shows up without any action.
        host.upsertAgent(app.client.fleet.value.agent("thr_0002")!!.copy(name = "Renamed live", state = AgentState.DONE))
        waitForText("Renamed live")
    }

    @Test
    fun approveOnceAnswersTheDesktop() {
        pair()
        val item = app.client.fleet.value.needsYou.first()
        scrollFleetTo("approve:${item.id}")
        compose.onNodeWithTag("approve:${item.id}").performClick()
        waitForText("Approved once")
        waitUntil { host.received.any { it.first == "needs.decide" } }
        val args = host.received.first { it.first == "needs.decide" }.second
        assertEquals("approve_once", args["decision"].toString().trim('"'))
    }

    @Test
    fun agentDetailDiffAndPrompt() {
        pair()
        scrollFleetTo("agent:thr_0002")
        compose.onNodeWithTag("agent:thr_0002").performClick()
        waitForTag("agentName")
        waitForText("buildReturnUrl") // agent.detail output
        compose.onNodeWithTag("agentDetail").performScrollToNode(hasTestTag("viewDiff"))
        compose.onNodeWithTag("viewDiff").performClick()
        waitForText("src/auth/redirect.ts")
        waitForText("return next;")
        compose.onNodeWithTag("back").performClick()
        compose.onNodeWithTag("agentDetail").performScrollToNode(hasTestTag("fullLog"))
        compose.onNodeWithTag("fullLog").performClick()
        waitForText("Log line 39")
        compose.onNodeWithTag("log").performScrollToNode(hasTestTag("loadEarlier"))
        compose.onNodeWithTag("loadEarlier").performClick()
        waitForText("Log line 19")
        compose.onNodeWithTag("back").performClick()
        waitForTag("promptField")
        compose.onNodeWithTag("promptField").performTextInput("Cover the logout redirect too")
        compose.onNodeWithTag("promptField").performImeAction() // the keyboard's Send
        waitForText("Sent to")
        assertTrue(host.received.any { it.first == "agent.prompt" && it.second["text"].toString().contains("logout") })
    }

    @Test
    fun stopAsksFirst() {
        pair()
        scrollFleetTo("agent:thr_0002") // WORKING in the fake fleet
        compose.onNodeWithTag("agent:thr_0002").performClick()
        compose.onNodeWithTag("agentDetail").performScrollToNode(hasTestTag("stop"))
        compose.onNodeWithTag("stop").performClick()
        waitForTag("confirmStop")
        assertTrue(host.received.none { it.first == "agent.stop" })
        compose.onNodeWithTag("confirmStop").performClick()
        waitForText("Stopped")
    }

    @Test
    fun launchAgentFromTheSheet() {
        pair()
        compose.onNodeWithTag("launchFab").performClick()
        waitForTag("launchSubmit")
        compose.onNodeWithTag("launchPrompt").performTextInput("Add a health check")
        androidx.test.espresso.Espresso.closeSoftKeyboard()
        compose.onNodeWithTag("launchSubmit").performScrollTo().performClick()
        waitUntil { host.received.any { it.first == "agent.launch" } }
        // The new agent opens once the workstation reports it.
        waitForText("Add a health check")
        waitForTag("agentName")
    }

    @Test
    fun kalVoiceTypedCommand() {
        pair()
        compose.onNodeWithText("KalVoice").performClick()
        waitForTag("voiceField")
        compose.onNodeWithTag("voiceField").performTextInput("What needs me?")
        compose.onNodeWithTag("voiceField").performImeAction()
        waitForText("need you")
        waitForText("Done")
    }

    @Test
    fun needsYouTabSplitsDecisionsAndAttention() {
        pair()
        // The tab (selectable), not the stat tile or the filter pill with the same words.
        compose.onNode(
            hasText("Needs You") and androidx.compose.ui.test.SemanticsMatcher.keyIsDefined(androidx.compose.ui.semantics.SemanticsProperties.Selected),
        ).performClick()
        waitForTag("needsList")
        waitForText("DECISIONS")
        waitForText("Run `cargo test -p git`?")
    }

    @Test
    fun runsAndRunDetail() {
        pair()
        compose.onNodeWithText("Runs").performClick()
        waitForTag("run:op_nightly")
        compose.onNodeWithTag("run:op_nightly").performClick()
        waitForText("diff::renames_are_detected")
    }

    @Test
    fun deepLinkToAGoneAgentSaysSoAndLandsOnFleet() {
        pair()
        app.pendingLink.value = DeepLink.AgentLink("thr_gone")
        waitForText("This agent has finished")
        compose.onNodeWithTag("fleetList").assertExists()
        app.pendingLink.value = DeepLink.Needs("approval:apr_gone")
        waitForText("Already answered")
    }

    @Test
    fun revokedShowsRemovedAndRePairUsesANewKey() {
        pair()
        host.revokeAll()
        waitForTag("removed")
        waitForText("This phone was removed")
        compose.onNodeWithTag("pairAgain").performClick()
        waitForTag("pairing")
    }

    @Test
    fun unpairFromSettings() {
        pair()
        compose.onNodeWithTag("openSettings").performClick()
        compose.onNodeWithTag("settings").performScrollToNode(hasTestTag("unpair"))
        compose.onNodeWithTag("unpair").performClick()
        compose.onNodeWithTag("confirmUnpair").performClick()
        waitForTag("pairing")
        assertEquals(null, app.client.workstation.value)
    }
}
