# G1.3 — ComfyUI 참조 이미지 전송·연결

핵심 파일:
- `src/lib/webtoon/comfyReference.ts` — 승인된 기준 이미지 SHA-256 확인, ComfyUI `POST /upload/image`, LoadImage 노드 바인딩, 작화 프롬프트 생성.
- `src/app/engine/comfyui.ts` — optional reference data를 받아 `prepareComfyUIWorkflow`에서 참조 이미지 노드에 실제 이름 삽입.
- `src/app/engine/renderQueuedPanel.ts` — 승인된 마스터·장소·직전 컷에서 참조를 골라 업로드한 뒤, 그 2컷 작업의 올바른 렌더 단계에서만 ComfyUI에 제출하는 **서버 내부 함수**.
- `tests/webtoon-comfy-reference.test.mjs` — 이미지 해시·승인 상태·노드 연결·텍스트 배제 테스트.

## 필수 준비
1. ComfyUI에서 **Illustrious XL v2.0용** 워크플로를 실제로 만들고 API format JSON으로 저장한다. SDXL용 IP-Adapter/ControlNet 등 필요한 확장이 설치돼 있어야 한다.
2. 해당 워크플로의 `LoadImage` 노드가 실제 KSampler → VAEDecode → SaveImage 생성 경로에 연결돼 있어야 한다. 노드 이름이나 모델 로더를 임의로 생성하지 않는다.
3. `comfyui/reference-bindings.example.json`을 복사하여 실제 node id를 기재한다. 예를 들어 `identity:hero`, `identity:other`, `location`, `continuity`는 서로 다른 LoadImage 노드를 가리켜야 한다.
4. 캐릭터·장소의 승인된 원본 이미지 파일을 `<WEBTOON_DATA_DIR>/<projectId>/refs/`에 저장하고 SHA-256이 카탈로그 메타데이터와 일치하게 한다.
5. 환경변수 `COMFYUI_REFERENCE_BINDINGS_PATH`를 설정한다. 이 파일이 없거나 활성 캐릭터의 참조 노드가 없는 경우 **생성을 거절**한다.

현재 구현은 ComfyUI 노드 바인딩과 API 업로드를 수행한다. `LoadImage`에 파일이 들어가는 것이 곧 **인물별 영역 제어**나 작화 일관성이 확보됐다는 뜻은 아니다. 각 IPAdapter·ControlNet 노드와 다중 인물 마스크, 모델 가중치, VRAM은 별도로 실제 시험해야 한다.

## 실패 차단
- 미승인·해시 불일치·경로 탈출 이미지 읽기 금지
- 연결되지 않은 LoadImage 노드와 충돌한 노드 매핑 거절
- 잘못된 업로드 응답 경로 거절
- 대사 텍스트는 이미지 생성 프롬프트에서 제외하고 말풍선 영역만 비워 두도록 구성
- 2컷의 두 번째 이미지가 생성되려면 첫 번째가 먼저 승인돼야 함

## 테스트 범위
로컬 Node 22 테스트 24개 통과. 실제 ComfyUI 서버 통합/Illustrious 품질, Next 빌드와 Colab T4 VRAM은 아직 미검증. UI는 여전히 기존 생성기를 사용하고 있으며, 새 `renderQueuedPanel`은 내부 API 수준이다.

참고: https://github.com/Comfy-Org/ComfyUI/blob/master/server.py (`POST /upload/image`), https://github.com/cubiq/ComfyUI_IPAdapter_plus/blob/main/NODES.md.