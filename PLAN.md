# PLAN.md — Court Call: Development Plan

## Current Architecture

### System Dependency Graph

```
Game (main.js) ─── orchestrates everything; owns scene, physics, systems, entities
 ├── Renderer (Three.js r170, NeutralToneMapping, sRGB) ──→ PostFX (composer per quality tier)
 ├── Quality (graphics tier singleton) ──→ Game._applyQuality → WeatherSystem, PostFX,
 │                                          Textures (anisotropy), World lights, Scenery density
 ├── Physics (cannon-es, NaiveBroadphase)
 ├── InputSystem ──→ Joystick (touch/mouse); Esc/P → Game.togglePause; 1-9 → dialogue choices
 ├── Player ←──→ GolfCart (enter/exit; the attendant sits in the driver's seat)
 │    └── CharacterModel (one SkinnedMesh per person, BlobShadows, CameraTracker)
 ├── NPC[] ──→ CharacterModel; waypoints from map.json
 ├── World ──→ Court, Building, Garden, Scenery (built from map.json; statics merged, props instanced)
 │    └── graphics/Materials, Textures, GeometryUtils (shared materials, canvas textures, geometry caches)
 ├── WeatherSystem ──→ Sky (SkyDome, Stars, Clouds, Horizon), lights, rain, wind, env map
 │    └── writes EnvState every frame; drives Materials wetness + night glow
 ├── SoundSystem (procedural Web Audio; volume / mute / pause)
 ├── DialogueSystem ──→ DialogueBox (typewriter overlay)
 ├── MissionSystem ──→ DialogueSystem, InventorySystem, NPC[]
 ├── InventorySystem (3-slot item store)
 ├── CourtMaintenanceSystem ──→ Court (dirt DataTexture), GolfCart, DialogueSystem, SoundSystem
 ├── SaveSystem + SettingsStore (localStorage) ←── captureSaveData / applySaveData
 ├── HUD ──→ WeatherSystem, MissionSystem, InventorySystem
 └── PauseMenu (volume/mute, graphics quality, camera sensitivity, save, reset)
      HUD, DialogueBox, Joystick and PauseMenu all style themselves from ui/theme.js
```

### Data Flow

```
map.json ──→ World (builds environment) + NPC waypoints + area bounds (normalised by Game._normalizeData)
npcs.json ──→ NPC[] (spawns characters with dialogue pools)
missions.json ──→ MissionSystem (task templates + dialogue scripts)
Constants.js ──→ everything (colors, sizes, tuning values)
graphics/Quality.js ──→ every visual module (read Quality.settings; subscribe with Quality.onChange)
WeatherSystem ──→ EnvState (time, night / lamp / golden factors, wetness, wind, sun) ──→ World, Scenery,
                  Court, GolfCart, NPC tags, PostFX grade
localStorage ←──→ SaveSystem (courtcall.save.v1), SettingsStore (courtcall.settings), Quality (courtcall.quality)
```

### Module Responsibilities

Line counts are from `wc -l` on the current tree (17,118 lines of JS in `src/`).

| Module | Lines | Role |
|--------|------:|------|
| `main.js` | 1377 | Game loop, camera, interaction detection, system wiring, pause/resume, save/load wiring, `setQuality`, shader pre-compile |
| **world/** | | |
| `World.js` | 1527 | Ground, paths, courts, junction props, buildings, garden, shed, patio, parking, perimeter fence, trees, lamps, grass, night lights |
| `Court.js` | 1020 | Shader-painted court surface (zones, lines, clay dirt), net, fence, windscreen, light poles, furniture, physics |
| `Building.js` | 1394 | Pro shop (interior, roof cutaway) and clubhouse, merged by material; wall physics |
| `Garden.js` | 410 | Paver walks, hedges, flower beds, animated fountain |
| `Scenery.js` | 650 | Instanced trees, benches, lamps, flowers, grass tufts, blob shadows; wind-sway shader |
| **entities/** | | |
| `CharacterModel.js` | 707 | Stylized skinned characters (1 draw call each), far LOD, seated pose, blob shadows, camera tracker |
| `Player.js` | 203 | Attendant: physics, walk animation, cart enter/exit (seated in the cart) |
| `GolfCart.js` | 657 | Cart mesh, velocity-based driving, wheel/steer/body-roll animation, lights, brush + clay dust |
| `NPC.js` | 491 | Per-NPC looks, AI state machine, name tags, request marker, reactions |
| **systems/** | | |
| `InputSystem.js` | 283 | Keyboard, touch joystick, camera drag, pause keys, choice keys, enable/disable |
| `WeatherSystem.js` | 634 | Day/night keyframes, weather states, sun/hemisphere lights, shadows, sky, env map, rain, wind; writes EnvState |
| `DialogueSystem.js` | 172 | Dialogue queue, branching choices, keyboard choose/advance |
| `MissionSystem.js` | 462 | Mission lifecycle, task board, radio dispatch, random encounters, `goTo` arrival, save state |
| `InventorySystem.js` | 84 | 3-slot item management, save state |
| `CourtMaintenanceSystem.js` | 627 | Clay grooming session, proximity feedback, courtside tasks, scoring, save/resume |
| `SoundSystem.js` | 554 | Procedural audio via Web Audio API; master volume, mute, pause |
| `SaveSystem.js` | 499 | Versioned localStorage save with migrations + sanitizing; SettingsStore |
| **graphics/** | | |
| `Quality.js` | 163 | low / medium / high tier settings, auto-detect, persistence, change listeners |
| `EnvState.js` | 43 | Shared per-frame environment state (written by WeatherSystem, read by everyone) |
| `Materials.js` | 213 | Cached `MeshStandardMaterial` factory, wetness + night-glow registries, shared shadow-depth materials |
| `Textures.js` | 482 | Seeded noise + cached procedural canvas textures (grass, clay, asphalt, wood, ...) |
| `GeometryUtils.js` | 302 | Geometry caches (incl. rounded boxes), `mergeStaticMeshes`, instancing helpers, `mergeParts` |
| `Sky.js` | 466 | Sky dome, stars, clouds, horizon hills + backdrop treeline + outer ground |
| `PostFX.js` | 225 | EffectComposer chain per tier: MSAA, grade/vignette, GTAO + bloom (high) |
| **ui/** | | |
| `HUD.js` | 1671 | Minimap, task panel, clock, inventory, action button, toasts, radio indicator, grooming overlay |
| `DialogueBox.js` | 454 | Bottom-centre dialogue overlay with typewriter and choice buttons |
| `PauseMenu.js` | 666 | Pause button + overlay: Resume, Settings, Save, Reset progress (confirm) |
| `Joystick.js` | 225 | Virtual joystick for touch/mouse |
| `theme.js` | 126 | Shared UI design tokens (CSS custom properties) and base classes |
| **utils/** | | |
| `Constants.js` | 254 | Colors, sizes, game tuning values, area enums |
| `AssetLoader.js` | 77 | JSON loader with cache and per-file error reporting (`AssetLoadError`) |

---

## Graphics Overhaul — "Sun-drenched country club" (done)

The whole world was rebuilt in a warm, stylized look (A Short Hike / Tiny Glade clarity) from
geometric primitives plus procedural canvas textures. There are still no external model, texture or audio files.

**Foundation (`src/graphics/`)**
- `Quality` tiers (below), auto-detected from the device and switchable live from the pause menu or `game.setQuality(tier)`.
- `EnvState`: one shared environment object that `WeatherSystem` writes each frame and other modules read, so they need no extra wiring.
- `Materials`: a cached `MeshStandardMaterial` factory (`mat`, `getMaterial`, `basicMat`). `registerWet` makes a material darker and glossier in rain. `registerNightGlow` makes a material's emissive follow `EnvState.lampFactor`. `sharedDepthMaterial` keeps the shadow pass from switching programs between plain, instanced and skinned casters.
- `Textures`: seeded fbm/value noise and cached canvas textures (grass with mow stripes, clay, acrylic, asphalt, concrete, pavers, wood, shingles, stucco, siding, hedge, chain-link, tennis net, noise, radial blob). Size is capped by tier (1024 px, 512 px on low).
- `GeometryUtils`: cached primitives and `RoundedBoxGeometry`. `mergeStaticMeshes` merges meshes by material, shadow flags and 32 m grid cell, so merged meshes can still be culled. Also `createInstanced`/`createInstancedBuckets` and `mergeParts` (with vertex colors).

**Rendering and lighting**
- Khronos PBR Neutral tone mapping, used because ACES washed out and hue-shifted the stylized palette. The shadow map updates once per frame. The sun's shadow frustum follows the ground point the camera looks at, so shadows stay crisp near the player.
- 14 keyframes set sun color and intensity, the hemisphere sky/ground fill, and the sky top/horizon colors. Mornings (~6–9) and evenings (~17–19:30) are golden, and nights have cool moonlight. Overcast skies and rain darken the scene. On medium and high, the sky also produces a PMREM environment map. Fog matches the horizon.
- A per-frame color grade in the output pass: cooler and less saturated at night, warmer at golden hour, flatter when overcast.
- All shader variants, including night lights and rain, compile while the loading screen is up, so the first dusk or shower doesn't hitch.

**World**
- The lawn uses vertex-color variation, a textured grass map with mow stripes, and a meadow tone outside the fence. Concrete cart paths have brick edging. Asphalt parking has painted bays and parked cars. Flat layers sit at fixed heights (`World.js` `LAYER`: edge 0.02, path 0.04, lot 0.06, paint 0.078), so nothing z-fights.
- Courts: each court is one shader plane that draws the zones, lines and clay dirt. Dirt and the last brush direction come from an 8×14 `DataTexture`, which gives fresh drag stripes. This replaced the 336 per-cell dirt meshes. Hard courts are US-Open blue with a green surround shared between courts 1 and 2 (`sharedPadLeft`/`sharedPadRight`). Each court also has curbs, a chain-link fence with windscreen, a net, floodlight poles, benches, an umpire chair, a ball hopper, a line broom, a hose reel and signs, for about 9 draw calls.
- Buildings: the pro shop has cream clapboard, a green shingle roof, and an interior with the task board, counter and racket wall. Its roof is cut away while the player is inside. The clubhouse has cream stucco, a slate roof, a colonnade and a cupola. Each building is about 10 draw calls, and windows glow at night.
- Garden and scenery: paver walks, hedges, flower beds and a fountain with GPU-animated spray. There are instanced oak, pine, blossom and cypress trees, benches, lamps, grass tufts, wildflowers and blob contact shadows. The perimeter has stone piers, wrought-iron pickets and a gated entrance with the club sign. The patio has tables and umbrellas, and there is a detailed equipment shed. Belt trees have trunk collision.
- Past the perimeter, horizon hills, a low-detail backdrop woodland and an outer ground ring fade into the fog, so the world has no flat edge.

**Weather and night**
- GPU rain streaks (density per tier). Surfaces soak in about 10 s of rain and dry over about 60 s. An instanced mesh of blowing leaves appears in windy weather. Trees and grass sway in the wind.
- At night: stars, glowing windows, lamps and court floodlights, and cart headlights and taillights with a light pool. Real point lights are capped by `maxLights` (medium 2, high 4). The first is a warm carry light that follows the player. The rest go, in order, to the patio, the fountain, the parking lot and the gate (so on high the gate stays unlit). Lights are hidden while off, so daytime shaders don't pay for them.

**Characters and cart**
- `CharacterModel`: each person is one `SkinnedMesh` with a small rigid skeleton (one draw call plus one shadow call). Faces (brows and mouth set by archetype), hair, hats and rackets are built from rounded primitives. The shipped NPCs have hand-authored looks in `NPC_STYLES`, and new JSON NPCs get a look derived from their id. Characters have walk, idle and talking-gesture motion and a far LOD mesh. The attendant is visibly seated in the cart. Club-style pill name tags fade with camera distance, and the request marker is a bouncing 3D "!".
- Golf cart: rounded cream body with a green canopy, instanced wheels with visible steering, visual-only body roll, pitch and bump, brush judder, and clay dust puffs that appear only over clay.

**UI**
- `ui/theme.js` defines the club palette (forest green, cream, gold) and loads Fraunces and Inter from Google Fonts without blocking; if the fonts can't load, system fonts are used.
- HUD redesign:
  - Clock pill and a collapsible task panel.
  - Minimap with a cached static layer, redrawn at about 12 fps.
  - Toasts that stack (up to 3).
  - Icon action button with a key hint.
- Typewriter dialogue box, themed joystick, a crest loading screen with a readable fatal-error panel, and a pause button with a pause menu.

### Quality tiers (`src/graphics/Quality.js`)

| Setting | low | medium | high |
|---------|-----|--------|------|
| Pixel ratio cap | 1 | 1.5 | 2 |
| Shadows | off | 1024², PCF soft, ±32 m | 2048², PCF soft, ±42 m |
| Post FX | none (direct render, canvas MSAA) | 4× MSAA target + grade/vignette | + GTAO ambient occlusion + bloom |
| Environment map (PMREM) | off | on | on |
| Anisotropy / max texture size | 1 / 512 | 4 / 1024 | 8 / 1024 |
| Grass / prop / rain density | 0.25 / 0.5 / 0.4 | 0.6 / 0.8 / 0.7 | 1 / 1 / 1 |
| Clouds / stars | 5 / off | 9 / on | 12 / on |
| Extra point lights at night | 0 (emissive only) | 2 | 4 |

The default tier is detected from the device: ≤2 cores or ≤2 GB memory → low; phones, tablets and
small screens → medium; ≤4 cores with ≤4 GB → medium; anything else → high. A tier the player
picks is saved under `courtcall.quality`. One limit: canvas antialiasing can't change after load,
so switching to low mid-session has no AA until the next reload.

### Measured cost

Numbers are from `renderer.info` for the screenshot tour at 1280×720 and 9:00 AM sunny. They
include the shadow pass and post-processing.

| View | low | medium | high |
|------|----:|-------:|-----:|
| 01 spawn follow cam | 188 | 256 | 441 |
| 02 overview (budget < 400 on medium) | 191 | 270 | 464 |
| 03 clay courts | 97 | 154 | 271 |
| 05 pro shop / patio | 137 | 213 | 364 |

The pre-overhaul baseline for the overview was about 1160 draw calls. About a third of those were the clay dirt-cell meshes.
High costs more because GTAO renders the scene a second time for its normal/depth pass. The
under-400 budget applies to medium, the mobile default.

---

## Phase 1 — Core Polish (done)

- [x] **Pause menu**: Esc or P (or the on-screen button) freezes physics, game time, weather, timers, NPCs, input, audio and the dialogue typewriter. The menu offers Resume, Settings, Save and Reset progress (with a confirm step). There is no Quit, since this is a browser game.
- [x] **Save system**: a versioned `localStorage` save (`SaveSystem.js`) with a migration table and per-field sanitizing. Corrupt data is moved to a backup key instead of crashing the game. It autosaves every 30 s of play, on mission completion, at the end of a groom, and when the tab is hidden or the page closes. The pause menu has a manual save, and a returning player sees a "Welcome back" toast.
- [x] **Volume control**: master volume slider and mute switch in Settings, saved in `courtcall.settings`. Settings also has camera sensitivity and graphics quality.
- [x] **Null checks on map data**: `Game._normalizeData()` fills in missing areas, courts, paths, spawn points, waypoints, NPC and mission lists. The task board check guards `proShop.taskBoard`, `center` and `bounds`.
- [x] **Reuse Vector3 objects**: the camera, tap raycast and interaction code use pre-allocated temporaries.

## Known Issues

### Bugs and gaps still open

| Issue | Severity | Location | Notes |
|-------|----------|----------|-------|
| Random-encounter first dialogue plays twice | Medium | `MissionSystem.handleInteraction` | Accepting via `acceptRandomEncounter` runs step 0's dialogue but never advances the step, so the next talk replays it |
| Every NPC in a mission gets a "!" at once | Medium | `MissionSystem._setupMissionNPCs` | Talking to the wrong one clears its marker and gives a generic greeting |
| Minimap pins only `step.target` with a matching waypoint | Medium | `HUD.updateMiniMap` | `pickup`/`deliver` steps (which use `location`) and the `patio` target (no `patio`/`patio_center` waypoint) show no pin; talk-to-NPC steps do highlight the NPC |
| Radio dispatch fills active slots without consent | Low | `MissionSystem._dispatchRadio` | Missions are pushed straight into the 3 active slots |
| NPC `playing` state is never entered | Low | `NPC.js` | `_updatePlaying` and the "playing" arm pose are unreachable |
| NPCs walk in straight lines through hedges and courts | Low | `NPC._updateWandering` | `_getPreferredWaypoint` resolves `court3` to the first matching key (`court3_bench`) |
| Mission completion has no feedback | Low | `MissionSystem.completeMission` / `main.js` | No sound, toast or celebration; only stats and an autosave |
| Physics uses `NaiveBroadphase` | Low | `main.js` init | O(n²) pair tests across all static fence, net, wall and trunk bodies |
| Reward data is never read | Design | `npcs.json` / `missions.json` | Nothing uses `tipChance`/`tipRange`, `baseReward`/`estimatedTime`, `npc.mood`, `requests` or `dialoguePool`; `stats.tips` is a placeholder |
| Weather flips too often | Design | `WeatherSystem.update` | Re-rolled every 60 s with a 30% chance of change |
| The night has no content | Design | `WeatherSystem` | The clock wraps at 24h (a day counter is kept), leaving about 14 real minutes of dark with nothing to do |

### Resolved in this pass

- `goTo` mission steps never completed, which soft-locked 6 of 11 missions. They now complete when the player enters the target area: `MissionSystem.handleArrival` is called from `Game._updateInteractions`, and `_detectCurrentArea` knows court ids, `proShop`, `patio`, `garden` and `equipmentShed`.
- A missing `taskBoard` in the map data crashed the game. It is now guarded, and all map data is normalised on load.
- Per-frame `Vector3` allocations in camera and interactions, and a new raycaster and `Vector2` on every tap. These are now pre-allocated.
- Biased `Math.random()-0.5` shuffle. Replaced with Fisher-Yates (`shuffleInPlace`).
- `Date.now()` in the NPC breathing animation. Characters now animate from accumulated `dt`, so pausing freezes them.
- The minimap was fully redrawn every frame. It now keeps a cached static layer and redraws at about 12 fps; the clock DOM only updates when its text changes.
- The asset loader had no fallback for 404s or bad JSON. `AssetLoadError` now lists every failed file, and the loading screen shows them with a Reload button.
- The game loop spammed the same error forever. Each distinct error is now logged once, with a warning after 600 repeats.
- Sound failed silently. The pause menu now says when audio is unavailable or waiting for the first tap.
- A missing dialogue key showed nothing. There is now a fallback line and a one-time warning.
- Random encounters were checked every frame. They are now checked every 0.5 s at the same effective rate.

---

## Elevation Roadmap

The roadmap comes from a design critique of the post-overhaul build. It keeps the critique's
priority order: the top 5 first, then cheap wins that can go in at any point, then everything
else. Effort is S/M/L and impact is 1–5. The **Status** column notes only what the current code
already does (verified).

### Top 5

| # | Idea | Area | Effort | Impact | Why / scope | Status |
|---|------|------|:-----:|:-----:|-------------|--------|
| 1 | **Make every mission completable and findable** | core loop | S | 5 | Fix the remaining mission bugs: advance after encounter dialogue; put the "!" only on the current step's NPC; add a floating world marker and a minimap pin for every step type (`pickup`/`deliver` `location`, `patio`); make radio dispatch not fill dead slots. Land it with the data/CI validator (#26) so it can't regress. | **Partly done**: `goTo` completes on arrival, so the maintenance, reservation and conflict missions no longer stall at `goTo`, and talk-to-NPC steps are highlighted on the minimap. The other items are still open (see Known Issues). |
| 2 | **Shift loop: clock-in to clock-out with pay, tips and staff rank** | core loop | M | 5 | A 7AM–7PM shift (about 15 min) with an opening checklist, rush windows, closing duties and an end-of-shift report card (tasks, tips, member happiness, court quality), then the next day. Pay and tips feed a rank ladder from Rookie Attendant to Head of Grounds that unlocks cart upgrades, equipment and cosmetics. Reuses `tipChance`/`tipRange`, `baseReward` and `npc.mood`. | Not started. A day counter (`weather.day`), `stats.tips` (placeholder) and saved stats already exist. |
| 3 | **Make grooming satisfying: painted stripes, towed brush, clay dust** | game feel | M | 5 | A higher-resolution paint mask (for example 128×256 per court) painted by the brush footprint, with directional stripes along the driven path, also used for coverage scoring. A hinged tow bar that trails and swings on turns. Scrape pitch tied to speed, a sparkle and chime at 100%, floating per-court % labels. | **Partly done**: the 336 dirt meshes are gone, dirt is an 8×14 `DataTexture` sampled by the court shader with per-cell brush-direction stripes, and clay dust puffs appear behind the brush. The brush is still a rigid child of the cart. |
| 4 | **Rigged, animated CC0 characters** | graphics | L | 5 | CC0 rigged packs (Quaternius, Kenney) with a shared AnimationMixer clip set: idle, walk, talk, sit, drive, forehand, serve. Per-NPC tint and accessories from `npcs.json`. Keep primitive characters on the low tier. Needed for #5. | **Partly done**: stylized skinned primitive characters with faces, hair, hats, per-NPC looks, walk/idle/talk motion and a far LOD. The attendant is seated in the cart. Still missing: real clips (swings, serve, sit) and CC0 models. |
| 5 | **NPCs actually play tennis on a court schedule** | world liveliness | L | 5 | A reservation schedule in data that pairs members on courts. Rallies with one pooled ball per court (arc, blob shadow, distance-attenuated "pock"), plus score chatter. Footwork dirties the clay mask where players moved, replacing the uniform `degradeSurface()`. This closes the loop: play, wear, groom, happy members, tips. | Not started (`playing` state unreachable). |

**Why this order**:
1. The core errand loop has to work before graphics or content pay off.
2. The shift loop gives each session a shape, and most of its reward data already exists.
3. Grooming is the only deep mechanic, so it becomes the signature moment (and the mask saves draw calls).
4. Characters are the biggest visual gap left against the polished club, and #5 needs their animations.
5. Matches are the largest job and depend on #3 and #4, but they pay off the most.

### Cheap wins (ride along any time)

| # | Idea | Area | Effort | Impact | Why / scope | Status |
|---|------|------|:-----:|:-----:|-------------|--------|
| 9 | **Reward and action feedback juice** | game feel | S | 4 | Completion jingle and toast, a tip counter that ticks up, pooled confetti, the carried item visible in hand or in the cart bed, squash-and-stretch reactions | **Partly done**: toasts now stack (max 3) instead of overwriting. Mission completion is still silent. |
| 12 | **Groom camera and pattern guide** | UX | S | 3 | High-angle camera toggle while grooming, a ghost line for the recommended lap, an end-of-session heatmap from the paint mask | Not started |
| 29 | **Runtime performance cleanup** | tech | S | 3 | `SAPBroadphase` with sleeping bodies; DOM only touched on change; minimap about 10 Hz; pause on `visibilitychange` | **Mostly done**: clock DOM on change, minimap about 12 Hz with a static layer, auto-pause and save when the tab is hidden. `NaiveBroadphase` remains. |

### Everything else (critique order)

| # | Idea | Area | Effort | Impact | Why / scope | Status |
|---|------|------|:-----:|:-----:|-------------|--------|
| 6 | **Repeatable, parameterized missions** | content | M | 4 | Templates with `{court}`/`{member}`/`{item}`/`{area}` slots, filled at dispatch and weighted by time of day and who is on site. NPC `requests` lines become hooks and `dialoguePool` supplies reactions. Maria Santos and Bob Hendricks get used. | Not started (missions are one-shot via `completedMissionIds`) |
| 7 | **Member rapport that remembers your choices** | core loop | M | 4 | A per-member rapport score that drives greetings, tip odds and request frequency, and unlocks small arcs. Shown in a Member Directory. | Not started (`onReaction` only feeds satisfaction stats) |
| 8 | **Cart feel: visible driver, body roll, horn, lights, tracks** | game feel | M | 4 | Horn that startles NPCs, tire tracks on clay and wet grass, reverse beeper, brake squeak, FOV kick at top speed | **Partly done**: visible seated driver, visual body roll/pitch/bump, wheel steer, headlights and taillights with a light pool at dusk, brush dust on clay. No horn, tracks, beeper, squeak or FOV kick. |
| 10 | **Adaptive procedural music and spatial ambience** | audio | M | 4 | Web Audio sequencer (day lounge loop, evening layer, night crickets, event stings). PannerNode loops for the fountain, patio murmur, court "pocks" and rain on roofs. Separate music and SFX volumes. | Not started (a master volume and mute exist; ambience is still the bird chirp) |
| 11 | **Contextual first-shift onboarding with Hank** | UX | M | 4 | Replace the 6-message radio intro with a scripted "First Shift" chain in `missions.json` that teaches one action at a time. Show proximity-based key and button hints. | Not started (the intro now plays only once, tracked by `flags.tutorialSeen`) |
| 13 | **Reservation desk puzzle** | content | M | 4 | A booking-sheet puzzle at the pro shop desk (court type, doubles and lessons, grooming windows) that also produces the match schedule for #5 | Not started |
| 14 | **More court-care jobs** | content | L | 4 | Line sweeping on foot, watering dry clay, rolling, squeegeeing hard courts after rain, a net-height gauge, a ball pickup tube, leaf-blowing paths on windy days. Reuse the paint mask. | Not started (rain still just blocks grooming) |
| 15 | **Club events calendar** | content | L | 4 | Data-driven `events.json`: tournament weekend, dusk member-guest mixer with string lights, kids' clinic, VIP valet, rain delays, a loose dog, a pickleball controversy | Not started |
| 16 | **Character storylines, a manager and coworkers** | content | M | 4 | 3–5 beat arcs per member, a Club Manager for briefings and reviews, a pro shop coworker, coach and junior archetypes | Not started |
| 17 | **Daily routines, path-following and background extras** | world liveliness | L | 4 | An A* path graph from `map.json` paths, member schedules (arrive, check in, play, lunch, leave), instanced non-interactive extras | Not started |
| 18 | **Weather with consequences and forecasts** | content | M | 3 | Longer fronts with a morning radio forecast. Rain closes courts and leaves puddles, wind blows leaves onto courts, heat dries clay and empties coolers. | Not started (wetness is visual only) |
| 19 | **Radio dispatch with agency** | UX | S | 3 | "On it" and "Busy" replies, a fast-answer tip bonus, walkie-talkie squelch and voice bleeps | Not started |
| 20 | **Ambient micro-life** | world liveliness | S | 3 | Bird flock that lifts off near the cart, butterflies, dawn sprinklers, a flapping club flag, swaying umbrellas, a ball machine on an empty court | **Partly done**: wind sway on trees and grass, and blowing leaves in windy weather |
| 21 | **Pro shop you can see and use** | graphics | M | 3 | A corkboard with pinned task cards instead of a choice list, a register for pickups, a trophy case for ranks and awards | **Partly done**: the interior now shows the task board, counter and racket wall with a roof cutaway, but the board still opens a dialogue choice list |
| 22 | **CC0 prop and vehicle kits through a GLTF pipeline** | graphics | M | 4 | GLTFLoader + meshopt, a `public/data/assets.json` manifest, instancing for repeated props (Kenney Car/Furniture kits, Quaternius nature, a cart model). Primitives stay as the low-tier fallback. | Not started (instancing/merge helpers are ready in `GeometryUtils`) |
| 23 | **The club visibly improves with your reputation** | graphics | M | 3 | Groomed stripes persist until played on; rank unlocks banners, flower beds, patio string lights, fresh shed paint | Not started (court dirt grids are already saved per cell) |
| 24 | **Photo mode and postcards** | graphics | S | 3 | Free camera, time-of-day slider, color grades, a "Greetings from Greenbriar" postcard frame with download or share | Not started (`PostFX.setGrade` and `weather.timeOfDay` are the hooks) |
| 25 | **High-tier-only post-processing** | graphics | M | 2 | AO, bloom, outline pass, per-time-of-day grading, tilt-shift in photo mode, all gated by `setQuality` | **Mostly done**: GTAO + bloom on high, grade/vignette on medium and high driven by `EnvState` each frame. No outline pass or tilt-shift. |
| 26 | **Automated tests and a CI gate for data and missions** | tech | S | 4 | Vitest for MissionSystem, Inventory and grooming scoring. A JSON validator (every step action has a handler; every `npcId`, `dialogueKey`, `target` and `location` resolves). A Playwright smoke test: zero console errors, every mission completes, draw calls < 400 on the overview. Run it before deploy. | Not started (`deploy.yml` still deploys without checks) |
| 27 | **Interaction registry refactor** | tech | M | 3 | Replace the `_updateInteractions` if-chain (later checks silently override earlier ones) with registered `{pos, range, priority, label, canUse, use}` interactables | Not started (the per-frame allocations there are fixed; the action is now a `kind` + target with no per-frame closures) |
| 28 | **Installable PWA with offline play** | tech | S | 3 | Web manifest + service worker with the `/Tennis-Attendant-Simulator/` base, a landscape hint, a fullscreen button | Not started (only `theme-color` and an SVG favicon so far) |
| 30 | **Colorblind-safe archetype cues** | UX | S | 2 | Shape or icon cues (crown, heart, question mark) instead of red/green, a text-size option, a reduce-motion option | Not started (archetype is still a red/green/blue dot on the name tag and in the dialogue speaker color; faces differ by archetype) |

### Earlier backlog not covered above

- Gamepad support and key rebinding in `InputSystem`
- FPS/perf overlay (the data is already in `game.renderStats`)
- More inventory items (sunscreen, first aid kit, snacks, newsletters)
- Achievements (first mission, 10 deliveries, 1000 m driven)
- Expanded map (pool, restaurant, practice wall)

---

## Architecture Improvements

### Refactors to Consider

| Refactor | Benefit | Effort | Status |
|----------|---------|--------|--------|
| Interaction registry / `InteractionManager` out of `main.js` | `main.js` is 1377 lines; removes silent overrides (roadmap #27) | Medium | Open |
| Extract `CameraController` from `main.js` | Clean separation, easier camera modes (groom cam #12, photo mode #24) | Low | Open |
| Centralize area resolution | Areas are resolved three ways: bounds checks in `main.js` (`_detectCurrentArea`/`_inArea`), `<id>_center` waypoint lookup in the minimap, and substring waypoint matching in `NPC.js` | Low | Open |
| Move module constants to `Constants.js` | `MINIMAP_INTERVAL`, `TOAST_MAX` (HUD), `AUTOSAVE_INTERVAL` (main), name-tag fade distances (NPC) | Low | Open |
| `SAPBroadphase` + sleeping static bodies | Cheaper physics with many fence, wall and trunk bodies | Low | Open |
| Fisher-Yates shuffle for mission randomization | Uniform task board selection | Trivial | Done |
| Pre-allocate temp vectors as class properties | No per-frame GC pressure | Low | Done |
| Consistent animation timing (no `Date.now()` in NPCs) | Pause and time-scale support | Low | Done |

### Design Principles

- **Data-driven first**: new content goes in JSON, not code changes.
- **No fail states**: the game is always playable and errors degrade gracefully (normalised data, sanitized saves, per-error logging).
- **Mobile-first**: 44px touch targets, safe-area insets, a portrait camera, quality auto-detection.
- **Stylized low-poly, procedural**: rounded primitives + procedural canvas textures through the `src/graphics/` kit. External models are an optional upgrade path (roadmap #4, #22) with primitives as the low-tier fallback.
- **Performance budget**: overview under 400 draw calls on medium, no per-frame allocations, shared materials and geometries, merged statics and instanced props.
- **Procedural audio**: keep sounds generated, with no audio file dependencies.
