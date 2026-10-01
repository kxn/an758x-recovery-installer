# 配对构建

## 工具链从哪来

全部是公开可获取的组件（本仓库 `deps/` 已放好 Mbed TLS）：

| 组件 | 来源 | 备注 |
| --- | --- | --- |
| `aarch64-linux-gnu-gcc` | Debian/Ubuntu：`apt install gcc-aarch64-linux-gnu` | 64 位 U-Boot/BL31 |
| `arm-none-eabi-gcc` | `apt install gcc-arm-none-eabi` | **必须是裸机工具链**（`ARM32_CROSS_COMPILE=arm-none-eabi-`）。用 `arm-linux-gnueabihf-` 会因 `-mfloat-abi=hard` 与 TF-A 的 `-march=armv8-a` 冲突而失败 |
| Mbed TLS 3.4.1 | [Mbed-TLS/mbedtls](https://github.com/Mbed-TLS/mbedtls) tag `mbedtls-3.4.1` | Git submodule `deps/mbedtls` |
| Rust stable | rustup | `rustup target add aarch64-unknown-linux-musl` |
| `AIROHA_SIGN_KEY`（可选） | 自己生成或自己的密钥 | 未设置时构建自动生成自签密钥并签名，与作者 release 的做法一致 |

## 前置条件

- `git`、`python3`、`dtc`、`node`（页面 JS 校验）
- `make`、`gcc`、`bison`、`flex`、`openssl`、OpenSSL 开发头文件
- 上述交叉工具链与 Mbed TLS
- Rust stable（`rustup target add aarch64-unknown-linux-musl`）

本次交叉构建与 CI 测试使用 Rust 1.97.1；CI 固定这个版本，避免 GitHub runner 的 Rust/Clippy 升级改变检查结果。

## 构建

```sh
export CROSS_COMPILE=aarch64-linux-gnu-
export ARM32_CROSS_COMPILE=arm-none-eabi-
tools/build.sh <target>
```

`<target>` 与上游 `scripts/build-an758x.sh` 一致
（`hg5382a`、`xg-040g-md`、`xg-040g-tf` 等）。脚本流程：

1. 校验两个 submodule 与 `UPSTREAM.lock` 的 SHA 一致，工作树干净；
2. 校验 profile，并用 `tools/extract-dtb.py` 检查最终 DTB 的
   `recovery-layout` 板级卷是否覆盖 profile 的 `target_volume`；不匹配
   直接失败；
3. 在临时 worktree 里 `git apply --check` + 应用补丁（不修改 submodule
   工作目录），内联共享 ZIP 库与恢复向导脚本；
4. 调用上游 `scripts/build-an758x.sh` 构建 U-Boot 镜像；
5. 对 BL2/FIP 做结构校验（FIP ToC 魔数、payload 边界、终止符 0xff 填充；
   payload UUID 与 stock2ubi 的设备端校验器一致）；
6. 用 `WIZARD_*` 环境变量注入镜像、哈希与板级规格，交叉编译 stock
   binary；
7. 输出 `<target>-installer-<version>/`，内含配对镜像、`<target>-installer`、
   `checksums.txt` 和 `build-manifest.txt`（写明上游 SHA、`NOT VERIFIED
   ON HARDWARE`、签名状态、profile 状态）。

没有 profile 的目标用 `--manual` 构建：安装程序不带嵌入镜像，
页面仅提供全部可见 MTD 分区的流式 tar 备份；它不提供一键刷写。

## 签名状态

上游 `sign-an758x-fip.sh` 用 TF-A `cert_create` 生成 RSA-4096 证书链签名
FIP。作者发布在 GitHub Release 里的产物就是**自签密钥**签的（证据：证书
issuer == subject，CN 是 cert_create 的默认名 "Trusted Key Certificate" 等，
与本仓库用任意一把新生成的密钥签名后的结构完全一致）。这些 AN758x 设备
接受自签镜像——否则"往首块写自定义 BL2"这个项目从一开始就不可行。

因此 `tools/build.sh` 的默认行为与作者一致：

- 未设置 `AIROHA_SIGN_KEY_PATH` / `AIROHA_SIGN_KEY` 时，自动生成一把
  4096 位自签密钥（`build/<target>/wizard-selfsigned.pem`）并签名，产物
  构建会检查镜像结构，能否在具体机器启动仍需实机验证；
- 设置了自己的密钥就用你的密钥；
- `build-manifest.txt` 记录 `signed:` 是哪把密钥签的。

**没有厂商私钥并不阻塞启动。** 厂商密钥只在"设备被厂商锁死为只接受
厂商签名的镜像"时才是必需的；上游有大量实机验证过的 PR（如 NAND ECC
修复）证明自签镜像确实在这些设备上引导。

## 产物状态

所有产物默认标记 **未实机验证**。构建通过不等于实机通过；签名状态与
是否实机验证是两回事，manifest 分别记录。

## 环境变量

| 变量 | 含义 |
| --- | --- |
| `MBEDTLS_DIR` | 可选 Mbed TLS 源码路径（默认 `deps/mbedtls` submodule） |
| `BUILD_ROOT` | 临时 worktree 根（默认 `build/`） |
| `OUTPUT_ROOT` | 产物根（默认 `output/`） |
| `BUILD_JOBS` | 并行度 |
| `WIZARD_VERSION` | 发布版本号（默认 `0.1.0-dev.YYYYMMDD`） |

## 上游更新流程

`tools/check-upstream.py` 列出上游目标与布局。上游出现新提交时：

1. `check-upstream.py --fail` 确认子模块漂移；
2. 更新 submodule，试 `git apply --check`，构建配对产物；
3. 人工审查新增目标的 profile 与板级数据映射；
4. 审查通过后更新 `UPSTREAM.lock` 并发布。

补丁逐渐大到难以重放时，可以把对应 submodule 改指 fork；更新其引用和锁定提交，继续保留同样的构建校验。
