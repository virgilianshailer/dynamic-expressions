# 🎭 Dynamic Expressions — SillyTavern Extension

A SillyTavern extension that **dynamically generates character sprites** based on the current roleplay context, replacing the traditional static `expressions/<emotion>.png` sprite system. Instead of swapping pre-made files, it edits the character's avatar in real time using **FLUX.2 Klein** through ComfyUI / SwarmUI to reflect the character's current emotion, pose, and clothing.

---

## ✨ Features

- **Live sprite generation** — Every assistant message triggers a new sprite that reflects what just happened in the scene (expression, pose, outfit).
- **Avatar as identity anchor** — Uses the character's avatar as a reference image, so the generated sprite preserves face, hair, and identity instead of drawing a brand-new person.
- **Edit-style prompting** — Asks the LLM to produce *instructions* ("make her smile, cross her arms") instead of *tag lists*, which is what FLUX.2 Klein's edit model expects.
- **Visual Novel + Solo mode** — Works inside SillyTavern's Visual Novel wrapper (with speaker highlighting and dimming) and in standard expression mode.
- **Group chat aware** — Tracks active sprite per character in group chats.
- **Sprite Shield** — A MutationObserver-based guard that prevents SillyTavern core from clearing or replacing the generated sprite on user messages or chat refreshes.
- **Non-character card detection** — Automatically skips cards that describe locations, objects, or abstract concepts (uses the LLM to classify once, then caches).
- **Persistent sprites** — Last generated sprite per character is cached in `localStorage` and restored when the chat is reopened.
- **AutoBackground compatibility** — Detects and ignores silent-mode background generation messages from the AutoBackground extension.
- **Two workflow sources** — Built-in FLUX.2 Klein workflow, or any custom workflow loaded through the AutoIllustrator extension.

---

## 📦 Installation

1. In SillyTavern, open **Extensions → Install Extension**.
2. Paste the URL of this repository and click **Install**.

Or install manually:

```
SillyTavern/
└── public/
    └── extensions/
        └── third-party/
            └── dynamic-expressions/
                ├── index.js
                └── manifest.json
```

Clone or copy the files into a folder named `dynamic-expressions` inside `public/extensions/third-party/`, then reload SillyTavern.

---

## 🖼️ Backend Setup — SwarmUI + FLUX.2 Klein

This extension talks to a ComfyUI-compatible backend over its HTTP API. The recommended setup is **SwarmUI**, since the built-in workflow uses Swarm-specific nodes (`SwarmKSampler`, `SwarmLoadImageB64`, `SwarmRemBg`) that ship with SwarmUI's ComfyUI backend.

### 1. Install SwarmUI

Follow the official install guide: <https://github.com/mcmonkeyprojects/SwarmUI>

After install, SwarmUI exposes its ComfyUI backend on `http://127.0.0.1:7801` by default. The extension expects the **raw ComfyUI URL**, typically `http://127.0.0.1:7821` (Swarm's internal ComfyUI port) or `http://127.0.0.1:8188` for a standalone ComfyUI. You can change this in SillyTavern's **Stable Diffusion → ComfyUI URL** field — the extension reads from there.

### 2. Download the required models

The built-in workflow references three model files. Place them under your SwarmUI `Models/` folder (or your shared model root if you use one):

| File | Folder | Source |
|---|---|---|
| `flux-2-klein-4b-fp8.safetensors` | `Models/diffusion_models/Flux2/` | [Black Forest Labs · FLUX.2-klein-4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) |
| `flux2-vae.safetensors` | `Models/vae/Flux/` | Same repo — VAE file |
| `qwen_3_4b.safetensors` | `Models/clip/` | [Qwen3 4B text encoder for FLUX.2](https://huggingface.co/Comfy-Org/flux2_text_encoders) |

> **Note on subfolders:** The built-in workflow loads models from `Flux2\flux-2-klein-4b-fp8.safetensors` and `Flux\flux2-vae.safetensors` (Windows-style paths). This means SwarmUI/ComfyUI expects them inside the `Flux2/` and `Flux/` subfolders shown above. If you have the files in a different layout, either move them or edit `buildInternalFluxWorkflow()` in `index.js` to match your paths.

> **9B variant:** If you have the FP16 or FP8 **9B** Klein model instead, edit `index.js` and replace the `unet_name` value on node `"4"` (around line 503) with your filename. The 9B model has stronger identity preservation but is slower.

### 3. Make sure SwarmUI's backend is running

Open SwarmUI in your browser. If the model loads correctly in Swarm's own "Generate" tab, the extension will be able to use it too.

---

## ⚙️ Settings

Open **Extensions → 🎭 Dynamic Sprite Expressions** in the SillyTavern sidebar.

| Setting | Description |
|---|---|
| **Enable Dynamic Sprites** | Master toggle. |
| **Skip non-character cards** | Uses the LLM to detect whether a card is a person/creature vs a location/object/concept, and skips the latter. Cached per card. |
| **Clear cache** | Wipes the character-type cache so cards are re-classified on the next message. |
| **Workflow Source** | `Built-in: Flux 2 Klein (SwarmUI)` or `Custom: AutoIllustrator Preset`. |
| **AI Preset** | (Custom mode only) Pick a workflow exported from the AutoIllustrator extension. |
| **Sprite Format** | `Face` (close-up), `Upper Body` (default), or `Full Body`. |
| **Negative Prompt** | Default targets identity drift: `different person, new face, identity change, multiple people, extra characters, scenery, complex background, text, watermark`. |
| **Test Generation** | Runs one generation immediately using the current chat state — useful for verifying the backend setup. |

---

## 🎨 How It Works

1. On every assistant message, the extension reads the message text and the active character card.
2. It sends a meta-prompt to your LLM asking for an **edit instruction** in plain English (e.g. *"Make her expression a soft smile. Change the pose to crossed arms. Keep her face, hair color, hair length, eye color and identity exactly the same as the reference image. Background: plain white."*).
3. The character's avatar is loaded, base64-encoded, and passed to ComfyUI as the reference image (`SwarmLoadImageB64` → `VAEEncode` → `ReferenceLatent`).
4. FLUX.2 Klein generates the modified sprite. Background is removed with `SwarmRemBg`.
5. The resulting PNG is injected into SillyTavern's expression holder, cached, and protected by the Sprite Shield against ST core overwrites.

The reason this extension uses **edit-style prompts** rather than tag lists: FLUX.2 Klein is an *image edit* model, not a text-to-image model. Descriptive prompts like `long black hair, blue eyes, smiling, looking at viewer` are interpreted as a request to generate a *new* person matching that description — not to edit the reference. Imperative instructions like `make her smile, keep her face the same` work as intended.

---

## 📋 Requirements

- SillyTavern (recent version with extension support)
- Any LLM backend connected to SillyTavern (used to write the sprite edit instructions and classify card types)
- **SwarmUI** running locally (or a ComfyUI install with the SwarmUI extra-nodes pack installed, since the built-in workflow uses `SwarmKSampler`, `SwarmLoadImageB64`, and `SwarmRemBg`)
- FLUX.2 Klein 4B (or 9B) model files placed in the correct SwarmUI folders

---

## 🐞 Troubleshooting

| Symptom | Likely cause |
|---|---|
| `ComfyUI error: ... not found in nodes` | You are running standalone ComfyUI without SwarmUI's extra-nodes pack. Either switch to SwarmUI, or install the [SwarmUI ComfyUI nodes](https://github.com/mcmonkeyprojects/SwarmComfyExtra). |
| Sprite looks like a different person | Klein's known identity drift. Try a longer/clearer `keep her face exactly the same as the reference` clause via the LLM's edit instructions, or switch to the 9B Klein model for stronger identity preservation. |
| `ComfyUI error: file 'flux-2-klein-4b-fp8.safetensors' not found` | Model is not at `Models/diffusion_models/Flux2/`. Either move it there or edit the path in `buildInternalFluxWorkflow()`. |
| Sprite disappears on user message | The Sprite Shield should prevent this. If it still happens, check the browser console for `[DynamicExpressions]` errors and file an issue. |
| Generation never finishes | The extension times out after ~3 minutes. Check that SwarmUI's backend is responding on the configured URL. |

---

## 📄 License

MIT — free to use, modify, and distribute.
