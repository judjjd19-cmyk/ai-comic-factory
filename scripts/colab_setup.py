#!/usr/bin/env python3
"""Install and configure the Colab T4 Webtoon Studio stack.

Run only after mounting your Drive. Downloaded weights remain in persistent
Drive; model processes are started separately by scripts/colab_runtime.py.
No public tunnel or unauthenticated service is created.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import secrets
import shutil
import subprocess
import sys

MODEL_FILES = (
    ("unsloth/Qwen3.5-9B-GGUF", "Qwen3.5-9B-Q4_K_M.gguf"),
    ("OnomaAIResearch/Illustrious-XL-v2.0", "Illustrious-XL-v2.0.safetensors"),
    ("h94/IP-Adapter", "sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors"),
    ("fofr/comfyui", "clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"),
)
QWEN_NAME = "Qwen3.5-9B-Q4_K_M.gguf"
IMAGE_NAME = "Illustrious-XL-v2.0.safetensors"
IP_NAME = "ip-adapter-plus_sdxl_vit-h.safetensors"
VISION_NAME = "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"


def execute(*args: str, cwd: Path | None = None) -> None:
    print("+", " ".join(args), flush=True)
    subprocess.run(args, check=True, cwd=cwd)


def ensure_clone(url: str, directory: Path) -> None:
    if directory.exists():
        if not (directory / ".git").is_dir():
            raise RuntimeError(f"{directory} exists but is not a git checkout")
        return
    directory.parent.mkdir(parents=True, exist_ok=True)
    execute("git", "clone", "--filter=blob:none", url, str(directory))


def link_weight(download: Path, destination: Path) -> None:
    if not download.is_file():
        raise FileNotFoundError(download)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink() and destination.resolve() == download.resolve():
        return
    if destination.exists() or destination.is_symlink():
        raise FileExistsError(f"Refusing to replace existing model file: {destination}")
    destination.symlink_to(download.resolve())


def download_weights(models: Path, comfy: Path) -> None:
    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        execute(sys.executable, "-m", "pip", "install", "huggingface_hub>=0.30,<2")
        from huggingface_hub import hf_hub_download

    root = models / "downloads"
    root.mkdir(parents=True, exist_ok=True)
    for repo, filename in MODEL_FILES:
        print(f"Download {repo}/{filename} (may be multiple GB)")
        downloaded = Path(hf_hub_download(repo_id=repo, filename=filename, local_dir=root))
        if not downloaded.is_file() or downloaded.stat().st_size < 1_000_000:
            raise RuntimeError(f"Model download incomplete: {downloaded}")

    link_weight(root / IMAGE_NAME, comfy / "models/checkpoints" / IMAGE_NAME)
    link_weight(root / "sdxl_models" / IP_NAME, comfy / "models/ipadapter" / IP_NAME)
    link_weight(root / "clip_vision" / VISION_NAME,
                comfy / "models/clip_vision" / VISION_NAME)


def write_local_settings(project: Path, data: Path) -> None:
    target = project / ".env.local"
    workflow = project / "comfyui/workflow-api.json"
    if not workflow.is_file():
        shutil.copyfile(project / "comfyui/workflow-api.example.json", workflow)
    if target.exists():
        print(f"Existing .env.local preserved: {target}")
        return
    token = secrets.token_urlsafe(36)
    content = "\n".join((
        "WEBTOON_STUDIO_TOKEN=" + token,
        "WEBTOON_DATA_DIR=" + str(data),
        "LLM_ENGINE=OPENAI",
        "AUTH_OPENAI_API_KEY=local",
        "LLM_OPENAI_API_MODEL=Qwen3.5-9B",
        "LLM_OPENAI_API_BASE_URL=http://127.0.0.1:8000/v1",
        "RENDERING_ENGINE=COMFYUI",
        "COMFYUI_API_URL=http://127.0.0.1:8188",
        "COMFYUI_WORKFLOW_PATH=comfyui/workflow-api.json",
        "COMFYUI_CHECKPOINT_NAME=" + IMAGE_NAME,
        "COMFYUI_STYLE_LORA_NAME=",
        "COMFYUI_REFERENCE_MODE=auto",
        "COMFYUI_IPADAPTER_FILE=" + IP_NAME,
        "COMFYUI_CLIP_VISION_FILE=" + VISION_NAME,
        "NEXT_PUBLIC_ENABLE_COMMUNITY_SHARING=false",
        "ENABLE_HUGGING_FACE_OAUTH=false",
        "ENABLE_HUGGING_FACE_OAUTH_WALL=false",
        "",
    ))
    target.write_text(content, encoding="utf-8")
    target.chmod(0o600)
    print(f"Studio secret (enter once at /webtoon): {token}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, default=Path.cwd(),
                        help="Checked-out judjjd19/ai-comic-factory")
    parser.add_argument("--workdir", type=Path, default=Path("/content"),
                        help="Runtime directory for llama.cpp and ComfyUI")
    parser.add_argument("--persistent", type=Path, required=True,
                        help="Existing, mounted Google Drive directory for models and art")
    parser.add_argument("--install", action="store_true",
                        help="Clone ComfyUI/llama.cpp and install required dependencies")
    parser.add_argument("--download-models", action="store_true",
                        help="Download the four verified public model files")
    args = parser.parse_args()

    project = args.project.resolve()
    if not (project / "package-lock.json").is_file():
        raise FileNotFoundError("Run in the AI Comic Factory repository")
    persistent = args.persistent.resolve()
    if not persistent.parent.is_dir():
        raise FileNotFoundError("Mount Google Drive first; the parent directory does not exist")
    persistent.mkdir(parents=True, exist_ok=True)
    models = persistent / "models"
    data = persistent / "projects"
    models.mkdir(exist_ok=True)
    data.mkdir(exist_ok=True)
    workdir = args.workdir.resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    comfy = workdir / "ComfyUI"
    llama = workdir / "llama.cpp"

    if args.install:
        for cmd in ("git", "cmake", "node", "npm"):
            if not shutil.which(cmd):
                raise RuntimeError(f"Install the prerequisite command: {cmd}")
        ensure_clone("https://github.com/Comfy-Org/ComfyUI.git", comfy)
        ensure_clone("https://github.com/ggml-org/llama.cpp.git", llama)
        ensure_clone("https://github.com/cubiq/ComfyUI_IPAdapter_plus.git",
                     comfy / "custom_nodes/ComfyUI_IPAdapter_plus")
        execute(sys.executable, "-m", "pip", "install", "-r", str(comfy / "requirements.txt"))
        execute(sys.executable, "-m", "pip", "install", "huggingface_hub>=0.30,<2")
        execute("cmake", "-S", str(llama), "-B", str(llama / "build"),
                "-DGGML_CUDA=ON", "-DCMAKE_BUILD_TYPE=Release")
        execute("cmake", "--build", str(llama / "build"), "--target", "llama-server", "-j", "4")
        execute("npm", "ci", cwd=project)

    if args.download_models:
        if not comfy.is_dir():
            raise FileNotFoundError("Install ComfyUI first with --install")
        download_weights(models, comfy)

    write_local_settings(project, data)
    print("Configured project:", project)
    print("Model cache:", models)
    print("Persistent project data:", data)
    print("LLM model:", models / "downloads" / QWEN_NAME)
    print("Next: use scripts/colab_runtime.py start-llm or start-image.")
    print("Next.js local UI: npm run dev -- --hostname 127.0.0.1")


if __name__ == "__main__":
    main()
