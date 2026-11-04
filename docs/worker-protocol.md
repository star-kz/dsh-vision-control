# Worker 协议 · 错误串契约清单（优-P1-12）

本文档成档宿主/worker 之间的**错误文本契约**。错误文本不是给人看的散文——它是两进程间的隐式协议：worker 抛出带 `[CODE]` 字面量的错误，宿主 `internal/failures.mjs` 的 `FAILURE_RULES` 按文本匹配贴码、贴 retry 判据、附「下一步：」行动句。漂移任何一端，另一端就失配。

> 本文档 §1-§6 覆盖错误串契约（优-P1-12 的范围）；§7 dryRun 彩排与 §8 text/ocr 附加观察是新-P1-02/新-P1-03 落入的协议内容扩展。28 命令全协议成档（重构-4）在本文档后续章节继续扩展。

## 1. 失败文本的统一格式（优-P1-11）

所有从 `decorateFailure` 出去的失败文本带统一头：

```
[CODE · retry=VERDICT] 消息正文
下一步：行动句
```

- `CODE`：稳定失败码（大写下划线）。worker 直发的裸 `[CODE]` 字面量会被宿主补上 retry 判据头，原字面量保留在正文里。
- `VERDICT` ∈ `never` / `retry` / `reobserve`：
  - `never`：重发无意义（目标不支持、参数非法、已被取消）。
  - `retry`：可直接重发。非幂等调用时 hint 会按幂等性分叉（TIMEOUT、HELPER_UNAVAILABLE「起来后死掉」态），说了「先观察」就先观察。
  - `reobserve`：先重新观察（computer_ui / computer_screenshot）再决定。
- `下一步：` 行动句是红线，一字不删地跟着规则走。
- 幂等守卫：已带 `[CODE · retry=X]` 头的文本再进 `decorateFailure` 原样返回，不叠头。
- 另有宿主前缀 `[UNKNOWN_OUTCOME · retry=reobserve]`（`withOutcomeNote`）：传输层知道而消息不知道的事——失败时请求**已派发**且非只读，结果未知。

## 2. worker 直发的 [CODE] 字面量（grep 自 backend/worker.ps1）

| CODE | 发出处（行） | 语义 |
|---|---|---|
| `[AMBIGUOUS_MATCH]` | 6099 | 启动目标名称等分匹配多个应用，拒绝猜测（action_sent=false） |
| `[BAD_REQUEST]` | 3621, 3792–10638 多处 | 参数/动作名不合法，worker 在执行前拒绝（action_sent=false） |
| `[CANCELED]` | 78, 9042, 10940, 11768 | 调用被取消；按住的输入已释放（注意 worker 拼写 CANCELED，宿主码为 CANCELLED） |
| `[CAPTURE_SURFACE_UNAVAILABLE]` | 3795, 4054, 4062 | 捕获面拿不到可用像素（client 矩形读不出 / 全同色 / require=window 渲染失败） |
| `[CLIPBOARD_BUSY]` | 5801 | 剪贴板被别的程序占用，require_restore 下拒绝粘贴 |
| `[CONDITION_TIMEOUT]` | 10882 | 批内 wait_for 步骤条件在预算内未成立，后续步骤未执行 |
| `[COORDINATE_MAPPING_UNKNOWN]` | 4748, 4778 | 帧图像到屏幕的变换不确定，拒绝投影而非猜测 |
| `[DEADLINE_EXHAUSTED]` | 107, 10648 | 调用级 deadline 耗尽；已跑的步骤生效，未跑的一步没动 |
| `[DISPLAY_TOPOLOGY_CHANGED]` | 4836 | 截图后显示器布局变了，帧像素不再映射当前屏幕 |
| `[DPI_CHANGED]` | 4843, 4875 | 截图后 DPI 缩放变了（系统级或窗口级） |
| `[ELEMENT_UNAVAILABLE]` | 11317, 11351, 11367 | ref 指向的控件已不在该 hwnd / 窗口 UIA 树不可读 |
| `[EXPIRED_FRAME]` | 4826, 4855, 4880 | frame id 不在登记表（跨重启/被淘汰/窗口已消失） |
| `[FRAME_CONTENT_CHANGED]` | 4809 | 截图后界面内容自己变了（几何不变、像素变） |
| `[FRAME_STALE]` | 4889, 4963, 5316 | 截图后窗口移动/缩放，投影点失效；拖拽途中发现则半途停（action_sent=true） |
| `[FRONT_NOT_TARGET]` | 3376 | 合成键入会落到前台窗口而前台不是目标 |
| `[PARTIAL_INPUT]` | 153, 10947 | SendInput 只送达部分输入（action_sent=true, outcome=unknown） |
| `[POINTER_NOT_SETTLED]` | 4266 | 指针移动未在时限内停稳，但输入通道是通的 |
| `[RESTORE_UNSUPPORTED]` | 5804 | 剪贴板内容无法经此通道还原且 require_restore 要求原样放回 |
| `[STALE_REF]` | 11290 | ref 不在登记表（跨重启/上一代 worker/已淘汰）；不代表控件消失 |
| `[TARGET_CHANGED]` | 4859, 4869, 11299 | hwnd 被系统回收复用，已不属于读帧/读 ref 时的进程 |
| `[TARGET_OCCLUDED]` | 4697, 4727 | 落点上覆盖着别的窗口（含同进程另一窗口），一个字节都没发 |
| `[WINDOW_MINIMIZED]` | 3717 | 最小化窗口只能渲染占位图，不是内容 |

worker 消息尾的标准键值：`action_sent=false|true`（是否已有输入送达桌面）、`recovery=<工具名>`（建议的下一步工具）、`auto_reresolve=false`、`element_lookup=...`、`outcome=unknown`、`dispatch_status=possibly_sent`。`action_sent=false` 是宿主判断「什么都没发生、无需 UNKNOWN_OUTCOME 警告」的依据（failures.mjs `withOutcomeNote`）。

## 3. 宿主侧失败码（FAILURE_RULES，internal/failures.mjs）

worker 码之外，宿主还贴这些码（多数按消息文本匹配，同一 code 可有多条规则分担不同形态）：

`BACKEND_BLOCKED_BY_AV`、`FRONT_NOT_TARGET`、`FOREGROUND_REQUIRED`、`POINTER_NOT_SETTLED`、`SEND_INPUT_BLOCKED`、`SCREEN_LOCKED`、`OUT_OF_BOUNDS`、`EXPIRED_FRAME`、`FRAME_STALE`、`FRAME_CONTENT_CHANGED`、`TARGET_OCCLUDED`、`COORDINATE_MAPPING_UNKNOWN`、`CONDITION_TIMEOUT`、`FRAME_REGION_OUTSIDE_WINDOW`、`STALE_REF`、`TARGET_CHANGED`、`REOBSERVE_REQUIRED`、`ELEMENT_UNAVAILABLE`、`AMBIGUOUS_APP`、`AMBIGUOUS_MATCH`、`TEXT_RANGE_SPLITS_SURROGATE_PAIR`、`NOT_SELECTABLE`、`CARET_UNAVAILABLE`、`ACTION_UNAVAILABLE`、`TREE_UNAVAILABLE`、`CLIPBOARD_BUSY`、`RESTORE_UNSUPPORTED`、`LAUNCH_FAILED`、`CAPTURE_TOO_LARGE`、`DISPLAY_UNKNOWN`、`CAPTURE_SURFACE_UNAVAILABLE`、`WINDOW_MINIMIZED`、`WINDOW_GONE`、`DISPLAY_TOPOLOGY_CHANGED`、`DPI_CHANGED`、`BAD_REQUEST`、`TIMEOUT`（幂等分叉）、`CANCELLED`、`DEADLINE_EXHAUSTED`、`PARTIAL_INPUT`、`UNKNOWN_OUTCOME`、`HELPER_UNAVAILABLE`（两态：「从未起来」retry 安全 /「起来后死掉」按幂等性分叉，优-P1-10）。

## 4. 传输层错误码（backend/bridge.js，不进 FAILURE_RULES 文本头）

`ComputerUseBackendError.code`：`NO_WORKER_SCRIPT`、`START_TIMEOUT`、`SPAWN_FAILED`、`WORKER_EXITED`（启动阶段与服务中退出共用一个 code，两态区分在 `backendMessage` 文案与 HELPER_UNAVAILABLE 规则，优-P1-10）、`DISPOSED`、`WRITE_FAILED`、`ABORTED`（派发前取消/丢弃，什么都没发生）、`CANCELLED`（已派发，逐步边界停）、`TIMEOUT`（后端已重启）、`WORKER_ERROR`、`HELPER_UNAVAILABLE`（两次启动尝试均失败）。

传输事实键：`error.dispatched === true` = 失败时请求已发给 worker（非只读则结果未知）；`error.releaseConfirmed` / `released` / `releaseError` = 被按住输入的独立进程释放结果。

## 5. 其他宿主直发码

`CONTROLLER_BUSY`（internal/lease.mjs，租约被占）、`NOT_AUTHORIZED`、`SUBAGENT_COMPUTER_USE_UNAVAILABLE`、`UNSUPPORTED_PLATFORM`、`PROTOCOL_MISMATCH`（index.js，worker 动作集握手不符——半升级保护 A09）。

## 6. 三层校验落位

1. **node:test 样本串断言**（重构-0 骨架的一部分）：对每条 FAILURE_RULES 喂代表性样本串，断言贴出的 code 与 retry 判据——防 test 正则漂移。
2. **本文档**：契约的文字形态，改任一端先对表。
3. **doctor grep `[CODE]` 字面量**：比对 worker.ps1 实际发出的字面量与本表——防文档漂移。

（1、3 的施工不在本批；本清单是它们的判定基准。）

## 7. batch 的 dryRun 彩排（新-P1-02 B / workerfeat A.5）

`batch` 请求带 `dryRun: true`（worker 端 `dryRun`/`dry_run` 双拼都认）时，worker 走 `Invoke-BatchDryRun` 彩排循环：除派发外一切全真（Assert-NotCancelled、deadline 余额、窗口守卫镜像真循环的 baseline 游标、各动作全真预检），但**一个输入都不派发**。

- **能力位**：worker 发布 `batch.dryrun`。宿主对无此位的旧 worker 拒 `dry_run` 请求（`[BAD_REQUEST]`，提示半升级重启）。
- **租约旁路**：`internal/lease.mjs` 的 `movesDesktop('batch', …)` 对 dryRun 直返 false——彩排零副作用，不占写租约、不挡别的会话。
- **回执字段**（`dryRun` 恒 true 为不可混标记——带它的回执从未跑过，跑过的回执永不带它）：

| 字段 | 语义 |
|---|---|
| `outcome` | `dry-run`（全真跑会跑完）/ `dry-run-deadline`（预算在某步前耗尽）/ `dry-run-reobserve`（前台窗口不是批次以为的那个且无 expected_transitions 覆盖） |
| `allOk` | 是否每步都通过彩排 |
| `wouldStopAt` | 全真跑首个会被拒的步号；-1 = 不会被拒 |
| `count` / `steps[]` / `lines[]` | 步数 / 逐步 report / 逐步一行文案 |
| `action_sent` | 恒 false；`wroteSteps` 恒 `[]` |
| `deadlineMs` + `deadlineLeftMs` | 仅带 deadline 时出现 |
| `transitions[]` | 彩排中被 expected_transitions 覆盖的窗口切换（atStep/from/to/title/process/matchedBy/note） |
| `waitFor` / `trailing` | 尾随观察彩排不产出：串 `not evaluated (dry run)…` / `{screenshot:'not taken (dry run)', state:'not read (dry run)'}` |

- `steps[]` 每步：`{step, action, verdict, dispatched:false, detail, elapsedMs}`，按动作附加 `point{x,y}` / `via` / `frame` / `warning` / `budgetLeftMs` / `caret`。`verdict` 实况 = `ok`（真跑会派发）| `refused`（真跑会停在这步）；拒绝不中断彩排，后续步假设前面的步成功后继续彩排。
- 宿主渲染走独立「彩排」文案分支（`value.dryRun === true` 置顶返回），**绝不写「已执行」**。

## 8. 观察附加字段：text 与 ocr（新-P1-03 / ocr O.5）

`uitree`（computer_ui）与 `batch` 的尾随 `state` 都能在请求里带 `text` 与 `ocr` 两个附加观察；回执的 state 对象同构携带。

### 请求形态

- `text`：object（`{}` = 焦点控件 + 选区），properties `focused` / `selection` / `document` / `selected`，共享 `max_text_chars` 预算；目标歧义时 `text_target`（ref 或精确选择器，二选一）。
- `ocr`：object（`{}` = 默认），properties `language`（BCP-47，默认系统显示语言）/ `max_lines`（默认 40，顶 200）/ `points`（默认 true，逐行带可点中心点）。schema 只暴露 object 形态；worker 兼容 bool/string 简写但不进契约。

### 回执字段（ocr 块）

`status` 恒 `'unverified'`、`verified` 恒 false（每行每词同）；`engine` = `windows.media.ocr`；`language` / `region{x,y,width,height}` / `downscaled` / `textFound` / `lineCount` / `truncated` / `elapsedMs`；`lines[]` 每行 `{text, verified:false, rect, point{x,y,level}|null, wordCount, words[]{text, verified:false, rect}}`。`reason` 仅失败时出现，前缀分型：`ocr engine unavailable:` | `ocr read failed:`，后面跟直述句。

### 保证与门控

- WinRT 延迟加载：没装 OCR 组件的系统只在第一次真用 OCR 时付出代价。
- 位图即读即弃，永不进 see 链、永不作为附件回给模型。
- 能力位门控：worker 发布 `ocr.observe`；宿主对无此位的 worker 拒带 ocr 的读（`[BAD_REQUEST]`，提示半升级重启或去掉参数）。隔离读 worker 发布同一份 capabilities，无需特判。
- digest 折叠：OCR 块进 state 的 digest（`digestOfOcr`），`unchanged` 不会对像素撒谎。
- 渲染：永远带 UNVERIFIED 字样；失败只说状态不装空；point 只在非 null 时出现；words 不渲染。
