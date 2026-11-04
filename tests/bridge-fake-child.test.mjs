/**
 * TODO 占位：backend/bridge.js 假 child 契约测试（方案「重构-0」范围内的共识 3 回归网）。
 *
 * 任务书允许先写占位。真正落地时的形态（给接手者）：
 *   用 `node:child_process` 起一个**假的 worker**（几行 node 脚本，按 JSONL 协议应答），
 *   塞进 PowerShellBackend 的 spawn 通道（或经环境变量/构造参数换脚本路径），
 *   断言传输层契约而不碰真 PowerShell。worker 协议事实见重构-4 的 docs/worker-protocol.md。
 *
 * 本文件独立可跑：node --test tests/bridge-fake-child.test.mjs
 */
import { test } from 'node:test';

test.todo('假 child 握手：启动 → 收到 ready → 收到 STEP_ACTION_LIST 并与宿主清单逐字比对（顺序即契约）');
test.todo('请求/响应按 id 配对：并发两请求、响应乱序返回，各自落到正确的等待者');
test.todo('错误包络 → ComputerUseBackendError：code 透传、message 进后端文案分支');
test.todo('已派发失败置 dispatched=true（withOutcomeNote 赖此分叉）：假 child 收到请求后死掉');
test.todo('未派发失败 dispatched=false：假 child 在握手前退出（SPAWN_FAILED/WORKER_EXITED）');
test.todo('WORKER_EXITED 两态：启动阶段退出（"did not start"）vs 服务中退出 → backendMessage 两种文案');
test.todo('TIMEOUT：假 child 装死超过 defaultTimeoutMs → 传输层杀进程、报错、下一次调用自动重启');
test.todo('取消通道：写 cancel flag 文件 → 假 child 的批处理在步骤边界停下（配合 execution.mjs 的 abort）');
test.todo('§6 第 4 条：强杀持有输入的假 child → 独立 release-input 进程释放，releaseConfirmed 进错误文案');
test.todo('释放确认三态：releaseConfirmed true/false/缺失 → backendMessage 三种措辞（宿主侧已测，这里测端到端）');
