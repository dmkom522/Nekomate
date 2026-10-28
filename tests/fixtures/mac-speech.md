# macOS speech smoke-test fixtures

These are synthetic speech WAV files created for Nekomate, not recordings of a person or a course. Both are 16 kHz, mono PCM16.

- `mac-speech-zh.wav`: Windows SAPI, Microsoft Huihui Desktop. Text: “早上九点，我们开始学习线性代数。”
- `mac-speech-en.wav`: Windows SAPI, Microsoft Zira Desktop. Text: “The cat is studying linear algebra with me.”

They test the packaged local recognizer and IPC with known Chinese and English speech. Passing does not establish accuracy on arbitrary human lectures, accents, or noisy recordings.
