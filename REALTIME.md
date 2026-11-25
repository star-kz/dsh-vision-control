# Realtime Vision Runtime

本分支把“模型余光”和“原生快速反射环”分开：现有 `computer_watch`、UIA/OCR、截图与慢速工具继续负责语义理解；新的 .NET 8 Worker 负责连续采集、有界 latest-frame、可插拔场景感知、跟踪/预测、有限策略、QPC 调度、trace 和安全停止。**LLM 不在逐帧硬实时路径上。**

## 架构

```text
WGC / DXGI / replay
        │  latest-frame（有界、丢弃旧帧）
        ▼
SceneDescriptor → Perceptor → Tracker/Predictor → bounded Policy
        │                                             │
        └──── epoch / runId / eventSeq / trace        ▼
                                             QPC Scheduler
                                                    │
                                      shadow recorder 或 HIL dispatcher
                                                    │
                                      独立 Safety / ownership / release
```

- `Rt.Core`：时钟、帧环、回放、技能、调度、trace、运行协调；不依赖 NuGet。
- `Rt.Windows`：WGC/DXGI、物理坐标、Win32 观察和 `SendInput` 隔离。
- `Rt.Adapters.Rhythm`：描述符驱动的 BGRA 连通域、跟踪、预测和 tap/hold/chord 示例；**不是通用 AI，也不是任意音游即插即用**。
- `Rt.Worker`：有界行 JSON **控制面**。逐帧 BGRA 不进入 Node/PowerShell，也不逐帧序列化 JSON。
- `Rt.SynthWindow`/`Rt.Harness`：自建硬件在环窗口、ground truth、对账与只读目标验证。

## 构建与发布

前置条件：Windows x64、Node ≥20、.NET 8 Desktop Runtime；开发构建需要 .NET 8 SDK 和 Windows SDK。发布为 framework-dependent `win-x64`，目标机器仍需 .NET 8 Desktop Runtime。

```powershell
npm test
npm run build:native
npm run pack:candidate
# 或一条命令：
npm run pack:candidate:native
```

原生资产输出到 `native/win-x64/{worker,synth,harness}`。也可用 `realtime.workerPath` 或 `DSH_RT_WORKER_PATH` 显式指定 Worker；默认参数为 `--stdio`。没有真实 Worker 时工具明确返回 `RT_WORKER_NOT_CONFIGURED`，不伪造 shadow 成功。

## 2.0 三态权限

- `disabled`（禁止线性图标）：实时工具不进入模型 schema，动态电脑提示为空，固定 skill 不自动进入模型目录；直接调用仍返回 `[NOT_AUTHORIZED]`。
- `watch`（眼睛线性图标）：允许 targets/validate/calibrate/status/stop/snapshot/trace、shadow run 和 replay；`realtime_run(mode:"active")` 返回 `[CONTROL_REQUIRED]`。
- `control`（电脑线性图标）：开放完整工作流，但 active 仍必须满足下述专用 HIL、目标级授权和独立原生验证，不等于可以控制任意窗口。

## 九个公开工具

`realtime_targets`、`realtime_skill_validate`、`realtime_calibrate`、`realtime_run`、`realtime_status`、`realtime_stop`、`realtime_snapshot`、`realtime_replay`、`realtime_trace_read`。

没有公开逐帧事件/附件工具；慢环只按需获取有界 PNG 快照或 trace 分页。回放永远是离线 `replay`，不会注入真实输入。

## Shadow 与 active

默认使用 `shadow`：采集、感知、计划和调度可运行，但输入只记录、不进入操作系统。

`active` 不是“把 computer chip 打开”即可获得。它同时要求：

1. 显式 `authorization.granted === true`，且 `authorization.targetId` 与本次目标完全一致；
2. 目标是自建 `Rt.SynthWindow`，提供当前 `hwnd/processId/title`，标题含专用 magic；
3. Node 通过独立 `Rt.Harness verify-target` 只读核验原生事实；
4. Worker 和每次输入前后再次检查 HWND、PID、进程名、标题、前台、可见性、bounds、授权、heartbeat、epoch、deadline 和控制白名单；
5. active 对同一目标互斥，慢速写与 RT 写互斥；停止、revoke、dispose 和断管进入释放/对账流程。

active 控制面默认每 1 秒发送一次 session heartbeat；Worker 原生侧超过约 5 秒未续约会冻结输入。续租失败会停止后续 heartbeat、把 run 记为 `unknown` 并走独立释放路径，不会盲目重试。服务器 heartbeat 事件只证明传输存活，不能替代主动续租。

active `authorization` 必须与 `target.id` 匹配且 `granted: true`，并提供且只提供一个有效到期字段：`expiresQpc`（与 Worker 时钟域一致的正整数 tick）或 `expiresAtMs`（未来的 Unix epoch 毫秒）。`deadlineMs` 为 1–86400000 的整数。Node 只转发 `expiresQpc`，不能用它声称不同机器的 QPC 已对齐。原生 terminal 只有在 clean stop 且 `released: true` 时才解除 Node 侧 active 租约；`stopped-unknown` 或相互矛盾的证据继续保持互斥。

native 调用前拒绝为 `NotDispatched`；调用后异常、部分插入或后置观察失败为 `Unknown`，**不把 unknown 伪报为已执行或已释放，也不盲目重试非幂等动作**。

## 验证与已知边界

- WGC/DXGI 真实采集、离线回放、调度、安全门和协议测试分别验收；合成测试绿不等于真实桌面输入成功。
- 4K 音游数据只代表特定合成场景的局部阶段测量，不包含 capture、显示、调度或驱动；120 Hz 下曾出现 P99 超出 8.33 ms，不能宣称端到端达标。
- 真实 HIL 需要合适的交互式 Windows 桌面和前台目标。当前会话曾多次在键盘输入前被 Windows 前台门禁阻断，因此没有真实连打/多键/长按/抢焦/kill 的延迟分位数。
- 原始采集故障时段有 NVIDIA `nvlddmkm Event 153`，后续压力复现未再出现；不能宣称所有 GPU/驱动组合稳定，也不能把某一复制 API 当成已证根因。
- 受控硬件拔出、多显示器/HDR 元数据、任意第三方窗口 active、通用场景模型均未验收。
