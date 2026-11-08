import "server-only"
import { randomUUID, createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { RenderedScene } from "@/types"
import { bindReferenceNodes, type UploadedReference, type ComfyBindings } from "@/lib/webtoon/comfyReference"
import { buildAutoIPAdapter } from '@/lib/webtoon/autoAdapter'
import type { PanelPlan } from '@/lib/webtoon/contracts'

type WorkflowReferences = { uploaded: UploadedReference[]; bindings?: ComfyBindings; auto?: { panel: PanelPlan; masks:Record<string,string> } }

// ComfyUI's exported API workflow is a dictionary keyed by node ID.
type Inputs = Record<string, unknown>
type Workflow = Record<string, { class_type: string; inputs: Inputs }>
type ImageOutput = { filename: string; subfolder?: string; type?: string }

function endpoint(): string {
  const value = process.env.COMFYUI_API_URL || "http://127.0.0.1:8188"
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("COMFYUI_API_URL must be an HTTP(S) URL")
  }
  return url.origin + url.pathname.replace(/\/+$/, "")
}

function nodesByType(workflow: Workflow, classes: string[]) {
  return Object.entries(workflow).filter(([, node]) => classes.includes(node.class_type))
}

function fromConnection(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length < 1) return undefined
  return String(value[0])
}

function nodeForText(workflow: Workflow, sampler: Inputs, which: "positive" | "negative"): string {
  const explicit = process.env[which === "positive" ? "COMFYUI_POSITIVE_NODE_ID" : "COMFYUI_NEGATIVE_NODE_ID"]
  const id = explicit || fromConnection(sampler[which])
  if (!id || !workflow[id] || workflow[id].class_type !== "CLIPTextEncode") {
    throw new Error("Cannot resolve CLIPTextEncode node for " + which + "; configure COMFYUI_" + which.toUpperCase() + "_NODE_ID")
  }
  return id
}

function numeric(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error("Invalid numeric ComfyUI configuration")
  return n
}

export async function prepareComfyUIWorkflow(prompt: string, width: number, height: number, references?: WorkflowReferences): Promise<Workflow> {
  if (!prompt.trim()) throw new Error("Cannot render an empty prompt")
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64) {
    throw new Error("Invalid image dimensions")
  }
  const workflowPath = resolve(process.cwd(), process.env.COMFYUI_WORKFLOW_PATH || "comfyui/workflow-api.json")
  const parsed: unknown = JSON.parse(await readFile(workflowPath, "utf8"))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ComfyUI workflow must be an API-format node dictionary")
  }
  let workflow = parsed as Workflow
  const samplers = nodesByType(workflow, ["KSampler", "KSamplerAdvanced"])
  const samplerId = process.env.COMFYUI_SAMPLER_NODE_ID || samplers[0]?.[0]
  if (!samplerId || !workflow[samplerId]) throw new Error("Workflow needs a KSampler node")
  const sampler = workflow[samplerId].inputs
  const positiveId = nodeForText(workflow, sampler, "positive")
  const negativeId = nodeForText(workflow, sampler, "negative")

  workflow[positiveId].inputs.text = prompt
  workflow[negativeId].inputs.text = process.env.COMFYUI_NEGATIVE_PROMPT ||
    "speech bubbles, subtitles, captions, text, watermark, logo, low quality"
  for (const [, node] of nodesByType(workflow, ["EmptyLatentImage", "EmptySD3LatentImage"])) {
    node.inputs.width = width
    node.inputs.height = height
    if ("batch_size" in node.inputs) node.inputs.batch_size = 1
  }
  if ("seed" in sampler) sampler.seed = Math.floor(Math.random() * 2000000000)

  const checkpoint = process.env.COMFYUI_CHECKPOINT_NAME
  if (checkpoint) {
    const loaders = nodesByType(workflow, ["CheckpointLoaderSimple"])
    if (loaders.length !== 1) throw new Error("Set exactly one CheckpointLoaderSimple or configure the workflow manually")
    loaders[0][1].inputs.ckpt_name = checkpoint
  }
  const styleLoRA = process.env.COMFYUI_STYLE_LORA_NAME
  if (styleLoRA) {
    const loaders = nodesByType(workflow, ["LoraLoader"])
    if (loaders.length > 1) throw new Error("A webtoon style workflow may contain at most one LoraLoader")
    let inputs: Inputs
    if (loaders.length === 1) {
      inputs = loaders[0][1].inputs
    } else {
      // Insert the webtoon style LoRA only when a real adapter is configured.
      // The checkpoint, text encoders and sampler remain valid without one.
      const checkpoints = nodesByType(workflow, ["CheckpointLoaderSimple"])
      if (checkpoints.length !== 1) throw new Error("Automatic LoRA insertion requires one CheckpointLoaderSimple")
      const checkpointId = checkpoints[0][0]
      const styleId = "auto_webtoon_style_lora"
      if (workflow[styleId]) throw new Error("Reserved ComfyUI LoRA node ID is already in use")
      inputs = {
        model: [checkpointId, 0],
        clip: [checkpointId, 1],
      }
      workflow[styleId] = { class_type: "LoraLoader", inputs }
      sampler.model = [styleId, 0]
      workflow[positiveId].inputs.clip = [styleId, 1]
      workflow[negativeId].inputs.clip = [styleId, 1]
    }
    inputs.lora_name = styleLoRA
    inputs.strength_model = numeric(process.env.COMFYUI_STYLE_LORA_STRENGTH, 0.8)
    inputs.strength_clip = numeric(process.env.COMFYUI_STYLE_LORA_CLIP_STRENGTH, 0.8)
  }
  if (!nodesByType(workflow, ["SaveImage"]).length) throw new Error("Workflow must contain SaveImage")
  if (references?.uploaded.length && references.auto) {
    workflow = buildAutoIPAdapter(workflow,references.uploaded,references.auto.panel,references.auto.masks,
      process.env.COMFYUI_IPADAPTER_FILE || 'ip-adapter-plus_sdxl_vit-h.safetensors',
      process.env.COMFYUI_CLIP_VISION_FILE || 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors')
  } else if (references?.uploaded.length) {
    workflow = bindReferenceNodes(workflow,references.uploaded,references.bindings||{})
  }
  return workflow
}

function scene(renderId: string, status: RenderedScene["status"], alt = "", assetUrl = "", error = ""): RenderedScene {
  return { renderId, status, assetUrl, alt, error, maskUrl: "", segments: [] }
}

export async function submitComfyUI(prompt: string, width: number, height: number, references?: WorkflowReferences): Promise<RenderedScene> {
  const workflow = await prepareComfyUIWorkflow(prompt, width, height, references)
  const res = await fetch(endpoint() + "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }),
    cache: "no-store",
  })
  if (!res.ok) throw new Error("ComfyUI submission failed (" + res.status + "): " + (await res.text()).slice(0, 1200))
  const result = await res.json() as { prompt_id?: string; error?: string }
  if (!result.prompt_id) throw new Error("ComfyUI did not return prompt_id: " + JSON.stringify(result))
  const samplers=nodesByType(workflow,["KSampler","KSamplerAdvanced"])
  const seed=Number(samplers[0]?.[1]?.inputs.seed)
  const fingerprint=createHash("sha256").update(JSON.stringify(workflow)).digest("hex")
  return {...scene(result.prompt_id, "pending", prompt),renderMeta:{
    seed:Number.isSafeInteger(seed)?seed:null,workflowSha256:fingerprint,
    checkpoint:process.env.COMFYUI_CHECKPOINT_NAME||"",
    styleLoRA:process.env.COMFYUI_STYLE_LORA_NAME||""
  }}
}

export async function pollComfyUI(promptId: string): Promise<RenderedScene> {
  if (!/^[a-zA-Z0-9_-]{6,128}$/.test(promptId)) throw new Error("Invalid ComfyUI prompt ID")
  const res = await fetch(endpoint() + "/history/" + encodeURIComponent(promptId), { cache: "no-store" })
  if (res.status === 404) return scene(promptId, "pending")
  if (!res.ok) throw new Error("ComfyUI history failed (" + res.status + ")")
  const records = await res.json() as Record<string, {
    status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
    outputs?: Record<string, { images?: ImageOutput[] }>;
  }>
  const history = records[promptId]
  if (!history) return scene(promptId, "pending")
  if (history.status?.status_str === "error") {
    return scene(promptId, "error", "", "", "ComfyUI execution error: " + JSON.stringify(history.status.messages || []).slice(0, 800))
  }
  if (!history.status?.completed && !history.outputs) return scene(promptId, "pending")
  const images = Object.values(history.outputs || {}).flatMap(output => output.images || [])
  const selected = images.find(item => item.type === "output") || images[0]
  if (!selected?.filename) return scene(promptId, "error", "", "", "ComfyUI completed without an output image")
  const url = new URL(endpoint() + "/view")
  url.searchParams.set("filename", selected.filename)
  url.searchParams.set("subfolder", selected.subfolder || "")
  url.searchParams.set("type", selected.type || "output")
  const img = await fetch(url, { cache: "no-store" })
  if (!img.ok) throw new Error("ComfyUI output retrieval failed (" + img.status + ")")
  const contentType = img.headers.get("content-type") || "image/png"
  if (!contentType.startsWith("image/")) throw new Error("ComfyUI returned non-image content")
  const assetUrl = "data:" + contentType + ";base64," + Buffer.from(await img.arrayBuffer()).toString("base64")
  return scene(promptId, "completed", "", assetUrl)
}
