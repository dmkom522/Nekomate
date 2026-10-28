# Nekomate v0.1.3 — macOS Preview

首个 macOS 预览版，面向 macOS 14.2 及以上，分别提供 Apple Silicon 和 Intel 安装包。

## 下载

- `Nekomate-0.1.3-mac-arm64.dmg`：M1、M2、M3、M4 等 Apple Silicon Mac。
- `Nekomate-0.1.3-mac-x64.dmg`：Intel Mac。
- `SHA256SUMS-macos.txt`：两种安装包的 SHA-256 摘要。

打开 DMG，将 Nekomate 拖入 Applications。应用包含本地 Qwen3-ASR 模型、Python 和推理运行时，不需要自行安装 Python 或语音模型。

## 本次适配

- 根据平台调用内置 Python，打包相应架构的 macOS 动态库和依赖。
- 语音解码在 Metal 可用且实际加载了 GPU 层时使用 Metal；编码器使用 CPU。不可用时使用同一模型的 CPU 模式。
- macOS 14.2 及以上可选择采集系统声音；应用声明系统录音用途，声音权限未生效时提示，并继续提供画面答疑。
- 使用 Nekomate 小猫作为应用图标。

## 验证范围与首次打开

发布流程在原生 Apple Silicon 和 Intel 构建机上挂载实际 DMG，核对包内版本和提示词，启动包内应用，并通过实际 Electron IPC 和内置语音进程转写已知内容的中英文合成语音，检查两分钟静音不产生文字。合成语音测试不能证明所有真人课程的识别准确率。

该预览版使用 ad-hoc 签名，没有 Apple Developer ID 证书和公证。macOS 可能要求在“系统设置 → 隐私与安全性”中确认打开。首次选择课程窗口时，需要允许屏幕录制；启用声音还需要系统声音录制权限。构建机测试不等于已经验证个人 Mac 上的这些隐私授权和实际课程采集。

首次使用请保留原学习数据备份，遇到问题可附系统版本、芯片类型和操作步骤反馈。
