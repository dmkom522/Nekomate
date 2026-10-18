# 开发与发布

## 结构

```text
src/main.mjs              Electron 主进程、窗口选择、加密配置、受限 IPC
src/preload.cjs           只暴露固定方法，不暴露通用 IPC 或 Node
src/core/provider.mjs    模型 / 转写兼容接口、取消、超时、错误处理
src/core/context.mjs     上下文校验、提示词、来源编号
src/renderer/app.mjs     采集、音频分段、界面、IndexedDB
src/renderer/buffer.mjs  有容量限制的画面缓存和片段选择
src/renderer/format.mjs  禁用原始 HTML 的 Markdown 与 KaTeX
tests/                  核心 / 传输 / 桌面集成测试
```

没有额外 HTTP 后端。模型请求从 Electron 主进程发出。渲染器启用 sandbox、contextIsolation，禁用 nodeIntegration，设置 CSP，阻止外部导航和新窗口。

## 采集与时间

主进程通过 `desktopCapturer.getSources` 展示候选，用户选择后的一次 `getDisplayMedia` 请求取得该源。Windows 音频使用系统 loopback。

预览请求帧率是采集约束，不是有效帧率证明。画面观察使用 `requestVideoFrameCallback`，每秒至多尝试一次抽样，比较 160×90 缩略图像素变化；低变化画面最多间隔约 5 秒保留一张。完整图片最大宽度 1600、JPEG 质量 0.85。

这种策略会漏掉一秒内的快速变化，也可能漏掉检测分辨率以下的细节。诊断中的 sampled / changed / duplicate 是抽样计数，不能解读为源视频有效 FPS。

会话时间在停止采集后暂停，继续采集时接续。它不跟随原视频的暂停、跳转、倍速变化。

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

- push / PR：运行单元测试、桌面合成输入测试，构建 Windows 安装包，保存构建产物。
- 推送 `v*` 标签：通过相同检查后发布安装包及 SHA256 校验文件到 GitHub Releases。
- 不需要在仓库 Secrets 中配置任何模型 API Key。

发布前更新 package.json / package-lock.json 版本及 CHANGELOG，然后：

```bash
git tag v0.1.0
git push origin main
git push origin v0.1.0
```

发布 workflow 使用仓库内置 `GITHUB_TOKEN`，仅发布步骤具有 contents:write 权限。如果仓库规则禁止工作流发布，需要维护者调整对应规则。不要把开发配置、学习记录、`.local/`、`node_modules/` 或安装包提交进 Git。
