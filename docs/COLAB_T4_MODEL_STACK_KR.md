# Colab T4 확정 모델 스택 (2026-11-08)

선정 기준: T4 약 15GiB VRAM에서 4비트 LLM과 이미지 모델을 **동시 탑재하지 않고** 순차적으로 실행.

## 고정 모델

- 스토리·콘티·한국어 대사: `unsloth/Qwen3.5-9B-GGUF` 의 `Qwen3.5-9B-Q4_K_M.gguf` (5.68GB). 원본 `Qwen/Qwen3.5-9B`.
- 이미지 기본 생성: `OnomaAIResearch/Illustrious-XL-v2.0` 의 `Illustrious-XL-v2.0.safetensors` (6.94GB, FP16 계열).
- 스토리 LoRA: `Qwen/Qwen3.5-9B` 기반으로 웹툰 플롯·대사·콘티 데이터에서 **별도 학습 예정**. 현재 가중치 파일 없음.
- 이미지 화풍 LoRA: Illustrious XL v2.0 기반으로 **별도 학습 예정**. 현재 가중치 파일 없음.

공개 LoRA `Muapi/manhwa-artstyle-webtoon-lora`는 SDXL 1.0 기반이므로 Illustrious XL v2.0에 동일 품질로 호환된다는 검증이 없음. 고정 스택의 기본 LoRA로 채택하지 않음.

## 순차 실행 계획

1. Colab에 두 모델을 파일로 다운로드·캐시 (디스크 저장은 가능, 동시에 VRAM 로드는 금지).
2. llama.cpp 서버에서 Qwen3.5-9B Q4_K_M 로드 → 시놉시스·회차 대본·컷별 JSON 전량 생성 → JSON 디스크 저장.
3. llama.cpp 서버 프로세스 종료, GPU 메모리 반환 및 메모리 반환 상태 확인.
4. ComfyUI 시작 → Illustrious XL v2.0 로드 → 저장된 JSON 기반 컷별 이미지 생성 → 이미지 저장.
5. 웹 편집기가 저장된 그림·대사를 받아 세로형 웹툰을 조립.

**중요:** 현재 앱 코드는 2~5단계의 모델 서버 시작/중지와 자동 스케줄링을 아직 구현하지 않았음. 단일 T4에서 즉시 완전 자동 순차 실행되는 상태라고 주장하면 안 됨.

## LoRA 적용

- LLM: QLoRA 훈련 체크포인트(PEFT)를 llama.cpp에서 지원하는 GGUF 어댑터로 변환한 후 서버 `--lora`로 로드; 정확한 Qwen3.5 변환·적용 성공 여부는 실험 검증 대상.
- 그림: Illustrious XL v2에 맞게 학습한 LoRA를 `ComfyUI/models/loras`에 배치하고 `COMFYUI_STYLE_LORA_NAME`에 파일명 지정.
- 현재 기본 워크플로는 실제 LoRA가 없어도 실행할 수 있도록 `LoraLoader`를 생략. 환경 변수에 LoRA 파일명을 넣으면 서버 어댑터가 `LoraLoader`를 자동 삽입.

## 품질 및 VRAM

- LLM Q4는 가중치가 5.68GB지만 KV cache·runtime 메모리는 추가 필요.
- Illustrious XL fp16 체크포인트가 6.94GB여도 추론 VRAM은 출력 해상도·배치와 노드에 따라 달라짐.
- T4에서 먼저 768×1024, batch=1로 실측 후 1024×1024 이상으로 확장.
- 이 문서는 모델 선정 및 코드 구성 기록이며 실제 T4 검증 결과가 아님.

모델 주소:
https://huggingface.co/unsloth/Qwen3.5-9B-GGUF
https://huggingface.co/OnomaAIResearch/Illustrious-XL-v2.0
