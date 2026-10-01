# 机型矩阵

上游 `scripts/build-an758x.sh` 的 11 个目标与 wizard profile 的对应关系。
"来源" 指原厂 MTD 分区（`profiles/<target>.json` 的 `source_names`）；没有
可靠来源的机型仅提供可见 MTD 分区归档下载，**不猜测 MTD 编号**。

| target | defconfig | 板级卷（DTB） | profile | 原厂来源 |
| --- | --- | --- | --- | --- |
| hg5382a | an7581_fiberhome_hg5382a | factory | 无 | 未知 → 手动 |
| hg5585f-ct | an7581_fiberhome_hg5585f-ct | factory | 无 | 未知 → 手动 |
| hg5585f-cu | an7581_fiberhome_hg5585f-cu | factory | 无 | 未知 → 手动 |
| xg2010g | an7581_gemtek_xg2010g | factory | 无 | 未知 → 手动 |
| xr1710g | an7581_gemtek_xr1710g | factory | 无 | 未知 → 手动 |
| zn504xg-d | an7581_znxt_zn504xg-d | factory | 无 | 未知 → 手动 |
| zn515xg-d | an7581_znxt_zn515xg-d | factory | 无 | 未知 → 手动 |
| ung00a | an7581_unionman_ung00a | factory | 无 | 未知 → 手动 |
| xg-040g-md | an7581_nokia_xg-040g-md | bosa, ri | candidate | 见 profile |
| xg-040g-tf | an7581_nokia_xg-040g-tf | bosa, ri | 无 | 未定义 |
| xg-040g-mf | an7583_nokia_xg-040g-mf | bosa, ri | candidate | 见 profile（未实机确认） |

`factory` 卷的原厂数据通常不是可直接回写的 MTD 分区（UBI 卷或需转换），
初版自动 ZIP 只支持原厂 MTD 来源，因此这些机型不开放一键刷写入口。

状态字段含义见 README；任何 `candidate` 都**不是**实机验证声明。

（此表由 `tools/check-upstream.py` 的输出手工维护；上游新增 target 时
先更新此表，再决定是否新增 profile。）
