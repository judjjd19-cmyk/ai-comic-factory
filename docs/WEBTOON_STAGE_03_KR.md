# G1.2 — 영속적 웹툰 프로젝트·2컷 승인 저장소

구현: `src/lib/webtoon/projectStore.ts`
테스트: `tests/webtoon-project-store.test.mjs`

- 프로젝트 생성 시 캐릭터 원본(master)과 승인된 기준 이미지 메타데이터를 등록한다. 모델 결과는 원본을 자동으로 변경할 수 없다.
- 승인된 이전 2컷의 `after` 상태와 다음 2컷의 `before` 상태가 일치할 때만 다음 작업을 등록한다.
- 작업의 `planned → validated → rendering_first → review_first → first_approved → rendering_second → review_second → approved` 순서를 강제한다.
- 렌더 이미지는 초안으로 저장하고, 승인되기 전에는 다음 컷의 참조로 사용하지 않는다. 승인된 이미지 기록에는 SHA-256을 남긴다.
- 프로젝트 메타데이터는 잠금 디렉터리, 임시 파일, 원자적 교체를 사용하며 `revision` 충돌을 감지한다.
- 임시 이미지 기록 후 실제 SHA-256 검사에 실패하면 승인을 거부한다. 실패 후에는 저장된 작업 상태가 변경되지 않는다.

## Colab 설정

`WEBTOON_DATA_DIR=/content/drive/MyDrive/WebtoonProjects`처럼 드라이브에 마운트된 경로를 지정한다. 미지정 시 앱 작업 디렉터리의 `webtoon-data/`에 저장되는데, Colab 세션에서 사라질 수 있다. Google Drive FUSE와 로컬 파일시스템의 원자적 이름 변경·잠금 특성은 실제 환경에서 검증해야 한다.

## 검증

Node.js 22의 테스트 명령: `npm run test:webtoon` (현재 18개 단위 테스트 통과).
기존 `.nvmrc`는 Node 20이고 Next.js 앱 전체 빌드는 아직 검증하지 못했다. 실제 Colab 모델·이미지 합성 E2E도 미검증.

## 미구현

- 인물 정면·측면·전신 원본 생성과 등록 UI
- `planNextPair`와 새 프로젝트 저장소를 연결하는 사용자 화면
- ComfyUI로 기준 이미지 업로드, 다중 인물 영역 조건화, 포즈/배경 참조
- 얼굴·손·의상·위치·말풍선 자동 시각 QA 및 부분 인페인팅
- 사용자 인증, 멀티호스트 동시 쓰기, 자동 복구 및 드라이브에 대한 E2E 테스트

현재는 서버 내부에서 사용할 수 있는 저장소 클래스만 구현했다. **공개 API로 노출하지 않는다.** 실제 승인 권한 검증과 자동 QA가 없기 때문이다.