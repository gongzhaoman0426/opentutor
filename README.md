# OpenTutor

开源 Markdown 视频工作室：在网页中导入 Markdown，使用 Codex harness 生成视频 DSL、讲稿与分镜，通过微软 Edge 免费语音生成配音，再以 Remotion 导出带字幕的 MP4。初版不包含数字人或 VTuber。

适合产品介绍、信息汇报、观点分享、故事叙述、知识讲解等图文视频。默认自动判断表达方式；视频用途预设和自由创作要求用于指定结构、语气与节奏，画面风格单独控制配色。无需将内容改写成教学讲义。

## 本地启动

需要 Node.js 24、Docker、FFmpeg（包含 `ffprobe`）、Python 3.10+ 和 `uv`。首次渲染会下载 Remotion 使用的 Chrome Headless Shell。

```sh
npm ci
cp .env.example .env
npm run infra:up
npm run speech:setup
codex login
npm run dev
```

打开 **http://127.0.0.1:3330**。`dev` 初始化数据库并同时启动网页与独立 Worker，关闭开发进程会停止两者。没有 `uv` 时，可以用 `python3 -m venv .venv` 与 `.venv/bin/pip install -r requirements.txt` 安装语音依赖。

已有 Codex 登录可以供个人本地运行使用。指定已有运行时，在 `.env` 设置 `CODEX_PATH` 为其绝对路径；模型默认沿用 Codex 配置，也可以通过 `CODEX_MODEL` 明确指定。部署服务时请配置服务自己的模型访问凭证，避免挂载个人完整工作目录。

如果终端不能直接访问模型服务，在 `.env` 设置 `CODEX_PROXY_URL` 为已有代理地址，例如 `http://127.0.0.1:7890`。它只作用于 Codex 子进程；程序不会修改系统代理或全局 Codex 配置。

## 制作流程

1. 主页输入项目名称创建项目，进入单屏编辑页。
2. 左侧管理章节，中间按章编写或导入 Markdown；上传、拖入或粘贴图片后自动插入稳定素材引用。
3. 右侧“Markdown”预览文稿与图片。点击“生成视频”打开本章设置，可选视频用途、目标受众与创作要求，以及分辨率、微软音色、画面风格、Codex 模型和稳定／创作模式。
4. 确认“生成本章视频”后，系统自动完成图片理解、章节编排、校验、微软配音和时间轴。一个章节生成一个独立视频；切换章节时，预览与下载同步切换。
5. 点击“下载视频”才开始当前章节的 MP4 渲染；相同输入已有成片时直接下载。修改本章保留旧预览，编辑其他章节不会让本章视频失效。

生成预览不编码 MP4。底层独立编排、配音、局部重生成和导出接口继续保留。详细交互见[工作台设计](docs/workbench-design.md)。

稳定模式只使用文字、代码、公式、表格、图片和分步关系等预设组件。创作模式允许 AI 编写动态图形 JavaScript，按视频帧生成 SVG，用于图表、运动和过程演示；代码在有时间和内存上限的 QuickJS 环境中执行，不能访问宿主 DOM、网络或文件。设置中的组件库可播放全部组件与布局示例。

新建项目默认面向普通观众，视频用途为“自动判断”。旧项目继续保留原受众、参数、文稿与成片；新增字段的默认值不会使旧章节视频过期。改变用途或创作要求会更新当前章的输入版本，需要重新生成该章视频。

模型下拉来自本机 Codex `model/list` 目录；目录可能有缓存，并不保证每个型号都对当前账号开放，实际生成时验证访问。选择“服务端默认”时沿用已配置模型。

图片通过 `asset://UUID` 引用，AI 接收实际图片像素及章节上下文。画面可展示原图、聚焦区域和高亮；缺失或歧义引用会报告错误。图片分析和章节结果按内容与版本缓存，未变化的配音也可复用。

微软配音使用 `edge-tts`，无需 TTS API key。它依赖在线服务；失败时显示阶段和原因，支持重试。模型生成不使用模拟数据替代真实输出。

## 运行结构

```text
app/                       Next.js 网页与 API
src/components/            工作室、导入设置、编辑器
src/shared/                DSL Schema、Markdown 来源索引、检查
src/server/                PostgreSQL、BullMQ、认证、工件与历史
src/engine/                Codex、Edge TTS、缓存、生成流水线
src/worker/                队列消费、租约、取消与恢复
src/video/                 预览与导出共用的 Remotion 场景、时间轴
scripts/speech_bridge.py   Python Edge TTS 桥接
tests/                     单元、数据库集成与浏览器检查
docs/                      产品需求、技术方案与实现状态
```

PostgreSQL 是任务与项目状态的来源，Redis 负责调度。提交任务与 outbox 记录在同一事务中保存，Worker 重试投递；数据库租约和提交令牌防止失效 Worker 发布结果。导出使用冻结的项目快照，后台晚到的结果保存在历史中，不会覆盖作者更新的版本。

首版使用本地工件存储 `.data/`，Web 与 Worker 共享该目录；音视频经注册的工件 ID 和受保护 API 读取，支持字节范围请求。数据库、Redis、工件目录需要一起保留。S3 兼容存储属于后续部署扩展。

默认监听回环地址，采用个人自托管模式。需要远程访问时先设置 `AUTH_TOKEN`，网页会要求输入访问令牌并建立 HttpOnly 会话；生产入口应由 HTTPS 反向代理提供。目前没有多租户账号、团队权限或托管计费系统。

## 配置

| 配置 | 用途 |
| --- | --- |
| `PORT` | 网页端口，默认 3330 |
| `DATABASE_URL` / `REDIS_URL` | 持久化与队列地址 |
| `OPENTUTOR_DATA_DIR` | Web 与 Worker 共享的工件目录 |
| `PYTHON_PATH` | 已安装 `edge-tts` 的 Python，默认 `.venv/bin/python` |
| `AUTH_TOKEN` | 远程访问令牌；本地回环模式可留空 |
| `CODEX_PATH` / `CODEX_MODEL` | 可选的 Codex 运行时与模型 |
| `CODEX_REASONING_EFFORT` | 视频生成的推理强度，默认 `medium`，不继承桌面 Codex 的超高推理配置 |
| `CODEX_API_KEY` / `CODEX_BASE_URL` | 可选的服务模型访问配置 |
| `CODEX_PROXY_URL` | 只供 Codex 使用的已有代理 |
| `CODEX_TIMEOUT_MS` | 每次 Codex 调用时限，默认 240000 ms |
| `JOB_TIMEOUT_MS` | 单个后台任务时限，默认一小时 |
| `WORKER_CONCURRENCY` | 同时运行的项目任务数，默认 1 |
| `RENDER_CONCURRENCY` | 每项导出的并行绘帧页数；留空按 CPU、内存与 Worker 数自动分配，最多 8 路。可设正整数，最高不超过可用 CPU 数 |
| `RENDER_GL` | 默认 `auto`，由 Chrome 选择绘图后端；需要强制软件绘图时设为 `swangle` |

长章节按小批编排，创作模式采用更小的正文预算，并限制每批画面数量。每批通过校验后立即保存并更新预览；单批超时会自动拆小重试。重新提交同一章节时复用已验证的批次，不需要删减文稿。单次调用和整项任务仍受上述时间上限控制。

首次下载需要把完整时间轴逐帧绘制并编码：例如 16 分钟、30 fps 的视频约有 28,800 帧，浏览器预览可以实时播放并不代表 MP4 已经生成。导出状态显示实际完成的画面帧数、平均绘制速度、耗时，以及后续编码和合成阶段；画面帧数全部完成后仍需等待文件发布。相同版本再次下载复用已有成片。提高 `RENDER_CONCURRENCY` 可能增加内存与 CPU 占用，应按机器实测调整；Worker 配置在重启后生效。

## 验证与生产构建

```sh
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run build
```

数据库集成测试使用独立 PostgreSQL schema 和 Redis 队列，结束后清理，不改用户项目。浏览器测试需要已启动的应用；首次执行先运行 `npx playwright install chromium`。常规测试不会调用模型或在线配音。

`node --import tsx --env-file=.env scripts/smoke-media.ts` 可验证真实 Edge 语音、时间轴和 MP4 编码，结果保存到 `.data/verification/`。这个检查使用明确手写的教学场景，仅用于媒体链路验证。

`node --import tsx --env-file=.env scripts/smoke-chapters.ts` 使用独立测试项目验证真实图片识别、章节编排、微软配音、无需 MP4 的预览和下载渲染，结束后清理项目。它会实际调用已配置的 Codex 和微软在线服务，报告保存到 `.data/verification/chapter-smoke-report.json`。

`node --import tsx --env-file=.env scripts/smoke-chapter-settings.ts` 验证章节输出隔离、不同音色与分辨率、稳定模式、真实 AI 自定义组件、修改其他章节后继续导出本章。报告与 MP4 保存到 `.data/verification/`；会调用真实模型和语音服务。

已有 `scripts/smoke-app.ts` 创建的勾股定理项目时，`scripts/smoke-workbench.ts` 可额外验证独立编排、作者修改、配音和导出接口；它同样可能实际调用 Codex，不能假设跨项目复用模型缓存。

生产构建后分别运行 `npm start` 和 `npm run worker`，并保留 PostgreSQL、Redis 及共享工件目录。请通过 `.env` 或服务环境传递 Worker 配置；`npm start` 的监听端口可设置 `PORT` 环境变量。

## 当前能力边界

支持任何适合图文与旁白表达的 Markdown 视频，包括产品介绍、信息汇报、观点分享、故事叙述和知识讲解。基础画面包括文字、公式、代码快照、表格、图片与分步关系说明。创作模式可生成动态 SVG 图解与过程演示，但不保证任意专用仿真的正确性；稳定模式采用预设组件。外部图片需要上传；文稿中的 HTML、脚本或代码不会直接执行。

结构、来源覆盖、引用和基础内容密度由程序检查；事实准确性、叙事忠实度与新增内容仍需作者审阅。容量和内容质量尚需真实项目试用，不能由少量链路测试推导普遍成功率。具体实现与剩余范围见 [实现状态](docs/implementation-status.md)。

核心代码许可证待项目方确定。Remotion 有独立许可条件，发布与部署应按实际用途遵守其条款；相关来源保留在 [技术方案](docs/technical-design.md)。

- [产品需求](docs/product-requirements.md)
- [技术方案](docs/technical-design.md)
- [Codex SDK 官方文档](https://learn.chatgpt.com/docs/codex-sdk)
- [Edge TTS 接入项目](https://github.com/rany2/edge-tts)
- [Remotion Renderer](https://www.remotion.dev/docs/renderer/render-media)
