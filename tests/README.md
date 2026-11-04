# vision-control 测试骨架（重构-0）

先于一切破坏性改动的安全网（方案第六节，refactor P0-2）。全部是**表征测试**
（characterization）：断言钉住的是当前实测行为，其中与源码注释不一致处在测试文件头
与 dev-tests 报告里标注。

## 运行

```powershell
node --test tests/                          # 全套（在 bundle 根目录）
node --test tests/see-cuts.test.mjs         # 每个文件独立可跑
```

无第三方依赖，只要 Node ≥ 20（node:test / mock timers / AbortSignal.any 均为内置）。

## 覆盖

| 文件 | 被测模块 | 钉什么 |
|---|---|---|
| `see-cuts.test.mjs` | `see/cuts.js` | 变化分边界值：首帧 null、同帧 0、黑↔白 85、环形色相、低饱和降权、hsv 缓冲复用 |
| `see-pack.test.mjs` | `see/pack.js` | **splitOneBin 单箱不变量**（80 条伪随机 + 定向序列：每段 solve 后 bins===1、保序、不丢帧）、solve/toRects 几何锚点 |
| `see-tiers.test.mjs` | `see/tiers.js` | 档位滞回（升档线/降档线/中间带双向保持）、密度窗严格下界、F=1/秒→4 档、F=4/秒→8 档 |
| `internal-failures.test.mjs` | `internal/failures.mjs` | FAILURE_RULES 全量样本串（顺序即优先级）、统一头 `[CODE · retry=X]`、幂等守卫、isIdempotentCall、withOutcomeNote |
| `internal-lease.test.mjs` | `internal/lease.mjs` | 租约生命周期：写执行期硬挡、空闲 10s 让位（mock Date）、拒绝文案两态、匿名会话 |
| `internal-execution.test.mjs` | `internal/execution.mjs` | combineSignals、describeCall、track/count/abort/stopping、runSessionCall 截止与中止传播 |
| `bridge-fake-child.test.mjs` | `backend/bridge.js` | TODO 占位：假 child 契约测试（共识 3 回归网，落地形态写在文件头） |
| `frameproject.test.mjs` | frameproject 投影 | TODO 占位：投影回归（precision P2-1 前置，file 源确定性喂帧） |

## 约定

- **并发施工期间**：其他代理正在改被测模块。测试红了先核对是不是契约被有意改动
  （尤其 failures 的 43 条规则表），是就同步样本表并记入报告；不是就是真回归。
- lease.mjs 是模块级单例：测试用 `import('../internal/lease.mjs?fresh=唯一标签')`
  拿全新实例，互不染指。重构-5 工厂化落地后改测 `createLease()`。
- 空闲过期用 `t.mock.timers.enable({ apis: ['Date'] })` 拨时钟，不真等 10 秒。
