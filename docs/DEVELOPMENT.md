# 开发与发布

## 结构

```text
src/main.mjs              Electron 主进程、窗口选择、加密配置、受限 IPC
src/preload.cjs           只暴露固定方法，不暴露通用 IPC 或 Node
src/core/provider.mjs    模型 / 转写兼容接口、取消、超时、错误处理
src/core/providers.mjs   服务商预设与配置就绪判断
src/core/chat-adapter.mjs OpenAI / Claude 请求与响应转换
src/core/local-cli.mjs   CLI 查找、npm 入口解析、各家协议适配
src/core/codex-cli.mjs   通用子进程取消 / 超时及兼容辅助函数
src/core/learning-session.mjs 会话绑定、增量事件与 API 完整消息
src/core/codex-session.mjs Codex 持久原生线程与恢复
src/core/claude-session.mjs Claude 原生 session 恢复与回执
src/core/pending-frames.mjs 待处理截图磁盘队列
src/core/i18n.mjs        中英文界面与受控错误本地化
src/core/context.mjs     上下文校验、提示词、来源编号
src/core/visual-memory.mjs 单任务读取、取消失效、笔记校验与检索
src/renderer/app.mjs     采集、按需转写、界面、IndexedDB
src/core/audio-buffer.mjs 音频采样环形缓存、PCM WAV 编码
src/renderer/rolling-audio.mjs 音频图与冻结快照
src/renderer/audio-worklet.mjs 音频线程采样，不依赖界面定时器
src/renderer/buffer.mjs  有容量限制的画面缓存和片段选择
src/renderer/format.mjs  禁用原始 HTML 的 Markdown 与 KaTeX
tests/                  核心 / 传输 / 桌面集成测试
```

没有额外 HTTP 后端。模型请求从 Electron 主进程发出。渲染器启用 sandbox、contextIsolation，禁用 nodeIntegration，设置 CSP，阻止外部导航和新窗口。

## 采集与时间

主进程通过 `desktopCapturer.getSources` 展示候选，用户选择后的一次 `getDisplayMedia` 请求取得该源。Windows 音频使用系统 loopback。

预览请求帧率是采集约束，不是有效帧率证明。画面观察使用 `requestVideoFrameCallback`，每秒至多尝试一次抽样，比较 160×90 缩略图像素变化；对比上次已入队的缩略图，两次采样至少间隔 30 秒；静止画面没有定时重发。缩略图仅在内存中用于变化检测。保留的图进入内存 FIFO，并按所属学习会话写入独立待图目录；确认落盘后才允许读图。读图串行执行，回答期间不生成笔记，但仍按同一间隔和变化门限继续采样。错误暂停、保存配置或切换会话时不采新图；1 秒是最小检测间隔，不是实际有效帧率。隐藏预览时另用定时器检查新解码帧。完整图片最大宽度 1600、JPEG 质量 0.85。

这种策略会漏掉一秒内的快速变化，也可能漏掉检测分辨率以下的细节。诊断中的 sampled / changed / duplicate 是抽样计数，不能解读为源视频有效 FPS。

会话时间在停止采集后暂停，继续采集时接续。它不跟随原视频的暂停、跳转、倍速变化。

## 历史对话

IndexedDB `deskmate` v3 用 `sessions` 保存会话正文、`sessionIndex` 保存列表摘要、`historyState` 保存当前会话 ID。旧版 `latest` 记录经验证后，在同一事务中迁移正文、索引和当前指针。v3 升级移除正文内的旧历史截图，索引包含搜索文本；空白新会话不显示在列表中。正文保存笔记、转写、聊天、草稿及已处理截图事件标记。待处理原图另存于 `userData/pending-frames/<sessionId>/`，模型绑定和 API 完整消息另存于 `userData/learning-sessions/<sessionId>/`；不能据正文的 `frames: []` 推断所有截图都不落盘。

内容变化后延迟 800 ms 自动保存，另有 10 秒补存。切换前取消当前回答并停止采集，等待当前会话保存成功，再切换指针、清理原始音频并恢复所选会话。保存失败时保留当前内容，不继续切换；新建学习不会删除旧记录。

## 后台画面理解

读取器一次只处理一张图，待处理图由内存 VisualFrameQueue 和主进程 PendingFrames 协作保管。磁盘记录包含原始 JPEG、窗口来源、相对时间和稳定事件编号，按会话隔离；通过临时文件写入和原子重命名确认保存。回答或慢读图期间继续采样并排队，回答完成、失败或取消后继续串行处理。内存队列最多 120 张、48 MiB（按图片字符串 UTF-16 估算）；满时保留已有图，提示暂缓新增采样。保存失败暂停新增截图并重试，损坏文件报错保留，不以读取失败为理由静默淘汰。

笔记完成后，先保存笔记及已处理事件标记，再删除对应待图文件；删除失败保留并重试。恢复时按稳定事件编号和已处理标记对账，避免已经保存的笔记再追加一次。暂停学习停止新截图和声音共享，已经保存的待图仍可继续补记；切换历史或重载时，内存队列切换为目标会话的磁盘队列，不把前一门课的图混入新会话。恢复待图不自动开启新的屏幕或声音采集，时间至少覆盖待图已有的相对时间。正常退出尝试等待渲染器保存与主进程写入收尾，失败明确提示；不承诺尚未确认写入的捕获或断电故障零丢失。

正常产品链路为每段学习保留一个模型会话：Codex / Claude 恢复对应的原生 ID，仅追加本次新增资料；普通 API 维护完整规范消息，按协议发送历史及新增输入。不会再挑最近 12+6 段笔记或最后 12 条聊天模拟另一个 CLI 会话。CLI 的自动上下文管理由自身负责；API 不因此拥有服务端持久线程或自动压缩。笔记、消息和转写完整保存，聊天列表按 60 条分批展开。

采集期间每次提问中断未完成的后台读图并让出生成顺序，立即冻结当前截图和音频末端，不受后台节流、去重或后台错误暂停限制。提问专属截图不先调用 model:analyze、不生成笔记；处理本次音频后将图片与问题放入同一个 model:ask。普通转写失败会提示并继续依据图片和已有资料回答；主动取消、切会话与退出仍中止旧问题。迟到结果按请求 ID 和会话代次丢弃。提问图片可能随模型会话保留；暂停后不额外截取桌面。

## 最近两分钟音频

采集音轨连接 AudioContext（请求 16 kHz，由音频引擎重采样）与 AudioWorklet，按实际输入的采样点写入 120 秒单声道环形缓存。工作线程不输出声音，避免系统回采。缓存以运行时 sampleRate 分配，不使用定时器切段，不拼接不可独立解码的 MediaRecorder 分块。

提问时冻结一次快照，只对最近 120 秒缓存中尚未处理的采样区间编码为完整的 16-bit PCM WAV。默认经 `local-speech.mjs` 启动独立的内置 Python 子进程，使用 Qwen3-ASR 0.6B INT4/Q4_K：DirectML 编码器、Vulkan 解码器，显卡不可用时结束旧子进程并使用同一模型的 CPU 模式。父子进程均验证 16 kHz 单声道 PCM16 格式和两分钟上限；不将原始音频写入文件。开始实际音频采集后预热，90 秒超时、取消及退出均终止工作进程，空闲 60 秒释放模型。Windows x64 资源通过固定 SHA-256 准备并内置，无需用户另装 Python；非 Windows 平台尚未提供本地转写运行时。

`transcription.useSelectedModel` 默认为 false，旧配置迁移也默认本地。明确勾选后才查询当前所选模型的音频能力，按该模型的 chat input_audio 或 audio/transcriptions 路由处理，不再选择目录中其他 ASR 模型。保存时也验证能力；地址、密钥、模型或连接方式改变会清除旧选择。元数据未声明能力时隐藏选项，不凭服务商名称推测；能力结果缓存 5 分钟，按地址、密钥和模型隔离。CLI 与 Anthropic Messages 使用本地转写。停止不触发转写；成功转写后推进准备游标并保留待提交文字，模型接收回执按转写事件编号去重。转写失败不推进准备游标，后续仍可处理缓存内保留的区间；取消问题同时取消转写，并用问题 ID 和会话代次丢弃晚到结果。每条录音流有独立 UUID，重启后不会把新录音误当作旧采样位置。IndexedDB 仅保存转写文字。

`npm run prepare:speech` 下载并验证固定 SHA-256 的模型资源；开发启动和打包前自动执行。下载可复用 `.local/qwen-downloads` 与本机已有基准资源，但仍校验摘要；`NEKOMATE_DOWNLOAD_PROXY` 仅用于构建下载代理。安装包包含模型与原生库，用户无需另行配置；运行时及模型保存在 `.local/qwen-speech`，Windows 打包通过 `extraResources` 复制为 `resources/qwen-speech`，不依赖 asarUnpack。第三方许可证与来源说明在 `assets/licenses`，其中 `Qwen-GGUF-NOTICE.txt` 记录推理实现授权查验的事实。推理实现从固定版本源码包下载并核对 SHA-256，再应用本项目的小补丁；上游实现源码不直接纳入 Git。单元测试覆盖取消、超时、空闲释放及默认无网络；桌面测试覆盖勾选持久化、模型切换和真实音频经 IPC 转成问答上下文（真实样本测试需本地基准样本）。

桌面音频测试包含约 130 秒实时合成音源，检查最终上传样本的时长、过期频率消失、最新频率保留及请求先后顺序；这不证明真实老师语音的系统 loopback 或外部模型识别质量。

## 本地开发

```bash
npm ci
npm start
npm test
npm run check
npm run test:desktop
```

普通桌面测试使用明确标记的合成画面和本机模拟 API；不需要真实密钥。它验证 IPC、模型请求内容、界面和持久化，不验证模型理解能力。

在具有交互桌面的 Windows 上可运行真实窗口采集夹具测试（只捕获测试自己创建的窗口）：

```powershell
$env:RUN_CAPTURE_TEST = '1'
npm run test:desktop
```

`DESKMATE_ELECTRON_PATH` 可指定测试运行时，用于开发排障；正常测试和 CI 使用锁定的 Electron。正式发布必须以锁定版本通过构建及桌面测试为准。

生成图标只在修改图标时需要 Python + Pillow；图标成品已提交，普通开发和用户运行不需要 Python。

## 构建与发布

```bash
npm run dist:win
```

产物在 `release/`。当前 Windows 构建未配置商业签名。macOS 和 Linux 构建命令仅作为开发入口，跨平台运行需要各平台测试；macOS 分发还需要签名及公证。

GitHub Actions：

- push / PR：准备固定依赖，运行单元测试和桌面合成输入测试。默认不上传包含 Qwen GGUF 推理实现的 Windows 安装包。
- 维护者核实该实现的适用再分发授权后，才可设置仓库变量 `ALLOW_QWEN_BINARY_REDISTRIBUTION=true` 开启二进制构建上传；推送 `v*` 标签仍须通过相同检查与此发布门限，才发布安装包及 SHA256 校验文件。
- 本项目 MIT 只覆盖自有代码。Qwen 模型的 Apache-2.0 不能用来断定 HaujetZhao 推理实现的许可；已检查固定版本未发现独立 LICENSE 或明确再分发许可，见 `assets/licenses/Qwen-GGUF-NOTICE.txt`。下载、校验摘要或开启工作流变量均不等于取得第三方授权。
- 不需要在仓库 Secrets 中配置任何模型 API Key。

发布前更新 package.json / package-lock.json 版本及 CHANGELOG，然后：

```bash
git tag v0.1.0
git push origin main
git push origin v0.1.0
```

发布 workflow 使用仓库内置 `GITHUB_TOKEN`，仅发布步骤具有 contents:write 权限。如果仓库规则禁止工作流发布，需要维护者调整对应规则。不要把开发配置、学习记录、`.local/`、`node_modules/` 或安装包提交进 Git。

## 流式回答

API 使用 OpenAI Chat Completions / Claude Messages SSE；Codex 使用 app-server 的 agentMessage delta，Claude Code 使用 include-partial-messages。主进程按请求 ID 转发到 renderer，renderer 丢弃非当前请求的事件；结束后渲染 Markdown，取消保留中断标记。读取图片仍使用单次完整返回。API 传输由主进程注入 defaultSession.fetch，目录、读图、问答与转写共同使用系统会话代理；JSON 与 SSE 均检查截断、长度、取消和超时。

模型列表采取保守筛选：明确的能力元数据优先，其次使用 model-capabilities.mjs 的文档规则；未知能力隐藏，不自动发起收费探测。目录筛选不验证账户权限。


课程背景由 `src/core/course-context.mjs` 管理，每段对话最多启动一次集中识别：复用初期正常读图或提问产生的截图，最多 3 张不同 JPEG；首张样本后 30 个采集秒仍未满时提交已有样本。普通后台读图无需等待背景完成。截图不入库，只保存 `courseContext: { text, attempted }`，文字上限 6000 字。该字段作为用户资料注入后续笔记和答疑，不提升为系统指令。恢复历史复用结果，新对话清空；暂停、切换会话和修改连接使待完成结果失效。失败或取消保留 attempted，避免后续每帧反复重试。旧记录没有字段时按尚未识别处理。

只有 `identifyCourse` 向模型完成器传入 `allowWeb: true`。正常笔记、答疑、转写与目录查询不提供联网工具：Codex 在启动参数及 thread/start 里禁用 web_search；Claude 的工具列表为空；DeepSeek 不附带函数工具。背景阶段保持此前的 CLI 工具隔离及 DeepSeek 有界调用链。其他 API 只能归纳可见背景，提示词明确声明没有联网能力。
