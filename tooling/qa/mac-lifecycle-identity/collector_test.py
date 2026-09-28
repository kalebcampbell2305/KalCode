"""Fixture-only tests for collect_lifecycle_identity.py.

Every OS boundary (identity, codesign/spctl/lipo/osascript, --build-info) is replaced by a fake
environment over a synthetic fake home in a unique temporary directory. No real profile, app,
Launch Services database or network is touched. Runs on Windows or macOS:

    python -B tooling/qa/mac-lifecycle-identity/collector_test.py
"""

import datetime
import hashlib
import importlib.util
import json
import os
import plistlib
import re
import shutil
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("collector", os.path.join(HERE, "collect_lifecycle_identity.py"))
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)

PROFILE = "kalcodeqa2"
UID = 503


def sha(data):
    return hashlib.sha256(data).hexdigest()


def can_symlink():
    probe = tempfile.mkdtemp()
    try:
        os.symlink(probe, os.path.join(probe, "link"))
        return True
    except (OSError, NotImplementedError):
        return False
    finally:
        shutil.rmtree(probe, ignore_errors=True)


SYMLINKS = can_symlink()
BASE_EXE = b"synthetic-baseline-kalcode-0.1.4"
CAND_EXE = b"synthetic-candidate-kalcode-0.1.5"
BASE_DMG = b"synthetic-retained-baseline-dmg-bytes" * 64
BASE = {
    "role": "baseline", "version": "0.1.4", "commit": "1" * 40, "dmgSha256": sha(BASE_DMG),
    "executableSha256": sha(BASE_EXE), "bundleTreeSha256": None,
}
CAND_PIN = {  # bundleTreeSha256 is bound after Fixture to the synthetic candidate install's digest
    "schemaVersion": 1, "role": "candidate", "version": "0.1.5", "commit": "2" * 40, "dmgSha256": "3" * 64,
    "executableSha256": sha(CAND_EXE), "bundleTreeSha256": None,
}


class FakeEnv:
    """Replaces only OS boundaries; filesystem reads go to the synthetic home."""

    def __init__(self, root, version, **overrides):
        self.users_root = root
        self.version = version
        self.o = {
            "user": PROFILE, "console": PROFILE, "uid": UID, "groups": {"staff"}, "home": os.path.join(root, PROFILE),
            "verify_rc": 0, "team": C.TEAM_ID, "identifier": C.BUNDLE_ID, "devid": True, "runtime": True, "timestamp": True,
            "spctl_rc": 0, "archs": "arm64", "build_info": None, "handler": None, "raise_on": None,
        }
        self.o.update(overrides)
        self.calls = []

    def user_name(self):
        return self.o["user"]

    def uid(self):
        return self.o["uid"]

    def owns(self, info):
        return self.o.get("owns", True)

    def group_names(self):
        return self.o["groups"]

    def console_user(self):
        return self.o["console"]

    def home_env(self):
        return self.o["home"]

    def now(self):
        return datetime.datetime(2026, 9, 28, 12, 0, 0, 123000, tzinfo=datetime.timezone.utc)

    def run(self, argv, timeout=120):
        self.calls.append(list(argv))
        tool = argv[0]
        if self.o["raise_on"] and self.o["raise_on"] in tool:
            raise RuntimeError("SECRET-token=abc user@example.com must never be copied")
        if tool == C.CODESIGN and argv[1] == "--verify":
            return self.o["verify_rc"], b"", b"raw verify text must not be copied"
        if tool == C.CODESIGN and argv[1] == "--display":
            is_app = argv[-1].endswith(".app")
            lines = [f"Identifier={self.o['identifier'] if is_app else 'com.kalcode.helper'}", "CodeDirectory v=20500 size=1 flags=0x10000(%s) hashes=1" % ("runtime" if self.o["runtime"] else "none")]
            if self.o["devid"]:
                lines.append("Authority=Developer ID Application: Private Person Name (JG5K9T47ZF)")
            if self.o["timestamp"]:
                lines.append("Timestamp=Sep 28, 2026 at 12:00:00")
            lines.append(f"TeamIdentifier={self.o['team']}")
            return 0, b"", "\n".join(lines).encode()
        if tool == C.SPCTL:
            return self.o["spctl_rc"], b"", b"accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Private Person Name"
        if tool == C.LIPO:
            return 0, (self.o["archs"] + "\n").encode(), b""
        if tool == C.OSASCRIPT:
            app = os.path.join(self.o["home"], "Applications", "KalCode.app")
            value = self.o["handler"] or {"handlerPath": app, "registeredPaths": [app], "running": [{"pid": 4242, "bundlePath": app}]}
            return 0, json.dumps(value).encode(), b""
        if argv[1:] == ["--build-info"]:
            value = self.o["build_info"] or {"schemaVersion": 1, "version": self.version, "channel": "stable", "testHooks": False}
            return 0, (value if isinstance(value, bytes) else json.dumps(value).encode()), b""
        raise AssertionError(f"unexpected OS call {argv}")


class Fixture:
    """Synthetic fake QA home with an installed app and updater state."""

    def __init__(self, test):
        # realpath: macOS temp roots live under the /var -> /private/var symlink, which the
        # collector's linked-path guards correctly refuse; fixtures must start from a canonical path.
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="kalcode-mac-lifecycle-"))
        test.addCleanup(shutil.rmtree, self.root, True)
        self.home = os.path.join(self.root, PROFILE)
        self.apps = os.path.join(self.home, "Applications")
        self.app = os.path.join(self.apps, "KalCode.app")
        self.data = os.path.join(self.home, "Library", "Application Support", C.BUNDLE_ID)
        self.updates = os.path.join(self.data, "updates")
        self.rollback = os.path.join(self.updates, "rollback")
        os.makedirs(self.home)

    def install(self, version, exe, bundle_id=C.BUNDLE_ID, extra=b""):
        shutil.rmtree(self.app, ignore_errors=True)
        macos = os.path.join(self.app, "Contents", "MacOS")
        os.makedirs(macos)
        with open(os.path.join(self.app, "Contents", "Info.plist"), "wb") as handle:
            plistlib.dump({"CFBundleIdentifier": bundle_id, "CFBundleShortVersionString": version}, handle)
        with open(os.path.join(macos, "kalcode"), "wb") as handle:
            handle.write(exe)
        for helper in C.HELPERS:
            with open(os.path.join(macos, helper), "wb") as handle:
                handle.write(helper.encode() + extra)

    def journal(self, value):
        os.makedirs(self.updates, exist_ok=True)
        with open(os.path.join(self.updates, "updater.json"), "w", encoding="utf-8") as handle:
            handle.write(value if isinstance(value, str) else json.dumps(value))

    def retain(self, dmg=BASE_DMG, **receipt_overrides):
        os.makedirs(self.rollback, exist_ok=True)
        digest = sha(BASE_DMG)
        with open(os.path.join(self.rollback, f"previous-{digest}.bin"), "wb") as handle:
            handle.write(dmg)
        receipt = {
            "schemaVersion": 2, "target": "darwin-aarch64", "format": "dmg", "channel": "stable", "version": BASE["version"],
            "size": len(BASE_DMG), "sha256": digest, "commit": BASE["commit"], "signature": "U0VDUkVULVNJR05BVFVSRS1CWVRFUw==",
            "artifactFile": f"previous-{digest}.bin",
        }
        receipt.update(receipt_overrides)
        with open(os.path.join(self.rollback, "rollback-receipt.json"), "w", encoding="utf-8") as handle:
            json.dump(receipt, handle)

    def state_for(self, step):
        if step == "B0":
            self.install("0.1.4", BASE_EXE)
            return "0.1.4"
        destination = "0.1.4" if step == "rollback" else "0.1.5"
        self.install(destination, BASE_EXE if step == "rollback" else CAND_EXE)
        self.journal({"schemaVersion": 2, "channel": "stable", "installAttempt": None, "lastSuccessfulVersion": destination, "lastFailure": None})
        self.retain()
        return destination


class _Cleanup:
    def __init__(self):
        self.calls = []

    def addCleanup(self, fn, *args):
        self.calls.append((fn, args))


def _reference_candidate_tree():
    holder = _Cleanup()
    fixture = Fixture(holder)
    try:
        fixture.install("0.1.5", CAND_EXE)
        return C.bundle_tree_sha256(fixture.app)[0]
    finally:
        for fn, args in holder.calls:
            fn(*args)


CAND_PIN["bundleTreeSha256"] = _reference_candidate_tree()
IDENTITY = {"file":"collect_lifecycle_identity.py", "sha256": "0" * 64, "candidatePinSha256": "0" * 64}


def run_step(test, step, fixture=None, **env_overrides):
    if fixture is None:  # a caller-supplied fixture is already prepared (and possibly mutated)
        fixture = Fixture(test)
        fixture.state_for(step)
    version = "0.1.4" if C.STEPS[step] == "baseline" else "0.1.5"
    env = FakeEnv(fixture.root, version, **env_overrides)
    report = C.collect(env, fixture.home, step, BASE, C.validate_candidate_pin(dict(CAND_PIN), BASE), IDENTITY)
    return report, fixture, env


class ContextGuard(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture(self)

    def env(self, **overrides):
        return FakeEnv(self.fx.root, "0.1.4", **overrides)

    def test_exact_standard_qa2_accepted(self):
        self.assertEqual(C.assert_context(self.env()), self.fx.home)

    def test_rejections(self):
        for overrides in ({"user": "kalcodeqa"}, {"user": "kalcodeqa3"}, {"console": "kalebcampbell"}, {"uid": 0},
                          {"groups": {"staff", "admin"}}, {"home": self.fx.home + "-other"}, {"home": ""}):
            with self.subTest(overrides=overrides), self.assertRaises(C.Refusal):
                C.assert_context(self.env(**overrides))

    @unittest.skipUnless(SYMLINKS, "symlinks unavailable on this host")
    def test_linked_home_refused(self):
        real = os.path.join(self.fx.root, "real-home")
        os.makedirs(real)
        shutil.rmtree(self.fx.home)
        os.symlink(real, self.fx.home)
        with self.assertRaises(C.Refusal):
            C.assert_context(self.env())


class Pins(unittest.TestCase):
    def test_baseline_pin_is_certified_retained_014(self):
        self.assertEqual(C.BASELINE_PIN["version"], "0.1.4")
        self.assertEqual(C.BASELINE_PIN["commit"], "0ee34938d6543bba3679cb008174231d0e9544ec")
        self.assertEqual(C.BASELINE_PIN["dmgSha256"], "918646e4b26f39463a6bd841c2f705ed7a18b42ec271668932a97b7d65c8c987")
        self.assertEqual(C.BASELINE_PIN["executableSha256"], "7dd8a8225967d43c5fe925061ac536db8a56dee9fef1daa1b2a14a1e21e6265a")
        self.assertEqual(C.BASELINE_COMPILED_STABLE_VERSION, "0.1.5")

    def test_no_candidate_identity_hardcoded(self):
        with open(os.path.join(HERE, "collect_lifecycle_identity.py"), encoding="utf-8") as handle:
            source = handle.read()
        for value in ("826cab4", "eb674623ba3ebdbf", "f3a8e2fbe37aa6c7", "bf79e314", "5181b095"):
            self.assertNotIn(value, source.split('"""', 2)[2])

    def test_candidate_pin_valid(self):
        self.assertEqual(C.validate_candidate_pin(dict(CAND_PIN), BASE)["commit"], "2" * 40)
        with open(os.path.join(HERE, "candidate-pin.template.json"), encoding="utf-8") as handle:
            template = json.load(handle)
        self.assertEqual(sorted(template), sorted(C.CANDIDATE_PIN_KEYS))
        with self.assertRaises(C.Refusal):
            C.validate_candidate_pin(template, BASE)

    def test_candidate_pin_rejections(self):
        cases = [
            {"commit": "<B-PRIME>"}, {"dmgSha256": "A" * 64}, {"executableSha256": "1" * 63}, {"bundleTreeSha256": "x"},
            {"version": "0.1.6"}, {"version": "0.1.4"}, {"commit": BASE["commit"]}, {"role": "baseline"}, {"schemaVersion": 2},
            {"schemaVersion": True}, {"schemaVersion": 1.0}, {"bundleTreeSha256": None},
            {"dmgSha256": BASE["dmgSha256"]}, {"executableSha256": BASE["executableSha256"]},
        ]
        for change in cases:
            with self.subTest(change=change), self.assertRaises(C.Refusal):
                C.validate_candidate_pin({**CAND_PIN, **change}, BASE)
        with self.assertRaises(C.Refusal):  # candidate tree equal to a pinned baseline tree
            C.validate_candidate_pin(dict(CAND_PIN), {**BASE, "bundleTreeSha256": CAND_PIN["bundleTreeSha256"]})
        extra = {**CAND_PIN, "note": "x"}
        missing = {k: v for k, v in CAND_PIN.items() if k != "dmgSha256"}
        for pin in (extra, missing, None, []):
            with self.subTest(pin=pin), self.assertRaises(C.Refusal):
                C.validate_candidate_pin(pin, BASE)

    def test_role_step_mismatch_refused_before_any_os_access(self):
        for argv in (["--role", "candidate", "--step", "B0"], ["--role", "baseline", "--step", "update"], ["--step", "rollback"]):
            with self.subTest(argv=argv):
                self.assertEqual(C.main(argv), 2)


class LifecycleSteps(unittest.TestCase):
    def test_every_checkpoint_matches_on_consistent_state(self):
        for step in ("B0", "update", "rollback", "reupdate"):
            with self.subTest(step=step):
                report, _, env = run_step(self, step)
                self.assertEqual(report["status"], "lifecycle-identity-matched", report["failedChecks"])
                self.assertEqual(report["applicationLaunched"], False)
                self.assertTrue(report["buildInfoProbeExecuted"])
                self.assertFalse(any(call[:2] == [C.OSASCRIPT, "set"] for call in env.calls))

    def test_update_and_reupdate_bundle_digest_identical_rollback_equals_b0(self):
        digests = {step: run_step(self, step)[0]["app"]["bundleTreeSha256"] for step in ("B0", "update", "rollback", "reupdate")}
        self.assertEqual(digests["update"], digests["reupdate"])
        self.assertEqual(digests["B0"], digests["rollback"])
        self.assertNotEqual(digests["B0"], digests["update"])

    def test_b0_tolerates_absent_journal_and_retention(self):
        report, _, _ = run_step(self, "B0")
        self.assertEqual(report["journal"], {"exists": False})
        self.assertFalse(report["rollback"]["receiptExists"])

    def test_pinned_bundle_tree_enforced(self):
        fx = Fixture(self)
        fx.state_for("update")
        tree, _ = C.bundle_tree_sha256(fx.app)
        env = FakeEnv(fx.root, "0.1.5")
        good = C.collect(env, fx.home, "update", BASE, {**CAND_PIN, "bundleTreeSha256": tree}, IDENTITY)
        bad = C.collect(env, fx.home, "update", BASE, {**CAND_PIN, "bundleTreeSha256": "9" * 64}, IDENTITY)
        self.assertEqual(good["status"], "lifecycle-identity-matched")
        self.assertIn("app.bundleTreeSha256", bad["failedChecks"])


class Mismatches(unittest.TestCase):
    def expect(self, failed_check, step="update", mutate=None, **env_overrides):
        fx = Fixture(self)
        fx.state_for(step)
        if mutate:
            mutate(fx)
        report, _, _ = run_step(self, step, fixture=fx, **env_overrides)
        self.assertEqual(report["status"], "identity-mismatch-pending-review")
        self.assertIn(failed_check, report["failedChecks"])
        return report

    def test_identity_mismatches(self):
        self.expect("app.executableSha256", mutate=lambda fx: fx.install("0.1.5", b"other-bytes"))
        self.expect("app.version", mutate=lambda fx: fx.install("0.1.4", CAND_EXE))
        self.expect("app.bundleId", mutate=lambda fx: fx.install("0.1.5", CAND_EXE, bundle_id="com.example.other"))
        self.expect("app.executableSha256", step="rollback", mutate=lambda fx: fx.install("0.1.4", CAND_EXE))
        self.expect("app.developerIdTeam", team="ABCDEFGHIJ")
        self.expect("app.developerIdTeam", devid=False)
        self.expect("app.codesignStrict", verify_rc=1)
        self.expect("app.hardenedRuntimeTimestamped", runtime=False)
        self.expect("app.gatekeeper", spctl_rc=3)
        self.expect("app.archArm64", archs="x86_64 arm64")
        self.expect("app.helpersSigned", mutate=lambda fx: os.remove(os.path.join(fx.app, "Contents", "MacOS", "kalcode-update-helper")))
        self.expect("app.ordinaryPerUserInstall", owns=False)
        self.expect("app.ordinaryPerUserInstall", mutate=lambda fx: shutil.rmtree(fx.app))

    def test_build_info_mismatches(self):
        for info in ({"schemaVersion": 1, "version": "0.1.5", "channel": "stable", "testHooks": True},
                     {"schemaVersion": 1, "version": "0.1.5", "channel": "beta", "testHooks": False},
                     {"schemaVersion": 1, "version": "0.1.4", "channel": "stable", "testHooks": False},
                     {"schemaVersion": 1, "version": "0.1.5", "channel": "stable", "testHooks": False, "extra": 1},
                     b"x" * 5000, b"not json"):
            with self.subTest(info=info if not isinstance(info, bytes) else info[:10]):
                self.expect("buildInfo.production", build_info=info)

    def test_handler_mismatch_and_non_gating_singleton(self):
        other = "/Users/kalcodeqa/Applications/KalCode.app"
        self.expect("handler.exactInstalledApp", handler={"handlerPath": other, "registeredPaths": [other], "running": []})
        fx = Fixture(self)
        fx.state_for("update")
        app = os.path.join(fx.home, "Applications", "KalCode.app")
        report, _, _ = run_step(self, "update", fixture=fx, handler={"handlerPath": app, "registeredPaths": [app, "/Volumes/KalCode/KalCode.app"], "running": [{"pid": 1, "bundlePath": app}, {"pid": 2, "bundlePath": "/Volumes/KalCode/KalCode.app"}]})
        self.assertEqual(report["status"], "lifecycle-identity-matched")
        self.assertFalse(report["handler"]["registeredOnlyInstalledApp"])
        self.assertEqual(report["handler"]["runningInstances"], 2)
        self.assertFalse(report["handler"]["runningFromInstalledPathOnly"])

    def test_leftover_swap_directory(self):
        self.expect("swap.noLeftoverStagedApps", mutate=lambda fx: os.makedirs(os.path.join(fx.apps, ".KalCode-update-abc123.app")))

    def test_previous_version_preserved_signature(self):
        report = self.expect("journal.noRecordedFailure", mutate=lambda fx: fx.journal(
            {"schemaVersion": 2, "channel": "stable", "installAttempt": None, "lastSuccessfulVersion": None, "lastFailure": "install_did_not_advance"}))
        self.assertEqual(report["journal"]["lastFailure"], {"code": "install_did_not_advance", "known": True})
        self.assertIn("journal.lastSuccessfulIsDestination", report["failedChecks"])

    def test_pending_attempt_and_wrong_destination(self):
        attempt = {"kind": "upgrade", "fromVersion": "0.1.4", "toVersion": "0.1.5", "sha256": "3" * 64, "startedAt": "1",
                   "binding": {"target": "darwin-aarch64", "sourceSha256": "4" * 64, "signingRequirementSha256": "5" * 64},
                   "macSwap": {"currentApp": "/Users/kalcodeqa2/Applications/KalCode.app", "stagedApp": "/Users/kalcodeqa2/Applications/.KalCode-update-x.app",
                               "parentPid": 7, "parentIdentitySha256": "6" * 64, "phase": "swapped"}}
        report = self.expect("journal.noPendingAttempt", mutate=lambda fx: fx.journal(
            {"schemaVersion": 2, "channel": "stable", "installAttempt": attempt, "lastSuccessfulVersion": "0.1.4", "lastFailure": None}))
        self.assertEqual(report["journal"]["installAttempt"]["macSwapPhase"], "swapped")
        self.assertNotIn("currentApp", json.dumps(report["journal"]))
        self.expect("journal.lastSuccessfulIsDestination", step="rollback", mutate=lambda fx: fx.journal(
            {"schemaVersion": 2, "channel": "stable", "installAttempt": None, "lastSuccessfulVersion": "0.1.5", "lastFailure": None}))

    def test_missing_journal_after_transition(self):
        self.expect("journal.present", mutate=lambda fx: os.remove(os.path.join(fx.updates, "updater.json")))

    def test_rollback_retention_mismatches(self):
        self.expect("rollback.retainedBaseline", mutate=lambda fx: shutil.rmtree(fx.rollback))
        self.expect("rollback.retainedBaseline", mutate=lambda fx: fx.retain(dmg=b"tampered" + BASE_DMG[8:]))
        self.expect("rollback.retainedBaseline", mutate=lambda fx: fx.retain(commit="9" * 40))
        self.expect("rollback.retainedBaseline", mutate=lambda fx: fx.retain(version="0.1.3"))
        self.expect("rollback.retainedBaseline", step="reupdate", mutate=lambda fx: fx.retain(target="windows-x86_64", format="nsis"))
        self.expect("rollback.retainedBaseline", step="rollback", mutate=lambda fx: os.remove(os.path.join(fx.rollback, f"previous-{sha(BASE_DMG)}.bin")))

        def stray(fx):
            with open(os.path.join(fx.rollback, f"previous-{'a' * 64}.bin"), "wb") as handle:
                handle.write(b"stale")
        self.expect("rollback.noStrayArtifacts", mutate=stray)


class Redaction(unittest.TestCase):
    def test_journal_projection_drops_unknown_fields_and_codes(self):
        fx = Fixture(self)
        fx.journal({"schemaVersion": 2, "channel": "private", "lastSuccessfulVersion": "secret", "lastFailure": "Bearer eyJhbGciOi user@example.com",
                    "secret": "must-not-copy", "installAttempt": {"kind": "evil", "fromVersion": "x", "toVersion": "0.1.5", "sha256": "no", "startedAt": "1"}})
        view = C.journal_projection(os.path.join(fx.updates, "updater.json"))
        self.assertEqual(view["channel"], "unknown")
        self.assertIsNone(view["lastSuccessfulVersion"])
        self.assertEqual(view["lastFailure"], {"code": "unrecognized", "known": False})
        self.assertEqual(view["installAttempt"]["kind"], "unknown")
        self.assertIsNone(view["installAttempt"]["sha256"])
        self.assertNotIn("must-not-copy", json.dumps(view))
        self.assertNotIn("example.com", json.dumps(view))

    def test_oversized_and_malformed_journal_refused(self):
        fx = Fixture(self)
        fx.journal("{" + " " * (C.MAX_STATE_BYTES + 1))
        with self.assertRaises(C.Unsafe):
            C.journal_projection(os.path.join(fx.updates, "updater.json"))
        fx.journal("{SECRET")
        with self.assertRaises(C.Unsafe):
            C.journal_projection(os.path.join(fx.updates, "updater.json"))

    def test_receipt_never_contains_signature_names_or_raw_tool_text(self):
        report, _, _ = run_step(self, "update")
        text = json.dumps(report)
        for forbidden in ("U0VDUkVULVNJR05BVFVSRS1CWVRFUw==", "Private Person Name", "raw verify text", "@"):
            self.assertNotIn(forbidden, text)
        self.assertTrue(report["rollback"]["signaturePresent"])

    def test_rollback_artifact_traversal_refused(self):
        fx = Fixture(self)
        fx.retain(artifactFile="../../../../etc/passwd")
        view = C.rollback_projection(fx.home, fx.rollback)
        self.assertFalse(view["artifactFileCanonical"])
        self.assertNotIn("artifactSha256", view)
        fx.retain(unexpected="field")
        with self.assertRaises(C.Unsafe):
            C.rollback_projection(fx.home, fx.rollback)

    def test_exception_text_is_replaced_by_constant_key(self):
        report, _, _ = run_step(self, "update", raise_on="lipo")
        self.assertEqual(report["status"], "pending-error")
        self.assertEqual(report["errors"], ["app:collection-failed"])
        self.assertNotIn("SECRET", json.dumps(report))

    def test_unsafe_section_records_constant_reason(self):
        fx = Fixture(self)
        fx.state_for("update")
        fx.journal("{SECRET")
        report, _, _ = run_step(self, "update", fixture=fx)
        self.assertEqual(report["status"], "pending-error")
        self.assertIn("journal:journal-malformed", report["errors"])
        self.assertNotIn("SECRET", json.dumps(report))


class PathSafety(unittest.TestCase):
    def test_outside_home_and_traversal_refused(self):
        fx = Fixture(self)
        for path in (os.path.join(fx.root, "kalcodeqa", "x"), os.path.join(fx.home, "..", "kalcodeqa", "x"), "relative/x"):
            with self.subTest(path=path), self.assertRaises(C.Unsafe):
                C.safe_under(fx.home, path)

    @unittest.skipUnless(SYMLINKS, "symlinks unavailable on this host")
    def test_linked_components_refused(self):
        fx = Fixture(self)
        fx.state_for("update")
        elsewhere = os.path.join(fx.root, "elsewhere")
        shutil.move(fx.updates, elsewhere)
        os.symlink(elsewhere, fx.updates)
        report, _, _ = run_step(self, "update", fixture=fx)
        self.assertEqual(report["status"], "pending-error")
        self.assertIn("journal:linked-path", report["errors"])

    @unittest.skipUnless(SYMLINKS, "symlinks unavailable on this host")
    def test_bundle_digest_does_not_follow_links(self):
        fx = Fixture(self)
        fx.install("0.1.5", CAND_EXE)
        before, _ = C.bundle_tree_sha256(fx.app)
        os.symlink("../../../../outside", os.path.join(fx.app, "Contents", "link"))
        after, _ = C.bundle_tree_sha256(fx.app)
        self.assertNotEqual(before, after)


class BundleDigest(unittest.TestCase):
    def test_deterministic_and_content_sensitive(self):
        fx = Fixture(self)
        fx.install("0.1.5", CAND_EXE)
        first, count = C.bundle_tree_sha256(fx.app)
        self.assertEqual(first, C.bundle_tree_sha256(fx.app)[0])
        self.assertGreater(count, 5)
        fx.install("0.1.5", CAND_EXE, extra=b"!")
        self.assertNotEqual(first, C.bundle_tree_sha256(fx.app)[0])

    def test_digest_mode_prints_only_digests(self):
        fx = Fixture(self)
        fx.install("0.1.5", CAND_EXE)
        self.assertEqual(C.main(["--digest-bundle", fx.app]), 0)
        self.assertEqual(C.main(["--digest-bundle", fx.home]), 2)


class Receipts(unittest.TestCase):
    def test_distinct_create_new_receipts(self):
        directory = os.path.realpath(tempfile.mkdtemp(prefix="kalcode-mac-receipts-"))
        self.addCleanup(shutil.rmtree, directory, True)
        report, _, env = run_step(self, "update")
        first = C.write_receipt(directory, report, env.now())
        second = C.write_receipt(directory, report, env.now())
        self.assertNotEqual(first, second)
        self.assertRegex(os.path.basename(first), r"^lifecycle-identity-kalcodeqa2-update-0\.1\.5-20260928T120000123Z-[0-9a-f]{32}\.json$")
        with open(first, encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)["status"], "lifecycle-identity-matched")

    @unittest.skipUnless(SYMLINKS, "symlinks unavailable on this host")
    def test_linked_receipt_directory_refused(self):
        directory = os.path.realpath(tempfile.mkdtemp(prefix="kalcode-mac-receipts-"))
        self.addCleanup(shutil.rmtree, directory, True)
        link = directory + "-link"
        os.symlink(directory, link)
        self.addCleanup(os.remove, link)
        with self.assertRaises(C.Refusal):
            C.assert_receipt_dir(link)


class Packet(unittest.TestCase):
    def test_wrappers_invoke_only_the_adjacent_collector(self):
        for name, role, steps in (("COLLECT-BASELINE-IDENTITY.command", "baseline", ("B0", "rollback")),
                                  ("COLLECT-CANDIDATE-IDENTITY.command", "candidate", ("update", "reupdate"))):
            with open(os.path.join(HERE, name), "rb") as handle:
                raw = handle.read()
            self.assertNotIn(b"\r\n", raw, name)
            text = raw.decode()
            self.assertTrue(text.startswith("#!/bin/zsh -f\n"))
            self.assertIn(f'/usr/bin/python3 -I -B "$here/collect_lifecycle_identity.py" --role {role} --step "$step"', text)
            for step in steps:
                self.assertIn(f"step={step}", text)
            for forbidden in (r"\bsudo\b", r"\bopen\s", r"\bhdiutil\b", r"scheme-binding", r"\sset\s", r"\brm\s", r"\bchmod\b", r"\bcurl\b"):
                self.assertIsNone(re.search(forbidden, text), forbidden)

    def test_manifest_inventory_matches_bytes(self):
        path = os.path.join(HERE, "manifest.json")
        if not os.path.exists(path):
            self.skipTest("manifest not yet generated")
        with open(path, encoding="utf-8") as handle:
            manifest = json.load(handle)
        listed = {item["file"] for item in manifest["files"]}
        present = {name for name in os.listdir(HERE) if os.path.isfile(os.path.join(HERE, name)) and name != "manifest.json"
                   and not name.startswith("lifecycle-identity-") and name != "candidate-pin.json"}
        self.assertEqual(listed, present)
        for item in manifest["files"]:
            with open(os.path.join(HERE, item["file"]), "rb") as handle:
                data = handle.read()
            self.assertEqual((len(data), sha(data)), (item["bytes"], item["sha256"]), item["file"])
        self.assertIsNone(re.search(r"826cab4|eb674623", json.dumps(manifest["baselinePin"])))


if __name__ == "__main__":
    unittest.main(verbosity=2)
