# Laundry Hacks — deploy notes

Everything is wired up and ready to push to GitHub Pages. This doc explains what changed, the prompt design, and how to deploy.

## What's in the folder

| File | Purpose |
|---|---|
| `index.html` | UI shell. Laundry tab + 4 screens (upload, confident match, category picker, treatment, after-photo). |
| `app.js` | App logic. New: `STAIN_SYSTEM_PROMPT`, `analyzeStain`, `findStainInPlaybook`, `getStainTreatment`, `renderStainResult`, `startTreatment`, `verifyStainRemoved`. |
| `laundry_playbook.json` | **802 stains** in machine-readable form. 22 internal categories, 9 user-facing picker categories. Each stain has: id, name, category, urgency, treatment_summary, steps[], products[], fabric_compatibility{safe, avoid, full_note}. |
| `laundry_stain_names.txt` | Plain-text list of all 802 stain names. Build artifact — useful for reference. |
| `sw.js` | Service worker. Cache bumped to `tidyai-v5-stain802` so users get the new playbook on next load. |

## The prompt design

`STAIN_SYSTEM_PROMPT` in `app.js` is the heart of identification. It's structured in 5 parts:

1. **Role & job description** — identify the stain, never prescribe treatment (the JSON playbook does that)
2. **AI Vision Identification Guide** — four axes the model uses:
   - **Color** (yellow/orange, red/pink, brown, black, blue/green, clear oily, white/cream — each with 5–10 candidate stains)
   - **Texture** (glossy/oily → fat; crusty → protein; sticky → sugar/polymer; powdery → dry pigment; crystalline → salt/sugar; fuzzy → mold; brittle → cured polymer)
   - **Location** (collar, pit, lap, knee, bum, cuff, hem, pocket)
   - **Freshness** (wet border, halo ring, crusty edge, sticky outside, stiff fabric)
3. **Category structure** — the 22 internal categories with representative stain names from each, so the model can return an exact name the playbook lookup will match
4. **Response schema** — strict JSON in one of two shapes (confident match vs. needs-category)
5. **Edge cases & tone rules** — non-fabric surfaces, blurry photos, multiple stains; plus the hard rules: never moralize, never reference the story behind the stain, never use shame, never push a brand

**Size & cost:** ~28KB / ~7K input tokens / ~$0.001 per scan with `gpt-4o-mini`. About 500 scans per $1.

## The data flow

```
User snaps stain photo
        │
        ▼
analyzeStain()  ──────► OpenAI Vision API (with STAIN_SYSTEM_PROMPT)
        │
        ▼
Returns JSON: { confident: true, stain_name: "Red wine", ... }
        │
        ▼
findStainInPlaybook("Red wine")  ──► PLAYBOOK.stains  (laundry_playbook.json)
        │
        ▼
Match found: { steps: [...], products: [...], fabric_compatibility: {...} }
        │
        ▼
renderStainResult() shows confident match card
        │
        ▼
User taps "Start treatment"
        │
        ▼
startTreatment() walks them through the steps one at a time
        │
        ▼
"After" photo → verifyStainRemoved() → reassure or suggest a second pass
```

If the model isn't confident (Shape B), the user sees a category picker (9 user-facing categories) plus 3–6 candidate stain names. Pick one → re-run `analyzeStain` with that category → narrowed second pass.

## Deploying to GitHub Pages

1. Open your GitHub repo (`monikanorkune-alt/Tidyai`).
2. Click **Add file → Upload files**.
3. Drag the entire contents of the `tidyai/` Desktop folder onto the upload zone:
   - `index.html`
   - `app.js`
   - `laundry_playbook.json` (this is the big one — 530KB)
   - `sw.js`
   - `manifest.json`
   - `icons/`
4. Commit message: `Add Laundry Hacks with 802-stain playbook`.
5. Click **Commit changes**.
6. Wait ~60 seconds for GitHub Pages to redeploy.
7. On your phone, close any open TidyAI tabs, then re-open the URL. The new service worker version (`tidyai-v5-stain802`) will activate and pull the new playbook + prompt.

If your phone shows the old version: pull to refresh, or close all Safari tabs and reopen. The cache-bump handles it automatically.

## Quick smoke test once deployed

1. Open the URL on your phone.
2. Tap **Laundry** in the bottom nav.
3. Tap **From gallery**, choose any stain photo. If you don't have one handy, search Google Images for "red wine on white shirt" and save one to your camera roll.
4. Tap **Identify stain**.
5. You should see "Most likely RED WINE" with category "Food & drink", urgency "act now", and a step-by-step treatment with Wine Away listed as the primary product.
6. Tap **Start treatment** to walk through the steps.

## Common pitfalls

- **Stain identified but treatment screen shows no steps.** The playbook lookup didn't find a match. Open the JS console — `findStainInPlaybook` returned null. Likely cause: the model returned a name that's spelled differently from any of the 802 entries. The fuzzy match handles most variations but not all. Quick fix: tap "Wrong stain?" and pick from the category list, then choose the specific stain.
- **"OpenAI error: 400" on identification.** Image too big or wrong format. The app downscales to 1024px and converts to JPEG. If the image is an HEIC from iPhone, the safety net in `onStainFileChosen` sends the original bytes; OpenAI handles HEIC natively.
- **Categories empty / "Loading categories…" forever.** `laundry_playbook.json` didn't load. Check the Network tab in dev tools — it should return 200 with ~530KB of JSON.

## What you can add later

- **Per-fabric warnings on the step screen.** The data is in each stain's `fabric_compatibility.full_note` — currently shown above the steps. Could be a dedicated warning banner if the model also returns `fabric_observation`.
- **Browse by category.** The data structure already supports it — just add a "Browse playbook" button that opens the 9-category picker without needing a photo first. Good for power users.
- **Treatment history.** State already tracks `state.stainHistory[]`. Add a "Recent treatments" section under the upload card.
- **Product affiliate links.** Each stain has a `products[]` array with role-tagged names. Wire them to Amazon affiliate URLs (or whatever you use).

## Sources baked into the playbook

The 802 entries are compiled from: r/laundry (especially KismaiAesthetics's spa day posts), r/CleaningTips, r/HomeImprovement, r/Frugal, Tide's stain library, Clorox how-tos, OxiClean stain solutions, Whirlpool/Maytag laundry blog posts, lifestyle blog reviews on Amazon/Trustpilot, Reader's Digest and BuzzFeed cleaning compilations, Branch Basics, ARM & HAMMER, The Laundress, Style Blueprint, HowStuffWorks. Full source list in the docx playbook on your Desktop.
