# 给 AI 编程助手

现行入口是 [AGENTS.md](AGENTS.md)。网页接入按 [docs/AI_INTEGRATION.md](docs/AI_INTEGRATION.md) 直接复用 `src/color-correction/`，不要根据研究笔记重写。

算法精确实现是 `src/color-correction/core.ts`；校准数据是该目录 `profiles/*.json`。`src/lib/chart.ts` 负责重标流程。旧 `src/lib/color.ts`、`profile.ts` 只是兼容转发。

技术原理、接口和限制见 [docs/COLOR_CORRECTION.md](docs/COLOR_CORRECTION.md)。跨语言移植再读 [PORTING.md](PORTING.md)，以当前代码为准；旧研究中的早期档、线性光模型或跨设备保证不能直接当当前结论。

使用步骤也可从 [skills/usdz-color-correction/SKILL.md](skills/usdz-color-correction/SKILL.md) 进入。真正的功能由代码提供，技能不包含另一套算法。
