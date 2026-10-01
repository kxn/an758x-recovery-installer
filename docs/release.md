# 自动构建与发布

`.github/workflows/release.yml` 从固定版本的上游构建脚本读取全部机型。当前包含 11 个目标：MD、MF 有 candidate profile，生成向导包；另外 9 个没有完整 profile，生成手动包。更新 submodule 和 `UPSTREAM.lock` 后，新目标会进入矩阵，再根据 profile 决定构建模式。

每个机型独立交叉编译 U-Boot、BL2/BL31 和静态 AArch64 程序。Action 安装工具链和 Mbed TLS submodule，使用 Rust 1.97.1。未配置厂商私钥，沿用本项目的自签构建逻辑。

## 使用 Action

在 GitHub 的 **Actions → Build model packages and release → Run workflow** 中填写版本号：

- 不勾选 `publish`：构建、校验、打包后保存在 Actions artifacts，供检查；
- 勾选 `publish`：全部主机检查和机型构建通过后，创建对应 `v<版本号>` 的 GitHub Release；
- 推送 `v*` tag：自动构建并发布该 tag 的源码。

版本格式例如 `0.1.0-rc.1` 或 `0.1.0`。带 `-rc` 等后缀的版本标记为 prerelease，普通版本号发布为正式 Release。已存在的 Release 不自动覆盖，请使用新版本号。

## 产物

- `<机型>-installer-v<版本>.zip`：向导包；
- `<机型>-manual-v<版本>.zip`：手动包，原厂端只提供 MTD 备份；
- MD、MF 的 `<机型>-installer`：单独下载的安装程序；
- `release-manifest.json`：每个包的模式、源码与上游提交、SHA-256；
- `SHA256SUMS`：全部下载资产的校验值。

每份 ZIP 保留安装程序的执行权限，并包含配对的引导镜像、DTB、`build-manifest.txt`、`checksums.txt`、许可证、电脑端恢复工具和使用说明。烽火并行 NAND 机型还提供 `<机型>-firstblock.bin`，这是放置在首块偏移 `0x800` 的 preloader 封装。

发布前会逐包验证内容、校验和、版本、模式与源码提交，并检查全部机型都有包。资产先上传到临时 draft，检查完整后公开；某个机型失败时整次发布停止，构建日志留在 Actions artifacts。

**Action 编译成功不等于实机验证。** 所有构建记录和 Release 说明均标记未实机验证。OpenWrt sysupgrade 由用户另行获取对应机型的固件。
