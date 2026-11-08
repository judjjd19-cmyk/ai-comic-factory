# AI Comic Factory — upstream import and local webtoon migration

The GitLab repository began with only its default README; the original AI Comic Factory source code is not yet present.
Original: https://github.com/jbilcke-hf/ai-comic-factory (archived 2025-10-31).

## Import with GitLab CI

1. Open Settings > CI/CD > Job token permissions.
2. Enable **Allow Git push requests to the repository** and save.
3. Under Build > Pipelines, run a pipeline for `main`, then play its manual `import_upstream` job.
4. Verify that the new `upstream-import` branch contains `src/`, `public/`, and `package.json`.
5. Start application development on a feature branch from `upstream-import`.

The importer preserves upstream Git history and refuses to overwrite an existing import branch. It does not execute upstream code.
Do not force-push into the unrelated GitLab scaffold `main` branch.

Alternative: clone https://github.com/jbilcke-hf/ai-comic-factory.git on your own computer,
add remote https://gitlab.com/judjjd19/ai-comic-factory.git and push `main:refs/heads/upstream-import`.

## Intended pipeline (design, not implemented yet)

1. Story LLM with an **optional story-writing/scene-planning LoRA** (loaded by the inference server).
2. Validated episode, scene, dialogue, camera, and panel specifications in JSON.
3. ComfyUI image generation with an **optional webtoon visual-style LoRA** (loaded by ComfyUI).
4. Reference-image/character-sheet and location continuity, without per-character LoRA training.
5. Comic editor: Korean text, speech balloons, vertical composition, quality checks and local regeneration.

Image API: ComfyUI `POST /prompt`, WebSocket `/ws`, `GET /history/{prompt_id}`, and `GET /view`.
LLM API: local OpenAI-compatible endpoint. Neither model-specific LoRA is loaded by the Next.js app itself.

**Current status:** preparation only. No image models or end-to-end webtoon generation have been tested.
