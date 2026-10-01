#!/bin/sh
# Paired build for one wizard target.
#
# usage: build.sh <target> [--manual]
#
# Steps:
#   1. Verify the submodules are on the SHAs in UPSTREAM.lock.
#   2. Check the profile and, when present, the DTB layout via extract-dtb.py.
#   3. Patch both upstreams in throwaway git worktrees (git apply --check
#      first; the submodule working directories are never modified).
#   4. Build the U-Boot images with upstream scripts/build-an758x.sh.
#   5. Build the paired installer with the images and page JS embedded.
#   6. Emit <target>-installer-<version>/ with checksums.txt and a build
#      manifest, marked "not verified on hardware".
#
# Without a profile (or with --manual) only the U-Boot images are built and
# the stock side is compiled without embedded images (manual mode).
#
# Required environment (also consumed by scripts/build-an758x.sh):
#   CROSS_COMPILE           AArch64 toolchain prefix (e.g. aarch64-linux-gnu-)
#   ARM32_CROSS_COMPILE     Arm bare-metal prefix for BL2 (e.g. arm-none-eabi-)
#   MBEDTLS_DIR             Mbed TLS 3.4.x source directory (defaults to deps/mbedtls)
# Optional: AIROHA_SIGN_KEY_PATH / AIROHA_SIGN_KEY (RSA-4096). When unset,
#           a self-signed key is generated for this build and the FIPs are
#           signed with it, matching how the upstream releases are signed.
#
set -eu

usage()
{
	cat >&2 <<'EOF'
usage: build.sh <target> [--manual]
EOF
	exit 2
}

[ "$#" -ge 1 ] || usage
[ "$#" -le 2 ] || usage
target="$1"
case "$target" in ''|*[!a-z0-9-]*) usage ;; esac
installer_bin="$target-installer"
mode="paired"
[ "$#" -gt 1 ] && { [ "$2" = "--manual" ] && mode="manual" || usage; }

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
root_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
uboot_repo="$root_dir/upstream/uboot-an758x"
stock_repo="$root_dir/upstream/an758x-stock2ubi"
shared_js="$root_dir/shared/wizard-zip.js"
profiles_dir="$root_dir/profiles"
build_root="${BUILD_ROOT:-$root_dir/build}"
output_root="${OUTPUT_ROOT:-$root_dir/output}"
MBEDTLS_DIR="${MBEDTLS_DIR:-$root_dir/deps/mbedtls}"
jobs="${BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)}"

# Prefer rustup's cargo over a possibly-too-old distro cargo. Keep it as a
# shell function so it works when quoted and unquoted. We run it inside
# subshells, so capture the absolute path here.
if command -v rustup >/dev/null 2>&1; then
	RUSTUP_BIN="$(command -v rustup)"
	RUST_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"
	cargo() { "$RUSTUP_BIN" run "$RUST_TOOLCHAIN" cargo "$@"; }
	rust_version="$("$RUSTUP_BIN" run "$RUST_TOOLCHAIN" rustc --version)"
else
	CARGO_BIN="$(command -v "${CARGO:-cargo}")"
	cargo() { "$CARGO_BIN" "$@"; }
	rust_version="$(rustc --version)"
fi

# --- 0. toolchain checks ---------------------------------------------------
for var in CROSS_COMPILE ARM32_CROSS_COMPILE MBEDTLS_DIR; do
	eval "value=\${$var:-}"
	[ -n "$value" ] || {
		echo "$var is required (see docs/build.md for toolchain setup)" >&2
		exit 1
	}
done
command -v "${CROSS_COMPILE}gcc" >/dev/null 2>&1 ||
	{ echo "${CROSS_COMPILE}gcc not found" >&2; exit 1; }
command -v "${ARM32_CROSS_COMPILE}gcc" >/dev/null 2>&1 ||
	{ echo "${ARM32_CROSS_COMPILE}gcc not found" >&2; exit 1; }
[ -d "$MBEDTLS_DIR/include/mbedtls" ] ||
	{ echo "MBEDTLS_DIR must contain include/mbedtls (Mbed TLS 3.4.x)" >&2; exit 1; }
mbedtls_major="$(awk '/define MBEDTLS_VERSION_MAJOR/ {print $3}' "$MBEDTLS_DIR/include/mbedtls/build_info.h" 2>/dev/null)"
[ "$mbedtls_major" = "3" ] ||
	{ echo "MBEDTLS_DIR is not Mbed TLS 3.x (TF-A 2.10 requires 3.x)" >&2; exit 1; }
export CROSS_COMPILE ARM32_CROSS_COMPILE MBEDTLS_DIR

# --- 1. lock check --------------------------------------------------------
lock="$root_dir/UPSTREAM.lock"
uboot_pinned="$(awk '$1=="uboot-an758x" {print $2}' "$lock")"
stock_pinned="$(awk '$1=="an758x-stock2ubi" {print $2}' "$lock")"
[ -n "$uboot_pinned" ] && [ -n "$stock_pinned" ] ||
	{ echo "UPSTREAM.lock is missing the pinned SHAs" >&2; exit 1; }
uboot_head="$(git -C "$uboot_repo" rev-parse HEAD)"
stock_head="$(git -C "$stock_repo" rev-parse HEAD)"
[ "$uboot_head" = "$uboot_pinned" ] ||
	{ echo "uboot-an758x is at $uboot_head, pinned $uboot_pinned" >&2; exit 1; }
[ "$stock_head" = "$stock_pinned" ] ||
	{ echo "an758x-stock2ubi is at $stock_head, pinned $stock_pinned" >&2; exit 1; }
[ -z "$(git -C "$uboot_repo" status --porcelain)" ] ||
	{ echo "uboot-an758x working tree is dirty" >&2; exit 1; }
[ -z "$(git -C "$stock_repo" status --porcelain)" ] ||
	{ echo "an758x-stock2ubi working tree is dirty" >&2; exit 1; }

# --- 2. profile and layout check -----------------------------------------
profile="$profiles_dir/$target.json"
boot_image="preloader"
model=""
if [ "$mode" = "paired" ]; then
	[ -f "$profile" ] || { echo "no profile for $target; use --manual" >&2; exit 1; }
	python3 - "$profile" <<'PYEOF' || exit 1
import json, sys
profile = json.load(open(sys.argv[1]))
assert profile["schema"] == 1, "unsupported profile schema"
assert profile["boot_image"] in ("preloader", "firstblock")
print("profile ok:", profile["target"], profile["boot_image"], profile.get("status"))
PYEOF
	boot_image="$(python3 -c "import json;print(json.load(open('$profile'))['boot_image'])")"
fi

# --- 3. throwaway worktrees and patches -----------------------------------
work="$build_root/$target"
uboot_wt="$work/uboot"
stock_wt="$work/stock"
cleanup()
{
	git -C "$uboot_repo" worktree remove --force "$uboot_wt" >/dev/null 2>&1 || true
	git -C "$stock_repo" worktree remove --force "$stock_wt" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
cleanup
rm -rf "$work"
mkdir -p "$work" "$output_root"
git -C "$uboot_repo" worktree add --detach "$uboot_wt" "$uboot_pinned" >/dev/null
git -C "$stock_repo" worktree add --detach "$stock_wt" "$stock_pinned" >/dev/null

apply_patch() { # <tree> <patch>
	tree="$1"; patch="$2"
	git -C "$tree" apply --check "$patch" ||
		{ echo "patch does not apply: $patch" >&2; exit 1; }
	git -C "$tree" apply "$patch"
}

uboot_patch="$root_dir/patches/uboot/0001-uboot-wizard-env-and-page.patch"
stock_patch="$root_dir/patches/stock2ubi/0001-stock2ubi-wizard-api-and-embedded-images.patch"
[ -f "$uboot_patch" ] && apply_patch "$uboot_wt" "$uboot_patch"
[ -f "$stock_patch" ] && apply_patch "$stock_wt" "$stock_patch"
for src in "$root_dir"/patches/uboot/files/*; do
	[ -e "$src" ] || continue
	cp "$src" "$uboot_wt/net/lwip/$(basename "$src")"
done
for src in "$root_dir"/patches/stock2ubi/files/*; do
	[ -e "$src" ] || continue
	case "$(basename "$src")" in
	build.rs) cp "$src" "$stock_wt/build.rs" ;;
	probe.rs|wizard.rs) cp "$src" "$stock_wt/src/$(basename "$src")" ;;
	wizard-stock.js) cp "$src" "$stock_wt/src/wizard-stock.js" ;;
	esac
done

# The recovery page inlines the shared ZIP library and the recovery wizard.
python3 - "$uboot_wt/net/lwip/httpd-page.html" "$shared_js" \
	"$root_dir/patches/uboot/files/wizard-uboot.js" \
	"$root_dir/patches/uboot/files/rom-restore.js" <<'PYEOF' || exit 1
import sys
page, shared, recovery, restore = sys.argv[1:]
text = open(page).read()
for js in (open(shared).read(), open(recovery).read(), open(restore).read()):
    assert "</script" not in js, "script cannot be inlined"
text = text.replace("{{WIZARD_SHARED_JS}}", open(shared).read(), 1)
text = text.replace("{{WIZARD_RECOVERY_JS}}", open(recovery).read(), 1)
text = text.replace("{{ROM_RESTORE_JS}}", open(restore).read(), 1)
assert "{{WIZARD" not in text, "unresolved placeholder"
assert "{{ROM_RESTORE" not in text, "unresolved placeholder"
open(page, "w").write(text)
print("recovery page JS inlined")
PYEOF

# --- 4. U-Boot build ------------------------------------------------------
# Upstream writes its artifacts to $OUTPUT_ROOT/$target/. When no signing
# key is configured, generate one (openssl genrsa) and sign — the upstream
# devices accept self-signed images (the upstream releases are signed this
# way, see docs/build.md). A key provided by the user is used as-is.
sign_key_path=""
sign_key_value=""
if [ -n "${AIROHA_SIGN_KEY_PATH:-}" ] || [ -n "${AIROHA_SIGN_KEY:-}" ]; then
	sign_key_path="${AIROHA_SIGN_KEY_PATH:-}"
	sign_key_value="${AIROHA_SIGN_KEY:-}"
	signed_by="user-provided key"
else
	sign_key_path="$work/wizard-selfsigned.pem"
	(umask 077; openssl genrsa -out "$sign_key_path" 4096 >/dev/null 2>&1) ||
		{ echo "generating a self-signed key failed (openssl missing?)" >&2; exit 1; }
	signed_by="self-signed key generated by this build ($sign_key_path)"
fi
if (
	cd "$uboot_wt"
	BUILD_ROOT="$work/uboot-build" \
	OUTPUT_ROOT="$output_root" \
	BUILD_JOBS="$jobs" \
	AIROHA_SIGN_KEY_PATH="$sign_key_path" \
	AIROHA_SIGN_KEY="$sign_key_value" \
	sh scripts/build-an758x.sh "$target"
) > "$work/uboot-build.log" 2>&1; then
	tail -n 20 "$work/uboot-build.log"
else
	cat "$work/uboot-build.log" >&2
	echo "U-Boot build failed; installer packaging stopped" >&2
	exit 1
fi
if grep -q "FIP signing skipped" "$work/uboot-build.log"; then
	signed="NO — signing failed or was skipped"
else
	signed="yes ($signed_by)"
fi

artifact_dir="$output_root/$target"
[ -d "$artifact_dir" ] || { echo "no artifacts at $artifact_dir" >&2; exit 1; }
fip_bin="$(ls "$artifact_dir"/*-bl31-u-boot.fip 2>/dev/null | head -1)"
case "$boot_image" in
firstblock)
	bl2_bin="$(ls "$artifact_dir"/*-firstblock.bin 2>/dev/null | head -1)"
	;;
*)
	bl2_bin="$(ls "$artifact_dir"/*-preloader.bin 2>/dev/null | head -1)"
	;;
esac
[ -n "$bl2_bin" ] || { echo "$boot_image image missing in $artifact_dir" >&2; exit 1; }
[ -n "$fip_bin" ] || { echo "FIP image missing in $artifact_dir" >&2; exit 1; }
dtb_bin="$artifact_dir/u-boot.dtb"
firstblock_bin="$(ls "$artifact_dir"/*-firstblock.bin 2>/dev/null | head -1)"
[ -f "$dtb_bin" ] || { echo "u-boot.dtb missing; layout checks skipped" >&2; dtb_bin=""; }

model=""
if [ -n "$dtb_bin" ]; then
	extract_out="$(python3 "$script_dir/extract-dtb.py" "$dtb_bin")" ||
		{ echo "DTB extraction failed" >&2; exit 1; }
	model="$(python3 -c "import json,sys;print(json.loads(sys.stdin.read()).get('model') or '')" <<EOF
$extract_out
EOF
)"
	if [ "$mode" = "paired" ]; then
		python3 "$script_dir/extract-dtb.py" "$dtb_bin" --check "$profile" ||
			{ echo "layout check failed for $target" >&2; exit 1; }
	fi
fi

# Structural FIP checks so a broken pair cannot ship (magic, entries,
# terminator boundary); signing state is reported, not enforced.
python3 - "$bl2_bin" "$fip_bin" "$firstblock_bin" <<'PYEOF' || exit 1
import struct, sys
for path in sys.argv[1:]:
    if not path:
        continue
    data = open(path, 'rb').read()
    if path.endswith('-firstblock.bin'):
        assert len(data) == 0x20000, f"{path}: unexpected first eraseblock size"
        data = data[0x800:]
    assert len(data) >= 56, f"{path}: too small"
    assert struct.unpack_from('<I', data, 0)[0] == 0xaa640001, f"{path}: bad FIP ToC magic"
    entries = 0
    cursor = 16
    while True:
        uuid, offset, size = struct.unpack_from('<16sQQ', data, cursor)
        cursor += 40
        if uuid == b'\x00' * 16:
            end = offset
            if end != 0:
                assert size == 0 and end >= cursor and end <= len(data), f"{path}: bad terminator"
                assert all(b == 0xff for b in data[end:]), f"{path}: non-FF padding after terminator"
            break
        assert size > 0 and offset + size <= len(data), f"{path}: entry overruns file"
        entries += 1
    assert entries > 0, f"{path}: no FIP payloads"
    print(f"fip check ok: {path} ({entries} entries, {len(data)} bytes)")
PYEOF

# --- 5. installer build ---------------------------------------------------
version="${WIZARD_VERSION:-0.1.0-dev.$(date +%Y%m%d)}"
stock_out="$artifact_dir/stock"
mkdir -p "$stock_out"

if [ "$mode" = "paired" ]; then
	[ -n "$model" ] || { echo "DTB model required for a paired build" >&2; exit 1; }
	hints="$(python3 -c "import json;print(','.join(json.load(open('$profile')).get('stock_model_hints') or []))")"
	specs="$(python3 - "$profile" "$extract_out" <<'PYEOF' || exit 1
import json, sys
profile = json.load(open(sys.argv[1]))
layout = json.loads(sys.argv[2])
volumes = {v["volume_name"]: v for v in layout.get("board_data", [])}
lines = []
for item in profile.get("board_data", []):
    vol = volumes[item["target_volume"]]
    lines.append("%s|%s|%s|%s" % (
        item["source_kind"], ",".join(item["source_names"]),
        item["target_volume"], vol["volume_size"]))
print(";".join(lines))
PYEOF
)"
	(
		cd "$stock_wt"
		WIZARD_TARGET="$target" \
		WIZARD_UBOOT_MODEL="$model" \
		WIZARD_BOOT_IMAGE_KIND="$boot_image" \
		WIZARD_UBOOT_COMMIT="$uboot_pinned" \
		WIZARD_STOCK_COMMIT="$stock_pinned" \
		WIZARD_VERSION="$version" \
		WIZARD_STOCK_HINTS="$hints" \
		WIZARD_BOARD_SPECS="$specs" \
		WIZARD_BL2_PATH="$bl2_bin" \
		WIZARD_FIP_PATH="$fip_bin" \
		WIZARD_JS_PATH="$shared_js" \
		cargo build --release --target aarch64-unknown-linux-musl
		cp target/aarch64-unknown-linux-musl/release/airoha-installer \
			"$stock_out/$installer_bin"
	)
else
	(
		cd "$stock_wt"
		cargo build --release --target aarch64-unknown-linux-musl
		cp target/aarch64-unknown-linux-musl/release/airoha-installer \
			"$stock_out/$installer_bin"
	)
fi

# --- 6. release bundle ----------------------------------------------------
release="$output_root/$target-installer-$version"
rm -rf "$release"
mkdir -p "$release"
cp "$bl2_bin" "$release/$target-$boot_image.bin"
if [ -n "$firstblock_bin" ] && [ "$boot_image" != "firstblock" ]; then
	cp "$firstblock_bin" "$release/$target-firstblock.bin"
fi
cp "$fip_bin" "$release/$target-u-boot.fip"
cp "$stock_out/$installer_bin" "$release/$installer_bin"
[ -n "$dtb_bin" ] && cp "$dtb_bin" "$release/$target-u-boot.dtb"
chmod 644 "$release"/*
chmod 755 "$release/$installer_bin"
cat > "$release/build-manifest.txt" <<EOF
an758x-recovery-installer $target $version
status: NOT VERIFIED ON HARDWARE (build only)
boot_image: $boot_image
uboot-an758x: $uboot_pinned
an758x-stock2ubi: $stock_pinned
mode: $mode
uboot_model: ${model:-<unknown>}
signed: $signed
source_commit: $(git -C "$root_dir" rev-parse HEAD)
mbedtls_commit: $(git -C "$MBEDTLS_DIR" rev-parse HEAD 2>/dev/null || echo external-source)
rust: $rust_version
EOF
[ -f "$profile" ] &&
	echo "profile: $target.json ($(python3 -c "import json;print(json.load(open('$profile'))['status'])"))" \
		>> "$release/build-manifest.txt"
(
	cd "$release"
	sha256sum ./* > checksums.txt
)

echo
echo "Release written to $release"
echo "signing: $signed"
echo "U-Boot images and the installer are BUILD ARTIFACTS; no hardware"
echo "verification has been performed."
