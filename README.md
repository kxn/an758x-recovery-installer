# AN758x Recovery Installer

为部分 Airoha AN758x 光猫提供免拆刷机向导：在原厂系统获得 root 后运行对应机型的安装程序，下载板级数据备份，写入恢复引导，再通过 Web U-Boot 初始化 UBI、恢复数据并上传 sysupgrade 镜像。

**刷写有变砖风险。** UBI 初始化到 FIP 重写完成期间不能断电。当前构建产物不标记为已实机验证；请先阅读 [恢复与风险说明](docs/recovery.md)。

## 支持状态

| 机型 | 安装程序 | 状态 |
| --- | --- | --- |
| Nokia XG-040G-MD | `xg-040g-md-installer` | candidate |
| Nokia XG-040G-MF | `xg-040g-mf-installer` | candidate |

`candidate` 只表示构建和主机测试通过。可用的板级数据映射见 [机型矩阵](docs/matrix.md) 和 `profiles/`。

原厂固件有时读不到设备树机型。向导会显示目标机型并要求用户人工确认；**分区名称和大小相符不能证明机型一定正确**。无法自动确认板级数据来源时，页面只提供全部可见 MTD 分区的 `.tar` 归档下载，不开放一键刷写。该归档可能包含重叠分区，也不保证覆盖整片 Flash 或 NAND OOB。

## 使用流程

1. 在原厂固件中获得 root，上传并运行对应机型的安装程序，例如 `./xg-040g-md-installer`。
2. 打开程序显示的地址，下载并妥善保存备份 ZIP，核对目标机型后输入 `yes`。
3. 设备进入 Web U-Boot 后，打开其恢复页面，上传同一份 ZIP；确认安装计划并等待 UBI 初始化、FIP 和板级数据回写完成。
4. 上传 sysupgrade 镜像。启动后设备的 IP 由所刷固件及网络配置决定，页面无法自动跳转。

备份 ZIP 用于这条恢复流程；它不是完整原厂 ROM 镜像。详细操作和中断后的状态见 [恢复说明](docs/recovery.md)。

## 恢复原厂 ROM

Web U-Boot 向导下方有折叠的“恢复原厂完整 ROM”入口。使用**这台机器**在原厂系统下保存的整片 Flash 主数据 `.bin`，长度必须与 Flash 容量一致；写入覆盖引导程序、系统和板级数据，完成逐块回读校验后才提供重启按钮。

如果机器还在旧版 Web U-Boot，可以用 `tools/recovery-client.py` 查看设备信息、仅测试上传，或调用其已有整片恢复接口。它保留具体 HTTP 错误，不需要先刷本项目的新版 U-Boot。旧版缺少接口时工具会报错；它不能替设备补上接口。操作步骤见 [完整 ROM 恢复与诊断](docs/stock-rom-recovery.md)。

## 上游关系

本项目直接引用原作者的两个仓库，不维护额外 fork：

| 上游 | 用途 | 本项目的改动 |
| --- | --- | --- |
| [pbs05/uboot-an758x](https://github.com/pbs05/uboot-an758x) | 引导镜像、Web U-Boot 和底层刷写 API | `patches/uboot/` |
| [pbs05/an758x-stock2ubi](https://github.com/pbs05/an758x-stock2ubi) | 原厂系统中的 MTD 访问和首次写入 | `patches/stock2ubi/` |

两者作为 Git submodule 固定在 `UPSTREAM.lock` 指定的提交。`tools/build.sh` 在临时 worktree 应用补丁，不改动上游目录。构建依赖 [Mbed TLS](https://github.com/Mbed-TLS/mbedtls) 也作为第三个 submodule 固定在 3.4.1；它不是本项目的 fork。克隆时运行：

```sh
git clone --recurse-submodules https://github.com/kxn/an758x-recovery-installer.git
```

若已普通克隆，运行 `git submodule update --init --recursive`。上游新增机型时先更新 submodule 和锁定提交，再审查 profile、补丁和板级数据映射；不能直接把新机型视为已支持。

## 构建与测试

工具链要求及签名说明见 [构建文档](docs/build.md)。例如：

```sh
export CROSS_COMPILE=aarch64-linux-gnu-
export ARM32_CROSS_COMPILE=arm-none-eabi-
export MBEDTLS_DIR="$PWD/deps/mbedtls"
tools/build.sh xg-040g-md
```

输出目录为 `output/xg-040g-md-installer-<version>/`，包含：

- `xg-040g-md-installer`：上传到原厂系统执行；
- `xg-040g-md-preloader.bin` 和 `xg-040g-md-u-boot.fip`：与安装程序配对的引导镜像；
- `xg-040g-md-u-boot.dtb`、`checksums.txt`、`build-manifest.txt`。

主机测试：

```sh
node --test tests/*.test.js tests/flow/*.test.js
python3 -m unittest discover -s tests -p 'test_*.py'
python3 tools/check-upstream.py --fail
```

预编译包见 [GitHub Releases](https://github.com/kxn/an758x-recovery-installer/releases)。MD、MF 下载 `*-installer-*.zip` 向导包，也可直接下载对应的安装程序；其他机型下载 `*-manual-*.zip` 手动包，原厂端仅提供备份功能。每个包都有构建记录与校验文件，所有产物均未实机验证。

`build/`、`output/` 和本地工具链依赖不提交到 Git。自动构建与发版操作见 [发布文档](docs/release.md)。

## 许可证

本项目新增代码按 GPL-2.0 发布。两个上游项目及其补丁分别遵循各自许可证；版权和来源保留在对应 submodule 与补丁中。
