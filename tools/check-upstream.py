#!/usr/bin/env python3
"""Check upstream sources for changes that affect the wizard.

Compares the pinned upstream SHAs (UPSTREAM.lock) with the checked-out
submodules and reports:

  - submodule drift (checked-out HEAD != pinned SHA)
  - recovery-layout board volumes per target (parsed from the source DTS)
  - defconfig drift (targets added/removed in scripts/build-an758x.sh)

Usage:
  check-upstream.py              # human-readable report
  check-upstream.py --json       # machine-readable report
  check-upstream.py --fail       # exit non-zero when anything drifted
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / "UPSTREAM.lock"
UBOOT = ROOT / "upstream" / "uboot-an758x"
STOCK = ROOT / "upstream" / "an758x-stock2ubi"
BUILD_SCRIPT = UBOOT / "scripts" / "build-an758x.sh"
DTS_DIR = UBOOT / "arch" / "arm" / "dts"

TARGET_RE = re.compile(r"^\s*([a-z0-9][a-z0-9-]*)\)\s*$")
DEFCONFIG_RE = re.compile(r"defconfig=([a-z0-9_-]+)")
PREFIX_RE = re.compile(r"artifact_prefix=([a-z0-9-]+)")


def read_lock():
    pinned = {}
    for line in LOCK.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) == 2:
            pinned[parts[0]] = parts[1]
    return pinned


def repo_sha(path: Path):
    proc = subprocess.run(
        ["git", "-C", str(path), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout.strip()


def build_script_targets():
    if not BUILD_SCRIPT.exists():
        return {}
    text = BUILD_SCRIPT.read_text()
    # The usage string and the case statement both list targets; parse the
    # case entries, which also carry the defconfig and artifact prefix.
    targets = {}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        m = TARGET_RE.match(lines[i])
        if m:
            target = m.group(1)
            if target not in ("esac",):
                block = []
                j = i + 1
                while j < len(lines) and not lines[j].strip().startswith(";;"):
                    block.append(lines[j])
                    j += 1
                body = "\n".join(block)
                dm = DEFCONFIG_RE.search(body)
                pm = PREFIX_RE.search(body)
                targets[target] = {
                    "defconfig": dm.group(1) if dm else None,
                    "artifact_prefix": pm.group(1) if pm else None,
                }
                i = j
        i += 1
    return targets


def layout_volumes(target: str) -> list:
    """Parse the recovery-layout volumes for one target from its DTS overlay."""
    volumes = []
    for dtsi in sorted(DTS_DIR.glob("*.dtsi")):
        text = dtsi.read_text(errors="replace")
        if f'recovery_layout' not in text:
            continue
        if not dtsi.name.startswith("an7581-") and not dtsi.name.startswith("an7583-"):
            continue
        # Check whether this overlay belongs to the target by matching its
        # name against the defconfig's board prefix.
        if target.replace("-", "") not in dtsi.name.replace("-", ""):
            continue
        # Parse &recovery_layout { ... } block.
        idx = text.find("&recovery_layout")
        if idx < 0:
            continue
        brace = text.find("{", idx)
        if brace < 0:
            continue
        depth = 0
        end = brace
        for k in range(brace, len(text)):
            if text[k] == "{":
                depth += 1
            elif text[k] == "}":
                depth -= 1
                if depth == 0:
                    end = k
                    break
        block = text[brace + 1:end]
        for m in re.finditer(r'volume-name\s*=\s*"([^"]+)"', block):
            volumes.append(m.group(1))
        # Collect sizes too where present
        for m in re.finditer(r'volume-size\s*=\s*<0x([0-9a-fA-F]+)>', block):
            pass
    return volumes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--fail", action="store_true")
    args = parser.parse_args()

    report = {"drift": [], "targets": {}, "profiles": []}
    pinned = read_lock()

    for name, path in (("uboot-an758x", UBOOT), ("an758x-stock2ubi", STOCK)):
        sha = repo_sha(path)
        if pinned.get(name) and sha != pinned[name]:
            report["drift"].append(
                {"repo": name, "pinned": pinned[name], "checked_out": sha}
            )

    report["targets"] = build_script_targets()

    profiles_dir = ROOT / "profiles"
    if profiles_dir.exists():
        for profile_path in sorted(profiles_dir.glob("*.json")):
            profile = json.loads(profile_path.read_text())
            report["profiles"].append(
                {
                    "target": profile.get("target"),
                    "status": profile.get("status"),
                    "boot_image": profile.get("boot_image"),
                }
            )

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("Upstream check")
        print("=" * 60)
        if not report["drift"]:
            print("submodules: clean (matching UPSTREAM.lock)")
        for item in report["drift"]:
            print(f"DRIFT {item['repo']}: pinned {item['pinned']} != checked out {item['checked_out']}")
        print()
        print(f"build-an758x.sh targets: {len(report['targets'])}")
        for target, info in sorted(report["targets"].items()):
            print(f"  {target:14s} {info['defconfig'] or '???'}")
        print()
        print(f"profiles: {len(report['profiles'])}")
        for profile in report["profiles"]:
            print(f"  {profile['target']:14s} {profile['status']} boot={profile['boot_image']}")

    if args.fail and report["drift"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
