# DSH-Vision-Control

**中文 | [English](README_EN.md)**

**实时视觉感知 + 精确桌面操控** —— 一个 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 插件，给 AI 一双眼睛和一双手。

`@k-launcher/dsh-vision-control` · v1.0.0 · Windows · PolyForm Noncommercial 1.0.0

---
## 核心目的
   为了解决当前大多数AI反应迟钝+耗token的问题
---
## 它能做什么

| 能力 | 说明 |
|---|---|
| 👁 **实时盯屏** | `computer_watch` 阻塞式盯屏：画面一变就出图，静止时几乎不花 token |
| 🔍 **精度阅读** | `quality:"high"` 半秒内给一张 1280×720 锐帧，文件名级可读 |
| 🖱 **免截图操作** | UIA 直接读控件树报坐标/名字/状态，点按钮不花一张图 |
| ⚡ **批量动作** | `computer_actions` 一次调用打完「点击 → 输入 → 回车 → 截图」整套 |
| ⏳ **条件等待** | `wait_for` 后端轮询「窗口出现 / 文字出现 / 画面稳定」，零 token |
| 🛑 **安全刹车** | 芯片一键收回授权；`computer_stop` 松开卡住的键鼠并可禁用能力 |
| 🚀 **干净启动** | `app_launch` 起 GUI 程序不受 Electron/Node 环境变量污染 |
| 📦 **输出压缩** | token-guard 把超长 shell 输出压成摘要，原文落盘可查 |

## 安装

需要 DeepSeek Harness ≥ 0.2.1-rc.2（desktop profile，Windows）。

在 DSH 插件管理中直接从 GitHub 安装：

```
github:star-kz/dsh-vision-control
```

或指定发布版本：

```
github:star-kz/dsh-vision-control#v1.0.0
```

> **依赖**：实时感知（`computer_watch`）需要系统里有 `ffmpeg`（支持 `ddagrab` 的构建）。
> 放进 PATH 即可；也可以设置环境变量 `DSH_FFMPEG_PATH` 指到 `ffmpeg.exe`。
> 没有 ffmpeg 时其余 15 个操控工具不受影响。

## 快速上手

### 0. 给 AI 装上使用教程（推荐）

本插件附带一个 **skill**（[skills/dsh-vision-control/SKILL.md](skills/dsh-vision-control/SKILL.md)），是一份写给 AI 的标准使用教程：工具族速览、看→定位→动→确认工作流、参数配方、故障速查。装入后 AI 在遇到桌面任务时会自动按最佳实践调用本插件，而不是边试边错。

安装方法：把 `skills/dsh-vision-control/` 整个目录复制到用户目录的 `.dsh\skills\` 下（如 `C:\Users\<你>\.dsh\skills\dsh-vision-control\`），新会话即可在技能目录中看到 `dsh-vision-control`。

### 1. 开启授权（每次会话一次）

在输入框工具栏找到**电脑图标按钮**（💻），点一下：

- 图标亮起 = 已授权，本会话内 AI 可以截图、看屏、动鼠标键盘、操作窗口。
- 再点一下 = 收回授权，所有 `computer_*` 工具立即拒绝执行。
- 鼠标悬停显示当前状态（已开启 / 已关闭 / 执行中 / 停止中…）。

授权是**会话级**的：新会话默认关闭。子代理（subagent）永远没有这项授权，只有主会话能操作电脑。

### 2. 直接下命令

- 「打开浏览器访问 xxx，帮我点一下登录」
- 「盯着屏幕，等我运行的程序出现错误就告诉我」
- 「把这个窗口截个图，读一下上面的表格」

AI 会自己决定用哪只「眼睛」、哪只「手」：

| 需求 | 它会用 | 成本 |
|---|---|---|
| 实时盯屏（等变化、守进度） | `computer_watch`（余光） | 静止时约 0 token |
| 精读画面（读小字、确认细节） | `computer_screenshot`（定睛看） | 一次性一张图 |
| 操作界面元素（按钮/输入框/菜单） | `computer_ui`（UIA 控件树） | **0 图** |

### 3. `computer_watch` 常用参数

- `watch`（默认）/ `peek` / `status` / `stop`
- `quality`：`low`（800×450，≈218 token/张）→ `standard` → `high`（文件名可认）→ `ultra`（接近原屏）。**读不清就升档**。
- `pace`：`calm`（省钱）/ `normal`（默认）/ `dense`（灵敏，操作电脑时推荐）
- `minFrames`：少于 N 帧不返回（静止屏幕调它省 token）

## 它是怎么实现的

插件分三层：**授权闸门 → 操控层 → 感知层**。

**授权闸门（requireGrant）**：所有 `computer_*` 工具第一行过闸门——芯片没开，一个像素都不会动；子代理一律拒绝。

**操控层**：16 个工具逐个安全注册（单工具失败不拖垮整插件）；执行后端是一个 PowerShell 工作进程（UIA 控件树、SendInput 键鼠合成、截图、窗口枚举），Node 端通过管道收发 JSON 指令。UIA 优先：能 `Invoke` 的控件绝不合成鼠标事件。

**感知层**（`see/` 目录）的实时管线：

```
ffmpeg ddagrab 抓屏 (800×450@12fps 单根管道)
   ↓  每帧算 HSV 变化分 → 尖峰判定选出"值得留"的画面
   ↓  按留帧密度在 8 个档位间升降，决定拼几格
   ↓  单箱 DP 装箱 → 拼格烧帧号 → 纯 JS PNG 编码（零依赖）
   ↓  调度：冷启动 eager 首帧、阻塞 watch 队列、静止节流
computer_watch 工具返回拼图附件
```

**为什么省 token**：静止屏幕一帧不留、一张图不出；画面越动帧越多。单张 low 档拼图 ≈218 token，约等于一段长文本。

## 目录结构

```
├── index.js            主机端入口：注册工具、闸门、worker 管理
├── client.js           浏览器端：工具栏电脑图标芯片（图标+状态点）
├── cordis.patch.yml    插件行定义 + tokenGuard/appLaunch 配置
├── backend/            PowerShell 执行后端（worker.ps1）
├── internal/           工具契约、worker 协议、降级报告
├── browser/            浏览器通道（browser_state / browser_actions）
├── see/                实时感知层（采集→留帧→装箱→拼图→注册）
└── skills/             AI 使用教程 skill（dsh-vision-control）
```

## 实测指标

抓屏首帧 ~370ms（ddagrab）/ 0.28 核 CPU；冷启动首图 ≤3 秒；阻塞上限 860 秒内必定返回（早于宿主 900 秒工具超时）。

## License

本项目整体以 **PolyForm Noncommercial 1.0.0** 发布（见 [LICENSE](LICENSE)）——个人与非商业使用免费，商用需授权。

参考/感谢
-  [dsh-computer-use](https://github.com/LJL454/dsh-computer-use) v1.40.3（© LJL454，MIT，见 [LICENSE-MIT](LICENSE-MIT)）
-  [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now) v0.0.3（© SAOS-3624，PolyForm Noncommercial，已获作者授权），移除了悬浮窗/语音旁白/后台唤醒

详见 [NOTICE](NOTICE)。
