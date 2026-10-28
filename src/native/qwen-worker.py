"""Bounded, offline JSON-lines worker. Launched only by Nekomate's main process."""
import base64
import contextlib
import ctypes
import io
import json
import os
import re
from pathlib import Path
import sys
import wave

sys.stdout.reconfigure(encoding="utf-8")
root = Path(__file__).resolve().parent
sys.path[:0] = [str(root / 'packages'), str(root / 'engine')]
is_macos = sys.platform == 'darwin'
mode = sys.argv[1]
if mode not in ("gpu", "cpu"):
    raise SystemExit(2)
os.environ["OMP_NUM_THREADS"] = "2"
os.environ["OPENBLAS_NUM_THREADS"] = "2"
if mode == "cpu":
    os.environ["VK_ICD_FILENAMES"] = "none"
else:
    os.environ.setdefault("GGML_VK_VISIBLE_DEVICES", "0")

import numpy as np
import onnxruntime as ort
from qwen_asr_gguf.inference import QwenASREngine, ASREngineConfig
from qwen_asr_gguf.inference import llama
from qwen_asr_gguf.inference.chinese_itn import chinese_to_num

original_options = ort.SessionOptions
def options():
    value = original_options()
    value.intra_op_num_threads = 2
    value.inter_op_num_threads = 1
    return value
ort.SessionOptions = options
original_context = llama.LlamaContext.__init__
def context(self, *args, **kwargs):
    kwargs.update(n_threads=2, n_threads_batch=2)
    return original_context(self, *args, **kwargs)
llama.LlamaContext.__init__ = context

engine = None
devices = []
gpu_layers = 0
gpu_log_callback = None
quiet = open(os.devnull, "w", encoding="utf-8")

def initialize():
    global engine, devices, gpu_layers, gpu_log_callback
    if engine is not None:
        return False
    if mode == "gpu":
        if not is_macos and "DmlExecutionProvider" not in ort.get_available_providers():
            raise RuntimeError("gpu-unavailable")
        llama.bind_llama_lib()
        lib = llama.ggml
        lib.ggml_backend_dev_count.restype = ctypes.c_size_t
        lib.ggml_backend_dev_get.argtypes = [ctypes.c_size_t]
        lib.ggml_backend_dev_get.restype = ctypes.c_void_p
        names = llama.ggml_base
        names.ggml_backend_dev_name.argtypes = [ctypes.c_void_p]
        names.ggml_backend_dev_name.restype = ctypes.c_char_p
        devices = [names.ggml_backend_dev_name(lib.ggml_backend_dev_get(i)).decode("utf-8")
                   for i in range(lib.ggml_backend_dev_count())]
        devices = [name for name in devices if name.startswith(("Metal", "MTL", "Apple"))] if is_macos else [name for name in devices if name.startswith("Vulkan")]
        if not devices:
            raise RuntimeError("gpu-unavailable")
        if is_macos:
            def record_offload(_level, message, _data):
                global gpu_layers
                match = re.search(r'offloaded\s+(\d+)(?:/\d+)?\s+layers', message.decode('utf-8', errors='replace')) if message else None
                if match:
                    gpu_layers = max(gpu_layers, int(match.group(1)))
            gpu_log_callback = ctypes.CFUNCTYPE(None, ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p)(record_offload)
            llama.llama_log_set(gpu_log_callback, None)
    model = root / "model"
    for name, size in [("qwen3_asr_encoder_frontend.int4.onnx", 20343991),
                       ("qwen3_asr_encoder_backend.int4.onnx", 94750816),
                       ("qwen3_asr_llm.q4_k.gguf", 484215360)]:
        if (model / name).stat().st_size != size:
            raise RuntimeError("invalid-model")
    with contextlib.redirect_stdout(quiet):
        engine = QwenASREngine(ASREngineConfig(
            model_dir=str(model), encoder_frontend_fn="qwen3_asr_encoder_frontend.int4.onnx",
            encoder_backend_fn="qwen3_asr_encoder_backend.int4.onnx", llm_fn="qwen3_asr_llm.q4_k.gguf",
            onnx_provider="DML" if mode == "gpu" and not is_macos else "CPU", llm_use_gpu=mode == "gpu",
            enable_aligner=False, verbose=False))
    if mode == "gpu" and not is_macos and any("DmlExecutionProvider" not in session.get_providers()
                             for session in (engine.encoder.sess_fe, engine.encoder.sess_be)):
        raise RuntimeError("gpu-unavailable")
    if mode == 'gpu' and is_macos and gpu_layers < 1:
        raise RuntimeError('gpu-unavailable')
    return True

while True:
    line = sys.stdin.buffer.readline(5_400_001)
    if not line:
        break
    request_id = None
    try:
        if len(line) > 5_400_000:
            raise ValueError("oversized-request")
        message = json.loads(line)
        request_id = message["id"]
        if type(request_id) is not int or request_id < 1:
            raise ValueError("invalid-id")
        fresh = initialize()
        if message["kind"] == "warmup":
            if fresh and mode == "gpu":
                with contextlib.redirect_stdout(quiet):
                    engine.asr(audio=np.zeros(16000, dtype=np.float32), context="", language=None, temperature=0)
            result = {"warmed": True, "mode": mode}
        elif message["kind"] == "transcribe":
            data = base64.b64decode(message["audio"], validate=True)
            if len(data) > 4_000_000:
                raise ValueError("oversized-wave")
            with wave.open(io.BytesIO(data), "rb") as wav:
                if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 16000 or not 1 <= wav.getnframes() <= 1920000:
                    raise ValueError("invalid-wave")
                samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768
            with contextlib.redirect_stdout(quiet):
                text = chinese_to_num(engine.asr(audio=samples, context="", language=None, temperature=0).text).strip()
            if len(text) > 64000:
                raise ValueError("oversized-result")
            duration = len(samples) / 16000
            result = {"text": text, "source": "local", "model": "Qwen3-ASR 0.6B " + mode.upper(),
                      "mode": mode, "devices": devices, "gpuLayers": gpu_layers, "encoderProvider": engine.encoder.sess_fe.get_providers()[0], "timing": "audio-window",
                      "segments": [{"start": 0, "end": duration, "text": text}] if text else []}
        else:
            raise ValueError("invalid-kind")
        print(json.dumps({"id": request_id, "result": result}, ensure_ascii=False), flush=True)
    except Exception:
        if os.environ.get('NEKOMATE_SPEECH_DIAGNOSTICS') == '1':
            import traceback
            traceback.print_exc(file=sys.stderr)
        print(json.dumps({"id": request_id, "error": "gpu-unavailable" if mode == "gpu" else "transcription-failed"}), flush=True)
        break
