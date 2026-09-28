#!/usr/bin/env python3
"""KalCode macOS QA2 lifecycle identity collector (read-only).

Run as the standard lifecycle QA user at each checkpoint of the updater lifecycle trial:
B0 (initial retained baseline), update (baseline -> candidate), rollback (candidate -> retained
baseline) and reupdate (baseline -> same candidate). It records, without launching the app:

* installed bundle path, bundle id, version, executable SHA-256, deterministic bundle-tree digest,
  architecture, strict codesign / Developer ID team / hardened runtime / timestamp, Gatekeeper;
* the production `--build-info` probe (main.rs answers it and returns before Tauri, WebView,
  stores, providers or the single-instance plugin start; verified in main.rs at the retained
  baseline 0ee34938 and at the selected successor source f81d3eb7);
* the updater journal (`updates/updater.json`) as a bounded, allowlisted projection;
* rollback retention (`updates/rollback/rollback-receipt.json` + `previous-<sha>.bin`), hashing the
  retained package; the detached updater signature is never copied;
* the `kalcode://` handler (same semantics as the reviewed `scheme-binding query`: handlerPath and
  registeredPaths) and running KalCode instances, via a read-only NSWorkspace query;
* leftover `.KalCode-update-*.app` swap directories and app-data root mode (B5 visibility).

It never installs, launches, updates, rolls back, sets a handler, reads account stores, tokens,
callback URLs or emails, and never copies raw tool output or exception text into a receipt.
Candidate identity is a parameter (candidate-pin.json beside this file); no candidate value is
hard-coded. Python 3 standard library only; invoke with `python3 -I -B`.
"""

import argparse
import datetime
import hashlib
import json
import os
import plistlib
import re
import stat
import subprocess
import sys
import uuid

LIFECYCLE_PROFILE = "kalcodeqa2"
BUNDLE_ID = "com.kalcode.desktop"
TEAM_ID = "JG5K9T47ZF"
TARGET = "darwin-aarch64"
CHANNEL = "stable"
EXECUTABLE = "kalcode"
HELPERS = ("kalcode-update-helper", "kalcode-provider-guardian", "kalcode-hook")
MAX_STATE_BYTES = 64 * 1024  # crates/updater MAX_UPDATE_STATE_BYTES
MAX_PLIST_BYTES = 1024 * 1024
MAX_BUILD_INFO_BYTES = 4096
MAX_PACKAGE_BYTES = 512 * 1024 * 1024  # crates/updater MAX_UPDATE_BYTES
TOOL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
CODESIGN = "/usr/bin/codesign"
SPCTL = "/usr/sbin/spctl"
LIPO = "/usr/bin/lipo"
OSASCRIPT = "/usr/bin/osascript"

# Retained private baseline: certified Stable 0.1.4 arm64 (retained-baseline certification evidence).
# Its compiled Stable endpoint is pinned to stable/0.1.5.json, so any candidate for THIS baseline
# must be version 0.1.5 (a different candidate version requires a new baseline build).
BASELINE_PIN = {
    "role": "baseline",
    "version": "0.1.4",
    "commit": "0ee34938d6543bba3679cb008174231d0e9544ec",
    "dmgSha256": "918646e4b26f39463a6bd841c2f705ed7a18b42ec271668932a97b7d65c8c987",
    "executableSha256": "7dd8a8225967d43c5fe925061ac536db8a56dee9fef1daa1b2a14a1e21e6265a",
    "bundleTreeSha256": None,
}
BASELINE_COMPILED_STABLE_VERSION = "0.1.5"
CANDIDATE_PIN_FILE = "candidate-pin.json"
CANDIDATE_PIN_KEYS = ("schemaVersion", "role", "version", "commit", "dmgSha256", "executableSha256", "bundleTreeSha256")

STEPS = {"B0": "baseline", "update": "candidate", "rollback": "baseline", "reupdate": "candidate"}
KNOWN_FAILURE_CODES = frozenset({
    "install_did_not_advance",  # UI: "The update did not complete. Your previous version was preserved."
    "installed_version_unexpected",  # UI: "KalCode couldn't verify the previous update result."
    "update_shutdown_failed",
    "rollback_shutdown_failed",
    "mac_update_health_check_failed",
})
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
STAGED_RE = re.compile(r"^\.KalCode-update-[A-Za-z0-9.-]{1,80}\.app$")
ARTIFACT_FILE_RE = re.compile(r"^previous-([0-9a-f]{64})\.bin$")

HANDLER_QUERY_JXA = r"""
ObjC.import('AppKit');
function p(u) { if (!u || u.isNil()) { return ''; } return ObjC.unwrap(u.URLByStandardizingPath.URLByResolvingSymlinksInPath.path); }
var ws = $.NSWorkspace.sharedWorkspace;
var probe = $.NSURL.URLWithString('kalcode://auth/google');
var handlerPath = p(ws.URLForApplicationToOpenURL(probe));
var registeredPaths = [];
var all = ws.URLsForApplicationsToOpenURL(probe);
for (var i = 0; i < all.count; i++) { registeredPaths.push(p(all.objectAtIndex(i))); }
var running = [];
var apps = ws.runningApplications;
for (var j = 0; j < apps.count; j++) {
  var app = apps.objectAtIndex(j);
  var id = app.bundleIdentifier;
  if (!id.isNil() && ObjC.unwrap(id) === 'com.kalcode.desktop') {
    running.push({ pid: app.processIdentifier, bundlePath: p(app.bundleURL) });
  }
}
JSON.stringify({ handlerPath: handlerPath, registeredPaths: registeredPaths, running: running });
"""


class Refusal(Exception):
    """Guard/usage refusal raised before any installed read or receipt write."""


class Unsafe(Exception):
    """A collection section met unsafe or malformed state; recorded as a constant error key."""


# ---------------------------------------------------------------------------------------------
# OS boundary. The real environment is built only by main(); there is no fixture/test CLI mode.
# ---------------------------------------------------------------------------------------------
class RealEnv:
    users_root = "/Users"

    def __init__(self):
        import grp  # noqa: PLC0415 - POSIX only; kept out of module import for the Windows test host
        import pwd  # noqa: PLC0415

        self._grp = grp
        self._pwd = pwd

    def user_name(self):
        return self._pwd.getpwuid(os.getuid()).pw_name

    def uid(self):
        return os.getuid()

    def owns(self, info):
        return info.st_uid == os.getuid()

    def group_names(self):
        names = set()
        for gid in set(os.getgroups()) | {os.getgid()}:
            try:
                names.add(self._grp.getgrgid(gid).gr_name)
            except KeyError:
                continue
        return names

    def console_user(self):
        return self._pwd.getpwuid(os.stat("/dev/console").st_uid).pw_name

    def home_env(self):
        return os.environ.get("HOME", "")

    def run(self, argv, timeout=120):
        env = {"PATH": TOOL_PATH, "HOME": self.home_env(), "LANG": "C", "LC_ALL": "C"}
        try:
            done = subprocess.run(argv, capture_output=True, env=env, timeout=timeout, check=False, stdin=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            return None, b"", b""
        return done.returncode, done.stdout, done.stderr

    def now(self):
        return datetime.datetime.now(datetime.timezone.utc)


def assert_context(env, profile=LIFECYCLE_PROFILE):
    user = env.user_name()
    if user != profile:
        raise Refusal("Only the designated lifecycle QA user may collect lifecycle identity.")
    if env.console_user() != user:
        raise Refusal("Run locally from the designated QA desktop session.")
    if env.uid() == 0 or "admin" in env.group_names():
        raise Refusal("A standard non-admin QA user is required.")
    home = os.path.join(env.users_root, profile)
    if env.home_env() != home or os.path.realpath(home) != os.path.abspath(home):
        raise Refusal("Unexpected QA home directory.")
    info = os.lstat(home)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise Refusal("Unexpected QA home directory.")
    return home


def validate_candidate_pin(pin, baseline=None):
    baseline = baseline or BASELINE_PIN
    if not isinstance(pin, dict) or sorted(pin) != sorted(CANDIDATE_PIN_KEYS):
        raise Refusal("candidate-pin.json must contain exactly the documented keys.")
    tree = pin["bundleTreeSha256"]
    if (
        type(pin["schemaVersion"]) is not int  # JSON true would otherwise equal 1
        or pin["schemaVersion"] != 1
        or pin["role"] != "candidate"
        or not isinstance(pin["version"], str)
        or not VERSION_RE.match(pin["version"])
        or not isinstance(pin["commit"], str)
        or not COMMIT_RE.match(pin["commit"])
        or not isinstance(pin["dmgSha256"], str)
        or not SHA256_RE.match(pin["dmgSha256"])
        or not isinstance(pin["executableSha256"], str)
        or not SHA256_RE.match(pin["executableSha256"])
        or not isinstance(tree, str)
        or not SHA256_RE.match(tree)
    ):
        # The candidate bundle-tree digest is mandatory: it is what proves update and reupdate
        # installed the identical bytes from the certified DMG (--digest-bundle on the mounted app).
        raise Refusal("candidate-pin.json has an invalid or placeholder value.")
    if pin["dmgSha256"] == baseline["dmgSha256"] or pin["executableSha256"] == baseline["executableSha256"] or (
        baseline.get("bundleTreeSha256") and tree == baseline["bundleTreeSha256"]
    ):
        raise Refusal("Candidate digests must differ from the retained baseline.")
    if pin["version"] != BASELINE_COMPILED_STABLE_VERSION:
        raise Refusal("Candidate version must equal the retained baseline's compiled Stable endpoint version.")
    if _version_key(pin["version"]) <= _version_key(baseline["version"]) or pin["commit"] == baseline["commit"]:
        raise Refusal("Candidate must be newer than, and distinct from, the retained baseline.")
    return dict(pin)


def _version_key(value):
    return tuple(int(part) for part in value.split("."))


# ---------------------------------------------------------------------------------------------
# Bounded, symlink-refusing filesystem reads under the QA home.
# ---------------------------------------------------------------------------------------------
def safe_under(home, path):
    home = os.path.abspath(home)
    absolute = os.path.abspath(path)
    if os.path.normpath(path) != absolute or not absolute.startswith(home + os.sep):
        raise Unsafe("outside-home")
    probe = absolute
    while len(probe) > len(home):
        if os.path.lexists(probe) and stat.S_ISLNK(os.lstat(probe).st_mode):
            raise Unsafe("linked-path")
        probe = os.path.dirname(probe)
    return absolute


def regular_file(path):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode):
        raise Unsafe("not-regular-file")
    return info


def read_bounded(path, limit):
    info = regular_file(path)
    if info is None:
        return None
    if info.st_size > limit:
        raise Unsafe("oversized")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, "rb") as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise Unsafe("oversized")
    return data


def sha256_file(path, limit=MAX_PACKAGE_BYTES):
    info = regular_file(path)
    if info is None:
        return None
    if info.st_size > limit:
        raise Unsafe("oversized")
    digest = hashlib.sha256()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bundle_tree_sha256(app):
    """Deterministic content digest of a bundle: sorted (type, relative path, content/target).

    File modes, timestamps and extended attributes (quarantine) are excluded so an installed copy
    of the DMG's KalCode.app compares equal to the DMG's own app. Symlinks are never followed.
    """
    root = os.path.abspath(app)
    if stat.S_ISLNK(os.lstat(root).st_mode) or not os.path.isdir(root):
        raise Unsafe("bundle-not-directory")
    entries = []
    for current, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            full = os.path.join(current, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            info = os.lstat(full)
            if stat.S_ISLNK(info.st_mode):
                entries.append(("l", rel, os.readlink(full)))
            elif stat.S_ISDIR(info.st_mode):
                entries.append(("d", rel, ""))
            elif stat.S_ISREG(info.st_mode):
                entries.append(("f", rel, sha256_file(full)))
            else:
                raise Unsafe("bundle-special-file")
    digest = hashlib.sha256()
    for kind, rel, value in sorted(entries, key=lambda item: item[1]):
        digest.update(f"{kind}\0{rel}\0{value}\n".encode("utf-8", "surrogateescape"))
    return digest.hexdigest(), len(entries)


# ---------------------------------------------------------------------------------------------
# Sections. Each returns a projection containing only allowlisted, formatted values.
# ---------------------------------------------------------------------------------------------
def codesign_identity(env, path, deep):
    argv = [CODESIGN, "--verify", "--strict", "--verbose=2", path]
    if deep:
        argv.insert(2, "--deep")
    verify_rc, _, _ = env.run(argv)
    display_rc, _, display = env.run([CODESIGN, "--display", "--verbose=4", path])
    lines = display.decode("utf-8", "replace").splitlines() if display_rc == 0 else []
    team = next((line.split("=", 1)[1] for line in lines if line.startswith("TeamIdentifier=")), None)
    identifier = next((line.split("=", 1)[1] for line in lines if line.startswith("Identifier=")), None)
    return {
        "strictVerify": verify_rc == 0,
        "teamIdentifier": team if team and re.match(r"^[A-Z0-9]{10}$", team) else None,
        "identifier": identifier if identifier and re.match(r"^[A-Za-z0-9._-]{1,128}$", identifier) else None,
        "developerIdApplication": any(line.startswith("Authority=Developer ID Application:") for line in lines),
        "hardenedRuntime": any(line.startswith("CodeDirectory ") and "runtime" in line for line in lines),
        "timestamped": any(line.startswith("Timestamp=") for line in lines),
    }


def gatekeeper(env, app):
    rc, _, err = env.run([SPCTL, "--assess", "--type", "execute", "--verbose=4", app])
    text = err.decode("utf-8", "replace")
    return {"accepted": rc == 0, "notarizedDeveloperIdSource": "source=Notarized Developer ID" in text}


def build_info(env, executable):
    rc, out, _ = env.run([executable, "--build-info"], timeout=30)
    if rc != 0 or len(out) > MAX_BUILD_INFO_BYTES:
        return {"probeOk": False}
    try:
        value = json.loads(out.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return {"probeOk": False}
    if not isinstance(value, dict) or sorted(value) != ["channel", "schemaVersion", "testHooks", "version"]:
        return {"probeOk": False}
    version = value["version"] if isinstance(value["version"], str) and VERSION_RE.match(value["version"]) else None
    channel = value["channel"] if value["channel"] in ("stable", "beta", "dev") else None
    return {
        "probeOk": True,
        "schemaVersion": value["schemaVersion"] if value["schemaVersion"] == 1 else None,
        "version": version,
        "channel": channel,
        "testHooks": value["testHooks"] if isinstance(value["testHooks"], bool) else None,
    }


def installed_app(env, home):
    applications = safe_under(home, os.path.join(home, "Applications"))
    app = safe_under(home, os.path.join(applications, "KalCode.app"))
    result = {"path": app, "exists": False}
    try:
        info = os.lstat(app)
    except FileNotFoundError:
        return result
    if not stat.S_ISDIR(info.st_mode):
        raise Unsafe("app-not-directory")
    result["exists"] = True
    result["ownedByQaUser"] = env.owns(info)
    plist_bytes = read_bounded(safe_under(home, os.path.join(app, "Contents", "Info.plist")), MAX_PLIST_BYTES)
    plist = plistlib.loads(plist_bytes) if plist_bytes is not None else {}
    short = plist.get("CFBundleShortVersionString")
    bundle_id = plist.get("CFBundleIdentifier")
    result["bundleId"] = bundle_id if isinstance(bundle_id, str) and len(bundle_id) <= 128 else None
    result["shortVersion"] = short if isinstance(short, str) and VERSION_RE.match(short) else None
    executable = safe_under(home, os.path.join(app, "Contents", "MacOS", EXECUTABLE))
    result["executableSha256"] = sha256_file(executable)
    result["bundleTreeSha256"], result["bundleEntries"] = bundle_tree_sha256(app)
    rc, out, _ = env.run([LIPO, "-archs", executable])
    archs = out.decode("utf-8", "replace").strip() if rc == 0 else ""
    result["archs"] = archs if re.match(r"^[a-z0-9_ ]{1,64}$", archs) else None
    result["codesign"] = codesign_identity(env, app, deep=True)
    result["gatekeeper"] = gatekeeper(env, app)
    helpers = {}
    for name in HELPERS:
        helper = safe_under(home, os.path.join(app, "Contents", "MacOS", name))
        present = regular_file(helper) is not None
        helpers[name] = {"present": present}
        if present:
            helpers[name]["sha256"] = sha256_file(helper)
            helpers[name]["codesign"] = codesign_identity(env, helper, deep=False)
    result["helpers"] = helpers
    result["buildInfo"] = build_info(env, executable)
    return result


def staged_leftovers(home):
    applications = safe_under(home, os.path.join(home, "Applications"))
    try:
        names = os.listdir(applications)
    except FileNotFoundError:
        return []
    return sorted(name for name in names if STAGED_RE.match(name))


def app_data(env, home):
    root = safe_under(home, os.path.join(home, "Library", "Application Support", BUNDLE_ID))
    result = {}
    for label, path in (("root", root), ("updates", os.path.join(root, "updates"))):
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            result[label] = {"exists": False}
            continue
        result[label] = {
            "exists": True,
            "directory": stat.S_ISDIR(info.st_mode),
            "linked": stat.S_ISLNK(info.st_mode),
            "mode": format(stat.S_IMODE(info.st_mode), "04o"),
            "ownedByQaUser": env.owns(info),
        }
    return root, result


def journal_projection(path):
    data = read_bounded(path, MAX_STATE_BYTES)
    if data is None:
        return {"exists": False}
    try:
        journal = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise Unsafe("journal-malformed") from error
    if not isinstance(journal, dict):
        raise Unsafe("journal-malformed")

    def version(value):
        return value if isinstance(value, str) and VERSION_RE.match(value) else None

    failure = journal.get("lastFailure")
    if failure is None:
        failure_view = None
    elif isinstance(failure, str) and CODE_RE.match(failure):
        failure_view = {"code": failure, "known": failure in KNOWN_FAILURE_CODES}
    else:
        failure_view = {"code": "unrecognized", "known": False}
    attempt = journal.get("installAttempt")
    attempt_view = None
    if attempt is not None:
        if not isinstance(attempt, dict):
            raise Unsafe("journal-malformed")
        swap = attempt.get("macSwap")
        phase = swap.get("phase") if isinstance(swap, dict) else None
        attempt_view = {
            "kind": attempt.get("kind", "upgrade") if attempt.get("kind", "upgrade") in ("upgrade", "rollback") else "unknown",
            "fromVersion": version(attempt.get("fromVersion")),
            "toVersion": version(attempt.get("toVersion")),
            "sha256": attempt.get("sha256") if isinstance(attempt.get("sha256"), str) and SHA256_RE.match(attempt["sha256"]) else None,
            "macSwapPhase": phase if phase in ("prepared", "swapped", "launched") else None,
        }
    schema = journal.get("schemaVersion")
    return {
        "exists": True,
        "schemaVersion": schema if schema in (1, 2) else None,
        "channel": journal.get("channel") if journal.get("channel") in ("stable", "beta", "dev") else "unknown",
        "lastSuccessfulVersion": version(journal.get("lastSuccessfulVersion")),
        "lastFailure": failure_view,
        "installAttempt": attempt_view,
    }


def rollback_projection(home, rollback_dir):
    receipt_path = safe_under(home, os.path.join(rollback_dir, "rollback-receipt.json"))
    try:
        names = sorted(os.listdir(rollback_dir))
    except FileNotFoundError:
        names = []
    data = read_bounded(receipt_path, MAX_STATE_BYTES)
    view = {"receiptExists": data is not None}
    retained = None
    if data is not None:
        try:
            receipt = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as error:
            raise Unsafe("rollback-receipt-malformed") from error
        allowed = {"schemaVersion", "target", "format", "channel", "version", "size", "sha256", "commit", "signature", "artifactFile"}
        if not isinstance(receipt, dict) or not set(receipt) <= allowed:
            raise Unsafe("rollback-receipt-malformed")
        size = receipt.get("size")
        artifact_file = receipt.get("artifactFile")
        artifact_match = ARTIFACT_FILE_RE.match(artifact_file) if isinstance(artifact_file, str) else None
        view.update({
            "schemaVersion": receipt.get("schemaVersion") if receipt.get("schemaVersion") in (1, 2) else None,
            "target": receipt.get("target") if receipt.get("target") in ("darwin-aarch64", "windows-x86_64") else None,
            "format": receipt.get("format") if receipt.get("format") in ("dmg", "nsis") else None,
            "channel": receipt.get("channel") if receipt.get("channel") in ("stable", "beta", "dev") else None,
            "version": receipt.get("version") if isinstance(receipt.get("version"), str) and VERSION_RE.match(receipt["version"]) else None,
            "commit": receipt.get("commit") if isinstance(receipt.get("commit"), str) and COMMIT_RE.match(receipt["commit"]) else None,
            "sha256": receipt.get("sha256") if isinstance(receipt.get("sha256"), str) and SHA256_RE.match(receipt["sha256"]) else None,
            "size": size if isinstance(size, int) and not isinstance(size, bool) and 0 < size <= MAX_PACKAGE_BYTES else None,
            "signaturePresent": isinstance(receipt.get("signature"), str) and len(receipt["signature"]) > 0,
            "artifactFileCanonical": bool(artifact_match) and artifact_match.group(1) == receipt.get("sha256"),
        })
        if view["artifactFileCanonical"]:
            retained = artifact_file
            artifact = safe_under(home, os.path.join(rollback_dir, artifact_file))
            info = regular_file(artifact)
            view["artifactExists"] = info is not None
            if info is not None:
                view["artifactSize"] = info.st_size
                view["artifactSha256"] = sha256_file(artifact)
    view["strayArtifacts"] = sorted(
        name for name in names if name.startswith("previous-") and name != retained and re.match(r"^previous-[0-9a-f]{64}\.bin(\.next)?$", name)
    )
    return view


def handler_query(env, app_path):
    rc, out, _ = env.run([OSASCRIPT, "-l", "JavaScript", "-e", HANDLER_QUERY_JXA], timeout=60)
    if rc != 0:
        return {"queryOk": False}
    try:
        value = json.loads(out.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return {"queryOk": False}
    if not isinstance(value, dict) or sorted(value) != ["handlerPath", "registeredPaths", "running"]:
        return {"queryOk": False}

    def path(item):
        return item if isinstance(item, str) and os.path.isabs(item) and len(item) <= 1024 and item.endswith(".app") else None

    registered = [path(item) for item in value["registeredPaths"]] if isinstance(value["registeredPaths"], list) else []
    running = []
    for item in value["running"] if isinstance(value["running"], list) else []:
        if isinstance(item, dict):
            pid = item.get("pid")
            running.append({"pid": pid if isinstance(pid, int) and not isinstance(pid, bool) else None, "bundlePath": path(item.get("bundlePath"))})
    handler = path(value["handlerPath"])
    return {
        "queryOk": True,
        "handlerPath": handler,
        "registeredPaths": registered,
        "handlerExact": handler == app_path,
        "registeredOnlyInstalledApp": registered == [app_path],
        "running": running,
        "runningInstances": len(running),
        "runningFromInstalledPathOnly": len(running) <= 1 and all(item["bundlePath"] == app_path for item in running),
    }


# ---------------------------------------------------------------------------------------------
# Evaluation of a checkpoint against the pinned from/to identities.
# ---------------------------------------------------------------------------------------------
def evaluate(report, step, baseline, candidate):
    expected = baseline if STEPS[step] == "baseline" else candidate
    app = report.get("app") or {}
    checks = []

    def check(name, passed, gating=True):
        checks.append({"name": name, "passed": bool(passed), "gating": gating})

    sign = app.get("codesign") or {}
    info = app.get("buildInfo") or {}
    check("app.ordinaryPerUserInstall", app.get("exists") and app.get("ownedByQaUser"))
    check("app.bundleId", app.get("bundleId") == BUNDLE_ID)
    check("app.version", app.get("shortVersion") == expected["version"])
    check("app.executableSha256", app.get("executableSha256") == expected["executableSha256"])
    if expected.get("bundleTreeSha256"):
        check("app.bundleTreeSha256", app.get("bundleTreeSha256") == expected["bundleTreeSha256"])
    check("app.archArm64", app.get("archs") == "arm64")
    check("app.codesignStrict", sign.get("strictVerify") and sign.get("identifier") == BUNDLE_ID)
    check("app.developerIdTeam", sign.get("teamIdentifier") == TEAM_ID and sign.get("developerIdApplication"))
    check("app.hardenedRuntimeTimestamped", sign.get("hardenedRuntime") and sign.get("timestamped"))
    check("app.gatekeeper", (app.get("gatekeeper") or {}).get("accepted"))
    helpers = app.get("helpers") or {}
    check("app.helpersSigned", all(
        (helpers.get(name) or {}).get("present")
        and ((helpers.get(name) or {}).get("codesign") or {}).get("strictVerify")
        and ((helpers.get(name) or {}).get("codesign") or {}).get("teamIdentifier") == TEAM_ID
        for name in HELPERS
    ))
    check("buildInfo.production", info.get("probeOk") and info.get("schemaVersion") == 1 and info.get("version") == expected["version"]
          and info.get("channel") == CHANNEL and info.get("testHooks") is False)
    handler = report.get("handler") or {}
    check("handler.exactInstalledApp", handler.get("queryOk") and handler.get("handlerExact"))
    check("handler.singleRegistration", handler.get("registeredOnlyInstalledApp"), gating=False)
    check("running.singletonFromInstalledApp", handler.get("runningFromInstalledPathOnly"), gating=False)
    check("swap.noLeftoverStagedApps", report.get("stagedSwapLeftovers") == [])

    journal = report.get("journal") or {}
    attempt_clear = journal.get("installAttempt") is None
    if step == "B0":
        check("journal.noPendingAttempt", attempt_clear)
        check("journal.noRecordedFailure", journal.get("lastFailure") is None, gating=False)
    else:
        check("journal.present", journal.get("exists"))
        check("journal.noPendingAttempt", journal.get("exists") and attempt_clear)
        check("journal.noRecordedFailure", journal.get("exists") and journal.get("lastFailure") is None)
        check("journal.lastSuccessfulIsDestination", journal.get("lastSuccessfulVersion") == expected["version"])
        check("journal.stableChannel", journal.get("channel") == CHANNEL)

    rollback = report.get("rollback") or {}
    retained_ok = (
        rollback.get("receiptExists")
        and rollback.get("schemaVersion") == 2
        and rollback.get("target") == TARGET
        and rollback.get("format") == "dmg"
        and rollback.get("channel") == CHANNEL
        and rollback.get("version") == baseline["version"]
        and rollback.get("commit") == baseline["commit"]
        and rollback.get("sha256") == baseline["dmgSha256"]
        and rollback.get("signaturePresent")
        and rollback.get("artifactFileCanonical")
        and rollback.get("artifactExists")
        and rollback.get("artifactSha256") == baseline["dmgSha256"]
        and rollback.get("artifactSize") == rollback.get("size")
    )
    if step == "B0":
        check("rollback.retainedBaseline", retained_ok, gating=False)
    else:
        check("rollback.retainedBaseline", retained_ok)
        check("rollback.noStrayArtifacts", rollback.get("strayArtifacts") == [])

    failed = [item["name"] for item in checks if item["gating"] and not item["passed"]]
    return checks, failed


def collect(env, home, step, baseline, candidate, collector_identity):
    role = STEPS[step]
    expected = baseline if role == "baseline" else candidate
    report = {
        "schemaVersion": 1,
        "kind": "kalcode-mac-lifecycle-identity",
        "observedAt": env.now().isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "profile": env.user_name(),
        "home": home,
        "step": step,
        "role": role,
        "target": TARGET,
        "expected": {k: expected[k] for k in ("version", "commit", "dmgSha256", "executableSha256", "bundleTreeSha256")},
        "retainedBaselineExpected": {k: baseline[k] for k in ("version", "commit", "dmgSha256")},
        "candidateExpected": None if candidate is None else {k: candidate[k] for k in ("version", "commit", "dmgSha256")},
        "collector": collector_identity,
        "scope": "Installed identity, updater journal, rollback retention and handler state only; not auth, product or publication certification",
        "applicationLaunched": False,
        "buildInfoProbeExecuted": False,
        "status": "pending",
        "errors": [],
    }
    sections = (
        ("app", lambda: installed_app(env, home)),
        ("stagedSwapLeftovers", lambda: staged_leftovers(home)),
        ("appData", lambda: app_data(env, home)[1]),
        ("journal", lambda: journal_projection(safe_under(home, os.path.join(app_data(env, home)[0], "updates", "updater.json")))),
        ("rollback", lambda: rollback_projection(home, safe_under(home, os.path.join(app_data(env, home)[0], "updates", "rollback")))),
        ("preparedEntries", lambda: _count_entries(safe_under(home, os.path.join(app_data(env, home)[0], "updates", "prepared")))),
        ("handler", lambda: handler_query(env, os.path.join(home, "Applications", "KalCode.app"))),
    )
    for key, section in sections:
        try:
            report[key] = section()
        except Exception as error:  # noqa: BLE001 - never copy exception text; record a constant key
            report[key] = None
            report["errors"].append(f"{key}:{error.args[0] if isinstance(error, Unsafe) and error.args else 'collection-failed'}")
    report["buildInfoProbeExecuted"] = bool((report.get("app") or {}).get("exists"))
    checks, failed = evaluate(report, step, baseline, candidate)
    report["checks"] = checks
    report["failedChecks"] = failed
    if report["errors"]:
        report["status"] = "pending-error"
    elif failed:
        report["status"] = "identity-mismatch-pending-review"
    else:
        report["status"] = "lifecycle-identity-matched"
    return report


def _count_entries(path):
    try:
        return len(os.listdir(path))
    except FileNotFoundError:
        return 0


def assert_receipt_dir(directory):
    absolute = os.path.abspath(directory)
    if os.path.realpath(absolute) != absolute or not os.path.isdir(absolute):
        raise Refusal("Receipt directory is unavailable or linked.")
    return absolute


def write_receipt(directory, report, now):
    directory = assert_receipt_dir(directory)
    stamp = now.strftime("%Y%m%dT%H%M%S") + f"{now.microsecond // 1000:03d}Z"
    name = f"lifecycle-identity-{report['profile']}-{report['step']}-{report['expected']['version']}-{stamp}-{uuid.uuid4().hex}.json"
    path = os.path.join(directory, name)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(path, flags, 0o644)
    with os.fdopen(fd, "wb") as handle:
        handle.write((json.dumps(report, indent=2, sort_keys=True) + "\n").encode("utf-8"))
        handle.flush()
        os.fsync(handle.fileno())
    return path


def load_candidate_pin(directory):
    path = os.path.join(directory, CANDIDATE_PIN_FILE)
    try:
        data = read_bounded(path, 4096)
    except Unsafe as error:
        raise Refusal("candidate-pin.json is not an ordinary bounded file.") from error
    if data is None:
        raise Refusal("candidate-pin.json is absent; Primary must bind the candidate identity first.")
    try:
        pin = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise Refusal("candidate-pin.json is not valid JSON.") from error
    return validate_candidate_pin(pin), hashlib.sha256(data).hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read-only KalCode macOS lifecycle identity collector.")
    parser.add_argument("--role", choices=("baseline", "candidate"))
    parser.add_argument("--step", choices=tuple(STEPS))
    parser.add_argument("--digest-bundle", metavar="APP", help="print the bundle-tree digest of a (mounted DMG) KalCode.app and exit")
    args = parser.parse_args(argv)
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        if args.digest_bundle:
            if args.role or args.step or not args.digest_bundle.endswith("KalCode.app"):
                raise Refusal("--digest-bundle takes only a KalCode.app path.")
            tree, entries = bundle_tree_sha256(args.digest_bundle)
            executable = sha256_file(os.path.join(args.digest_bundle, "Contents", "MacOS", EXECUTABLE))
            print(json.dumps({"bundleTreeSha256": tree, "bundleEntries": entries, "executableSha256": executable}))
            return 0
        if not args.role or not args.step or STEPS[args.step] != args.role:
            raise Refusal("Select a checkpoint that matches the wrapper role (baseline: B0/rollback; candidate: update/reupdate).")
        env = RealEnv()
        home = assert_context(env)
        receipt_dir = assert_receipt_dir(here)
        candidate, candidate_pin_sha = (None, None)
        if args.role == "candidate" or args.step == "rollback":
            candidate, candidate_pin_sha = load_candidate_pin(here)
        identity = {
            "file": os.path.basename(__file__),
            "sha256": sha256_file(os.path.abspath(__file__)),
            "candidatePinSha256": candidate_pin_sha,
        }
        report = collect(env, home, args.step, BASELINE_PIN, candidate, identity)
        path = write_receipt(receipt_dir, report, env.now())
    except (Refusal, Unsafe) as error:
        print(f"refused: {error.args[0] if error.args else 'unsafe state'}", file=sys.stderr)
        print("Nothing was collected or written.", file=sys.stderr)
        return 2
    print(f"{report['status']}: {path}")
    if report["failedChecks"]:
        print("Failed checks: " + ", ".join(report["failedChecks"]))
    print("No application, installer, updater or handler change was made. Lifecycle PASS is decided by Primary.")
    return 0 if report["status"] == "lifecycle-identity-matched" else 1


if __name__ == "__main__":
    sys.exit(main())
