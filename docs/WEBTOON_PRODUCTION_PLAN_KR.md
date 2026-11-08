# 웹툰 생산 파이프라인 상세 구현 계획 (v1.0, 2026-11-08)

대상: Qwen3.5-9B Q4_K_M(스토리) / Illustrious XL v2.0(그림) / Colab T4(약 15GiB) / 2컷씩 생성.
목표: 이미지 모델은 상황과 **편집 가능한 빈 말풍선**까지 구성하고, LLM이 생성한 한국어 대사는 별도 텍스트 레이어로 정확히 합성한다. 주요 인물의 정체성과 두 컷 간 동작·장소·카메라 연속성을 유지한다.

## 고정 불변조건
1. 두 컷을 하나의 시퀀스로 기획하되, 이미지는 컷1 승인 → 컷2 생성/승인 순서로 처리한다. 최종 홀수 컷 예외만 허용.
2. 기준 캐릭터·의상·장소는 불변 버전과 참조 이미지, 색상·형태 정의를 가진다. 생성 결과로 자동 덮어쓰지 않는다.
3. 이전 컷 중 승인된 이미지에만 참조 자격을 준다. 거절/임시 이미지를 다음 컷에 사용하지 않는다.
4. 스토리 상태(작가가 의도한 사실)와 비주얼 상태(승인 이미지에 실제 나타난 상태)를 분리한다. 실패 그림 때문에 각본을 임의로 바꾸지 않는다.
5. 캐릭터별 LoRA는 필수가 아니다. 스토리 LoRA와 화풍 LoRA는 별개의 선택 기능이며, LoRA가 없어도 베이스 기능을 실행해야 한다.
6. LLM Q4, 이미지 FP16은 VRAM에 동시에 적재하지 않는다. 모델 교체·일시중단·재시작을 처리하는 Colab 작업 큐가 주관한다.
7. 성공 주장에는 실제 검증 기록이 필요하다. QA가 불확실하면 REVIEW로 남기고 자동 승인하지 않는다.

## 생성 순서
A. 프로젝트 생성: 작품 성경(story_bible), 등장인물 master, 장소 master, 화풍/모델 manifest.
B. 캐릭터 생성: 공통 얼굴 앵커 → 정/3/4/측면·전신·의상 버전 → 비교 QA → 승인된 master 고정. 장소도 기준 배경을 등록.
C. 회차 설계: 전체 사건/복선/감정선/회차 갈등을 구조화. 연속 2컷을 생성할 때 전체 회차 목표를 참조.
D. 2컷 콘티: before_state, panel1, mid_state, panel2, after_state를 한 번에 JSON으로 출력; 각 컷은 actor_id, action, gesture, emotion, camera, left/right, facing, gaze, outfit_id, prop_id, background_id, bubble list를 가진다.
E. 콘티 검증: ID/시간/소품/동선/대사 화자/카메라 축 및 말풍선 공간을 확인. 실패 시 이미지 생성 전에 재계획.
F. 참조 선택: 등장 인물 master > 해당 의상 master > 장소 master > 직전 승인 컷(동선·구도) > 승인된 해당 각도·소품 컷. 모든 참조에 역할·가중치·mask를 기록.
G. 컷1 작화: 예약된 말풍선 구역을 포함한 actor bounding boxes/region masks/pose/depth hints를 사용. 최적의 Illustrious SDXL 호환 제어기만 실측 후 적용.
H. 컷1 시각 QA → 부족한 부분 인페인팅/재생성 → 승인.
I. 컷2 작화: 동일 master에 승인된 컷1을 장면 연결 참조로 추가. 컷2 QA 후 두 컷의 연속성을 함께 검토.
J. 빈 말풍선 형태를 **독립적인 투명 그래픽 레이어**로 생성/보정한다. 이미지 AI가 생성한 빈 풍선을 추출할 수 있으면 사용하며, 실패하면 스타일을 맞춘 편집 가능한 2D 곡선으로 재구성한다. 원화에 가짜 글자/대사를 직접 그리지 않는다.
K. LLM의 대사를 bubble_id·speaker_id·read_order에 따라 정확히 삽입하고 한국어 줄바꿈/넘침/꼬리/얼굴 가림을 확인한다.
L. 두 컷과 해당 state를 원자적으로 승인하고, 이후 2컷에 적용한다. 승인본·모델/seed/workflow hash를 영구 저장한다.

## 반드시 분리할 데이터
- CharacterMaster: character_id, immutable anchor IDs, appearance, outfit versions, approved angles and expressions, asset hashes.
- LocationMaster: location_id, reference plates, stable props, layout, time-of-day variations.
- StoryBible: facts, relationships, world rules, timeline, episode arc and foreshadowing.
- SceneState: time, location, positions [0,1], screen direction, camera axis, expressions, held props, actor depths.
- PairPlan: pair_id, episode_id, before/mid/after states, panel1 and panel2, read_order, continuity requirements.
- PanelPlan: actor instances with individual region masks, shot, pose, background, bubble positions and speaker IDs.
- RenderAttempt: model/adapter/workflow versions, seed, selected ref manifest, output, latency, error, QA report, retry_count.
- ApprovedPanel: approved image, layered bubble/text, approved state snapshot, immutable checksum.

**검증 불변식:** 두 컷 규격·존재하는 actor_id·화자 일치·state transition 연속·화풍/의상 버전·화면 좌표 [0,1]·대사/버블 텍스트 정확성·미승인 참조 금지.

## 주의할 실패 모드
- 참조 이미지만 많이 넣으면 얼굴이 섞이거나 포즈가 고착된다. **캐릭터별 영역 mask, position/pose hints**를 도입하되 Illustrious v2 호환성과 VRAM을 사전 시험한다.
- IP-Adapter FaceID는 특히 애니메이션 얼굴에서 동일성 보장을 하지 않는다. face embedding 성능을 별도로 비교하고 실패 시 plus-face 일반 참조·지역별 인페인팅으로 대체한다.
- 이전 컷만 참조하면 외형이 서서히 드리프트한다. master는 항상 우선하고 이전 승인 컷은 장면 연결 보조로만 쓴다.
- 동작·소품·좌우 관계는 이미지 유사도보다 구조적인 SceneState와 배치/카메라 축 검증이 중요하다.
- 말풍선을 이미지에 통째로 래스터로 박아 넣으면 대사 수정·재배치가 어려워진다. 별도 shape/mask/text 레이어를 원본으로 저장한다.
- 전 컷 텍스트를 LLM 컨텍스트에 무한 누적하지 않는다. story bible + 사건 요약 + 최근 상세 state + 관련 사실 조회를 쓴다.
- 오류가 발생했다고 컷 전체를 무조건 재생성하지 않는다. 버블 → 재배치, 손/얼굴 → 국소 inpaint, 배우 뒤바뀜/구도 실패 → 해당 컷 재렌더, 서사 모순 → LLM 부분 재계획.
- 자동 재시도 기본 최대 3회. 실패하면 BLOCKED/REVIEW; 성공으로 숨기거나 다음 컷에 전달하지 않는다.

## Colab T4 운영
권장 생산 방식: Qwen3.5-9B Q4로 **전체 회차 스토리를 2컷 단위로 모두 기획/검증하고 디스크에 저장** → LLM 종료 및 VRAM 반환 확인 → ComfyUI/Illustrious를 로드하여 2컷씩 순차 작화·QA·수정 → 작품 조립. 이 방식도 2컷씩 생성/승인하는 원칙을 유지한다.
그림 결과 때문에 각본 변경이 필요한 경우에만 LLM 단계로 돌아가 변경 범위의 콘티를 재생성한다.
완전히 대화형으로 2컷마다 LLM↔이미지 모델을 교체하는 모드도 가능하지만, 모델 로딩 오버헤드가 크므로 기본값이 아니다.
우선 Colab notebook에서 batch runner와 영구 아티팩트(예: Google Drive) 저장을 구현하고, 웹 UI는 가져오기/보기/편집/승인/내보내기를 수행하도록 한다. Colab 내부 127.0.0.1은 외부 브라우저와 동일하지 않으므로 접근 설계를 별도로 검증한다.
세션 재시작 시 마지막 완료 pair의 승인본을 기반으로 정확히 재개한다. 중복 작업 ID는 재실행되어도 승인 파일을 덮지 않는다.

## 현재 GitLab의 수정 위치
- src/app/main.tsx: 기존 단순 2컷 호출 및 배열 누적 → durable pair job/state machine.
- src/app/queries/predictNextPanels.ts + getStoryContinuation.ts: 정교한 2컷 계획·스토리 상태·화자·말풍선 schema.
- src/types.ts: master/pair/panel/render_attempt/qa/approval 타입 추가.
- src/app/engine/comfyui.ts: 업로드 이미지 참조, region masks, ControlNet/IPAdapter 조건화, inpaint workflow.
- src/app/engine/render.ts: job ID, prompt ID, retry, failure evidence 연결.
- src/app/interface/panel/index.tsx: 컷1 승인 의존 컷2, 독립 editable bubble/text layer 표시.
- src/lib/bubble/injectSpeechBubbleInTheBackground.ts: 현재 래스터 글자 합성 대신 수정 가능한 말풍선/텍스트 분리.
- src/app/store/index.ts: 브라우저 임시 state와 영속적 작업/승인 기록 분리.
- 신규: src/lib/webtoon/{schema,continuity,reference-selector,layout,balloons,qa}.ts, scripts/colab_runner.py, tests/.

## 단계별 개발과 통과 게이트
G0. 환경 검증: npm ci / TypeScript·build / ComfyUI 한 컷 / T4 최고 VRAM / Qwen Q4 부팅 실측. 통과 전 고급 제어 추가 금지.
G1. Schema & 저장: 잘못된 컷 수·미등록 인물·화자·state 전이를 차단. master 불변성 및 충돌 방지 테스트.
G2. 원본 등록: 외형이 구별되는 2인/2개 장소의 얼굴·3/4·전신·의상 승인 master.
G3. LLM 콘티: 연속 2컷 JSON, 시간·동선·대사·화자·스크린 방향·말풍선 bbox 검사.
G4. 이미지 참조 A/B: txt2img vs 단일 master vs 캐릭터별 regional vs regional+pose를 같은 장면/seed/해상도에서 비교. T4/Illustrious에서 성공한 최소 조합만 채택.
G5. 빈 말풍선 레이어와 정확한 한국어 조판; 편집/재내보내기 후 데이터 동일성.
G6. QA/수정/승인: 3회 초과 BLOCKED, 거절본 참조 금지, 승인본 불변, 세션 재시작 복구.
G7. 검증 파일럿 **20쌍(40컷)**: 같은 장소 대화, 교차 동선, 전신/클로즈업, 소품 전달, 의상 변경, 장소 전환, 다중 말풍선. **승인본**에서 인물 뒤바뀜·대사 누락/오배치·마스터 정보 손상 0건. 첫 시도 성공률과 수리 횟수는 실측값 보고.
G8. 전체 회차/반복 실행: 3개 이상의 별도 시나리오, 중단·복구 및 장면 변경, 웹툰 세로 출력 회귀 검사.

**완료 조건:** '모델이 한 번에 완벽하게 그림'이 아니라, 오류를 검출하고 부분 수정하며 승인된 컷과 고정 원본만을 차기 생성에 사용하고, 재개/내보내기까지 일관되게 동작하는 웹툰 제작 파이프라인.

## 기술적 근거(실제 조합 성공의 증거는 아님)
- ComfyUI official workflow API example: https://github.com/comfyorg/comfyui/blob/master/script_examples/websockets_api_example.py
- IP-Adapter SDXL / regional conditioning: https://github.com/comfyorg/comfyui-ipadapter
- ControlNet preprocessors / pose and depth: https://github.com/comfyorg/comfyui-controlnet-aux
- ComfyUI img2img / inpainting: https://comfyanonymous.github.io/ComfyUI_examples/
