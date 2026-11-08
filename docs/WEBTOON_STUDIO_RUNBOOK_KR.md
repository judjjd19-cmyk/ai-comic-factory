# Webtoon Studio (Colab T4 / local)

## Running the studio

1. Install Node 20+ and dependencies with \`npm ci\`. The new UI is \`http://localhost:3000/webtoon\`; the original editor remains at \`/\`.
2. Copy \`.env.local.example\` to \`.env.local\` and set actual installed model paths and ComfyUI API URL. Set \`WEBTOON_DATA_DIR\` to persistent storage **outside the Git repo**.
3. Before creating panels, generate or upload character master images and location plates. **Explicitly approve** them in the studio UI.
4. With the LLM server on, click **회차 전체 2컷씩 사전 기획**. All pair scripts are stored as recoverable drafts.
5. Stop the LLM server; start ComfyUI with Illustrious XL v2 and SDXL IP-Adapter and CLIP Vision dependencies installed.
6. Click **저장된 다음 2컷 불러오기**, render panel 1, inspect and approve, then render panel 2. After approving both, activate the next draft. This preserves two-panel creation while avoiding constant model swaps.
7. Adjust/edit speech bubbles independently, then export a single vertical PNG.

## Colab phase supervisor

- Pre-requisites: compiled CUDA llama-server, Qwen3.5-9B Q4_K_M GGUF weights, ComfyUI with installed Illustrious checkpoint, compatible SDXL IP-Adapter Plus custom nodes, SDXL IP-Adapter weights and CLIP Vision weights, Node dependencies, and mounted persistent storage.
- Run \`python scripts/colab_runtime.py start-llm --binary /content/llama.cpp/build/bin/llama-server --model /content/drive/MyDrive/models/Qwen3.5-9B-Q4_K_M.gguf\` for screenplay generation.
- Run \`python scripts/colab_runtime.py start-image --comfy-dir /content/ComfyUI\` for image generation. This terminates the previously started model server before loading the next one.
- Use \`python scripts/colab_runtime.py status\` and \`python scripts/colab_runtime.py stop\` for operational control.
- The program refuses startup when required executable/weights are absent or GPU memory free is below its safety threshold. It does not download models, upload images to external services or open public network ports.
- Save \`WEBTOON_DATA_DIR\` on mounted Drive to survive Colab restarts. Restart Next in the same runtime before using \`/webtoon\`.
- **Important:** The Next app's API currently requires a localhost Host header. Colab's public proxy URL and browser access need a separate authenticated proxy/tunnel design; do not expose the server publicly without protection.

## Reference conditioning

Set \`COMFYUI_REFERENCE_MODE=auto\` (default in the new queued renderer). The pipeline creates IPAdapterAdvanced nodes for approved identity, optional outfit/view, location and approved previous panel references; visible actor references are spatially constrained with generated alpha masks. Requires \`ComfyUI_IPAdapter_plus\` node family, \`COMFYUI_IPADAPTER_FILE\`, and \`COMFYUI_CLIP_VISION_FILE\` installed in ComfyUI.

The basic \`comfyui/workflow-api.example.json\` is the base graph. Copy it to \`comfyui/workflow-api.json\` and replace the checkpoint filename with an installed one. The studio's auto mode injects reference nodes dynamically, so manual \`reference-bindings.json\` is not required. **Actual T4 VRAM and image consistency have not been tested.**

## Verification

- \`npm run test:webtoon\` executes the pure Node TypeScript contract tests.
- \`npm run build\` checks the full Next app after dependencies are installed.
- Actual ComfyUI plugin compatibility, Q4 Story LoRA support, T4 VRAM, mixed-character identity and exported image layout require hardware and image-level tests before production-quality claims.

## Known limitations

- Generated master sheets and reference image recognition require human approval; there is no demonstrated fully automatic identity scoring system.
- The QA checks geometry, image dimensions and obvious empty output; they do not prove face likeness or pose correctness.
- The previous Comic Factory UI uses its own legacy state; the new \`/webtoon\` route is a dedicated production flow.
- Model checkpoints, LoRAs, IP-Adapter/CLIP vision weights and GitLab CI runner permissions are external dependencies, not included in this repository.
