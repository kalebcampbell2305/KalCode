import XCTest

// KalCode Remote UI tests.
//
// Two suites:
//  • FixtureSmokeTests — run anywhere, no workstation needed (DEBUG `-kc-fixture <name>`).
//  • DevhostFlowTests  — run against the real fake workstation (devhost). They need either
//      KC_CTL_DIR   (TEST_RUNNER_KC_CTL_DIR)  a host directory for the control protocol, or
//      KC_PAIR_LINK (TEST_RUNNER_KC_PAIR_LINK) a single pairing link (pair-only tests).
//    Control protocol: write `pair` | `kill` | `start` | `revoke` to `<KC_CTL_DIR>/request`
//    (atomically: request.tmp → rename), after deleting any old `ack-<cmd>`; the runner
//    performs it and writes `<KC_CTL_DIR>/ack-<cmd>`. For `pair` the ack's contents are a
//    fresh single-use pairing link. Every test launches with `-kc-reset`.
//
// Accessibility identifiers used by the app:
//  welcome.view, welcome.scan, welcome.paste, welcome.demo
//  demo.badge, demo.exit, settings.exitDemo
//  pair.linkField, pair.pasteFromClipboard, pair.continue, pair.linkError, pair.title,
//  pair.expiry, pair.confirm, pair.done, pair.retry, pair.cancel, pair.errorTitle
//  scanner.close, scanner.paste, scanner.error
//  status.pill, banner.reconnecting, banner.offline, banner.retry, banner.connecting, toast
//  fleet.list, fleet.header, fleet.launch, fleet.settings, filter.<all|needsYou|working|failed|done>
//  agentCard.<agentId>, needsCard.<needsId>, needs.approve.<needsId>, needs.deny.<needsId>,
//  needs.seeAll, needs.list
//  agent.header, agent.output, agent.diff, agent.diffToggle, agent.log, agent.stop,
//  agent.stop.confirm, agent.retry, agent.close, agent.prompt.field, agent.prompt.send,
//  agent.prompt.queued
//  diff.view, diff.summary, diff.file.<path>, diff.truncated, diff.close
//  log.view, log.loadEarlier
//  launch.workspace, launch.provider, launch.account, launch.model, launch.effort,
//  launch.prompt, launch.submit, launch.cancel, launch.error
//  runs.list, runs.segment.<runs|services|environments>, runRow.<runId>, run.detail, run.log
//  voice.view, voice.mic, voice.field, voice.send, voice.result, voice.queued, voice.unavailable
//  settings.view, settings.deviceName, settings.notifications.enable, settings.unpair,
//  settings.unpair.confirm
//  removed.view, removed.message, removed.repair
//  sidebar.<mission|needs|runs|voice|settings> (iPad)
//  iPhone tabs are found by label: "Mission Control", "Needs You", "Runs", "KalVoice".

// MARK: - Helpers

extension XCUIApplication {
    func element(_ id: String) -> XCUIElement {
        descendants(matching: .any).matching(identifier: id).firstMatch
    }

    func first(prefix: String) -> XCUIElement {
        descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).firstMatch
    }

    var toast: XCUIElement { element("toast") }

    /// Swipes the scroll view until a lazily created element appears.
    @discardableResult
    func scrollTo(_ id: String, in container: String = "fleet.list", maxSwipes: Int = 8) -> XCUIElement {
        let target = element(id)
        var swipes = 0
        while !target.exists && swipes < maxSwipes {
            element(container).swipeUp()
            swipes += 1
        }
        return target
    }
}

extension XCUIElement {
    @discardableResult
    func waitFor(_ timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        XCTAssertTrue(waitForExistence(timeout: timeout), "Timed out waiting for \(self)", file: file, line: line)
        return self
    }

    func waitToDisappear(_ timeout: TimeInterval = 10) -> Bool {
        let p = NSPredicate(format: "exists == false")
        return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: self)], timeout: timeout) == .completed
    }
}

// MARK: - Fixture smoke (no host)

final class FixtureSmokeTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func launch(_ fixture: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-kc-reset", "-kc-fixture", fixture]
        app.launch()
        return app
    }

    func testWelcomeWhenUnpaired() {
        let app = XCUIApplication()
        app.launchArguments = ["-kc-reset"]
        app.launch()
        app.element("welcome.paste").waitFor()
        XCTAssertTrue(app.element("welcome.scan").exists)
        app.element("welcome.paste").tap()
        let field = app.element("pair.linkField").waitFor()
        field.tap()
        field.typeText("https://example.com/not-a-pairing-link")
        app.element("pair.continue").tap()
        app.element("pair.linkError").waitFor()
    }

    func testFleetFixtureRendersAndOpensAgent() {
        let app = launch("fleet")
        app.element("fleet.list").waitFor()
        XCTAssertEqual(app.element("status.pill").label, "Connection: Online")
        app.element("needs.approve.approval:apr_7731").waitFor()
        app.scrollTo("agentCard.thr_remote").waitFor().tap()
        app.element("agent.header").waitFor()
        app.element("agent.output").waitFor()
        app.element("agent.diff").tap()
        app.element("diff.summary").waitFor()
        XCTAssertTrue(app.element("diff.file.crates/auth/src/session.rs").exists)
    }

    func testApproveInFixture() {
        let app = launch("fleet")
        let approve = app.element("needs.approve.approval:apr_7731").waitFor()
        approve.tap()
        app.toast.waitFor()
        XCTAssertTrue(approve.waitToDisappear(5))
    }

    func testReconnectingFixtureShowsBannerAndQueuesPrompt() {
        let app = launch("reconnecting")
        app.element("banner.reconnecting").waitFor()
        app.element("fleet.list").waitFor()
        app.scrollTo("agentCard.thr_remote").waitFor().tap()
        let field = app.element("agent.prompt.field").waitFor()
        field.tap()
        field.typeText("Rebase on main when the build passes")
        app.element("agent.prompt.send").tap()
        app.element("agent.prompt.queued").waitFor()
    }

    func testRemovedFixture() {
        let app = launch("removed")
        app.element("removed.view").waitFor()
        XCTAssertTrue(app.element("removed.message").label.contains("Studio Workstation"))
        app.element("removed.repair").tap()
        app.element("welcome.paste").waitFor()
    }

    func testBigFleetScrolls() {
        let app = launch("big")
        app.element("fleet.list").waitFor()
        let list = app.element("fleet.list")
        for _ in 0..<6 { list.swipeUp(velocity: .fast) }
        XCTAssertTrue(app.first(prefix: "agentCard.thr_bulk_").exists)
    }

    func testDeepLinkToMissingAgentInFixture() {
        let app = launch("fleet")
        app.element("fleet.list").waitFor()
        app.launchArguments = ["-kc-fixture", "fleet"]
        app.open(URL(string: "kalcode-remote://agent/thr_gone_does_not_exist")!)
        let toast = app.toast.waitFor()
        XCTAssertTrue(toast.label.contains("finished"))
    }
}

// MARK: - In-app demo (release code path: what App Review and new users see)

final class DemoModeTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testExploreDemoWorkstationEndToEnd() {
        let app = XCUIApplication()
        app.launchArguments = ["-kc-reset"]
        app.launch()

        // Welcome → demo: the real fleet UI with a persistent Demo badge.
        app.element("welcome.demo").waitFor().tap()
        app.element("fleet.list").waitFor()
        XCTAssertTrue(app.element("demo.badge").waitFor().exists)
        XCTAssertEqual(app.element("status.pill").label, "Connection: Online")

        // Approving answers locally and removes the request.
        let approve = app.element("needs.approve.approval:apr_7731").waitFor()
        approve.tap()
        XCTAssertTrue(app.toast.waitFor().label.contains("Approved"))
        XCTAssertTrue(approve.waitToDisappear(5))

        // Agent detail, diff and a follow-up prompt.
        app.scrollTo("agentCard.thr_remote").waitFor().tap()
        app.element("agent.header").waitFor()
        app.element("agent.output").waitFor()
        let field = app.element("agent.prompt.field").waitFor()
        field.tap()
        field.typeText("Also pin the header row")
        app.element("agent.prompt.send").tap()
        XCTAssertTrue(app.toast.waitFor().label.contains("Sent"))
        XCTAssertFalse(app.element("agent.prompt.queued").exists)

        // Stop changes the agent's state.
        app.element("agent.stop").waitFor().tap()
        app.element("agent.stop.confirm").waitFor().tap()
        XCTAssertTrue(app.toast.waitFor().label.contains("Stopped"))
        XCTAssertTrue(app.element("demo.badge").exists)

        // Settings → Exit demo returns to the welcome screen, still unpaired.
        app.terminate()
        app.launchArguments = ["-kc-reset"]
        app.launch()
        app.element("welcome.demo").waitFor().tap()
        app.element("fleet.list").waitFor()
        if app.element("fleet.settings").exists {
            app.element("fleet.settings").tap()
        } else {
            app.element("sidebar.settings").waitFor().tap()
        }
        XCTAssertFalse(app.element("settings.unpair").exists)
        app.element("settings.exitDemo").waitFor().tap()
        app.element("welcome.paste").waitFor()
        XCTAssertFalse(app.element("demo.badge").exists)
    }

    /// The demo leaves no pairing behind: a fresh launch (without reset) is back at welcome.
    func testDemoIsNotRemembered() {
        let app = XCUIApplication()
        app.launchArguments = ["-kc-reset"]
        app.launch()
        app.element("welcome.demo").waitFor().tap()
        app.element("fleet.list").waitFor()
        app.terminate()
        app.launchArguments = []
        app.launch()
        app.element("welcome.demo").waitFor()
    }
}

// MARK: - Devhost flows (real fake workstation)

class DevhostTestCase: XCTestCase {
    private var ctlDir: String? { ProcessInfo.processInfo.environment["KC_CTL_DIR"].flatMap { $0.isEmpty ? nil : $0 } }
    private var staticLink: String? { ProcessInfo.processInfo.environment["KC_PAIR_LINK"].flatMap { $0.isEmpty ? nil : $0 } }

    override func setUpWithError() throws {
        continueAfterFailure = false
        if ctlDir == nil && staticLink == nil {
            throw XCTSkip("Devhost flows need KC_CTL_DIR or KC_PAIR_LINK")
        }
    }

    /// Sends a control command and waits for its ack. Returns the ack's contents.
    @discardableResult
    func host(_ command: String, timeout: TimeInterval = 30) throws -> String {
        guard let dir = ctlDir else { throw XCTSkip("Needs KC_CTL_DIR for `\(command)`") }
        let fm = FileManager.default
        let ack = (dir as NSString).appendingPathComponent("ack-\(command)")
        let tmp = (dir as NSString).appendingPathComponent("request.tmp")
        let request = (dir as NSString).appendingPathComponent("request")
        try? fm.removeItem(atPath: ack)
        try command.write(toFile: tmp, atomically: false, encoding: .utf8)
        try? fm.removeItem(atPath: request)
        try fm.moveItem(atPath: tmp, toPath: request)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if fm.fileExists(atPath: ack) {
                Thread.sleep(forTimeInterval: 0.1)
                return (try? String(contentsOfFile: ack, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        XCTFail("No ack for `\(command)` within \(Int(timeout)) s")
        return ""
    }

    func pairingLink() throws -> String {
        if ctlDir != nil {
            let link = try host("pair")
            XCTAssertTrue(link.hasPrefix("kalcode-remote://pair"), "pair ack should contain a link, got: \(link.prefix(40))")
            return link
        }
        return staticLink!
    }

    /// Launches fresh, pairs through the paste flow and lands on Mission Control.
    @discardableResult
    func launchPaired() throws -> XCUIApplication {
        let link = try pairingLink()
        let app = XCUIApplication()
        app.launchArguments = ["-kc-reset"]
        app.launch()
        app.element("welcome.paste").waitFor().tap()
        let field = app.element("pair.linkField").waitFor()
        field.tap()
        field.typeText(link)
        app.element("pair.continue").tap()
        app.element("pair.confirm").waitFor().tap()
        // The notification permission alert may appear right after pairing.
        addUIInterruptionMonitor(withDescription: "Notifications") { alert in
            for label in ["Allow", "Don’t Allow", "Don't Allow"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
        let done = app.element("pair.done")
        if !done.waitForExistence(timeout: 20) {
            app.tap()  // trigger the interruption monitor
            done.waitFor(10)
        }
        done.tap()
        app.element("fleet.list").waitFor(15)
        return app
    }

}

final class DevhostFlowTests: DevhostTestCase {
    func testPairAndMissionControlShowsAgents() throws {
        let app = try launchPaired()
        app.first(prefix: "agentCard.").waitFor(15)
        XCTAssertEqual(app.element("status.pill").label, "Connection: Online")
    }

    func testOpenAgentAndViewDiff() throws {
        let app = try launchPaired()
        app.first(prefix: "agentCard.").waitFor(15).tap()
        app.element("agent.header").waitFor()
        app.element("agent.output").waitFor()
        app.element("agent.diff").waitFor().tap()
        app.element("diff.view").waitFor()
        app.element("diff.summary").waitFor(15)
    }

    func testSendPrompt() throws {
        let app = try launchPaired()
        app.first(prefix: "agentCard.").waitFor(15).tap()
        let field = app.element("agent.prompt.field").waitFor()
        field.tap()
        field.typeText("Please add a regression test for this.")
        app.element("agent.prompt.send").tap()
        app.toast.waitFor(15)
    }

    func testApproveNeedsYou() throws {
        let app = try launchPaired()
        let approve = app.first(prefix: "needs.approve.").waitFor(15)
        let id = approve.identifier
        approve.tap()
        app.toast.waitFor(15)
        XCTAssertTrue(app.element(id).waitToDisappear(15), "Answered item should leave Needs You")
    }

    func testDeepLinkToGoneAgentShowsToast() throws {
        let app = try launchPaired()
        // `open` may relaunch the app with its launch arguments; keep the pairing this time.
        app.launchArguments = []
        app.open(URL(string: "kalcode-remote://agent/thr_gone_does_not_exist")!)
        let toast = app.toast.waitFor(10)
        XCTAssertTrue(toast.label.localizedCaseInsensitiveContains("finished"), "toast said: \(toast.label)")
        XCTAssertTrue(app.element("fleet.list").exists)
    }

    func testHostKilledShowsReconnectingThenRecovers() throws {
        let app = try launchPaired()
        app.first(prefix: "agentCard.").waitFor(15)
        try host("kill")
        app.element("banner.reconnecting").waitFor(45)
        XCTAssertEqual(app.element("status.pill").label, "Connection: Reconnecting")
        try host("start")
        XCTAssertTrue(app.element("banner.reconnecting").waitToDisappear(45))
        XCTAssertEqual(app.element("status.pill").label, "Connection: Online")
    }

    func testRevokedShowsRemovedScreen() throws {
        let app = try launchPaired()
        app.first(prefix: "agentCard.").waitFor(15)
        try host("revoke")
        // A live session gets `bye revoked`; otherwise the next handshake is rejected.
        if !app.element("removed.view").waitForExistence(timeout: 20) {
            try host("kill")
            try host("start")
        }
        app.element("removed.view").waitFor(45)
        app.element("removed.repair").tap()
        app.element("welcome.paste").waitFor()
    }
}

// MARK: - Design tour (opt-in: KC_SHOTS_DIR) — screenshots for visual review

final class DesignTourTests: XCTestCase {
    private var dir: String? { ProcessInfo.processInfo.environment["KC_SHOTS_DIR"].flatMap { $0.isEmpty ? nil : $0 } }

    override func setUpWithError() throws {
        if dir == nil { throw XCTSkip("Design tour runs only with KC_SHOTS_DIR") }
        continueAfterFailure = true
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        Thread.sleep(forTimeInterval: 0.8)
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let idiom = UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
        try? png.write(to: URL(fileURLWithPath: dir!).appendingPathComponent("\(idiom)-\(name).png"))
    }

    private func launch(_ args: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-kc-reset"] + args
        app.launch()
        return app
    }

    func testTour() {
        let pad = UIDevice.current.userInterfaceIdiom == .pad
        if pad {
            XCUIDevice.shared.orientation = .landscapeLeft
            var app = launch(["-kc-fixture", "fleet"])
            app.element("fleet.list").waitFor()
            snap(app, "landscape-fleet")
            app.element("agentCard.thr_login").tap()
            snap(app, "landscape-agent")
            app.element("agent.diffToggle").tap()
            snap(app, "landscape-agent-diff")
            app = launch(["-kc-fixture", "fleet", "-kc-open", "kalcode-remote://run/op_nightly"])
            snap(app, "landscape-runs")
            app = launch(["-kc-fixture", "fleet", "-kc-tab", "settings"])
            snap(app, "landscape-settings")
            app = launch(["-kc-fixture", "reconnecting"])
            snap(app, "landscape-reconnecting")
            app = launch(["-kc-fixture", "big"])
            snap(app, "landscape-big")
            XCUIDevice.shared.orientation = .portrait
            app = launch([])
            snap(app, "portrait-welcome")
        } else {
            var app = launch(["-kc-fixture", "fleet"])
            app.element("fleet.list").waitFor()
            app.element("fleet.list").swipeUp()
            snap(app, "fleet-cards")
            app.element("fleet.list").swipeUp()
            snap(app, "fleet-cards-2")
            app = launch(["-kc-fixture", "fleet", "-kc-open", "kalcode-remote://agent/thr_login"])
            app.element("agent.header").waitFor()
            app.swipeUp()
            snap(app, "agent-output")
            app = launch(["-kc-fixture", "fleet", "-kc-open", "kalcode-remote://agent/thr_fail"])
            snap(app, "agent-failed")
            app = launch(["-kc-fixture", "fleet", "-kc-open", "kalcode-remote://agent/thr_done"])
            snap(app, "agent-done")
            app = launch(["-kc-fixture", "fleet", "-kc-tab", "voice"])
            app.element("voice.field").waitFor().tap()
            app.element("voice.field").typeText("What needs me right now?")
            app.element("voice.send").tap()
            Thread.sleep(forTimeInterval: 1.0)
            app.element("voice.field").tap()
            app.element("voice.field").typeText("Stop it")
            app.element("voice.send").tap()
            Thread.sleep(forTimeInterval: 1.0)
            app.swipeDown()
            snap(app, "voice-results")
            app = launch(["-kc-fixture", "fleet", "-kc-open", "kalcode-remote://agent/thr_login"])
            app.element("agent.log").waitFor().tap()
            Thread.sleep(forTimeInterval: 1.0)
            snap(app, "agent-log")
            app = launch(["-kc-fixture", "fleet", "-kc-tab", "runs"])
            app.element("runs.segment.environments").tap()
            snap(app, "runs-environments")
            app.element("runs.segment.services").tap()
            snap(app, "runs-services")
            app = launch(["-kc-fixture", "fleet"])
            app.element("welcome.paste").waitForExistence(timeout: 1)
            app.element("fleet.list").waitFor()
            app.open(URL(string: "kalcode-remote://pair?d=" + Self.samplePayload)!)
            app.element("pair.confirm").waitFor()
            snap(app, "pair-confirm")
            app = launch([])
            app.element("welcome.scan").waitFor().tap()
            snap(app, "scanner")
            app.element("scanner.paste").waitFor().tap()
            snap(app, "paste")
        }
    }

    /// base64url({"v":1,"wid":"ws_demo","name":"Kaleb's Workstation","pk":<32B>,"code":<32B>,"addrs":[…],"exp":4102444800})
    static let samplePayload: String = {
        let key = Data(repeating: 9, count: 32).base64EncodedString()
        let json = #"{"v":1,"wid":"ws_demo","name":"Kaleb's Workstation","pk":"\#(key)","code":"\#(key)","addrs":["192.168.1.20:47820","100.101.7.40:47820"],"exp":4102444800}"#
        return Data(json.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }()
}

// MARK: - Live tour (opt-in: KC_CTL_DIR + KC_SHOTS_DIR) — screenshots of the REAL dev host

final class LiveTourTests: DevhostTestCase {
    private var shots: String? { ProcessInfo.processInfo.environment["KC_SHOTS_DIR"].flatMap { $0.isEmpty ? nil : $0 } }

    override func setUpWithError() throws {
        try super.setUpWithError()
        if shots == nil || ProcessInfo.processInfo.environment["KC_CTL_DIR"] == nil {
            throw XCTSkip("Live tour runs only with KC_SHOTS_DIR and KC_CTL_DIR")
        }
    }

    private func snap(_ name: String) {
        Thread.sleep(forTimeInterval: 1.2)  // let springs and the first detail fetch settle
        let png = XCUIScreen.main.screenshot().pngRepresentation
        try? png.write(to: URL(fileURLWithPath: (shots! as NSString).appendingPathComponent("\(name).png")))
    }

    private func relaunch(_ args: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = args
        app.launch()
        return app
    }

    func testLiveTour() throws {
        if UIDevice.current.userInterfaceIdiom == .pad { XCUIDevice.shared.orientation = .landscapeLeft }
        // Pairing
        let link = try pairingLink()
        var app = XCUIApplication()
        app.launchArguments = ["-kc-reset"]
        app.launch()
        app.element("welcome.paste").waitFor()
        snap("01-welcome")
        app.element("welcome.paste").tap()
        let field = app.element("pair.linkField").waitFor()
        field.tap()
        field.typeText(link)
        app.element("pair.continue").tap()
        app.element("pair.confirm").waitFor()
        snap("02-pair-confirm")
        app.element("pair.confirm").tap()
        addUIInterruptionMonitor(withDescription: "Notifications") { alert in
            for label in ["Allow", "Don’t Allow", "Don't Allow"] where alert.buttons[label].exists {
                alert.buttons[label].tap(); return true
            }
            return false
        }
        let done = app.element("pair.done")
        if !done.waitForExistence(timeout: 20) { app.tap(); done.waitFor(10) }
        done.tap()

        // Mission Control (live)
        let card = app.first(prefix: "agentCard.").waitFor(15)
        snap("03-mission-control")
        let agentId = String(card.identifier.dropFirst("agentCard.".count))

        app = relaunch(["-kc-tab", "needs"])
        app.first(prefix: "needs.").waitFor(20)
        snap("04-needs-you")

        app = relaunch(["-kc-open", "kalcode-remote://agent/\(agentId)"])
        app.element("agent.output").waitFor(20)
        snap("05-agent-detail")

        app = relaunch(["-kc-open", "kalcode-remote://diff/\(agentId)"])
        app.element("diff.summary").waitFor(20)
        snap("06-diff")

        app = relaunch(["-kc-tab", "runs"])
        Thread.sleep(forTimeInterval: 2)
        snap("07-runs")

        app = relaunch(["-kc-tab", "voice"])
        Thread.sleep(forTimeInterval: 2)
        snap("08-kalvoice")

        app = relaunch([])
        app.first(prefix: "agentCard.").waitFor(20)
        try host("kill")
        app.element("banner.reconnecting").waitFor(45)
        snap("09-reconnecting")
        try host("start")
        XCTAssertTrue(app.element("banner.reconnecting").waitToDisappear(45))

        try host("revoke")
        if !app.element("removed.view").waitForExistence(timeout: 20) {
            try host("kill"); try host("start")
        }
        app.element("removed.view").waitFor(45)
        snap("10-removed")
    }
}
