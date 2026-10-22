# dsh-kv-computer-use

DeepSeek Harness 的 Windows 电脑操控插件。设计目标不是"再加一个 computer use"，而是把**事务化验证**（KV Computer Use 的契约层）、**文本优先观察**（dsh-click 的思路）、**WinRT OCR**（dsh-computer-use-win 的强项）和**后台/多屏能力**装进同一个工具面。

## 为什么不是直接用市场的插件

2026-10-21 实测的结论：

- 官方 `@deepseek-ai/dsh-computer-use` 解包 5.4KB，40 行代码，只做"一个进程只能注册一个 provider"的独占槽位。README 原文：**不添加模型可见工具、不含驱动对象、不含操作接口**。所以"官方不够用"是设计如此。
- 市场 6254 个插件里 34 个 computer-use 族。下载量前三各有取舍：`dsh-computer-use-win`（23 工具 + OCR，MCP 桥）、`@copylee/dsh-computer-use`（人机共处体验最好）、`dsh-click`（8 工具，四道安全闸门）。
- 本地 `kv-computer-use` MCP（本插件复用的执行引擎）拥有市场里没有的东西：**5 态事务 outcome、风险分级、postcondition 轮询、requireBackground 强制、多屏投放、持久化收据**；但它缺输入层（`type_text`/`hotkey`/`click_point` 在 UIA 受控版里直接 `ACTION_UNSUPPORTED`）、缺 OCR、且是 Codex MCP 而非 DSH 插件。

本插件 = 那套契约 + 缺的那几层 + DSH 原生工具面。

## 工具（core 9 / full 13）

默认 `toolset: 'core'` 只注册 9 个工具，省上下文；需要编排与多屏时把配置改成 `full`。

| 工具 | 组 | 作用 |
|---|---|---|
| `cu_status` | core | 驱动/输入层/OCR 状态、能力表、守卫配置、被跳过的工具 |
| `cu_observe` | core | 窗口列表 + 无障碍树，短引用 `uia:rN`，绑 `observationId`，记录身份与树指纹 |
| `cu_find` | core | 按 name / automationId / controlType / value / 正则搜元素，只返回命中项和新 ref |
| `cu_capture` | core | 窗口/显示器/区域截图存盘，PrintWindow 后台优先，顺带回填像素指纹 |
| `cu_ocr` | core | WinRT OCR，行级 + 词级像素坐标（中文可用） |
| `cu_read` | core | 读控件文本：TextPattern → ValuePattern → WM_GETTEXT，不依赖渲染 |
| `cu_act` | core | **统一动作入口**：invoke / set_value / type / hotkey / click / scroll / focus / wait |
| `cu_abort` | core | 急停开关；置位后所有写动作 `HALTED_BEFORE_EFFECT`，只读工具照常 |
| `cu_guard` | core | 解释守卫：作用域、TTL、指纹、急停状态；可测试某个标签是否危险/是否凭据字段 |
| `cu_sequence` | full | ≤10 步串行编排，首步失败即停 |
| `cu_monitors` | full | 显示器列表 + 推荐 agent 屏 |
| `cu_place_window` | full | 把窗口投到 agent 屏，**不激活** |
| `cu_receipts` | full | 回读收据 |

## 写入与读取的降级链（v0.3.0）

**写入**（`cu_act` 的 `set_value`）
1. UIA `ValuePattern` — WPF、Win32 Edit、多数 UWP 控件
2. `WM_SETTEXT` — 仅有 TextPattern 的控件（WinForms TextBox、部分 Electron/Chromium 输入框）。定位到控件自己的原生句柄，直接发消息，**不抢焦点、不敲键盘**；写完立即 `InvalidateRect`/`UpdateWindow`/`RedrawWindow`，否则 WinForms 不重绘、屏幕上看不到
3. 都不可用时保留原始 `PATTERN_UNAVAILABLE` 错误，不伪造成功

写入成功的证据优先用**原生读回**（`WM_GETTEXT`），比 UIA 间接查更快也更硬。

**读取**（`cu_read`）
1. `TextPattern` — 文档类控件
2. `ValuePattern` — 表单字段
3. `WM_GETTEXT` — 兜底，只要有原生句柄就能读

这条链让"没有 value 字段的控件"不再是盲区：`cu_observe` 看不到内容时，`cu_read` 能拿到文本，而且不依赖屏幕渲染（锁屏、遮挡、远程桌面下依然有效）。

## 输出必须是 lossless JSON（v1.0.1）

harness 对工具返回值有一条硬约束：任何一个 `undefined` 字段都会让整条结果被拒（`value is not lossless JSON`），工具在运行时就等于不可用——而 `undefined` 在日志里是看不见的，单元断言也照常通过。

所以注册层统一包了一层 `clean()`：递归丢弃 `undefined`，保留 `null`（`null` 在这里有语义）。`test/output-shape.mjs` 对每个工具做 JSON 往返比对，专门守这条线。

## 设计取舍（明确不做的）

这几个是市场插件里有、我们**主动不做**的机制，不是遗漏：

- **set-of-marks 截图标注**：给元素画编号框，是给视觉模型看的。这里的模型直接读结构化文本树，标注图反而多一层翻译损耗。`cu_capture` + `cu_ocr` 已覆盖真正需要看像素的场景。
- **窗口级光晕**：需要覆盖层窗口跟着目标窗口走，成本高。功能上 `conversation.composer.dock` 的状态行已经说明"谁在操作、操作什么、几秒"，且不会遮挡用户界面。
- **主动视觉观察者**：不替模型截图→调视觉模型→描述→返回。插件只提供 `cu_capture` 的图片路径和 `cu_ocr` 的文本，用哪条通道由模型自己决定——多一层自动调用等于把成本藏起来。
- **工具满天飞**：不做 20+ 工具。`core` 9 个、`full` 13 个，用 `set_value` 统一写入、`cu_act` 统一动作、`cu_find` 统一定位。

## 人机共处（v0.6.0）

Web UI 半在输入框下方的 `conversation.composer.dock` 里放一条状态行：

- 动作执行中显示「正在操作电脑 · 点击控件 · 3.2s · 按 Esc 停止」
- **Esc 立即急停**：host 在下一个写动作进入前就拒绝它（`HALTED_BEFORE_EFFECT`），不是等当前步骤跑完
- 停止后状态行变成「电脑操作已停止 / 继续」，点继续或再按 Esc 恢复
- 颜色继承主题（`currentColor` + `color-mix`），不硬编码品牌色；计时器、监听器全部在 unmount 时清理

状态行在三种状态下都可见：**运行中**（带计时）、**已停止**、以及**动作完成后 8 秒内**（显示 `已验证` / `已执行·未验证` / `已拦截` / `需人工核对` / `失败`）。没有这个尾窗，一个 300ms 的动作永远来不及被看见。

Esc 只在动作进行中拦截，其他时候保持应用原有的 Esc 语义。

client 半通过 host 路由通信：`GET /kv-computer-use/state`（活动状态 + 急停标志）、`POST /kv-computer-use/abort`、`POST /kv-computer-use/resume`。**新增 host 半与 client 半都需要重启宿主才生效。**

## 观察层（v0.5.0）

**按条件找元素，不要整棵树**。`cu_find` 在目标窗口里按字段搜索，返回命中元素的短引用和 observationId——这些 ref 可以直接喂给 `cu_act`，不需要再 observe 一次。九个元素的窗口里找按钮，比读全树省一个数量级的 token。

**树没用就自动看像素**。`cu_observe` 会判断树是否"稀疏"：元素少于 8 个、或没有一个可交互元素、或带名字的元素占比低于 30%。命中任一条件时，自动截图并 OCR，把文本行和锚点坐标一起返回（`ocr.lines`）。判据是"这棵树对模型还有没有用"，不是"能不能 OCR"——正常的窗口不会为此多付 2 秒。

`autoOcr` 可显式设 `on`（总是）或 `off`（从不）。

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

驱动查找顺序（包内不含任何个人路径）：

1. `KV_CU_DRIVER` —— 精确指向 `kv-windows-uia-driver.exe`
2. `~/.cache/dsh-kv-computer-use/kv-windows-uia-driver.exe`
3. `~/.cache/dsh-kv-computer-use/driver.path` —— **首次定位成功后自动写入的指针**，因此检出目录搬走后仍然可用
4. `KV_CU_DRIVER_SEARCH` —— 分号分隔的搜索根，每个根都试 `<root>/kv-windows-uia-driver.exe` 和 `<root>/apps/windows-uia-driver/publish/kv-windows-uia-driver.exe`

首次使用建议：

```bash
# Windows (PowerShell)
$env:KV_CU_DRIVER_SEARCH = "D:\path	o\kv-browser-bridge-action-seq"; dsh
```

找不到时 `cu_status` 报 `DRIVER_NOT_FOUND`，不会静默降级。

## 验证

```bash
node test/layers.mjs        # 守卫规则 + 新鲜度边界（纯逻辑，43 断言）
node test/smoke.mjs         # driver 真机：status / observe / ref 映射 / postcondition / 收据
node test/harness.mjs       # fake ctx 挂载：工具集、拒绝路径、急停、守卫自省
node test/live.mjs          # WPF 夹具：ValuePattern 后台写入 + value_equals
node test/live-settext.mjs  # WinForms 夹具：无 ValuePattern → WM_SETTEXT 兜底 → 原生读回 + cu_read
node test/live-type.mjs     # 焦点守卫 + 前台锁行为（诚实报告未验证）
node test/latency.mjs       # 输入层一次性 vs 守护进程延迟对比
node test/observe.mjs       # cu_find 搜索 + OCR 兜底触发判据
node test/client-channel.mjs # Web UI 通道：state / abort / resume / 停止真的阻断动作
```

`live*.mjs` 只操作自己启动的夹具窗口（`test/fixture-wpf.ps1` / `test/fixture.ps1`），用完按 pid 关掉，绝不碰用户的编辑器或其他窗口。

实测（本机 Windows，2026-10-21/22）：
- WPF TextBox 后台 `set_value` **229ms**，中文无碍，`value_equals` VERIFIED
- WinForms TextBox（无 ValuePattern）走 `WM_SETTEXT` 兜底成功，原生读回 `WM-SETTEXT-测试-77`，outcome VERIFIED
- capture 返回 `print-window` / `occlusionRisk=false`
- 锁屏或远程会话下 PrintWindow 可能返回空白，OCR 不可用（`cu_read` 不受影响）

## 输入性能（v0.4.0）

输入层改由常驻 PowerShell 守护进程承接：helper 只编译一次、只加载一次，之后每个动作是一行 JSON 的往返。

| 路径 | 中位延迟 |
|---|---|
| 一次性 PowerShell（旧的） | **1773ms** |
| 常驻守护进程（现在） | **2ms** |

首次启动约 1.5 秒，空闲 5 分钟自动退出。守护进程起不来时自动回退一次性路径；**mid-flight 超时不重试**，否则一批按键可能被投递两次。

`hotkey` 也修正为真组合键：按住修饰键 → 敲主键 → 逆序释放。之前是逐个"按下+弹起"，`Ctrl+S` 这种根本不生效。

## 已知限制

- 只支持 Windows。
- `set_value` 优先 ValuePattern，失败自动退 `WM_SETTEXT`（覆盖 WinForms / 部分 Electron）。两者都没有时才会失败，并保留原始错误码。
- `WM_SETTEXT` 需要控件有独立原生句柄；无句柄的合成控件（部分浏览器内部输入）仍要退 `type`。
- **`type` 依赖窗口真正拥有输入焦点**。Windows 的前台锁会让"程序化激活窗口"失败（`FOCUS_REJECTED`），此时窗口可能仍被报告为前台，但按键投递到了别处。因此：
  - 优先用 `set_value`（后台、不依赖激活）；
  - `type` 的结果在观察不到控件变化时只会报 `COMPLETED_UNVERIFIED`，绝不报 `VERIFIED`；
  - `focus` 默认带 `window_focused` 后置条件，激活失败会如实报失败而不是假成功。
- 输入层每次调用约 **1.4 秒**（PowerShell 启动 + 加载缓存 DLL），DLL 首次编译约 0.4 秒。没有做常驻进程。
- OCR 每张约 **1.9 秒**（PS 启动 + WinRT 解码）。
- **TTL 过期 ≠ 画面变了**：`compare()` 会在 TTL 之后仍然计算身份与树指纹，返回 `unchanged` 标记。过期的引用如果内容没变，插件重新盖章后放行（模型只是思考/等用户回答花了几分钟）；真正发生变化的，照旧拒绝。
- **树指纹只在相同观测形状下可比**：`cu_find` 用 depth 12 / 2000 元素建指纹，`cu_act` 校验时必须用同一组参数重观测，否则两次元素集不同、每个动作都会被判成 `TREE_CHANGED`。插件的处理是：记录观测形状，校验时照原样重放。
- `cu_place_window` 会把窗口拉成整个显示器工作区，**driver 协议没有 resize 方法**，插件无法恢复原尺寸。结果里如实给出 `sizeBefore`/`sizeAfter`/`resized`，不假装保持了尺寸。
- 像素级陈旧检测默认关闭（闪烁光标/动画会误报），可开 `staleCheckPixels: true` 用于静态界面。
- `uia:rN` 短引用只在一次观测内有效；跨观测验证请用 `name` / `automationId`。
- 没有视觉理解：截图只能交给 `cu_ocr` 或模型自身的图像通道。插件不替模型"看图"。
- 多屏投放（`cu_place_window`）只在单机上验证了 `list_monitors` 返回结构，未做双屏端到端。
- 未在桌面端 0.2.1-rc.2 上跑过真实加载（需要重启宿主）；模块加载与 peer 解析已验证。

## 许可

MIT。执行引擎来自 KV Computer Use（MIT, Copyright (c) 2026 Fineguide.AI），详见 `NOTICE`。
