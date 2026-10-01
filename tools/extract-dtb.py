#!/usr/bin/env python3
"""Extract the final U-Boot DTB's model and recovery-layout board volumes.

Usage:
  extract-dtb.py <u-boot.dtb>          # print JSON {model, board_data:[...]}
  extract-dtb.py --check <u-boot.dtb> <profile.json>

Without --check, prints the layout extracted from a built DTB. With --check,
compares the extracted layout against a profile and exits non-zero on
mismatches (missing target volume, duplicate volume-name, unreadable size).

The DTB is expected to be the final control DTB built by upstream
`scripts/build-an758x.sh` (output/<target>/u-boot.dtb). This tool only reads
it; it does not build anything.
"""
import argparse
import json
import re
import subprocess
import sys


class BuildError(Exception):
    pass


def open_dts_text(dtb: str) -> str:
    proc = subprocess.run(
        ["dtc", "-I", "dtb", "-O", "dts", dtb],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        raise BuildError(f"dtc failed on {dtb}: {proc.stderr.strip()}")
    return proc.stdout


def parse_dts_text(text: str) -> dict:
    model = None
    m = re.search(r'model\s*=\s*"([^"]+)"', text)
    if m:
        model = m.group(1)
    layout = find_node_text(text, "airoha,an758x-recovery-layout")
    board_data = []
    if layout:
        board_data = parse_layout_node(layout)
    return {"model": model, "board_data": board_data}


def find_node_text(text: str, compatible: str):
    idx = text.find(compatible)
    if idx < 0:
        return None
    # The compatible property sits inside the node; the node's opening brace
    # is the first `{` after the last `;` before the compatible property.
    semi = text.rfind(";", 0, idx)
    open_brace = text.find("{", semi if semi >= 0 else 0)
    if open_brace < 0:
        return None
    depth = 0
    for i in range(open_brace, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[open_brace + 1:i]
    return None


def parse_layout_node(node_text: str):
    volumes = []
    i = 0
    while i < len(node_text):
        brace = node_text.find("{", i)
        if brace < 0:
            break
        head = node_text[i:brace].strip()
        # Skip property assignments like `foo = <1>;`
        if "=" in head or ";" in head or not head:
            semi = node_text.find(";", i)
            i = semi + 1 if semi >= 0 else brace + 1
            continue
        depth = 0
        j = brace
        while j < len(node_text):
            if node_text[j] == "{":
                depth += 1
            elif node_text[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        body = node_text[brace + 1:j]
        entry = {"node": head}
        m = re.search(r'volume-name\s*=\s*"([^"]+)"', body)
        if m:
            entry["volume_name"] = m.group(1)
        m = re.search(r'volume-type\s*=\s*"([^"]+)"', body)
        if m:
            entry["volume_type"] = m.group(1)
        m = re.search(r'volume-size\s*=\s*<0x([0-9a-fA-F]+)>', body)
        if m:
            entry["volume_size"] = int(m.group(1), 16)
        elif re.search(r'volume-size\s*=', body):
            entry["volume_size"] = None
        volumes.append(entry)
        i = j + 1
    return volumes


def load_profile(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        profile = json.load(f)
    schema = profile.get("schema")
    if schema != 1:
        raise BuildError(f"{path}: unsupported schema {schema!r}")
    for key in ("target", "boot_image"):
        if not profile.get(key):
            raise BuildError(f"{path}: missing {key}")
    if profile["boot_image"] not in ("preloader", "firstblock"):
        raise BuildError(f"{path}: invalid boot_image {profile['boot_image']!r}")
    for item in profile.get("board_data", []):
        for key in ("source_kind", "source_names", "target_volume"):
            if key not in item or not item[key]:
                raise BuildError(f"{path}: board_data entry missing {key}")
        if item["source_kind"] not in ("mtd", "ubi"):
            raise BuildError(f"{path}: invalid source_kind {item['source_kind']!r}")
    return profile


def check(extracted: dict, profile: dict) -> list:
    problems = []
    have = {}
    for volume in extracted.get("board_data", []):
        name = volume.get("volume_name")
        if not name:
            continue
        if name in have:
            problems.append(f"duplicate volume-name {name!r} in DTB layout")
        have[name] = volume

    for item in profile.get("board_data", []):
        target = item["target_volume"]
        if target not in have:
            problems.append(f"target volume {target!r} missing from DTB layout")
            continue
        size = have[target].get("volume_size")
        if size is None:
            problems.append(f"target volume {target!r} has unreadable volume-size")
        elif not isinstance(size, int) or size <= 0:
            problems.append(f"target volume {target!r} has invalid volume-size")
        # The profile deliberately does not duplicate target volume lengths;
        # the DTB is the single source of truth for them.

    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dtb", help="built u-boot.dtb")
    parser.add_argument("--check", metavar="PROFILE.json", help="compare against a profile")
    args = parser.parse_args()

    try:
        extracted = parse_dts_text(open_dts_text(args.dtb))
    except BuildError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    if args.check:
        profile = load_profile(args.check)
        problems = check(extracted, profile)
        if problems:
            for problem in problems:
                print(f"error: {problem}", file=sys.stderr)
            return 1
        print(f"ok: DTB layout matches {profile['target']}")
        return 0

    print(json.dumps(extracted, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
