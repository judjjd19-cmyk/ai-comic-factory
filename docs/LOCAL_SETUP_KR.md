# 로컬 웹툰 생성 연결

원본 UI는 보존하고 LLM과 그림 생성기의 서버측 공급자만 교체한다.
작업 브랜치: `source-mirror-import` (2025년 공개 미러 기반; 원본 최신본 동일성 미확인).

## 설정

1. Node.js, Next.js 의존성을 설치한다: `npm ci`.
2. ComfyUI를 실행하고 체크포인트와 웹툰 화풍 LoRA를 해당 ComfyUI models 디렉터리에 설치한다.
3. `comfyui/workflow-api.example.json`을 `comfyui/workflow-api.json`으로 복사한 후
   실제 모델 파일명을 입력한다. 복잡한 모델이라면 ComfyUI에서 API-format JSON을 export해 대신 사용한다.
4. `.env.local.example`을 `.env.local`로 복사해 로컬 호스트 주소·모델명 설정을 수정한다.
5. OpenAI 호환 LLM 서버(vLLM, llama.cpp 등)를 실행하고, 스토리 LoRA를 해당
   서버에서 로드한다. `LLM_OPENAI_API_MODEL`에는 서버가 노출하는 모델 ID를 입력한다.
6. `npm run dev` 실행. UI 설정에서는 LLM 및 렌더링 모델을 모두 `SERVER`로 선택한다.

## 경로

스토리 프롬프트 → `predictNextPanels` → 로컬 LLM(`/v1/chat/completions`) →
컷별 JSON → 기존 렌더 엔진 → ComfyUI(`POST /prompt`) →
poll(`GET /history/{prompt_id}`) → binary image(`GET /view`) → 기존 편집기.

LoRA는 캐릭터마다 학습하지 않는다. 스토리 LoRA는 LLM 서버에서,
웹툰 화풍 LoRA는 ComfyUI `LoraLoader`에서 각각 적용한다.
인물 외형 일관성은 후속 개발에서 캐릭터 참조 시트와 장면 상태로 관리한다.

## 현재 한계

- 실제 모델 파일·서버가 없어 E2E 생성은 아직 검증하지 않았다.
- 기본 워크플로는 SD 계열 `CheckpointLoaderSimple` + `LoraLoader` + `KSampler` 예제다.
  Flux 등 다른 이미지 모델은 모델에 맞는 ComfyUI API JSON이 필요하다.
- ComfyUI 렌더링은 비동기이며 기존 편집기가 `getRender`를 통해 완료 상태를 확인한다.
- 생성된 이미지는 기존 HF 엔진처럼 base64 data URI로 에디터에 반환한다.
- 현재 캐릭터 참조 이미지 및 장편 스토리 메모리 시스템은 아직 미구현이다.
- 설정은 서버 환경변수로 제어한다. UI의 커스텀 모델 입력값은 이 로컬 제공자에는 적용되지 않는다.
