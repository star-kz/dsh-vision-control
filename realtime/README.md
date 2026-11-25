# realtime/ — Node 实时控制面

本目录是实时视觉运行时的 Node 控制面：会话、授权、生命周期、租约、主动 heartbeat、状态、快照、回放与 trace 分页。帧和轨迹字节不逐帧经过 Node；控制面使用有界 JSONL stdio，慢环只按需读取 PNG 或有界 trace。

真实 .NET Worker 联调、公开九工具注册和原生发行资产均已完成。协议假 Worker 仍用于精确模拟乱序、断管、超时和异常事件，但不能替代真实采集或真实 HIL 验收。

## 模块

| 文件 | 职责 |
| --- | --- |
| `contracts.mjs` | 协议常量、纯校验、run/stop 记录、active 授权、HIL 目标与错误语义 |
| `worker-client.mjs` | Worker 启动、hello/welcome、请求关联、主动 heartbeat、超时/退出/断管处理；从不自动重启 |
| `controller.mjs` | 九命令编排、session/run 绑定、事件排序、deadline/terminal、active 互斥和独立释放 |
| `../tools/realtime.mjs` | 公开工具、宿主 session 固定、真实 Harness 验证、目标所有权和公开记录序列化 |
| `../tools/native-runtime.mjs` | bundled Worker/Harness 解析及 framework-dependent win-x64 发布 |

## 线协议

```text
worker → host : {"rt":"hello","protocol":1,"capabilities":[...]}
host  → worker: {"rt":"welcome","protocol":1}
host  → worker: {"rt":"req","id":"r-7","cmd":"run","args":{...}}
worker → host : {"rt":"res","id":"r-7","ok":true,"result":{...}}
worker → host : {"rt":"event","event":"state|heartbeat|terminal","runId":"...",
                 "eventSeq":8,"sourceEpoch":3,...}
```

- 单行按 UTF-8 字节限制为 256 KiB；大数据必须走文件/共享内存，不得放大控制行。
- 应答按 id 关联，允许乱序；请求写出后失败为 `dispatched=true`，结局未知，不自动盲重试。
- `eventSeq` 必须严格递增；`sourceEpoch` 是非负安全整数，允许相等但不得回落。幽灵 run、重复或过期事件不落账。
- 每个 run 使用 UUID，并绑定创建它的宿主 session；跨 session 操作返回 `STALE_RUN`。
- `run.target` 在入口复制并深冻结，授权、验证、互斥和派发共享同一不可变快照。

## 生命周期与停止

- `shadow` 默认只记录计划和回执；`replay` 永远离线，不能注入真实输入。
- `active` 每 1 秒由 Node 主动续租，Worker 约 5 秒未收到 heartbeat 会冻结输入。服务器 heartbeat 事件本身不等于续租。
- active 到期字段必须是且只能是 `expiresQpc` 或未来的 `expiresAtMs`；`deadlineMs` 为 1–86400000。
- 原生 `terminal` 是独立生命周期证据：只有 `stopped + released` 才解除租约；`stopped-unknown`、released-only 或矛盾证据继续保持互斥。
- stop 在已收到 terminal 后短路，不重复发送 estop；进程退出、断管或 heartbeat 失败进入独立释放/对账，不把 unknown 伪报为成功。
- `released`、`releaseConfirmed`、`estopAcked` 和 `leaseRevoked` 是不同证据，不能互相顶替。公开记录不暴露循环引用的 `heartbeatTimer`。

## 目标与写互斥

active 需要显式授权、独立 `Rt.Harness verify-target` 只读验证和 Worker 原生复核。当前真实输入只允许专用 `Rt.SynthWindow`。

原生 `hil-<hex>`、目标 `handle` 与 legacy 数字 `hwnd` 会归一为同一个精确所有权键。id/handle 不一致、非法 handle 或无法确定身份时采取保守互斥；未知 active 与已知 active 也不能在同一 session 并存。慢速写与 RT 写共用目标租约，不使用 legacy PowerShell release 清理 native 租约。

## 构建与验证

```powershell
npm test
npm run build:native
npm run pack:candidate:native

# 显式执行真实 published Worker → WGC/DXGI shadow → PNG/trace/deadline E2E
$env:RT_LIVE_CAPTURE = '1'
node --test tests/realtime-native-e2e.test.mjs

dotnet run -c Release --project rt/tests/Rt.Tests
```

完整证据与当前 tar 哈希见 `artifacts/verification-2026-11-07.json`；构建和使用说明见根目录 `REALTIME.md`。

## 已知限制

- 真实 HIL 在当前 Windows 会话被前台门禁阻断，键盘发送前均安全终止；没有真实连打/多键/长按的延迟分位数。
- Windows 某些断管写入会让本机 Node/libuv 直接退出，因此真实断管集成只断言平台实际结局；异步 write 错误另用注入测试覆盖，二者不混称。
- 控制面不是通用场景理解器；合成 4K 局部阶段数据不代表真实 4K 音游端到端性能。
- framework-dependent 发布需要目标机器安装 .NET 8 Desktop Runtime。
