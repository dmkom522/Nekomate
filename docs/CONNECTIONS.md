# 连接模型服务

设置页先选服务商，再展开对应连接配置。DeepSeek 直接连接自己的 API；其他服务可选择 API 或本机 CLI。画面读取和问答共用当前学习会话；语音默认由内置 Qwen 在本机转写，仅在提问时处理最近 120 秒缓存中尚未处理的部分，不需要额外 API。

## API

OpenAI、DeepSeek 使用各自的 OpenAI 兼容入口，Claude 使用原生 Messages。其他服务可选择这两种协议之一，填入兼容地址。填写地址与密钥后自动读取模型列表，在下拉框中选择模型，也可点击“刷新模型”。如果当前图片模型确认支持音频输入或转写接口，设置页显示“使用所选模型转写音频”，默认不勾选。主动勾选并保存后才将音频交给该模型，复用当前地址和密钥，不改用目录里其他转写模型。切换模型或连接后恢复默认本地。

不自动把一个服务的密钥带到另一个服务；切换服务商或地址后请填写对应密钥。没有密钥的本机服务允许留空。远程服务要求 HTTPS，本机 localhost / 127.0.0.1 支持 HTTP。

目录、读图、问答及可选云端转写使用 Electron 默认系统会话的 fetch，沿用系统代理；不修改系统代理设置。本地转写不访问网络。JSON 和流式回答都检查输出上限、未完成状态与响应大小，取消在读取正文期间仍生效，不把被截断的文字当作完整成功结果。

## 一段学习的上下文

点击 **开始新的学习** 才建立新的模型对话。自动读图、初期课程检索、提问时新增的转写和用户问题都追加到这一段学习中；后台消息不展示为普通聊天气泡，但仍属于同一上下文。已被接收的图片或转写不再次作为新增资料提交。

Codex 使用固定的持久原生 thread ID，Claude Code 使用固定 session ID。切换历史或重启后恢复绑定的原生会话；连接、账户不匹配或原生记录无法恢复时会报错，不自动创建替代会话。CLI 进程可以退出或重启，原生会话身份不因此改变。没有模型绑定的旧版历史只可查看，需点击 **开始新的学习** 才能继续使用模型。

普通 Chat Completions / Messages API 没有因此获得服务器持久线程。应用为每段学习保留完整的规范消息序列，每次按协议发送已有消息及本次新增内容，而不是挑选最近 12 段笔记重组上下文。历史消息可能包含图片并再次随请求传输；这与把同一转写反复追加成新消息不同。长对话仍受模型上下文和服务限制；CLI 使用其自身的上下文管理，应用不额外承诺手动压缩或无限保留在模型可用上下文中。

## 本机 CLI

1. 先安装所选 CLI，并在终端完成登录或接口配置，确认其支持图片输入。
2. 在 Nekomate 选择服务商和“本机 CLI”，直接填写对应程序的路径：OpenAI → Codex、Claude → Claude Code。只有选择“其他服务”时才显示程序选择。DeepSeek 使用 API 直连，不提供 CLI 选项。
3. 路径留空先从 Nekomate 进程的 PATH 查找，再检查桌面版 Codex、用户 bin、npm 和 Node.js 的常见安装目录。也可用“选择文件”指定完整路径；支持资源管理器复制的带引号路径、~/ 用户目录写法和 Windows %变量% 路径，不要填写命令参数。新安装程序或修改环境变量后需要重新启动 Nekomate。
4. “检测安装”运行版本与帮助命令，检查基础能力，并自动填入路径。模型列表自动读取，在下拉框中选择。
5. 保存后选择课程窗口，检查能否生成画面笔记并回答一个需要识图的问题。版本检测通过不代表登录、额度、模型或图片传输已通过真实服务验收。

Windows 支持原生 `.exe`，以及 Codex、Claude Code 标准 npm 安装生成的 `.cmd`。后者会查找对应 npm 包的 JavaScript 入口，使用 PATH 中的 `node.exe` 运行，不执行批处理内容。不支持任意 shell 脚本、WSL 命令串或自定义启动参数。其他系统可填写原生可执行路径，仍需平台验收。

**服务商选择不会重配置已有 CLI。** CLI 模式不使用设置页隐藏的 API Key，真实后端与账户由 CLI 自身配置决定。仅在某个终端设置的环境变量，不会自动出现在从桌面启动的进程里。Codex 的模型列表、读图和问答统一使用 app-server，沿用 CLI 自身的服务配置和登录；同一学习的读图与问答使用同一个持久线程，关闭本机命令、插件和 MCP 功能。Claude Code 首次使用指定 session ID，后续恢复相同 ID，不使用禁止历史持久化的参数。不会强制把自定义服务改成 OpenAI 默认服务。旧版将 DeepSeek 绑定 Claude Code 的配置会自动切回 API，保留已有 API 配置；CLI 模型别名不会被当作 API 模型，缺少密钥或模型时需补齐后保存。

新学习初期的集中课程查询可按课程标题、章节和必要关键词检索公开背景：Codex 使用 `web_search="live"`；Claude Code 仅开放 `WebSearch` / `WebFetch`，不开放本机文件和命令工具。检索在同一学习会话中进行，后续读图和答疑关闭网页工具。网页内容只补充背景，不能代替实际课程画面。是否能检索仍取决于 CLI 版本、所连服务、账户策略与网络；工具参数开启不等于端到端检索成功。DeepSeek API 直连另行接入下述官方网页接口；其他普通 Chat Completions / Messages 连接尚未额外提供搜索工具。

DeepSeek 仅在初期课程背景查询中提供 `web_search` / `web_fetch` 两个函数工具。Nekomate 将调用交给当前 DeepSeek 地址的官方 Search / Fetch 接口，沿用同一密钥，不经过 Claude 或 Codex，也不要求额外搜索服务密钥。重复结果在内存缓存五分钟，按地址、密钥和查询隔离。搜索和网页读取可能单独计费，详见 [DeepSeek 官方说明](https://api-docs.deepseek.com/zh-cn/guides/search/)。网关需要提供对应工具接口；拒绝访问或没有结果时，会告诉模型没有取得外部内容，继续依照已有资料处理。

Nekomate 启动 CLI 时优先保留已有 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY；没有这些显式变量时，沿用 Electron 为相应服务解析出的系统 HTTP(S) 代理。不会修改 Windows 代理设置。系统代理为 DIRECT 时保持直连；SOCKS 或复杂多代理切换不由此适配器代为处理。

CLI 在本机启动，模型通常仍在远端运行，使用对应服务的额度。Codex 可在同一 app-server 连接上连续处理消息；Claude Code 可以按轮次启动进程并恢复同一个原生会话。进程启动、恢复与服务请求都有耗时，不承诺比 API 更快。取消只中止本次任务；需要重连时仍恢复原 ID。已送达服务商的请求可能仍产生用量，接收状态不明时不会盲目重发原始资料。

## 模型列表与对话中切换

设置页和聊天输入框底部均可选择模型。聊天中的选择使用当前已保存的连接，切换后保存为该连接的模型，后续画面读取与提问使用新选择。正在回答时暂时禁止切换。切换不会重读旧截图，已有笔记仍保留。

API 使用服务的 `GET /models`，Claude 使用 `x-api-key` 和 `anthropic-version`，其余使用兼容接口的 Bearer 鉴权。分页限制在 20 页。自定义网关需实现兼容模型列表接口；404、鉴权失败或空列表会显示错误，不提供编造的模型名称。成功读取目录后，不支持当前用途或能力未知的旧选择会从下拉框移除，需要重新选择。

CLI 模型列表分别通过 Codex `model/list` 和 Claude Code 控制协议的初始化响应获取，不发送课程问题或推理请求。

模型目录不是调用成功的证明。程序按图片输入和文件转写能力分别筛选：优先使用能力元数据，没有元数据则匹配已核对的官方模型规则，未知能力隐藏。转写不接受普通音频聊天或 TTS 模型。自定义模型别名若没有能力元数据可能被隐藏；不会为了检测而自动发送收费推理请求。目录可能受 CLI 版本、登录、缓存、网关策略影响；失败可刷新。取消或切换连接后，旧请求的结果不会覆盖新选择。

每段学习使用固定目录 `userData/learning-sessions/<id>/work`，绑定与接收状态保存在对应学习目录，不再每次推理建立并删除临时目录。命令行参数固定，新增问题和图片通过 CLI 协议传入；已提交的上下文由原生会话管理。CLI 自己的历史可能持久化截图，API 的完整消息记录也可能包含图片，不能将会话目录当作纯文字缓存。原始音频仍只在内存保留，默认本地转写。适配器限制工具和自定义扩展，但这不是操作系统级沙箱。CLI 自己的登录、历史、缓存和组织策略仍由其自身管理；请使用可信的程序。

## 适配依据与验证范围

- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)：JSON 输入输出、指定会话 ID、恢复、工具限制与 safe-mode。
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)：模型列表、持久线程、恢复、图片输入和增量事件。
- [Codex model/list](https://learn.chatgpt.com/docs/app-server#list-models-modellist)、[Claude 控制协议源码](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)。
- [Claude 视觉接口](https://platform.claude.com/docs/en/build-with-claude/vision)、[DeepSeek 视觉接口](https://api-docs.deepseek.com/guides/vision/)。

协议夹具检查各家适配器的进程输入、图片字节、接收状态、持久会话恢复、取消和输出解析，HTTP 测试检查请求体与鉴权。另已进行真实 Codex 短文字验证：第一轮确认收到事实，第二轮能回忆 `MINT_4827`，结束进程后第三轮恢复同一线程仍能回忆该值，后两轮未重发事实。这只证明该环境下的短文字原生上下文与跨进程恢复，不证明长课、图片理解或所有账户可用。Claude Code 与 DeepSeek 本轮仍只有协议夹具或本机模拟服务验证，没有真实账户调用。旧版本 CLI 可能缺少相关参数，请使用新版。

### 本次流式与能力筛选依据

- [OpenAI Chat SSE](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)、[文件转写](https://developers.openai.com/api/docs/guides/speech-to-text)、[图像输入](https://developers.openai.com/api/docs/guides/images-vision)。
- [Claude API 流式](https://platform.claude.com/docs/en/build-with-claude/streaming)、[Claude Code 增量事件](https://code.claude.com/docs/en/headless#stream-responses)。
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)、[DeepSeek 视觉输入](https://api-docs.deepseek.com/guides/vision/)。

真实供应商 CLI 版本可能不同。协议夹具测试覆盖增量读取与完成事件；不能把这些测试当作真实账户的端到端兼容证明。

云端音频适配依据：[OpenAI 文件转写接口](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)。当前 CLI 与 Claude Messages 适配器使用本地转写后的文字；原始音频不会经这些连接上传。本地采用 [Qwen3-ASR-GGUF](https://github.com/HaujetZhao/Qwen3-ASR-GGUF) 0.6B，Windows x64 内置独立 Python、DirectML 编码器与 Vulkan 解码器；显卡不可用时使用同一模型的 CPU 模式。

## Claudian 参考

本次对照 [Claudian](https://github.com/YishenTu/claudian/tree/1e432bef66868d81ec14507138d6c502d31fc4b9) 的固定提交，采用适合陪学用途的连接策略：

- [CLI 路径处理](https://github.com/YishenTu/claudian/blob/1e432bef66868d81ec14507138d6c502d31fc4b9/src/core/process/cliPath.ts) 与 [Codex 安装查找](https://github.com/YishenTu/claudian/blob/1e432bef66868d81ec14507138d6c502d31fc4b9/src/providers/codex/runtime/CodexBinaryLocator.ts)：正规化复制的路径，优先使用明确路径 / PATH，再检查常见安装目录。
- [Codex 启动描述](https://github.com/YishenTu/claudian/blob/1e432bef66868d81ec14507138d6c502d31fc4b9/src/providers/codex/runtime/CodexLaunchSpecBuilder.ts)：保持同一启动方式和 CLI 自身的账户配置。Nekomate 同一学习的后台读图、课程查询与答疑共享持久原生会话，只追加新增内容。
- [进程生命周期](https://github.com/YishenTu/claudian/blob/1e432bef66868d81ec14507138d6c502d31fc4b9/src/core/process/ManagedStdioProcess.ts) 与 [RPC 传输](https://github.com/YishenTu/claudian/blob/1e432bef66868d81ec14507138d6c502d31fc4b9/src/core/rpc/JSONRPCTransport.ts)：区分初始化 / 会话建立 / 生成超时，终止错误及时结束。Nekomate 同时兼容仅提供完成文本的回复，并避免把已流式输出的部分重复显示。

参考的是连接策略。桌面环境、代理和路径由 Nekomate 自身适配；没有引入 Obsidian 依赖，未实现 Claudian 的 WSL 支持或常驻共享进程池。

## 对话页快速模式

当前连接与所选模型确认支持 Fast 时，模型选择旁显示细线闪电。默认关闭，点击高亮开启，再点关闭；回答和保存设置期间不可切换。选项保存在本机加密设置中，切换模型、CLI 程序、服务、地址或密钥后关闭，避免把付费选项自动带到其他连接。只对学习答疑申请快速处理，后台笔记、课程检索和转写不主动申请。

Codex 使用真实 model/list 返回的 serviceTiers，只为当前答疑轮次申请相应处理档位，不另建会话。Claude Code 通过本次进程 --settings 的 fastMode 设置，关闭时明确传 false，不修改用户全局 CLI 配置。OpenAI 兼容 API 使用 service_tier；Claude Messages 使用 speed，并仅在需要的预览模型上添加 fast-mode-2026-02-01 头。

未知网关须明确公布支持的处理档位，不能仅因模型名称类似 GPT 就显示开关。官方 OpenAI、Claude 支持型号结合官方说明判断；DeepSeek 不把关闭思考或 Flash 模型名称当成相同的付费 Fast 档位。启用时主进程再次核对模型目录，能力查询仅短暂缓存并按连接、模型和密钥隔离。服务端可以拒绝或降级处理，高亮代表已选择请求 Fast，不是实时速度保证。快速模式可能增加费用或额度消耗，按钮悬停会提示。

依据：[OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)、[Codex Speed](https://learn.chatgpt.com/docs/agent-configuration/speed)、[Claude API Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)、[Claude Code Fast mode](https://code.claude.com/docs/en/fast-mode)。


## 本地语音构建依赖与来源

Qwen3-ASR-GGUF 推理实现通过固定版本源码包准备，校验 SHA-256 后再应用本项目的适配补丁；下载内容属于构建/测试依赖，不直接纳入应用的受版本控制源码。来源与查验事实见 [Qwen GGUF 说明](../assets/licenses/Qwen-GGUF-NOTICE.txt)。

Nekomate 的 MIT 仅适用于自有代码，Qwen 模型的 Apache-2.0 不等于 HaujetZhao 推理实现的授权。已检查的固定版本未发现独立 LICENSE 或明确的再分发许可，因此自动工作流默认不上传、发布包含该实现的二进制包。启用 `ALLOW_QWEN_BINARY_REDISTRIBUTION=true` 前应核实适用授权；该变量本身不是授权。这个发布边界不等于已验证所有第三方条款，也不改变用户本机已有的模型连接设置。
