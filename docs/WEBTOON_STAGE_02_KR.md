# G1.1 — validated two-panel LLM planner

This stage introduces `src/lib/webtoon/pairPlanner.ts` and
`src/app/queries/planNextPair.ts`, without replacing the current UI generator.
The default UI still uses `getStoryContinuation` until character master registration
and persistent production jobs are implemented. This is an intentional migration
boundary: the new planner requires a pre-approved character/location catalog.

`planNextPair` calls the existing OpenAI-compatible LLM provider. Qwen3.5-9B
with its optional story adapter can serve that endpoint. It instructs the model
to output two scene-linked panels with actor IDs, outfits, normalized positions,
scene states, camera, speaker IDs and editable bubble plans. It reads the
`before` state only from the approved server-side snapshot, not the model.

Pure functions have offline Node.js 22 tests:

```
node --experimental-strip-types --test tests/webtoon-*.test.mjs
```

Unit tests cover malformed JSON, wrong speakers, wrong panel count, immutable
prior state, retry with structured feedback, and terminal failure. The existing
seven schema/reference/approval tests also remain active (14 total).

**Not yet done:** model serving in Colab, registering character masters in UI,
ComfyUI reference-image conditioning, two-panel runner integration, image QA,
permanent state storage, or Next.js build verification.

Next step: implement immutable asset registry, durable pair jobs and a safe
export/import path for Colab; then wire the new planner to the UI. Do not
use previous images as a canonical identity reference.