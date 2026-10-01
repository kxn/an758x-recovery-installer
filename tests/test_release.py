import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release", ROOT / "tools/release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.output = self.directory / "output"
        self.assets = self.directory / "assets"
        self.target = "xg-040g-mf"
        self.version = "0.1.0-rc.1"
        self.bundle = self.output / f"{self.target}-installer-{self.version}"
        self.bundle.mkdir(parents=True)
        self.fields = (f"an758x-recovery-installer {self.target} {self.version}\n"
                       "status: NOT VERIFIED ON HARDWARE (build only)\nboot_image: preloader\n"
                       "mode: paired\nsigned: yes (test key)\n"
                       f"source_commit: {'a' * 40}\nuboot-an758x: {'b' * 40}\n"
                       f"an758x-stock2ubi: {'c' * 40}\n")
        for filename, data in {
            f"{self.target}-installer": b"model-binary",
            f"{self.target}-preloader.bin": b"preloader",
            f"{self.target}-u-boot.fip": b"fip",
            f"{self.target}-u-boot.dtb": b"dtb",
            "build-manifest.txt": self.fields.encode(),
        }.items():
            (self.bundle / filename).write_bytes(data)
        self.write_checksums()

    def tearDown(self):
        self.temp.cleanup()

    def write_checksums(self):
        (self.bundle / "checksums.txt").write_text("".join(
            f"{release.digest(p.read_bytes())}  ./{p.name}\n" for p in sorted(self.bundle.iterdir())
            if p.name != "checksums.txt"))

    def package(self):
        release.pack(SimpleNamespace(target=self.target, mode="paired", version=self.version,
                                     output_root=self.output, assets=self.assets))

    def assemble(self):
        matrix = self.directory / "matrix.json"
        matrix.write_text(json.dumps({"include": [{"target": self.target, "mode": "paired"}]}))
        release.assemble(SimpleNamespace(version=self.version, matrix=matrix, assets=self.assets))

    def test_zip_and_global_checksums_preserve_executable_and_model(self):
        self.package()
        self.assemble()
        prefix = f"{self.target}-installer-v{self.version}"
        with zipfile.ZipFile(self.assets / f"{prefix}.zip") as archive:
            self.assertEqual(archive.getinfo(f"{prefix}/{self.target}-installer").external_attr >> 16, 0o100755)
            self.assertEqual(archive.read(f"{prefix}/{self.target}-installer"), b"model-binary")
        for line in (self.assets / "SHA256SUMS").read_text().splitlines():
            expected, name = line.split("  ", 1)
            self.assertEqual(expected, release.digest((self.assets / name).read_bytes()))
        manifest = json.loads((self.assets / "release-manifest.json").read_text())
        self.assertEqual(manifest["packages"][0]["target"], self.target)
        self.assertFalse(manifest["packages"][0]["hardware_verified"])

    def test_changed_image_is_rejected_before_packaging(self):
        (self.bundle / f"{self.target}-u-boot.fip").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            self.package()
        self.assertFalse(self.assets.exists())

    def test_old_version_and_unsigned_images_are_rejected(self):
        for changed in [self.fields.replace(self.version, "0.0.1"), self.fields.replace("yes (test key)", "NO")]:
            (self.bundle / "build-manifest.txt").write_text(changed)
            self.write_checksums()
            with self.assertRaises(ValueError):
                self.package()

    def test_missing_model_package_blocks_assembly(self):
        self.assets.mkdir()
        with self.assertRaises(FileNotFoundError):
            self.assemble()

    def test_manual_packages_have_distinct_names(self):
        self.assertEqual(release.package_name("hg5382a", "manual", self.version), f"hg5382a-manual-v{self.version}")

    def test_malformed_version_and_target_are_rejected(self):
        for value in ["../../secret", "v1.0", "1.0.0;echo", "01.2.3"]:
            with self.assertRaises(ValueError):
                release.version(value)
        with self.assertRaises(ValueError):
            release.package_name("../model", "paired", self.version)


if __name__ == "__main__":
    unittest.main()
