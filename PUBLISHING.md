# 上传内容与校验

本仓库来自 2026-10-29 修复交接版本。发布整理只修改仓库说明、补充根许可证和 Git 配置，并将失败复现日志中的本机绝对路径替换为 `<workspace>`；插件源码和 TGZ 保持原字节。

`reports/` 是既有验收证据，不代表在 GitHub 整理当天重新完成全部实机操作。额外鼠标绘制回归因人工输入中止，未计入通过数量。视觉辅助没有远端付费模型准确率验收。

完整性校验：`powershell -NoProfile -ExecutionPolicy Bypass -File .\Verify.ps1`。
安装/回滚隔离回归：`node scripts/Test-Handoff.cjs`，仅使用临时假 profile 和假 pnpm，不操作本机实际 DSH 配置。

根许可证适用于本仓库新增内容与 dsh-control；附带 dsh-agent-supervisor 的版权声明另见其目录内 LICENSE，均保留 MIT 原文。

未上传账户凭据、浏览器资料目录、Cookie、会话聊天或业务附件。
