---
name: dsh-vision-control
description: 实时视觉感知 + 精确桌面操控的标准使用教程（DSH-Vision-Control 插件）。当任务需要看屏幕、观察界面变化、点击/输入/拖拽、操作窗口与桌面应用、GUI 自动化、滑块/人机验证、或用户说"帮我点/看着屏幕/操作电脑/打开某个软件"时使用。Triggers: 操作电脑、点一下、帮我点、看着屏幕、盯梢、screen watch、screenshot、click、type、drag、desktop automation、GUI automation、human verification、slider。注意：需用户已在输入框工具栏点亮电脑图标授权「电脑操作」。
metadata:
  author: star-kz
  version: "1.0.0"
---

# DSH-Vision-Control 使用教程

给 AI 一双眼睛和一双手：`computer_watch` 实时看屏幕变化（省 token 的余光），`computer_*` 15 个工具精确操控桌面。

## 0. 前置：授权闸门

所有 computer_* 工具受「电脑操作」授权控制——用户必须在输入框工具栏点亮 **电脑图标**（无文字，点一下）。未授权时工具返回 `[NOT_AUTHORIZED]...`，这时**提醒用户点图标**，不要重试。

## 1. 工具族速览

| 工具 | 用途 | 何时用 |
|---|---|---|
| `computer_watch` | 实时感知：按画面变化量自动留帧，多帧拼一张图 | 盯变化、等加载、验证操作结果（默认首选的"看"） |
| `computer_screenshot` | 全分辨率单帧精读 | 读小字、拿坐标、点之前 |
| `computer_ui` | 读 UIA 控件树（类型/名字/AutomationId/矩形） | **零图定位**控件，优先于看图找 |
| `computer_ui_action` | UIA 直控（invoke/set_value/select/toggle/expand…） | 能定位到控件就用它，不耗图 |
| `computer_click` | 绝对坐标点击（可多击/修饰键/从截图投影） | UIA 搞不定时的兜底 |
| `computer_type` / `computer_key` | 打字（Unicode 任意语言）/ 按键与快捷键 | 输入框、快捷键 |
| `computer_paste` | 粘贴长文本（自动保留还原用户剪贴板） | 长文本、中文大段 |
| `computer_drag` | 拖拽（两坐标或路径点） | 滑块、选文本、拖窗口 |
| `computer_scroll` | 滚轮 | 滚动页面/列表 |
| `computer_windows` | 列顶层窗口 / 置前 | 切换应用前先看有哪些窗口 |
| `computer_ui` 的 `hwnd` | 之后所有动作可锁窗口 | 多窗口防误触 |
| `computer_stop` | 释放卡住的输入 / 关闭能力 | 手势中断后清理 |
| `browser_state` / `browser_actions` | 浏览器页面：可访问性树 / 动作序列 | 网页任务**优先用这两个**，比看图点像素可靠 |
| `app_launch` | 干净环境启动应用（剥 Electron 注入变量） | 启动 Electron 应用必备 |
| `app_env_audit` | 查会话里的 Node 注入变量 | 应用打不开（无窗口 exit 0）时诊断 |

## 2. 标准工作流

**看 → 定位 → 动 → 确认**，四步循环：

1. **看**：`computer_screenshot`（全屏或 window 捕获）拿全貌；或已知区域变化时直接 `computer_watch`。
2. **定位**：优先 `computer_ui` 按名字/类型找控件拿 `[s#.#]` ref；找不到再从截图读坐标。
3. **动**：有 ref 用 `computer_ui_action`（invoke/set_value 最稳）；没有就 `computer_click(x, y)`。坐标用虚拟桌面像素，与截图信封一致；用 `from_frame` 可直接按截图里的像素点。
4. **确认**：动作后用 `computer_actions` 的 `wait_for`（零 token 等条件：窗口出现/文本变化/控件启用），或 `computer_watch` 挂住看变化。**不要拿 watch 当时序敏感动作的确认信号**（它有 ~0.5s 判定延迟）——确认用 wait_for。

批量动作写进一个 `computer_actions` 调用（最多 50 步，末尾可带截图/UIA 读），省往返。

## 3. 操作循环范式（批与盯梢的纪律）

四条纪律，同一个目标：让每批动作"带着自己的确认上路"——不拍脑袋等，也不往旧页面上点。

**① 批内确认用 `wait_for` 语义条件，不用固定 sleep 猜时间。** 点完要等"结果出现"时，在批里插 `wait_for` 步声明条件，worker 轮询（首次立即查，之后每 `poll_ms`，默认 120ms），条件一成立立刻走下一步——而不是 `wait` 一个事前猜的秒数（猜短了点在旧页面上，猜长了每步白烧时间）。八种条件：`window`（窗口出现/消失）、`control`（控件出现、`enabled:true` 可点）、`value`（控件值变成 `expected`）、`text`（窗口文字里出现 `contains`）、`file`（产物落盘）、`region`（屏幕区域像素 `changed`/`stable`，自绘界面的兜底）、`every`/`any`（组合）。步级 `timeout_ms` 默认 30s、上限 120s；超时默认 `on_timeout:'stop'` 停在原地，回执 `nextStep` 点名停在哪、`waits` 说看到了什么（`condition-timeout` = 没变成真，`condition-unobservable` = 根本没看着，两回事）。固定 `wait` 步只用于纯时长（动画、settle，单步上限 30s）。**预算口径**：批内所有等待——`wait_for` 步和固定 `wait` 步——共用本次调用的一个预算；长等待链显式给 `deadline_ms`，被预算裁断的等待如实报 `timeoutFrom:'deadline'` / `[DEADLINE_EXHAUSTED]`，不会有隐式截断。

**② `computer_watch` 只在预计空闲 >10s 时挂；一批返回后想续看必须重挂。** watch 每次调用**只回一批图**（阻塞到有变化或超时即返回），返回后采集器只留 **60 秒宽限**——60s 内没有新的 watch 调用，采集（ffmpeg）即被 teardown，下次再看要重付冷启动。所以：预计接下来 >10s 不用动手（等加载、等进度条、等消息）才挂；自己马上要连续发动作时别挂——watch 是阻塞调用，挂住期间你一步也动不了。一批图返回后还要继续看，**60s 内立刻再挂一次**（复用温采集，零重启成本）——"挂一次就一直在看"是错觉，它从不持续投递。

**③ 长任务的批里插 `screenshot` 步，留中间证据。** 默认 `evidence:true` 只对整批**首尾**做指纹比对——长批在第 N 步失败时，首尾指纹只说"变了/没变"，看不到失败现场。在每个阶段边界插 `{action:'screenshot'}` 步（只读步，可安全重发），回执把中间帧带回来，出问题时按图定位是哪一步开始偏离。阶段多于两三段的长批，每段末尾一张。

**④ 跨页面跳转/向导翻页/同窗口对话框的批：步间必须声明 `wait_for` 语义网。** 批守卫 `stop_on_window_change`（默认开）只看**前台窗口**变化——网页跳转、向导翻页、同窗口弹出的对话框都不换前台窗口，守卫看不见。这类批在触发跳转的步之后**必须插 `wait_for` 步**确认新页面就位再往下点：有可读控件用 `control`/`value`/`text`，自绘界面用 `region`。否则就是"回执成功、其实点在旧页面"。反过来，动作**预期**会换前台窗口（点"导出"弹出完成框）时，把目标窗口声明进 `expected_transitions` 放行，而不是关掉守卫。

## 4. computer_watch 详解（余光）

```jsonc
computer_watch({ action: "watch", seconds: 300 })   // 阻塞到有图或超时；有变化时 15-40s 出一张
computer_watch({ action: "peek" })                  // 立刻取走已攒的图，不等
computer_watch({ action: "status" })                // 看采集器状态
computer_watch({ action: "stop" })                  // 收工
```

- **返回值**：`frames[]`（多帧拼一图）+ `packs[]` 元数据。图内坐标换算屏幕坐标 = **× (屏幕宽 / 图宽)**。
- **参数**：`quality`（low 默认 800×450≈218 tok/张 → standard → high 能读文件名 → ultra 接近原屏）、`pace`（calm/normal 默认/dense 操作时推荐）、`minFrames`（静止屏幕调大省 token）、`seconds`（阻塞上限 ≤860）。
- **何时用**：等页面加载完、等进度条走完、盯聊天窗口来消息、长时间任务挂余光。静止时几乎不花 token。
- **读不了小字就升 quality**，别猜糊图。

## 5. 定位与操控要点

- **UIA 优先**：`computer_ui({ filter: "保存" })` → `computer_ui_action({ action: "invoke", name: "保存" })`。零截图、不怕遮挡、中文稳。跨调用引用控件用 `ref`（`[s#.#]`，带过期保护）。
- **click 兜底**：`prefer_a11y:true`（默认）会先尝试 UIA 按压；`clicks:2` 双击、`modifiers:"ctrl"` 组合点击。`from_frame` + 截图内像素坐标，插件自动投影回屏幕。
- **窗口级操作**：`computer_windows` 拿 hwnd → `focus_hwnd` 置前；`computer_ui_action` 支持 `close/minimize/maximize/restore`（不需要前台）。截图加 `window: hwnd` 可拍被遮挡的窗口。
- **输入**：`computer_type` 逐字（Unicode，中文可）；大段文本用 `computer_paste`（先点目标框聚焦）；`computer_key` 发快捷键（`ctrl+c`、`alt+tab`、`win`）。
- **滑块/人机验证**：`computer_drag({ from_x, from_y, to_x, to_y })` 或 `path` 走曲线（更像人）。拖拽中被打断用 `computer_stop` 释放按键。
- **剪贴板**：`computer_clipboard` get/set/clear——读应用内文本的最可靠方式（选中→ctrl+c→读板）。

## 6. 常见配方

| 任务 | 配方 |
|---|---|
| 打开应用 | `app_launch("notepad")`（Electron 应用必须用它，裸 shell 会因 ELECTRON_RUN_AS_NODE 无窗口退出） |
| 网页任务 | 先 `browser_state` 读可访问性树 → `browser_actions` 批量点/填；别用桌面坐标点网页 |
| 等某个窗口出现 | `computer_actions` 末尾 `wait_for: { kind:"window", title:"保存", timeout_ms:30000 }` |
| 读弹窗内容 | `computer_ui({ filter:"确定" })` 或 window 截图 |
| 长时间盯梢 | `computer_watch({pace:"dense"})` 挂着，每出图看一眼，安静时不烧钱 |
| 应用点了没反应 | `app_env_audit` 查注入变量；`computer_windows` 确认窗口是否真开了 |

## 7. 故障速查

| 症状 | 处置 |
|---|---|
| 失败文本带 `[CODE · retry=X]` 头 | 统一格式：`retry=X` 是重试判据——`never`（重发无意义，按 hint 修正参数/目标）/ `retry`（可直接重发；非幂等调用时 hint 会改口"先观察"，照做）/ `reobserve`（先 `computer_ui` / `computer_screenshot` 观察再决定）。头下面的「下一步：」行动句照做 |
| `[NOT_AUTHORIZED]` | 让用户点输入框工具栏的电脑图标 |
| watch 返回缺 ffmpeg / 采集失败 | 装 ffmpeg（[gyan.dev](https://www.gyan.dev/ffmpeg/builds/)）并把 `bin` 加进 PATH，或设 `DSH_FFMPEG_PATH` |
| `[TARGET_OCCLUDED]` | 目标被别的窗口盖住：先 `computer_windows` 置前，或 click 加 `allow_activate:true` |
| `[STALE_REF]` | ref 过期，重新 `computer_ui` 读一次再动 |
| `[HELPER_UNAVAILABLE]` | 两态，看文案区分：**「从未起来」**（启动失败/脚本缺失）= 调用没到达任何 worker、什么都没发生，重发安全（会自动重启后端，冷启动最长约 60s）；连续失败先查安全软件拦截或跑 doctor，别盲重试。**「起来后死掉」**（服务中途退出）= 调用可能已派发到 worker：只读调用直接重试；非只读先观察桌面再决定 |
| UIA 读不到内容（自绘界面） | 放弃 UIA，直接截图读像素 + 坐标点击 |
| 打字丢字 | `computer_type` 换 `computer_paste` |
| 操作子代理里不可用 | 设计如此：电脑操作只对主会话开放 |

## 8. 边界

- Windows 桌面专用（屏幕捕获走 ffmpeg ddagrab，操控走 UIA + SendInput）。
- `computer_watch` 单次阻塞上限 860 秒；超时返回空结果属正常，再挂一次即可。
- 本插件遵守 PolyForm Noncommercial 1.0.0（个人/非商用免费），其 computer-use 血统部分为 MIT。
