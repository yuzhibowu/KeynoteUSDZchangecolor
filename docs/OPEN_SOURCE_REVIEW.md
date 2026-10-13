# 开源准备检查报告

日期：2026-10-13。检查起点 `432fe3b`，工作区干净；初次检查时分支 main 与本机 origin/main 一致；当时通过 `git ls-remote --heads --tags origin` 核对远端只有 main，没有远端标签。该核对发生在本地身份清理之前，不能用来判定当前本地与远端已同步。通过 GitHub CLI 只读查询确认 [yuzhibowu/KeynoteUSDZchangecolor](https://github.com/yuzhibowu/KeynoteUSDZchangecolor) 为 PRIVATE、默认分支 main、未识别到 LICENSE。初次准备未改可见性、推送或发布 npm。随后按用户要求清理 Git 身份和一条提交说明，并经用户确认用精确 lease 同步了 GitHub main；全新远端克隆验证无待清理身份，仓库仍私有。清理后的本地 main 为 `432fe3bd18dbb80d3c0fe051e162925b700dcae7`。

## 已完成的准备

- MIT LICENSE 用于自有代码、独立模块、文档及内置数值档；根 package 元数据标 MIT，`private:true` 保留（防误发 npm，与 GitHub 私有状态无关）。
- README、AGENTS、技术原理/导出/AI 接入说明、仓库技能与可运行示例。
- 锁文件 156 个包的许可盘点：MIT、BSD-3-Clause、Apache-2.0、ISC、CC-BY-4.0。原包许可/通知合集与 vendored r185 Three.js MIT 许可。
- `.gitignore` 增加环境文件和常见私钥文件；原有私人图片、构建/打包目录不进入 Git。跟踪文件未发现个人图片/模型。
- 历史规则扫描覆盖 153 个提交、624 个 blob；常见提供商令牌、私钥、带凭据 URL、secret 字面量未命中。只发现 FFmpeg JS 的上游 `/home/web_user` 构建路径，并非本机私人路径。
- 保存可重复扫描脚本 `scripts/audit-source.py`；输出只有位置/类型，不输出疑似秘密值。

## 发布检查结果

**FFmpeg 发布阻塞项已按避免二进制再分发的方式处理。** 原未知内核从发布文件和 Git 历史移除，改用浏览器从上游固定版本 CDN 按需加载官方 npm 发布文件并校验哈希；仓库及生产 `dist` 均不含内核。实际验证了 ProRes 4444 XQ、两帧输出和 0/64/128/255 四档透明度。未来复制内核做自托管或离线分发仍需处理其 GPL 及对应源码要求；本项目没有将内核重新声明为 MIT。详情见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

**Git 身份处理已按用户决定执行。** 本地 153 个提交的 author/committer 已改用该 GitHub 用户的 noreply 身份，一条提交说明中的私人邮箱及主机名也已替换；代码快照、日期与拓扑未改变，未提交工作完整保留。后续提交配置也已更新。远端 main 已经用户确认后用精确 `--force-with-lease` 同步，并验证 153 个提交及全部 1290 个远端克隆对象无待清理身份。项目外保留本地恢复备份，不参与发布。详见 [HISTORY_PRIVACY.md](HISTORY_PRIVACY.md)。

**许可范围。** 按用户开源授权以 MIT 提供原创代码、文档及内置数值实测档，保留第三方原许可；原始截图与私人素材没有加入。后续外部贡献应由贡献者确认拥有相应授权。

## 检查边界

这不是“绝对没有敏感信息”的证明。规则扫描没有高熵检测、专业 secret scanner 或远端删除 refs/GitHub Actions 日志/LFS 审计；读取的是本地全部可达历史与当前跟踪/未忽略文件。仓库可见性查询时已确认，公开前再确认。隐藏/删除远端历史若有应另查。第三方许可盘点来自包元数据与原文，外部内核继续适用其自身许可，当前仓库不分发它。

## 验证记录

独立模块提取后现有 268 项与新增 2 项测试最终全量通过；隔离消费、类型检查、主应用构建均通过。具体结果见 [VALIDATION.md](VALIDATION.md)。本次保留了提取前原算法输出基线；未将模型预测冒充 Apple 实拍。公开前仍核对最终远端引用与历史不含原二进制；本次处理不承诺覆盖其他私有备份或 GitHub 缓存。

最终复核：155 个提交逐项排除旧内核路径，其他代码/文件及提交信息一致；当前树和完整可达主线不包含未知内核。273 项测试、构建、独立包测试和真实浏览器透明 MOV 回环通过。仓库可见性由 GitHub 实际状态为准；本报告说明发布准备及检查边界。
