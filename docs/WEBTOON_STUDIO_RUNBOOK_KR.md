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

## Authentication

Create a strong secret with `python -c "import secrets;print(secrets.token_urlsafe(32))"` and set `WEBTOON_STUDIO_TOKEN` in `.env.local`. `/webtoon` will request this secret once and store only a signed HttpOnly session cookie. **Do not commit the secret.** The image and command endpoints refuse unauthenticated requests; a public tunnel is not enabled by this project.


## Colab T4 초기화·실행 경로

- 실행 노트북: notebooks/WEBTOON_COLAB_T4.ipynb (GitLab에서 내려받아 Colab에 업로드)
- 설치: scripts/colab_setup.py
- Q4 LLM/ComfyUI 전환: scripts/colab_runtime.py
- 제작 화면: /webtoon

Colab에서 Drive 마운트 후 설치:
    python scripts/colab_setup.py --project /content/ai-comic-factory --persistent /content/drive/MyDrive/WebtoonFactory --install --download-models

LLM 콘티 생성 단계:
    python scripts/colab_runtime.py start-llm --binary /content/llama.cpp/build/bin/llama-server --model /content/drive/MyDrive/WebtoonFactory/models/downloads/Qwen3.5-9B-Q4_K_M.gguf

LLM으로 회차 콘티를 저장한 뒤 이미지 단계:
    python scripts/colab_runtime.py start-image --comfy-dir /content/ComfyUI

설치 스크립트는 공개 Qwen3.5-9B Q4_K_M, Illustrious XL v2.0, IP-Adapter Plus SDXL, CLIP Vision 가중치를 내려받고 ComfyUI 경로에 심볼릭 링크한다. 모델 가중치는 GitLab 저장소에 포함하지 않는다.

웹 스튜디오는 WEBTOON_STUDIO_TOKEN으로 인증한다. Colab 프록시는 브라우저 쿠키 정책에 따라 별도 탭과 iframe에서 다르게 동작할 수 있다. 인증 없는 공개 터널은 만들지 않는다.

## 실제 검증 수준

- Node 코어의 기존 단위 테스트와 인증 테스트를 로컬에서 실행했다.
- 최신 브랜치 전체 TypeScript/Next 빌드, 실제 Colab T4 peak VRAM, ComfyUI 다중 인물 참조와 LoRA 적용은 아직 실측하지 않았다.
- GitLab CI는 계정 identity verification 제한으로 실행되지 못하고 있다.
- 기계적 시각 QA는 말풍선 기하, 이미지 크기, 빈 이미지 후보 탐지 수준이다. 얼굴·의상·행동 동일성은 승인 단계에서 육안 검수가 필요하다.


## 장편 연재: 작품 → 화 → 2컷 쌍 → 승인 컷

연재 제작 상태는 프로젝트 manifest의 `series.episodes`에 저장된다.

1. 원본 인물·장소를 승인한 다음 1화의 서사 개요를 설계한다. LLM은 장면 밀도에 따른 권장 2컷 쌍 수를 제공한다.
2. LLM 모델 단계에서 한 화의 2컷 계획을 저장한다. 각 묶음은 `episode1_p00001`, 각 컷은 `episode1_p00001_0`처럼 화별로 고유하다.
3. 이미지 모델 단계에서 저장된 계획을 하나씩 활성화하고 첫 컷 → 검수·승인 → 둘째 컷 → 검수·승인 순으로 처리한다. 자동 진행 체크박스는 다음 작화나 저장된 2컷 활성화를 자동 실행하지만 검수·승인은 자동 통과시키지 않는다.
4. 승인된 모든 2컷을 완료하면 화수 마감에서 요약·마지막 후킹·미해결 복선·회수한 복선·인물 관계 변경을 검수한다. 모든 컷의 승인 이미지 파일 해시를 확인한 뒤 원자적으로 해당 화를 확정한다.
5. 다음 화 생성은 앞 화의 마지막 장면 상태와 확정된 서사 기록을 자동 이어받는다. 앞 화가 미완료 상태거나 이전 화의 미완성 계획이 있으면 다음 화 콘티 작성을 차단한다.
6. 선택한 화만 10컷씩 나누어 PNG로 출력할 수 있고, 별도로 장면·컷·말풍선·관계·복선 데이터를 JSON으로 저장한다.

`main` 도입 전부터 제작한 기존 프로젝트는 모든 이미지가 승인되어 있고 연속성 검증을 통과한 경우에 한해 제작 화면의 **기존 작품의 회차 데이터 변환**으로 이전할 수 있다. 기존 승인 이미지는 새로 생성하거나 잘라내지 않는다.

### 검증 기준

새 연재 코드에는 회차 2개 이상의 연결, 컷 ID 중복 방지, 승인 전 마감 차단, 이미지 파일 손상 검출, 미해결 복선 승계, 대사 수정 후 검수 요구, 완료된 화의 수정 차단과 잠금 복구 테스트를 포함한다. GitLab CI가 계정 인증 제한으로 실행되지 않는다면 **해당 테스트가 GitLab에서 통과했다고 보고하지 않는다**. 실제 T4 모델 실행과 다인물 작화 일관성은 별도의 GPU 검증이 필요하다.
