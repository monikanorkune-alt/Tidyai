# TidyAI — MVP

A mobile-first PWA that turns a photo of any room into a 3-minute quick-clean plan, with fair chore assignment across your family.

## What it does

- **Scan**: snap or upload a room photo. The app sends it to OpenAI's vision model and gets back a cleanliness score, a short summary, and a list of specific tasks tied to what's actually visible.
- **3-minute quick-clean plan**: the AI tags 2–4 tasks as "quick wins" totaling ~3 minutes. The biggest visible impact, fastest. Save them to your task list with one tap.
- **Family fair-share**: add family members. New tasks auto-assign to whoever has the lowest open-minute load. Tap "Reassign fairly" to rebalance everything at once.
- **Tasks tab**: filter by person, quick wins, or "done". Reassign with a dropdown.
- **Installable**: works offline as a PWA. On iOS, open in Safari → Share → Add to Home Screen.

## Running it

It's a static site. Any static host works, but you need to serve it over HTTP (not `file://`) for the camera and service worker to work.

**Quickest local run:**
```bash
cd tidyai
python3 -m http.server 8000
# then open http://localhost:8000 on your phone (same wifi)
# or http://<your-computer-ip>:8000 from your phone
```

For real phone testing, deploy to Netlify, Vercel, or GitHub Pages — drag the `tidyai/` folder onto Netlify Drop and you're done.

## Setup

1. Open the app.
2. Tap **Settings** in the bottom tab bar.
3. Paste your OpenAI API key (get one at https://platform.openai.com/api-keys) and tap **Save**.
4. Choose a model:
   - `gpt-4o-mini` — fast, cheap (~$0.001–0.002 per scan)
   - `gpt-4o` — slower, sharper analysis
5. Tap **Family**, add the people who'll share chores.
6. Go to **Scan**, choose a photo, hit **Analyze**.

The API key is stored only in your browser's localStorage. It's never sent anywhere except directly to OpenAI when you tap Analyze.

## Files

- `index.html` — UI shell, all CSS inline
- `app.js` — state, OpenAI call, family logic, render functions
- `manifest.json` — PWA manifest (installable)
- `sw.js` — service worker, caches the app shell for offline use
- `icons/` — 192px and 512px app icons

## Architecture notes

- **State**: pure localStorage. Five keys: API key, model, family[], tasks[], lastScan.
- **Photo handling**: images are downscaled to max 1024px and re-encoded as JPEG at 0.85 quality before sending, to keep API costs low.
- **AI contract**: the system prompt asks for strict JSON with `cleanliness_score`, `summary`, `room_type`, and `items[]` where each item has `id`, `title`, `why`, `minutes`, `priority`, `quick_win`. Uses OpenAI's `response_format: json_object` for reliability.
- **Fair assignment** (`autoAssign` in app.js): each new task goes to the family member whose open tasks sum to the fewest minutes. `reassignAll` clears all assignments and re-balances starting from the longest tasks first, which produces a near-optimal split for small task lists.

## What's intentionally not in the MVP

- Plant health detection (you skipped this option — easy to add later as another field in the JSON schema).
- Multi-user sync. Each device is its own database.
- Notifications / scheduled scans.
- Login / accounts.
- Before/after comparison photos.

## Next steps if you want to keep building

1. **Plant care add-on**: extend the system prompt to also return `plants: [{location, issue, action}]` and render a third section on the scan results screen.
2. **Cloud sync**: swap localStorage for Supabase or Firebase; add anonymous auth so a household shares one task list across phones.
3. **Streaks & rewards**: count completed quick-clean sessions per member, show a weekly leaderboard.
4. **Voice mode**: have GPT read the 3-minute plan aloud, hands-free while you clean.

## Cost estimate

With `gpt-4o-mini` at `detail: 'low'` (what this app uses), one scan is roughly **$0.001–0.003**. You'd need ~500 scans to spend $1.
