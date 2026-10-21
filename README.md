# dsh-kv-computer-use

DeepSeek Harness 的 Windows 电脑操控插件。设计目标不是"再加一个 computer use"，而是把**事务化验证**（KV Computer Use 的契约层）、**文本优先观察**（dsh-click 的思路）、**WinRT OCR**（dsh-computer-use-win 的强项）和**后台/多屏能力**装进同一个工具面。

## 为什么不是直接用市场的插件

2026-10-21 实测的结论：

- 官方 `@deepseek-ai/dsh-computer-use` 解包 5.4KB，40 行代码，只做"一个进程只能注册一个 provider"的独占槽位。README 原文：**不添加模型可见工具、不含驱动对象、不含操作接口**。所以"官方不够用"是设计如此。
- 市场 6254 个插件里 34 个 computer-use 族。下载量前三各有取舍：`dsh-computer-use-win`（23 工具 + OCR，MCP 桥）、`@copylee/dsh-computer-use`（人机共处体验最好）、`dsh-click`（8 工具，四道安全闸门）。
- 本地 `kv-computer-use` MCP（本插件复用的执行引擎）拥有市场里没有的东西：**5 态事务 outcome、风险分级、postcondition 轮询、requireBackground 强制、多屏投放、持久化收据**；但它缺输入层（`type_text`/`hotkey`/`click_point` 在 UIA 受控版里直接 `ACTION_UNSUPPORTED`）、缺 OCR、且是 Codex MCP 而非 DSH 插件。

本插件 = 那套契约 + 缺的那几层 + DSH 原生工具面。

## 工具（core 7 / full 11）

默认 `toolset: 'core'` 只注册 7 个工具，省上下文；需要编排与多屏时把配置改成 `full`。

| 工具 | 组 | 作用 |
|---|---|---|
| `cu_status` | core | 驱动/输入层/OCR 状态、能力表、守卫配置、被跳过的工具 |
| `cu_observe` | core | 窗口列表 + 无障碍树，短引用 `uia:rN`，绑 `observationId`，记录身份与树指纹 |
| `cu_capture` | core | 窗口/显示器/区域截图存盘，PrintWindow 后台优先，顺带回填像素指纹 |
| `cu_ocr` | core | WinRT OCR，行级 + 词级像素坐标（中文可用） |
| `cu_act` | core | **统一动作入口**：invoke / set_value / type / hotkey / click / scroll / focus / wait |
| `cu_abort` | core | 急停开关；置位后所有写动作 `HALTED_BEFORE_EFFECT`，只读工具照常 |
| `cu_guard` | core | 解释守卫：作用域、TTL、指纹、急停状态；可测试某个标签是否危险/是否凭据字段 |
| `cu_sequence` | full | ≤10 步串行编排，首步失败即停 |
| `cu_monitors` | full | 显示器列表 + 推荐 agent 屏 |
| `cu_place_window` | full | 把窗口投到 agent 屏，**不激活** |
| `cu_receipts` | full | 回读收据 |

## 守卫与新鲜度（v0.2.0）

动作执行前多过两道闸，任一不过都是 `HALTED_BEFORE_EFFECT`，不会静默成功：

**守卫**（源自市场的两类实现，做成可解释的判定）
- 应用作用域 `allowedApps`：窗口名/类名/pid 不在白名单直接拒绝
- 凭据字段：`password`/`密码`/`token`/`api_key` 命名的目标，`type` 与 `set_value` 一律拒绝
- 危险标签：删除/清空/支付/转账/退出登录 等中英文词命中时要求 `approved: true`，不是默默拦掉

**新鲜度边界**（机制取自 dsh-click 的三重校验）
- 身份：pid + 类名 + 几何 + 标题
- 树：元素序列的 sha256
- 像素：可选，默认**关闭**——闪烁光标、时钟、动画会让每次截图字节都不同
- TTL 默认 30 秒；过期即拒，要求重新 `cu_observe`
- 没有观测记录直接拒绝动手（禁止盲操作）

**动作后静止检测**：写动作完成后轮询截图直到画面不再变化（最多 2.5 秒），避免把半渲染帧当成 postcondition 失败。

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
node test/layers.mjs    # 守卫规则 + 新鲜度边界（纯逻辑，30+ 断言）
node test/smoke.mjs     # driver 真机：status / observe / ref 映射 / postcondition / 收据
node test/harness.mjs   # fake ctx 挂载：工具集、拒绝路径、急停、守卫自省
node test/live.mjs      # 真机成功路径：自建 WPF 夹具窗口 → 后台写入 → value_equals 验证
```

`live.mjs` 只操作自己启动的夹具窗口（`test/fixture-wpf.ps1`），用完按 pid 关掉，绝不碰用户的编辑器或其他窗口。

实测（本机 Windows，2026-10-21）：后台 `set_value` 写入 WPF TextBox **229ms**，中文无碍，`value_equals` 判定 VERIFIED，capture 返回 `print-window`/`occlusionRisk=false`。

## 已知限制

- 只支持 Windows。
- **`set_value` 依赖 UIA ValuePattern**。WPF TextBox、Win32 Edit、多数 UWP 控件都有；**WinForms TextBox 只有 TextPattern**，会报 `does not expose ValuePattern`（实测）。这类控件要用 `type`（会抢焦点）。
- 输入层每次调用约 **1.4 秒**（PowerShell 启动 + 加载缓存 DLL），DLL 首次编译约 0.4 秒。没有做常驻进程。
- OCR 每张约 **1.9 秒**（PS 启动 + WinRT 解码）。
- 像素级陈旧检测默认关闭（闪烁光标/动画会误报），可开 `staleCheckPixels: true` 用于静态界面。
- `uia:rN` 短引用只在一次观测内有效；跨观测验证请用 `name` / `automationId`。
- 没有视觉理解：截图只能交给 `cu_ocr` 或模型自身的图像通道。插件不替模型"看图"。
- 多屏投放（`cu_place_window`）只在单机上验证了 `list_monitors` 返回结构，未做双屏端到端。
- 未在桌面端 0.2.1-rc.2 上跑过真实加载（需要重启宿主）；模块加载与 peer 解析已验证。

## 许可

MIT。执行引擎来自 KV Computer Use（MIT, Copyright (c) 2026 Fineguide.AI），详见 `NOTICE`。
