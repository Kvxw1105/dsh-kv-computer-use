# dsh-kv-computer-use

DeepSeek Harness 的 Windows 电脑操控插件。设计目标不是"再加一个 computer use"，而是把**事务化验证**（KV Computer Use 的契约层）、**文本优先观察**（dsh-click 的思路）、**WinRT OCR**（dsh-computer-use-win 的强项）和**后台/多屏能力**装进同一个工具面。

## 为什么不是直接用市场的插件

2026-10-21 实测的结论：

- 官方 `@deepseek-ai/dsh-computer-use` 解包 5.4KB，40 行代码，只做"一个进程只能注册一个 provider"的独占槽位。README 原文：**不添加模型可见工具、不含驱动对象、不含操作接口**。所以"官方不够用"是设计如此。
- 市场 6254 个插件里 34 个 computer-use 族。下载量前三各有取舍：`dsh-computer-use-win`（23 工具 + OCR，MCP 桥）、`@copylee/dsh-computer-use`（人机共处体验最好）、`dsh-click`（8 工具，四道安全闸门）。
- 本地 `kv-computer-use` MCP（本插件复用的执行引擎）拥有市场里没有的东西：**5 态事务 outcome、风险分级、postcondition 轮询、requireBackground 强制、多屏投放、持久化收据**；但它缺输入层（`type_text`/`hotkey`/`click_point` 在 UIA 受控版里直接 `ACTION_UNSUPPORTED`）、缺 OCR、且是 Codex MCP 而非 DSH 插件。

本插件 = 那套契约 + 缺的那几层 + DSH 原生工具面。

## 九个工具

| 工具 | 作用 |
|---|---|
| `cu_status` | 驱动路径/运行态、输入层、OCR、能力表、提权状态、收据路径 |
| `cu_observe` | 窗口列表 + 目标窗口无障碍树，compact 短引用 `uia:rN`，绑 `observationId` |
| `cu_capture` | 窗口/显示器/区域截图存盘，PrintWindow 后台优先，返回路径与尺寸 |
| `cu_ocr` | WinRT OCR，返回行级 + 词级像素坐标（中文可用） |
| `cu_act` | **统一动作入口**：invoke / set_value / type / hotkey / click / scroll / focus / wait，带 postcondition 与收据 |
| `cu_sequence` | ≤10 步串行编排，首步失败即停，省模型往返 |
| `cu_monitors` | 显示器列表 + 推荐 agent 屏（避开用户当前屏） |
| `cu_place_window` | 把窗口投到 agent 屏，**不激活** |
| `cu_receipts` | 回读收据：做了什么、为什么、输入模式、outcome、验证证据 |

工具数刻意压在 9 个：市场里 23 工具的版本让模型选择成本变高，而 8 工具的版本又缺编排与 OCR。

## 设计契约

每个变更动作走固定一条链，任一步失败都不会被报成"成功"：

```
envelope 校验 → 窗口/焦点守卫 → 执行 → postcondition 轮询 → 5 态 outcome → 落盘收据
```

- **5 态 outcome**：`VERIFIED` / `HALTED_BEFORE_EFFECT` / `COMPLETED_UNVERIFIED` / `RECONCILIATION_REQUIRED` / `FAILED`。写操作执行了但验不出来，是 `RECONCILIATION_REQUIRED`，不是"完成"。
- **风险分级**：`read` / `reversible-write` / `external-write` / `destructive`。风险由动作类型推导，调用方**只能升级不能降级**；`destructive` 与 `external-write` 需 `approved: true`。
- **`requireBackground: true`**：会移动共享光标或抢焦点的动作在**执行前**被拒绝（`HALTED_BEFORE_EFFECT`）。
- **postcondition**：`text_present` / `value_equals` / `window_focused` / `element_exists` / `element_absent` / `driver_result` / `none`，带轮询与超时。
- **焦点守卫**：`type`/`hotkey` 传了 `windowHandle` 时，先核对前台窗口 handle，不匹配直接拒绝，避免文字打进错误窗口。
- **收据**：`~/.cache/dsh-kv-computer-use/receipts.jsonl`，一行一条。

## 安装

开发/链接方式（3080 web profile 已验证支持）：

```bash
dsh plugin --profile web add D:\Projects\dsh-kv-computer-use
```

tarball 方式（桌面端等只接受包 spec 的场景）：

```bash
cd D:\Projects\dsh-kv-computer-use && npm pack
dsh plugin --profile desktop add ./dsh-kv-computer-use-0.1.0.tgz
```

驱动查找顺序：`KV_CU_DRIVER` 环境变量 → `~/.cache/dsh-kv-computer-use/kv-windows-uia-driver.exe` → 本机 KV Computer Use 仓库的 `publish` 目录。找不到时 `cu_status` 会明确报 `DRIVER_NOT_FOUND`。

## 验证

```bash
node test/smoke.mjs
```

覆盖：契约分类、envelope 校验（含 requireBackground 拒绝与风险降级拒绝）、真实 driver status/observe、短引用→真 runtimeId 映射、postcondition 的 `element_exists`/`element_absent`、收据往返。不动鼠标键盘。

## 已知限制

- 只支持 Windows。
- 输入层每次调用约 **1.4 秒**（PowerShell 启动 + 加载缓存 DLL）。DLL 首次编译约 0.4 秒。没有做常驻进程。
- OCR 每张约 **1.9 秒**（PS 启动 + WinRT 解码）。
- `uia:rN` 短引用靠 driver 的 runtime-id 重定位，窗口内容大改后可能失效；收据会带 `observationId` 供排查。
- 没有视觉理解：截图只能交给 `cu_ocr` 或模型自身的图像通道。插件不替模型"看图"。
- 多屏投放（`cu_place_window`）在本机双屏未做端到端实测，仅验证了 `list_monitors` 返回结构。
- 未在桌面端 0.2.1-rc.2 上跑过完整加载验证（需要重启宿主）。

## 许可

MIT。执行引擎来自 KV Computer Use（MIT, Copyright (c) 2026 Fineguide.AI），详见 `NOTICE`。
