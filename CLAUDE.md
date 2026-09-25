# CLAUDE.md — Court Call: Tennis Attendant Simulator

This file provides context for Claude Code when working on this project.

## Project Overview

Court Call is a 3D browser-based sandbox game where the player works as a tennis attendant at an upscale private club. Built with Three.js + Cannon.js, bundled with Vite, using vanilla JavaScript (no frameworks). Mobile-first with touch controls. Deployed to GitHub Pages with a base URL of `/Tennis-Attendant-Simulator/`. The art direction is a stylized, warm "sun-drenched country club" built from rounded primitives and procedural canvas textures (no external model, texture or audio files).

## Tech Stack

- **Three.js** (`three ^0.170.0`, r170) — 3D rendering. Addons (`RoundedBoxGeometry`, `BufferGeometryUtils`, `EffectComposer`, `GTAOPass`, `UnrealBloomPass`, `OutputPass`) are imported from `three/addons/...`
- **Cannon.js** (`cannon-es ^0.20.0`) — physics engine (rigid bodies, collisions)
- **Vite** (`^6.2.0`) — dev server and production bundler
- **Web Audio API** — all sounds are procedurally generated (no audio files)
- **Vanilla JavaScript** (ES modules, no React/Vue/etc.)
- **Google Fonts** (Fraunces + Inter), loaded non-blocking from `index.html`; system fonts are the fallback
- All game data lives in **JSON config files** under `public/data/` (served as static assets)

## Commands

- `npm run dev` — start Vite dev server on port 3000 (open `http://localhost:3000/Tennis-Attendant-Simulator/`)
- `npm run build` — production build to `dist/`
- `npm run preview` — preview production build

There are no tests, linters, or formatters configured yet. The deploy workflow builds and publishes without any checks.

## Project Structure

```
├── index.html              # Entry point: crest loading screen (+ fatal-error panel), canvas, #ui-root, fonts
├── vite.config.js          # Vite config (port 3000, base: /Tennis-Attendant-Simulator/)
├── package.json
├── .github/workflows/
│   └── deploy.yml          # GitHub Pages auto-deploy on push to main
├── src/
│   ├── main.js             # Game class: init, loop, camera, interactions, pause, save/load, setQuality
│   ├── world/
│   │   ├── World.js        # Ground, paths, courts, buildings, garden, shed, patio, parking, perimeter, trees, lamps, night lights
│   │   ├── Court.js        # Shader-painted court surface (zones, lines, clay dirt texture), net, fence, lights, props, physics
│   │   ├── Building.js     # Pro shop (interior, roof cutaway) and clubhouse structures
│   │   ├── Garden.js       # Paver walks, hedges, flower beds, animated fountain
│   │   └── Scenery.js      # Instanced trees/grass/flowers/benches/lamps/blob shadows + wind sway
│   ├── entities/
│   │   ├── CharacterModel.js # Shared stylized character builder (1 draw call each), contact shadows, camera tracker
│   │   ├── Player.js       # Player character: physics body, walk animation, seated in cart
│   │   ├── GolfCart.js     # Drivable cart: physics, steering, body roll, lights, brush + clay dust
│   │   └── NPC.js          # NPC: per-NPC looks, wandering AI, name tags, request marker, reactions
│   ├── systems/
│   │   ├── InputSystem.js  # Keyboard (WASD/arrows/Space/E/Enter/Q/R/Esc/P/1-9) + touch + camera drag
│   │   ├── WeatherSystem.js# Day/night keyframes, weather, lights, shadows, sky, env map, rain/wind; writes EnvState
│   │   ├── DialogueSystem.js# Dialogue queue, branching choices, NPC conversation flow
│   │   ├── MissionSystem.js# Task board, radio dispatch, random encounters, step logic, goTo arrival
│   │   ├── InventorySystem.js # Carry up to 3 items for errands
│   │   ├── CourtMaintenanceSystem.js # Clay court grooming minigame
│   │   ├── SoundSystem.js  # Procedural Web Audio API sounds (no audio files), volume/mute/pause
│   │   └── SaveSystem.js   # Versioned localStorage save (courtcall.save.v1) + SettingsStore
│   ├── graphics/
│   │   ├── Quality.js      # low/medium/high tiers (auto-detected, persisted in courtcall.quality)
│   │   ├── EnvState.js     # Shared per-frame env state (time, night/lamp/golden factors, wetness, wind)
│   │   ├── Materials.js    # Cached MeshStandardMaterial factory, registerWet / registerNightGlow
│   │   ├── Textures.js     # Seeded noise + procedural canvas textures (grass, clay, asphalt, ...)
│   │   ├── GeometryUtils.js# Cached geometries (rounded boxes), mergeStaticMeshes, createInstanced
│   │   ├── Sky.js          # Sky dome, stars, clouds, horizon hills + backdrop treeline
│   │   └── PostFX.js       # Composer: MSAA, grade/vignette (medium), GTAO + bloom (high)
│   ├── ui/
│   │   ├── theme.js        # Shared UI tokens (CSS custom properties --cc-*) + base classes (.cc-panel, .cc-btn…)
│   │   ├── Joystick.js     # Virtual joystick (touch + mouse fallback)
│   │   ├── DialogueBox.js  # Bottom-center dialogue overlay with choices (typewriter)
│   │   ├── PauseMenu.js    # Pause button + menu: Resume, Settings (volume, graphics, camera), Save, Reset
│   │   └── HUD.js          # Mini-map, task list, clock/weather, inventory, action button, toasts, grooming overlay
│   └── utils/
│       ├── Constants.js    # Colors, sizes, game tuning values, area enums
│       └── AssetLoader.js  # JSON data loader with cache + AssetLoadError (per-file failures)
└── public/
    ├── data/
    │   ├── map.json        # Club layout: areas, courts, paths, waypoints
    │   ├── npcs.json       # NPC definitions: names, archetypes, dialogue pools
    │   └── missions.json   # Mission templates, dialogue scripts, branching choices
    └── assets/             # Future: models, textures, audio files
```

## Architecture Notes

- **Game loop** is in `src/main.js`. The `Game` class owns the scene, physics world, all systems and entities. `_gameLoop()` runs via `requestAnimationFrame`, clamps `dt` to 0.05 s, and wraps `_update(dt)` and `_render(dt)` in separate try/catch blocks. `_reportLoopError` logs each distinct error once and warns again at 600 repeats. While paused, the loop only re-renders when the canvas was invalidated (resize or quality change).
- **Startup**: `AssetLoader.loadAllData()` loads the three JSON files with `Promise.allSettled`. Failures throw an `AssetLoadError` listing every bad file, and `_showFatalError` shows them on the loading screen with a Reload button. `_normalizeData()` then fills in anything missing (areas, courts, paths, spawn points, waypoints, NPC and mission lists) so a hand-edited file can't crash the game. Finally `_precompileShaders()` compiles every shader variant, including hidden night and rain objects, before the loading screen hides.
- **Physics** uses Cannon.js with `NaiveBroadphase`. The ground is a `CANNON.Plane` and buildings and walls are static `CANNON.Box` bodies, plus thin colonnade columns and trunk bodies for the tree belts. Player and NPCs are `CANNON.Sphere` bodies. The cart is a dynamic `CANNON.Box` (400 kg, Y-axis angular lock to prevent flipping).
- **World building** is data-driven. `World.js` reads `data/map.json` and builds courts, buildings, paths, etc. To add or move areas, edit `public/data/map.json`. Static decoration is parented to `World.staticRoot` and merged with `mergeStaticMeshes(root, { cellSize: 32 })`. Repeated props go through the shared `Scenery` batch (`addTree`, `addBench`, `addLamp`, `addTuft`, `addFlowerClump`, `addBlob`, then `build()` once).
- **NPCs** are defined in `public/data/npcs.json`. Each has an archetype (`entitled`/`friendly`/`clueless`), preferred areas, greeting pools and dialogue lines. Wandering uses waypoints from `map.json`. Each NPC is a `CharacterModel.Character`. Its look comes from `NPC_STYLES` in `NPC.js` (keyed by id) or, failing that, from `_deriveStyle()` (deterministic from id + archetype). The state machine has `idle`, `wandering`, `talking` and `playing`, but nothing sets `playing` yet. Name tags are canvas sprites (pill with an archetype color dot) that fade with camera distance. The request marker is a bouncing 3D "!" mesh. Reactions are emoji sprites that float up and fade.
- **Missions** are defined in `public/data/missions.json`. Each mission has typed steps (`goTo`, `dialogue`, `pickup`, `deliver`, `choose`, `groom`). `MissionSystem` manages active missions (max 3), the task board and radio dispatch. `goTo` steps complete when the player enters the target area: `Game._updateInteractions` calls `MissionSystem.handleArrival(areaId)`, and `_detectCurrentArea` recognises court ids, `proShop`, `patio`, `garden` and `equipmentShed`. Two hooks: `onMissionComplete(mission)` updates stats and autosaves, and `onReaction(npcId, mood)` counts satisfaction.
- **Dialogue** flows through `DialogueSystem`, which controls `DialogueBox`, a typewriter overlay. Space, Enter, E or a tap finishes the line, then advances. Keys 1–9 pick a choice. Dialogues are keyed in `public/data/missions.json` under `dialogues`. A missing key logs one warning and shows a fallback line. Speaker names are color-coded by archetype.
- **Camera** follows the player or cart in third person with lerp smoothing. In cart mode it follows the cart's heading. On foot, the player rotates it with Q/R or by dragging on the right side of the screen (>35% width), scaled by the camera-sensitivity setting. Portrait screens get FOV 72 and a slightly pulled-back camera. `_snapCamera()` jumps straight to the follow pose after a save loads.
- **Sound** is fully procedural via the Web Audio API in `SoundSystem.js`. Footsteps, cart engine, UI clicks, pickups, notifications, bird chirps, brush scraping, brush attach, groom complete, proximity warnings, cooler swap and trash pickup are all synthesized at runtime. There are no audio files. The system initializes on the first user interaction (browser autoplay rules). `setMasterVolume`, `setMuted` and `setPaused` work before init too. `available` becomes false if Web Audio fails, and the pause menu then says so.
- **Court Maintenance** is managed by `CourtMaintenanceSystem.js`.
  - **Setup**: three adjacent clay courts (3, 4 and 5) are all groomed in a single session. The player attaches a drag brush to the golf cart at the equipment shed, then drives onto any clay court to begin.
  - **Dirt data**: each court keeps an 8×14 `dirtGrid`, mirrored into a `DataTexture` that the court surface shader samples. R is dirt; G/B hold the last brush direction, which draws the fresh drag stripes.
  - **Technique**: fence perimeter first (stay close), then near the nets, then fill in the middles and the areas between courts. Proximity feedback shows the distance to the nearest fence or net (green optimal, yellow warning, red danger).
  - **Courtside tasks**: swap coolers, add cups and empty trash at the junctions between courts during the session.
  - **Rating**: "excellent" needs cleanliness ≥ `groomScoreThreshold`, coverage ≥ 70% and ≥ 80% of courtside tasks done.
  - **Rules**: a first-time tutorial from Hank teaches the technique. Courts degrade over time, and rain blocks grooming.
  - **Integration**: the `groom` mission step integrates with `MissionSystem`. `getState()`/`setState()`/`resumeGrooming()` save per-cell grids and can reopen a session that was in progress when the game was saved.
- **Court Junctions** are defined in `map.json` under `areas.courtJunctions`. Each junction sits between two adjacent clay courts at the net line and holds igloo coolers and trash bins. `World.js` builds the 3D objects. During grooming, `CourtMaintenanceSystem` generates courtside tasks for each junction.
- **Player/Cart interaction**: `Player.enterCart()` seats the player mesh in the cart's driver seat (parented to the cart, static seated pose), disables collision and hands movement to the cart. `getPosition()` then returns the cart position. `Player.exitCart()` places the player beside the cart and re-enables collision. The cart uses velocity-based driving, not force-based, because box-on-plane friction eats applied forces. Body roll, pitch, bump, wheel steer, lights and brush dust are visual only and don't touch physics. Player and cart meshes are scaled down (`SIZES.playerScale` = 0.85, `SIZES.cartScale` = 0.75) to fit the court sizes.
- **Court collisions**: Nets and back fences have static CANNON.Box physics bodies, preventing the cart and player from driving through them. Net collision spans the full width at net height. Fence collision spans behind each baseline.
- **Perimeter path**: A golf cart path runs around the entire map perimeter, connecting to existing court and entrance paths for a continuous driving loop. The perimeter fence (stone piers, iron pickets, gated north entrance) keeps the original 2 m physics walls.

### Rendering pipeline (`src/graphics/`)

- **Renderer**: `WebGLRenderer` with `NeutralToneMapping` (Khronos PBR Neutral, which keeps the stylized palette true where ACES washed it out), exposure 1.0, sRGB output. `shadowMap.autoUpdate = false`: `_render()` sets `needsUpdate` once per frame so post passes don't re-render shadows. `renderer.info.autoReset = false`, and `game.renderStats` (`calls`, `triangles`) counts every pass: shadow, scene and post.
- **Lighting**: `WeatherSystem` owns one sun `DirectionalLight` (moonlight at night), a `HemisphereLight` and a tiny ambient floor. 14 hour keyframes (`KEYS`) set sun color and intensity, hemisphere colors and sky top/horizon colors; they are golden around 6–9 and 17–19:30. Weather adds overcast and rain darkening. The shadow frustum (±`shadowExtent`) follows `Game._computeShadowFocus()`, the ground point the camera looks at, and is texel-snapped. On medium and high the sky dome is rendered into a PMREM environment map. Fog color and distance track the horizon.
- **Sky** (`Sky.js`): gradient `SkyDome` with sun and moon discs, `Stars` (medium and high), low-poly `Clouds` whose count depends on tier and weather, and `Horizon` (rolling hills, a backdrop treeline ring and an outer ground ring), so the world never ends at a flat edge.
- **Post FX** (`PostFX.js`): **low** renders directly with canvas MSAA. **Medium** renders into a 4× MSAA HalfFloat target, then `GradeOutputPass` (tone map + sRGB + lift/gamma/gain, saturation, contrast, vignette, dither in one full-screen pass). **High** adds `GTAOPass` (transparent, alpha-tested and `userData.noAO` objects are excluded) and `UnrealBloomPass`. `postFX.updateFromEnv(EnvState)` regrades each frame (cooler at night, warmer at golden hour, flatter when overcast). `postFX.setGrade({...})` changes the base grade.
- **Night**: materials registered with `registerNightGlow` (windows, lamp glass, floodlights, signs) follow `EnvState.lampFactor`. `World._buildLights()` creates up to `maxLights` point lights: a warm carry light that follows the player, then the patio, fountain, parking and gate spots. They are hidden while off so daytime shaders don't pay for them. The cart turns on its headlights, taillights and light pool.
- **Rain and wind**: GPU-animated rain streaks (`RAIN_MAX` × `rainDensity`). Wetness (`EnvState.wetness`) soaks in about 10 s and dries over about 60 s, darkening and glossing materials registered with `registerWet`. Blowing leaves (one `InstancedMesh`) appear when windy. Trees and grass sway through `applyWindSway` uniforms in `Scenery.js`.
- **Courts** render their surface with one shader plane per court (zones, lines and clay dirt) — there is no line geometry. Hard courts that share a surround set `sharedPadLeft`/`sharedPadRight` in `map.json` to drop the inner edging. About 9 draw calls per court.
- **Buildings** are merged by material into about 10 draw calls each. The pro shop roof layer stops drawing (but keeps casting its shadow) while the camera follows the player inside (`Building.setCutaway`, driven from `onBeforeRender`, so there is no game-loop wiring).
- **Characters** (`CharacterModel.js`): one `SkinnedMesh` per person with a 10-bone rigid skeleton, all sharing one vertex-colored material, with a far LOD mesh (always used on low). `BlobShadows` is one `InstancedMesh` of soft contact shadows for all characters and carts. `CameraTracker` records the last rendered camera position so name tags can fade without extra wiring.

### Quality tiers (`graphics/Quality.js`)

- `Quality` is a singleton. `Quality.tier` is `'low' | 'medium' | 'high'` and `Quality.settings` is that tier's entry in `QUALITY_SETTINGS`: `pixelRatioCap`, `shadows`, `shadowMapSize`, `shadowSoft`, `shadowExtent`, `postFX`, `msaaSamples`, `ao`, `bloom`, `colorGrade`, `envMap`, `anisotropy`, `maxTextureSize`, `grassDensity`, `propDensity`, `rainDensity`, `cloudCount`, `stars` and `maxLights`.
- The first tier is auto-detected by `detectQualityTier()`: ≤2 cores or ≤2 GB memory → low; phones, tablets and small screens → medium; ≤4 cores with ≤4 GB → medium; else high. The player's choice is persisted in `localStorage['courtcall.quality']`.
- `game.setQuality(tier)` (also used by the pause menu) calls `Quality.set()`, which notifies `Quality.onChange` listeners. `Game._applyQuality()` then updates pixel ratio, shadow type and size, `WeatherSystem.setQuality`, the PostFX chain and texture anisotropy, and precompiles changed shaders. `World` lights and `Scenery` density subscribe themselves.
- Limitation: the canvas `antialias` flag is fixed at creation, so switching to low mid-session has no AA until reload.

### EnvState (`graphics/EnvState.js`)

A plain shared object that `WeatherSystem` writes once per frame and any module may read: `time`, `timeOfDay`, `weather`, `nightFactor`, `lampFactor`, `goldenFactor`, `wetness`, `overcast`, `windStrength`, `windDirection`, `sunDirection`, `sunColor`, `sunIntensity`, `skyTopColor`, `horizonColor` and `focus`. Readers must not keep or mutate its vectors and colors; copy them into their own temporaries. Use it instead of wiring new dependencies through `main.js`.

### Materials / Textures / Geometry kit

- `mat(color, opts)` returns a cached `MeshStandardMaterial` keyed by its parameters (roughness 0.85 and metalness 0 by default). Options: `map`, `normalMap`, `roughnessMap`, `bumpMap`, `alphaMap`, `transparent`, `opacity`, `side`, `emissive`, `emissiveIntensity`, `vertexColors`, `alphaTest`, `polygonOffset`, `depthWrite`, `fog`, `wet`, `envMapIntensity` and `unique`.
  - Cached materials are **shared**. Never mutate one for a single object; use `{ unique: true }` or `.clone()`.
  - `getMaterial(key, factory)` is a named cache. Use it when a mesh needs its own instance, for example InstancedMesh users that must not share with plain meshes.
  - `basicMat()` gives cached unlit materials.
  - `sharedDepthMaterial(variant)` provides the shadow depth material for instanced and skinned casters.
- `Textures.<name>({ repeat })` returns cached procedural canvas textures: `grass` (mow stripes), `clay`, `acrylic`, `asphalt`, `concrete`, `pavers`, `wood`, `shingles`, `stucco`, `siding`, `hedge`, `chainLink`, `tennisNet`, `noise`, `radialBlob`.
  - `createCanvasTexture(size, drawFn, { key, repeat, srgb, seed, mipmaps, height })` generates once per `key`. A different `repeat` returns a clone that shares the GPU upload.
  - Size is clamped to the tier's `maxTextureSize` (≤1024 px; 512 on low). Color maps are sRGB; pass `srgb: false` for data maps.
  - Noise helpers: `seededRandom`, `hash2`, `valueNoise2`, `fbm2`.
- `GeometryUtils` provides:
  - Geometry caches: `getGeometry(key, factory)`, `roundedBox(w, h, d, r)`, `boxGeo`, `cylinderGeo`, `sphereGeo`, `coneGeo`, `icoGeo`.
  - `mergeStaticMeshes(root, { cellSize })` merges by material, shadow flags and render order. It skips `userData.noMerge` and `userData.dynamic`.
  - Instancing: `createInstanced(geo, mat, items, opts)` and `createInstancedBuckets` (per-grid-cell buckets so instances can be culled).
  - Merging: `mergeParts([{ geometry, matrix, color }])` builds one geometry from pieces, with optional baked vertex colors. `makeMatrix(x, y, z, ry, s, rx, rz)` is a helper for it.

### SaveSystem (`systems/SaveSystem.js`) and localStorage keys

| Key | Owner | Contents |
|-----|-------|----------|
| `courtcall.save.v1` | `SaveSystem` | Versioned JSON snapshot (`SAVE_VERSION` = 1): time/day/weather, player + cart transforms (brush attached), in-cart flag, camera yaw, missions (active + step, completed, task board, timers), inventory, stats, clay court cleanliness + per-cell hex grids, in-progress groom session, degrade timer, flags (`tutorialSeen`, `groomTutorialSeen`) |
| `courtcall.save.v1.backup` | `SaveSystem` | Unreadable or corrupt saves are moved here (`{ reason, at, raw }`) instead of crashing |
| `courtcall.settings` | `SettingsStore` | `volume` (0–1), `muted`, `cameraSensitivity` (0.25–2.5) |
| `courtcall.quality` | `Quality` | `'low' \| 'medium' \| 'high'` (absent = auto-detect) |

- `captureSaveData(game)` → `saveSystem.save(data)`. `saveSystem.load()` runs `migrateSave` (the `MIGRATIONS` table), then `sanitizeSave` (clamps every field, drops unknown ids), then `applySaveData(game, data)`. Each section is restored in its own try/catch.
- Autosave happens every 30 s of unpaused play (`AUTOSAVE_INTERVAL` in `main.js`), on mission completion, at the end of a groom, after the intro tutorial, on `visibilitychange` → hidden (which also pauses), and on `pagehide`. The pause menu has a manual Save.
- `game.resetProgress()` disables saving, clears the slot and reloads. Settings and quality are kept.
- Systems expose `getState()`/`setState()`: `WeatherSystem`, `MissionSystem` (a pending `choose` step is saved as the dialogue step before it), `InventorySystem` and `CourtMaintenanceSystem`.
- All storage access goes through `storageGet`/`storageSet`/`storageRemove` (try/catch for private mode, quota and blocked storage). If saving fails, the player sees a one-time toast.

### Pause menu (`ui/PauseMenu.js`)

- Esc or P (`InputSystem.onPauseToggle`, which fires even while input is disabled) or the round pause button under the minimap calls `game.togglePause()`.
- `game.pause(reason)` freezes physics, game time, weather, timers, NPCs, input (`input.setEnabled(false)`), audio (`sound.setPaused`) and the dialogue typewriter. Deferred one-shot events are pushed back by the paused duration.
- Views:
  - **Main**: summary (day, time, weather), stats (tasks done, courts groomed, best groom), Resume, Settings, Save and Reset progress.
  - **Settings**: master volume, mute, graphics quality (Low/Medium/High), camera sensitivity.
  - **Confirm**: confirms Reset progress.
- Esc steps back from a sub-view before resuming (`handleEscape()`). The menu owns no game logic; everything goes through the callbacks passed in by `Game._createPauseMenu()`.

### UI theme (`ui/theme.js`)

- `injectTheme()` (idempotent) adds `--cc-*` CSS custom properties. Palette: forest green `#2d5a3d`, cream `#f4e8c1`, gold `#d9a441`, clay `#c8663c`, blue `#2f6db3`, plus ok/warn/danger and panel colors. Fonts: Fraunces for display and Inter for UI.
- It also sets safe-area insets and base classes (`.cc-panel`, `.cc-title`, `.cc-label`, `.cc-btn`, `.cc-btn--primary`, `.cc-btn--danger`).
- `THEME` exports the same values for JS/canvas use. HUD, DialogueBox, Joystick and PauseMenu build their CSS on these tokens.

## Key Conventions

- All visual objects are **low-poly geometric primitives** (rounded/bevelled boxes, cylinders, spheres, cones) with procedural canvas textures. Create materials through the kit (`mat()` / `getMaterial()` in `graphics/Materials.js`, which gives `MeshStandardMaterial`) instead of `new THREE.Mesh*Material` ad hoc; never use `MeshLambertMaterial`/`MeshPhongMaterial` for visible world objects. There are no external 3D models yet; they go in `public/assets/` when ready.
- **Every large surface gets subtle procedural texture** (noise, grain, speckle, mow stripes) — never a large flat color. Small props may be flat or vertex-colored.
- **No z-fighting**: stacked flat layers are separated by ≥ 0.015 world units (see the `LAYER` heights in `World.js`, `WALK_Y` in `Garden.js`, `SIZES.courtSurfaceY` = 0.15 for anything on a court), and/or use `polygonOffset` via `mat(..., { polygonOffset: true })`. Use curbs or edging where surfaces meet.
- **Performance budget (mobile-first, a hard constraint)**:
  - Keep the overview (tour view 02) **under 400 draw calls on medium**; it is about 270 today (low about 190, high about 460 with GTAO).
  - No per-frame allocations in update loops: use pre-allocated temporaries and reused result objects.
  - Share and cache materials and geometries. Merge static meshes and instance repeated props instead of adding individual meshes.
  - Generate canvas textures once and cache them (≤1024 px, ≤512 on low).
  - Gate expensive effects on `Quality.settings`.
  - Check draw calls with `game.renderStats`.
- Three.js r170 uses physical light units: a sun `DirectionalLight` sits around 2.5–3, a `HemisphereLight` around 1–2. Color textures need `tex.colorSpace = THREE.SRGBColorSpace` (`createCanvasTexture` does this).
- Visual modules read `EnvState` and `Quality.settings` instead of taking new constructor parameters from `main.js`.
- Colors are centralized in `src/utils/Constants.js` under `COLORS`. Game tuning values (speeds, timers, ranges) are in `Constants.js` under `SIZES` and `GAME`. `Constants.js` is shared; add entries, don't reorganize.
- The JSON data files are designed to be hand-editable. When adding content (new NPCs, missions, dialogue), edit the JSON files rather than source code.
- UI elements are DOM elements appended to `#ui-root`, not rendered in the 3D canvas, and styled with the `theme.js` tokens. All touch targets are at least 44px.
- The game has **no fail states**. Missions always resolve; NPC satisfaction varies based on player choices.
- Canvas textures are used for name tags, reaction emoji, court labels and building signs.
- NPCs show a floating 3D `!` marker when they have a request, and display reaction emojis that float up and fade.
- Every `localStorage` access goes through try/catch (see `SaveSystem.js` helpers).
- **Dev hook**: in dev builds only (`import.meta.env.DEV`), `window.__game` is the `Game` instance and `window.__env` is `EnvState`. Use them for debugging and automated screenshots (e.g. `__game.setQuality('high')`, `__game.weather.timeOfDay = 19`, `__game.weather.setWeather('rainy', true)`, `__game.renderStats`). Never rely on them in game code.

## Key Tuning Values (Constants.js)

| Constant | Value | Description |
|----------|-------|-------------|
| `SIZES.playerSpeed` | 8 | Walk speed (units/s) |
| `SIZES.cartMaxSpeed` | 7 | Cart top speed (units/s) |
| `SIZES.cartAcceleration` | 5 | Cart acceleration (units/s^2) |
| `SIZES.cameraDistance` | 8 | Camera follow distance (+2 in cart, +1.5 in portrait) |
| `SIZES.cameraHeight` | 5 | Camera height above target (+1 in cart, +0.8 in portrait) |
| `SIZES.cameraLerpSpeed` | 3 | Camera position smoothing |
| `SIZES.cameraLookAhead` | 2 | Look-at point ahead of the target |
| `SIZES.courtSurfaceY` | 0.15 | Top of every court pad; props on courts sit here |
| `GAME.dayDurationSeconds` | 1800 | Real seconds per in-game day (30 min) |
| `GAME.startHour` | 9 | Starting hour for a new game |
| `GAME.weatherCheckInterval` | 60 | Seconds between weather re-rolls |
| `GAME.weatherChangeProbability` | 0.3 | Chance the weather changes on a re-roll |
| `GAME.maxActiveMissions` | 3 | Simultaneous mission cap |
| `GAME.interactionRange` | 3 | Distance to interact with NPCs/objects |
| `GAME.radioDispatchInterval` | 90 | Seconds between radio dispatches |
| `GAME.taskBoardRefreshInterval` | 120 | Seconds between task board refreshes |
| `GAME.randomEncounterChance` | 0.15 | Per-frame-equivalent encounter chance (checked every 0.5 s) |
| `GAME.gravity` | -9.82 | Physics gravity |
| `GAME.groomCellSize` | 2 | Grid cell size for court dirt (world units) |
| `GAME.groomSpeedLimit` | 5 | Max speed for quality grooming (units/s) |
| `GAME.groomSpeedPenalty` | 8 | Above this speed, no grooming happens |
| `GAME.courtDegradeInterval` | 120 | Seconds between court degradation ticks |
| `GAME.courtDegradeAmount` | 0.05 | Dirt added per degradation tick |
| `GAME.groomBrushWidth` | 3 | Brush sweep radius (world units) |
| `GAME.groomScoreThreshold` | 0.85 | Cleanliness needed for "excellent" (also needs ≥70% coverage, ≥80% courtside tasks) |
| `GAME.proximityOptimalMin` | 0.5 | Min safe brush-center distance to fence/net |
| `GAME.proximityOptimalMax` | 3.0 | Max optimal brush-center distance (edge ~1.5m from fence) |
| `GAME.proximityWarnMax` | 4.5 | Warning distance — getting too far |
| `GAME.proximityDangerMin` | 0.3 | Danger — brush hitting fence/net |
| `GAME.coolerInteractRange` | 2.5 | Range to interact with courtside objects |

Outside `Constants.js`: `AUTOSAVE_INTERVAL` = 30 s (`main.js`); `MINIMAP_INTERVAL` ≈ 83 ms / 12 fps and `TOAST_MAX` = 3 (`HUD.js`); per-tier graphics values in `QUALITY_SETTINGS` (`graphics/Quality.js`); lighting keyframes `KEYS`, `SUNRISE`/`SUNSET` and `WEATHER_TARGETS` (`WeatherSystem.js`); name-tag fade distances (`NPC.js`).

## Common Tasks

**Adding a new NPC:** Add an entry to `data/npcs.json` under `npcs[]` with id, name, archetype, shirtColor, preferredAreas, greetings, requests and dialoguePool. The NPC spawns and wanders automatically, with a look derived from its id and archetype. For a hand-authored look (hair, hat, skin, bottom, brows/mouth, racket, scale, ...), add an entry keyed by the id to `NPC_STYLES` in `src/entities/NPC.js`.

**Adding a new mission:** Add an entry to `data/missions.json` under `missions[]` with id, type, title, description, source (`taskBoard`/`radio`/`random`) and a steps array. Add any dialogue scripts to the `dialogues` object. Supported step actions: `goTo`, `dialogue`, `pickup`, `deliver`, `choose`, `groom`. A `goTo` `target` must be something `Game._detectCurrentArea` returns (a court id, `proShop`, `patio`, `garden`, `equipmentShed`). For the minimap pin it also needs a `<target>_center` or `<target>` waypoint in `map.json`. For maintenance missions, use type `maintenance` and the `groom` step action with a `target` matching a clay court id (e.g., `court3`, `court4`, `court5`). All 3 clay courts are groomed in one session, so a `groom` step targeting any clay court triggers the multi-court grooming system. Saves reference missions by id, so renaming an id drops that mission from existing saves.

**Changing the map layout:** Edit `public/data/map.json`. Court positions, building locations, path routes and waypoints are all defined there, and the world rebuilds from this data on load. Keep new flat pieces on their own layer heights (see "No z-fighting").

**Tuning game feel:** Adjust values in `src/utils/Constants.js`: cart speed (`SIZES.cartMaxSpeed`), player speed (`SIZES.playerSpeed`), camera distance (`SIZES.cameraDistance`), day length (`GAME.dayDurationSeconds`), etc.

**Tuning lighting / time of day:** Edit the `KEYS` keyframes (sun color/intensity, hemisphere sky/ground, sky top/horizon per hour) and `WEATHER_TARGETS` in `WeatherSystem.js`. Use sRGB hex colors. Base grading is in `PostFX` (`grade` defaults, `updateFromEnv`). To preview, use `__game.weather.timeOfDay = 18.5` in dev, or the screenshot tour with `TOD=18.5`.

**Adding a procedural texture:** Add a function to the `Textures` object in `src/graphics/Textures.js` that calls `createCanvasTexture(size, (ctx, s, rand, h) => { ... }, { key: 'myTex', repeat })`. Use a unique `key`, keep `size` ≤ 1024, and draw with the seeded `rand` and `fbm2`/`valueNoise2` so the result is deterministic. For performance, use `fillPixelsScaled` for per-pixel noise at reduced resolution and batch strokes into single paths. Pass `srgb: false` for roughness, alpha or data maps. Author color maps near their final color and use them with `mat(0xffffff, { map: Textures.myTex({ repeat: [x, y] }) })`. Add `wet: true` if the surface should react to rain.

**Adding a quality setting:** Add the key with a value for **each** tier in `QUALITY_SETTINGS` (`src/graphics/Quality.js`). Read it through `Quality.settings.<key>` and react to changes with `Quality.onChange((tier, settings) => ...)`. Renderer- and composer-level settings belong in `Game._applyQuality()`, `WeatherSystem.setQuality()` or `PostFX.apply()`. If the new setting changes shader programs (lights, shadows, defines), make sure `_precompileShaders()` still covers it (it runs after every quality change). If players should see it, update the tier note in `QUALITY_NOTES` (`PauseMenu.js`).

**Persisting new state / bumping the save version:** Add the field in `captureSaveData()` and in `sanitizeSave()` (with a safe default and clamping), and restore it in `applySaveData()` inside its own `step(...)`. A purely additive field with a default doesn't need a version bump. For a breaking shape change:
1. Increment `SAVE_VERSION`.
2. Add `MIGRATIONS[oldVersion] = (d) => ({ ...d, /* transform */, version: oldVersion + 1 })`.
3. Keep the key name `courtcall.save.v1` unless old saves must be abandoned, because the version lives inside the JSON.

Saves from a newer version, or with no migration path, are backed up to `courtcall.save.v1.backup` and the game starts fresh.

**Adding a setting:** Add a default to `DEFAULT_SETTINGS` and validation in `SettingsStore.load()` (`SaveSystem.js`), a control in `PauseMenu._buildSettingsView()` plus syncing in `_syncSettings()`, and apply it in the `settings.onChange` handler in `main.js`.

**Adding a UI component:** Call `injectTheme()`, build DOM into `#ui-root`, and style it with the `--cc-*` variables and `.cc-*` classes. Keep touch targets at least 44px and respect `--cc-safe-*` insets. Stop pointer and touch events from reaching the canvas where needed (see `PauseMenu`).

**Adding inventory items:** Add a new entry to the `ITEMS` object in `src/systems/InventorySystem.js` with a name and emoji. Current items: `towels`, `ball_hopper`, `water_bottles`, `racket`.

**Adding sounds:** All sounds are procedural in `src/systems/SoundSystem.js` using Web Audio API oscillators and noise buffers. Add new methods following the existing patterns: create an oscillator or gain, schedule ramps and connect to the master gain so volume, mute and pause apply. Wrap them in try/catch like the others.

**Tuning court maintenance:** Adjust values in `Constants.js` under the `GAME` object:
- `groomCellSize`: grid resolution
- `groomSpeedLimit`: max effective speed
- `groomSpeedPenalty`: speed cutoff
- `courtDegradeInterval`: how fast courts get dirty
- `groomBrushWidth`: sweep area
- `groomScoreThreshold`: rating threshold
- `proximityOptimalMin`/`Max`: fence/net sweet spot
- `proximityWarnMax`/`DangerMin`: warning thresholds
- `coolerInteractRange`: courtside task range

Proximity distances are measured from the **brush center** to the fence or net. The brush is 3 units wide (1.5 unit radius), so its edge is about 1.5 units closer than the reported distance. Court dirt colors are in `COLORS` under `clayCourtDirty` and `clayCourtClean`, and the dirt/stripe look is in the court surface shader in `Court.js`. Courtside object colors are in `COLORS` under `iglooCooler`, `trashBin`, etc.

**Adding/modifying court junctions:** Edit `public/data/map.json` under `areas.courtJunctions`. Each junction has a position and flags for `hasCooler`/`hasTrashBin`. The `World.js` class builds the 3D objects and `CourtMaintenanceSystem` generates courtside tasks from this data.

**Checking visuals and performance:** With the dev server running, drive the page with Playwright (or the browser console) through `window.__game`: set `timeOfDay`, weather and quality, place the camera, then read `game.renderStats.calls`. Compare the overview draw calls against the < 400 (medium) budget before and after a visual change.
