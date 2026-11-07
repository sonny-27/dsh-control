# DSH Control — 电脑与浏览器操作插件

为 Windows DSH Desktop 提供独立的电脑与 Chromium 浏览器操作工具。源码、安装包、安装/回滚脚本及验收记录一并维护于本仓库。

- **电脑操作**：鼠标点击、拖拽与曲线路径、UIA 无障碍后台操作，从观察开始显示屏幕顶部操控状态，支持人工接管。
- **浏览器操作**：页面内状态与虚拟鼠标、会话原生彩色标签组、已有浏览器协同、父子代理独占交接原标签。
- **审批与模型**：每会话权限、DSH 原生 Auto Review、GUI 审批模型设置及非视觉模型的独立视觉辅助插槽。
- **执行效率**：同页多步 sequence、控件实时重新定位、浏览器独立运行并在 DSH 重启后重连。

详细工具参数见 [插件使用说明](src/dsh-control/README.zh-CN.md)，子代理侧栏修复说明见 [supervisor README](src/dsh-agent-supervisor/README.md)。插件源码版本保持 2026-10-29 验收版本；GitHub 整理日期为 2026-11-07。

日期：2026-10-29。包含两个独立插件的当前修复版本：

| 插件 | 版本 | 用途 |
|---|---|---|
| dsh-control | 1.12.0 | Windows/浏览器操控、视觉辅助、多步执行、浏览器保留、父子标签交接 |
| dsh-agent-supervisor | 0.1.3-dsh021rc3.3 | 子代理侧栏、状态同步修复、保留原有联动停止与暂停规则 |

这不是 DSH 安装包。需要已有 Windows DSH Desktop，组合推荐使用 0.2.1-rc.3；声明兼容的其他版本不等于经过同样完整的验收。Chrome 已做实机验证。Node、pnpm 优先使用 DSH 自带版本。

## 安装

先结束正在执行的电脑操作。推荐退出 DSH 后安装，再启动 DSH。解压到普通本地文件夹，在 PowerShell 中进入本目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Verify.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -PlanOnly
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
```

默认安装到当前用户 `$DSH_HOME/profiles/desktop`；未设置 DSH_HOME 时使用 `%USERPROFILE%\.dsh`。可通过 `-DshHome`、`-Profile`、`-AppDirectory` 指定位置。脚本校验完整性、备份 profile 配置，将两个 TGZ 复制到稳定的本地目录后再调用 pnpm。不会引用解压目录作为长期运行依赖。

默认停用旧 `dsh-click` / `tool-browseruse` / `dsh-browseruse` 入口，以避免与新电脑操控工具重复；若需保留它们，使用 `-KeepLegacyPlugins`。安装不会删除旧插件文件、聊天、浏览器数据、模型配置或暂停记录。

如已安装相同版本，通常不需要重复安装。脚本支持迁移、交接和重装。

## 回滚

安装会打印备份路径。优先用该路径：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Rollback.ps1 -BackupPath '实际备份目录' -PlanOnly
powershell -NoProfile -ExecutionPolicy Bypass -File .\Rollback.ps1 -BackupPath '实际备份目录'
```

不指定路径时，读取本交接安装器保存的当前 profile 最近一次备份。回滚会恢复安装前的 profile 配置并用 pnpm 同步依赖，不删除用户文件或浏览器资料。若安装后 profile 配置又发生变化，默认拒绝覆盖；先人工核对，确实需要覆盖时才加 `-Force`。回滚依赖旧包仍可获取；需要下载时必须有相应网络访问。

## 主要功能入口

- 电脑操控设置：会话输入区左侧“电脑操控”。权限跟随 DSH 会话，保留原生 Auto Review。
- 非视觉模型：设置“视觉辅助”和独立视觉供应商/模型；主模型得到文字观察和候选坐标。模型实际视觉准确率取决于所选服务。
- 一次执行多步：`control_browser` / `control_desktop` 使用 `action:sequence`，同一页面/窗口 1..8 个已观察控件动作。
- 父子代理交接：父会话 `handoff` 指定原标签、观察 ID 和真实直接子代理 ID；子代理重新观察原标签，`return-tab` 归还，父会话可 `reclaim-tab` 收回。GUI 也提供“父子会话标签交接”。
- 浏览器保留：新版专用浏览器独立运行，DSH 重启后连接同一浏览器；旧观察与审批不会跨重启复用。
- 子代理状态：状态不一致时显示“同步中”，只有明确结束或暂停证据才显示“已中止”。真实的人工停止仍然有效，修复不会自动解除暂停。

详细架构、复现、边界和后续维护说明见 [HANDOFF.md](HANDOFF.md)。

## 内容与证据

- `packages/`：可安装的原始 TGZ。
- `src/`：对应源码与插件原有许可证、测试。
- `reports/`：原有测试结果、当前版本文件校验、界面截图及本交接包校验。
- `manifest.json`：文件大小和 SHA-256；`SHA256SUMS.txt` 还包含 manifest 的摘要。

电脑操控版本既有验收为 280 项；侧栏修复为 49 项单元检查和 6 项浏览器 UI 检查。不是声称本次打包重新跑了所有这些实机任务。交接包本身另外检查文件、TGZ 与源码对应、脚本、安装和回滚流程。

没有打包聊天全文、附件、真实账号 Cookie、密钥、用户浏览器资料、实际业务文件或临时取消来源监听脚本。文件摘要用于发现损坏或意外修改，不是发布者数字签名。
