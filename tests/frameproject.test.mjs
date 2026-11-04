/**
 * TODO 占位：frameproject 投影回归（方案「重构-0」范围内，precision P2-1 的前置回归网）。
 *
 * 任务书允许先写占位。真正落地时的形态（给接手者）：
 *   用 see 的 file 源（方案第 24 条：file 源活到测试骨架落地后转为 DSH_SEE_SOURCE_FILE
 *   环境变量后门）做**确定性喂帧**，对 frameproject 的投影结果做像素级对照；
 *   它是「优-P2-02 ToAbsolute 四舍五入」（02-native-code.ps1:484,493 截断取整改四舍五入）
 *   的前置：坐标原语改动前必须有这张网。
 *
 * 需要钉住的几何事实（落地时逐条换成断言）：
 *   - 帧内像素 (px,py) → 虚拟桌面坐标的投影：帧原点偏移 × 缩放比 × DPI，边界取整方向；
 *   - 守卫触发：FRAME_STALE（窗口移动 >阈值）、DPI_CHANGED、DISPLAY_TOPOLOGY_CHANGED、
 *     EXPIRED_FRAME（frame 不在登记表）、FRAME_REGION_OUTSIDE_WINDOW；
 *   - 缩放截图的坐标还原：信封倍数 × 图像坐标 = 屏幕坐标（failures.mjs 的 OUT_OF_BOUNDS
 *     提示承诺的换算方向）。
 *
 * 本文件独立可跑：node --test tests/frameproject.test.mjs
 */
import { test } from 'node:test';

test.todo('投影恒等：frame 未动时 像素坐标 → 屏幕坐标 → 回投影 等于原值（含取整方向）');
test.todo('ToAbsolute 四舍五入回归：亚像素输入的取整边界（0.5 向上）——优-P2-02 的靶心');
test.todo('FRAME_STALE：窗口位移超阈值后投影被拒并带 reobserve 判据');
test.todo('DPI_CHANGED / DISPLAY_TOPOLOGY_CHANGED：DPI 或显示器布局变化后投影被拒');
test.todo('EXPIRED_FRAME：不存在的 frame id 被拒并带 reobserve 判据');
test.todo('file 源确定性喂帧：同一帧序列两次喂入，投影结果逐点一致');
