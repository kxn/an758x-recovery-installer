#!/usr/bin/env python3
"""Generate the upstream build matrix and verified per-model Release assets."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION_RE = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?")
TARGET_RE = re.compile(r"[a-z0-9][a-z0-9-]*")


def version(value):
    value = value.removeprefix("v")
    if not VERSION_RE.fullmatch(value):
        raise ValueError("Version must be SemVer, e.g. 0.1.0-rc.1 or v0.1.0")
    return value


def digest(data):
    return hashlib.sha256(data).hexdigest()


def build_matrix():
    report = json.loads(subprocess.check_output(
        [sys.executable, str(ROOT / "tools/check-upstream.py"), "--json", "--fail"], text=True))
    profiles = {p["target"]: p for p in report["profiles"]}
    rows = []
    for target, info in sorted(report["targets"].items()):
        if not TARGET_RE.fullmatch(target) or not info["defconfig"]:
            raise ValueError(f"Unusable upstream target: {target}")
        profile = profiles.get(target)
        paired = profile and profile["status"] in ("candidate", "verified")
        rows.append({"target": target, "mode": "paired" if paired else "manual"})
    if not rows:
        raise ValueError("No upstream build targets found")
    if set(profiles) - set(report["targets"]):
        raise ValueError("A profile references a target absent from upstream")
    return {"include": rows}


def manifest_fields(text):
    return dict(line.split(": ", 1) for line in text.splitlines() if ": " in line)


def package_name(target, mode, release_version):
    if not TARGET_RE.fullmatch(target) or mode not in ("paired", "manual"):
        raise ValueError("Invalid target or mode")
    label = "installer" if mode == "paired" else "manual"
    return f"{target}-{label}-v{version(release_version)}"


def check_bundle(files, target, mode, release_version):
    executable = f"{target}-installer"
    required = {executable, f"{target}-u-boot.fip", f"{target}-u-boot.dtb", "build-manifest.txt", "checksums.txt"}
    if not required <= files.keys():
        raise ValueError(f"{target}: missing files {sorted(required - files.keys())}")
    fields = manifest_fields(files["build-manifest.txt"].decode())
    if files["build-manifest.txt"].decode().splitlines()[0] != f"an758x-recovery-installer {target} {release_version}":
        raise ValueError(f"{target}: stale or mismatched build version")
    if fields.get("mode") != mode or fields.get("status") != "NOT VERIFIED ON HARDWARE (build only)":
        raise ValueError(f"{target}: unexpected build mode/status")
    if not fields.get("signed", "").startswith("yes ("):
        raise ValueError(f"{target}: boot images are not signed")
    boot_image = fields.get("boot_image")
    if boot_image not in ("preloader", "firstblock") or f"{target}-{boot_image}.bin" not in files:
        raise ValueError(f"{target}: missing boot image")
    if not re.fullmatch(r"[0-9a-f]{40}", fields.get("source_commit", "")):
        raise ValueError(f"{target}: missing source commit")
    checked = set()
    for line in files["checksums.txt"].decode().splitlines():
        expected, name = line.split("  ", 1)
        name = name.removeprefix("./")
        if name not in files or name == "checksums.txt" or name in checked:
            raise ValueError(f"{target}: invalid checksum entry {name}")
        if digest(files[name]) != expected:
            raise ValueError(f"{target}: checksum mismatch for {name}")
        checked.add(name)
    if checked != files.keys() - {"checksums.txt"}:
        raise ValueError(f"{target}: some bundle files are not checksummed")
    return fields


def pack(args):
    release_version = version(args.version)
    name = package_name(args.target, args.mode, release_version)
    bundle = args.output_root / f"{args.target}-installer-{release_version}"
    files = {p.name: p.read_bytes() for p in bundle.iterdir() if p.is_file()}
    check_bundle(files, args.target, args.mode, release_version)
    explanation = ("Full stock-to-UBI installation wizard. Run the model-specific installer on the stock firmware as root."
                   if args.mode == "paired" else
                   "MANUAL PACKAGE: the stock-side executable offers MTD backups only. Automatic stock-to-UBI installation is unavailable for this model.")
    files["README.txt"] = (f"AN758x Recovery Installer v{release_version}\nModel: {args.target}\nMode: {args.mode}\n\n"
                           f"{explanation}\n\nNOT VERIFIED ON HARDWARE. Verify the model yourself.\n"
                           "Do not power off during UBI initialization or whole-ROM restoration.\n"
                           "The boot images in this package are a matching pair; use this model's files together.\n"
                           "OpenWrt sysupgrade must be obtained separately for your model.\n\n"
                           "https://github.com/kxn/an758x-recovery-installer\n").encode()
    files["LICENSE"] = (ROOT / "LICENSE").read_bytes()
    files["recovery-client.py"] = (ROOT / "tools/recovery-client.py").read_bytes()
    files["checksums.txt"] = "".join(f"{digest(data)}  {filename}\n" for filename, data in sorted(files.items())
                                       if filename != "checksums.txt").encode()
    args.assets.mkdir(parents=True, exist_ok=True)
    output = args.assets / f"{name}.zip"
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for filename, data in sorted(files.items()):
            info = zipfile.ZipInfo(f"{name}/{filename}")
            info.create_system = 3
            info.external_attr = (0o100755 if filename in (f"{args.target}-installer", "recovery-client.py") else 0o100644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    print(output)


def assemble(args):
    release_version = version(args.version)
    matrix = json.loads(args.matrix.read_text())["include"]
    records = []
    expected_archives = set()
    for row in matrix:
        target, mode = row["target"], row["mode"]
        name = package_name(target, mode, release_version)
        path = args.assets / f"{name}.zip"
        expected_archives.add(path.name)
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)) or any(not entry.startswith(f"{name}/") for entry in names):
                raise ValueError(f"Invalid archive paths in {path.name}")
            files = {p[len(name) + 1:]: archive.read(p) for p in names}
            if any("/" in p or p in ("", ".", "..") for p in files):
                raise ValueError(f"Unexpected archive path in {path.name}")
        fields = check_bundle(files, target, mode, release_version)
        record = {"target": target, "mode": mode, "file": path.name, "sha256": digest(path.read_bytes()),
                  "source_commit": fields["source_commit"], "uboot_commit": fields["uboot-an758x"],
                  "stock_commit": fields["an758x-stock2ubi"], "hardware_verified": False}
        records.append(record)
        if mode == "paired":
            # Convenient direct download for the two stock-side installers.
            (args.assets / f"{target}-installer").write_bytes(files[f"{target}-installer"])
            (args.assets / f"{target}-installer").chmod(0o755)
    actual = {p.name for p in args.assets.glob("*.zip")}
    if actual != expected_archives:
        raise ValueError(f"Archive set mismatch: {sorted(actual ^ expected_archives)}")
    if len({r["source_commit"] for r in records}) != 1:
        raise ValueError("Packages were built from different source commits")
    release = {"version": release_version, "tag": f"v{release_version}", "packages": records}
    (args.assets / "release-manifest.json").write_text(json.dumps(release, indent=2) + "\n")
    (args.assets / "SHA256SUMS").write_text("".join(f"{digest(p.read_bytes())}  {p.name}\n"
                                                   for p in sorted(args.assets.iterdir())
                                                   if p.is_file() and p.name != "SHA256SUMS"))
    print(f"Verified {len(records)} model packages")


def notes(args):
    release = json.loads((args.assets / "release-manifest.json").read_text())
    commit = release["packages"][0]["source_commit"]
    previous = args.previous
    range_ = f"{previous}..{commit}" if previous else commit
    commits = subprocess.check_output(["git", "log", "--reverse", "--format=%h %s", range_], cwd=ROOT, text=True).splitlines()
    paired = [p["target"] for p in release["packages"] if p["mode"] == "paired"]
    manual = [p["target"] for p in release["packages"] if p["mode"] == "manual"]
    repo = "https://github.com/kxn/an758x-recovery-installer"
    groups = {}
    for line in commits:
        subject = line.split(" ", 1)[1]
        prefix = subject.split(":", 1)[0].split("(", 1)[0]
        group = {"feat": "功能", "fix": "修复", "ci": "构建与自动化", "build": "构建与自动化",
                 "docs": "文档"}.get(prefix, "其他")
        groups.setdefault(group, []).append(line)
    commit_list = "\n\n".join(f"### {group}\n\n" + "\n".join(f"- {line}" for line in lines)
                                 for group, lines in groups.items())
    text = (f"AN758x Recovery Installer **{release['tag']}**\n\n"
            f"上一正式版本：{previous or '无（首版）'}。目标提交：[`{commit[:12]}`]({repo}/commit/{commit})。\n\n"
            "所有产物均未实机验证。请核对机型；UBI 初始化和完整 ROM 恢复期间不能断电。\n\n"
            "## 本次重点\n\n"
            "- 原厂端备份、首次写入与 Web U-Boot 恢复向导。\n"
            "- 完整原厂 ROM 恢复入口及电脑端诊断工具。\n"
            "- 自动构建上游全部机型，按 profile 区分向导包和手动包。\n\n"
            "## 下载选择\n\n"
            f"- **向导包**：{', '.join(paired)}（`*-installer-*.zip`）。可直接下载对应 `*-installer` 可执行文件。\n"
            f"- **手动包**：{', '.join(manual)}（`*-manual-*.zip`）。原厂端仅提供 MTD 备份；不提供一键安装。\n"
            "- ZIP 包含对应机型的配对引导镜像、安装／备份程序、说明、校验文件及恢复工具。\n"
            "- 使用 `SHA256SUMS` 校验下载，`release-manifest.json` 记录各包机型、模式与源码提交。\n\n"
            "## 提交清单\n\n" + commit_list + "\n\n")
    text += (f"[Compare]({repo}/compare/{previous}...{release['tag']})\n" if previous else
             f"[首版提交记录]({repo}/commits/{release['tag']})\n")
    args.output.write_text(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("matrix")
    p = commands.add_parser("version")
    p.add_argument("value")
    p = commands.add_parser("pack")
    p.add_argument("target")
    p.add_argument("--mode", choices=("paired", "manual"), required=True)
    p.add_argument("--version", required=True)
    p.add_argument("--output-root", type=Path, default=ROOT / "output")
    p.add_argument("--assets", type=Path, default=ROOT / "output/assets")
    p = commands.add_parser("assemble")
    p.add_argument("--version", required=True)
    p.add_argument("--matrix", type=Path, required=True)
    p.add_argument("--assets", type=Path, required=True)
    p = commands.add_parser("notes")
    p.add_argument("--assets", type=Path, required=True)
    p.add_argument("--previous")
    p.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "matrix":
        print(json.dumps(build_matrix(), separators=(",", ":")))
    elif args.command == "version":
        print(version(args.value))
    else:
        globals()[args.command](args)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        sys.exit(f"Release error: {error}")
