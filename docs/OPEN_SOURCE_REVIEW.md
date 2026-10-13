# 开源准备检查报告

日期：2026-10-13。检查起点 `c947ee4`，工作区干净；初次检查时分支 main 与本机 origin/main 一致；当时通过 `git ls-remote --heads --tags origin` 核对远端只有 main，没有远端标签。该核对发生在本地身份清理之前，不能用来判定当前本地与远端已同步。通过 GitHub CLI 只读查询确认 [yuzhibowu/KeynoteUSDZchangecolor](https://github.com/yuzhibowu/KeynoteUSDZchangecolor) 为 PRIVATE、默认分支 main、未识别到 LICENSE。初次准备未改可见性、推送或发布 npm。随后按用户要求清理 Git 身份和一条提交说明，并经用户确认用精确 lease 同步了 GitHub main；全新远端克隆验证无待清理身份，仓库仍私有。清理后的本地 main 为 `c947ee49e5d9f18ca13446f289926e0e46a2fb77`。

## 已完成的准备

- MIT LICENSE 用于自有代码、独立模块、文档及内置数值档；根 package 元数据标 MIT，`private:true` 保留（防误发 npm，与 GitHub 私有状态无关）。
- README、AGENTS、技术原理/导出/AI 接入说明、仓库技能与可运行示例。
- 锁文件 156 个包的许可盘点：MIT、BSD-3-Clause、Apache-2.0、ISC、CC-BY-4.0。原包许可/通知合集与 vendored r185 Three.js MIT 许可。
- `.gitignore` 增加环境文件和常见私钥文件；原有私人图片、构建/打包目录不进入 Git。跟踪文件未发现个人图片/模型。
- 历史规则扫描覆盖 153 个提交、624 个 blob；常见提供商令牌、私钥、带凭据 URL、secret 字面量未命中。只发现 FFmpeg JS 的上游 `/home/web_user` 构建路径，并非本机私人路径。
- 保存可重复扫描脚本 `scripts/audit-source.py`；输出只有位置/类型，不输出疑似秘密值。

## 公开前需要决定与完成

**FFmpeg 是发布阻塞项。** 实际 WASM 启用 GPL/x264/x265，确切对应源码不在仓库；它与官方 `@ffmpeg/core@0.12.10` 哈希不一致。完整项目不能以「全部 MIT」发布。须找回实际构建源码与第三方许可/构建说明，或经测试替换成来源齐全构建。可先独立发布不含 FFmpeg 的色彩代码包，但公开当前整个仓库仍会公开旧二进制历史。详情和哈希见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

**Git 身份处理已按用户决定执行。** 本地 153 个提交的 author/committer 已改用该 GitHub 用户的 noreply 身份，一条提交说明中的私人邮箱及主机名也已替换；代码快照、日期与拓扑未改变，未提交工作完整保留。后续提交配置也已更新。远端 main 已经用户确认后用精确 `--force-with-lease` 同步，并验证 153 个提交及全部 1290 个远端克隆对象无待清理身份。项目外保留本地恢复备份，不参与发布。详见 [HISTORY_PRIVACY.md](HISTORY_PRIVACY.md)。

**版权确认。** 以当前仓库所有者/贡献者作为 MIT 版权声明，不为已知第三方重授许可。内置档是历史记录中用户提供的数值实测档；原始截图与私人素材没有加入。正式发布前由维护者确认原创代码、数值档、品牌名称及任何外部贡献的授权。

## 检查边界

这不是“绝对没有敏感信息”的证明。规则扫描没有高熵检测、专业 secret scanner 或远端删除 refs/GitHub Actions 日志/LFS 审计；读取的是本地全部可达历史与当前跟踪/未忽略文件。仓库可见性查询时已确认，公开前再确认。隐藏/删除远端历史若有应另查。第三方许可盘点来自包元数据与原文，GPL 内核已明确列为未完成项。

## 验证记录

独立模块提取后现有 268 项与新增 2 项测试最终全量通过；隔离消费、类型检查、主应用构建均通过。具体结果见 [VALIDATION.md](VALIDATION.md)。本次保留了提取前原算法输出基线；未将模型预测冒充 Apple 实拍。完成技术准备不代表本报告中的发布待办已解决。
