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
- `npm run validate` — check `public/data/*.json` (`scripts/validate-data.mjs`): every mission step resolves (actions, targets, NPCs, dialogue keys, items, pickup-before-deliver, minimap pins), the shift section and ranks, `schedule.json` (court / NPC ids, start < end, two players per match), the mission `templates` (shape + ~350 sampled generated missions, each validated) and `events.json` (schema, boosts, each event's merged schedule). Exits 1 on any error; warnings don't fail.

There are no unit tests, linters or formatters. The deploy workflow runs `npm run validate` before `npm run build`; the Playwright suites used during development live outside the repo.

## Project Structure

```
├── index.html              # Entry point: crest loading screen (+ fatal-error panel), canvas, #ui-root, fonts
├── vite.config.js          # Vite config (port 3000, base: /Tennis-Attendant-Simulator/)
├── package.json
├── .github/workflows/
│   └── deploy.yml          # GitHub Pages auto-deploy on push to main (validate → build → deploy)
├── scripts/
│   └── validate-data.mjs   # `npm run validate`: data validator (uses MissionValidation.js)
├── src/
│   ├── main.js             # Game class: init, loop, camera (+ groom camera), interactions, pause, save/load, shift + perk wiring, setQuality
│   ├── world/
│   │   ├── World.js        # Ground, paths, courts, buildings, garden, shed, patio, parking, perimeter, trees, lamps, night lights
│   │   ├── Court.js        # Shader-painted court surface (zones, lines, clay paint mask), groomStroke / wearAt, net, fence, lights, props, physics
│   │   ├── Building.js     # Enterable building base: door gaps, rooms, roof/upper-wall cutaway, indoor camera; pro shop + clubhouse
│   │   ├── ClubBuildings.js# Clubhouse (lobby, lounge, café, locker wing), fitness & wellness centre, pool house + pool deck
│   │   ├── InteriorArt.js  # Shared interior furnishing builders (merged by material)
│   │   ├── NavRooms.js     # Room/door nav graph so NPCs route through doorways
│   │   ├── ItemProps.js    # Visible errand items: waiting at pickup spots, carried (hand bones / cart), set down on delivery
│   │   ├── ClubUpgrades.js # Club projects in the world (koi, trophy, planters, scoreboard, patio heaters, hitting wall), shown when funded
│   │   ├── Garden.js       # Paver walks, hedges, flower beds, animated fountain
│   │   └── Scenery.js      # Instanced trees/grass/flowers/benches/lamps/blob shadows + wind sway
│   ├── entities/
│   │   ├── CharacterModel.js # Stylized skinned character (1 draw call each, far LOD), clip playback API, restyle, contact shadows, camera tracker
│   │   ├── CharacterRig.js # Shared skeleton layout + bone rotation conventions
│   │   ├── CharacterAnimations.js # 22 procedural clips (CLIP_DEFS key poses → baked AnimationClips), Animator, contact probe
│   │   ├── Player.js       # Player character: physics body, locomotion clips, seated in cart, setCapColor (rank perk)
│   │   ├── GolfCart.js     # Drivable cart: physics, steering, body roll, lights, towed drag brush (trailer kinematics) + clay dust, perk hooks
│   │   ├── NPC.js          # NPC: per-NPC looks, wandering / sitting / playing states, name tags, request marker, reactions
│   │   ├── Seats.js        # Benches NPCs can sit on (found from the built world; registerSeat)
│   │   └── TennisBall.js   # Pooled analytic match ball (parabolic segments) + blob shadow
│   ├── systems/
│   │   ├── InputSystem.js  # Keyboard (WASD/arrows/Space/E/Enter/Q/R/C/Esc/P/1-9) + touch + camera drag
│   │   ├── WeatherSystem.js# Day/night keyframes, weather, lights, shadows, sky, env map, rain/wind; writes EnvState
│   │   ├── DialogueSystem.js# Dialogue queue, branching choices, NPC conversation flow
│   │   ├── MissionSystem.js# Task board, radio dispatch (On it / Busy), random encounters, shift routines, step logic, goTo arrival
│   │   ├── MissionValidation.js # Pure "can this mission be completed?" + schedule checks (runtime + `npm run validate`), parseHour
│   │   ├── MissionGenerator.js # Procedural missions from missions.json → templates (roles filled from the live world), request classifier
│   │   ├── EventSystem.js  # Daily events calendar (events.json): weekly rotation, dispatch / tip / groom-bonus modifiers, schedule merge
│   │   ├── MissionMarkers.js # Floating gold objective markers for place-based steps (pooled)
│   │   ├── SmallTalk.js    # Per-member small-talk selector (greeting, personality, time-of-day, weather, mood lines)
│   │   ├── ShiftSystem.js  # Daily loop: clock-in, checklist, rush windows, closing, report; wallet, tips, rank + perks
│   │   ├── ShopSystem.js   # Club shop + services: buy / equip gear, cosmetics, cart upgrades; lessons; club projects; horn; validateShop
│   │   ├── MatchSystem.js  # Scheduled member tennis matches (schedule.json): walk-in, rallies, scoring, rain, clay wear
│   │   ├── RoutePlanner.js # A* over static physics boxes for scripted NPC walks (match walk-in / walk-off / rain shelter)
│   │   ├── InventorySystem.js # Carry up to 3 items for errands
│   │   ├── CourtMaintenanceSystem.js # Clay court grooming minigame (paint-mask strokes, groom camera, scoring)
│   │   ├── GroomFX.js      # Floating per-court % labels + sparkle bursts while grooming
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
│   ├── tennis/             # After-hours tennis with Coach Rafa: session, spin ball sim, AI, scoring, HUD, camera, FX, audio
│   ├── ui/
│   │   ├── theme.js        # Shared UI tokens (CSS custom properties --cc-*) + base classes (.cc-panel, .cc-btn…)
│   │   ├── Joystick.js     # Virtual joystick (touch + mouse fallback)
│   │   ├── DialogueBox.js  # Bottom-center dialogue overlay with choices (typewriter)
│   │   ├── PauseMenu.js    # Pause button + menu: Resume, Settings (volume, graphics, camera), Save, Locker, Reset
│   │   ├── HUD.js          # Mini-map, task list, clock/weather, wallet, radio dispatch card, inventory, action button, toasts, grooming overlay (+ groom camera button)
│   │   ├── GroomSummary.js # End-of-groom card with the paint-mask heatmap (auto-hides in game time)
│   │   ├── ShopUI.js       # Shop / lessons / Locker overlay (tabs, item cards with stat deltas, project progress)
│   │   └── ShiftReport.js  # End-of-shift report card (pay, tips, happiness, court quality, rank) + Next day
│   └── utils/
│       ├── Constants.js    # Colors, sizes, game tuning values, area enums
│       └── AssetLoader.js  # JSON data loader with cache + AssetLoadError (per-file failures)
└── public/
    ├── data/
    │   ├── map.json        # Club layout: areas, courts, paths, waypoints
    │   ├── npcs.json       # NPC definitions: names, archetypes (tipChance / tipRange), dialogue pools
    │   ├── missions.json   # Mission templates, dialogue scripts, branching choices, taskTypes pay, "shift" (wage, rush, ranks)
    │   ├── shop.json       # Shop catalog: slots, items (stats / looks / cart looks), lessons, club projects, vendors
    │   ├── schedule.json   # Court reservations for member matches (MatchSystem)
    │   └── events.json     # Daily events calendar (EventSystem): week rotation, event modifiers, extra matches
    └── assets/             # Future: models, textures, audio files
```

## Architecture Notes

- **Game loop** is in `src/main.js`. The `Game` class owns the scene, physics world, all systems and entities. `_gameLoop()` runs via `requestAnimationFrame`, clamps `dt` to 0.05 s, and wraps `_update(dt)` and `_render(dt)` in separate try/catch blocks. `_reportLoopError` logs each distinct error once and warns again at 600 repeats. While paused, the loop only re-renders when the canvas was invalidated (resize or quality change).
- **Startup**: `AssetLoader.loadAllData()` loads the three JSON files with `Promise.allSettled`. Failures throw an `AssetLoadError` listing every bad file, and `_showFatalError` shows them on the loading screen with a Reload button. `_normalizeData()` then fills in anything missing (areas, courts, paths, spawn points, waypoints, NPC and mission lists) so a hand-edited file can't crash the game. Finally `_precompileShaders()` compiles every shader variant, including hidden night and rain objects, before the loading screen hides.
- **Physics** uses Cannon.js with `NaiveBroadphase`. The ground is a `CANNON.Plane` and buildings and walls are static `CANNON.Box` bodies, plus thin colonnade columns and trunk bodies for the tree belts. Player and NPCs are `CANNON.Sphere` bodies. The cart is a dynamic `CANNON.Box` (400 kg, Y-axis angular lock to prevent flipping).
  - **Contacts are frictionless** (`defaultContactMaterial.friction = 0` in `Game.init`; no body carries its own `CANNON.Material`). cannon-es caps friction per solver step as an *impulse* of μ·m·g rather than μ·m·g·dt, so at μ 0.5 a velocity-driven body was stopped almost dead every step: the player walked 2.15 m/s at 60 fps and 0.78 m/s at 20 fps against a configured 8. Every moving body is kinematically driven, so stopping is explicit instead: `Player.update` zeroes horizontal velocity without input (player `linearDamping` is 0.01), the cart tracks `currentSpeed` and brakes when parked, and NPCs translate their body position directly (`NPC._walkStep`) and zero velocity every update. Measured now: player 8.0 m/s (7.95 at 20 fps), cart 6.96 of 7 (its 0.3 linear damping).
  - Don't add friction back to make something stop or grip; set its velocity. If a future body really needs friction (a loose ball, a pushed cooler), give it and the statics explicit `CANNON.Material`s and a `ContactMaterial` for that pair only.
- **World building** is data-driven. `World.js` reads `data/map.json` and builds courts, buildings, paths, etc. To add or move areas, edit `public/data/map.json`. Static decoration is parented to `World.staticRoot` and merged with `mergeStaticMeshes(root, { cellSize: 32 })`. Repeated props go through the shared `Scenery` batch (`addTree`, `addBench`, `addLamp`, `addTuft`, `addFlowerClump`, `addBlob`, then `build()` once).
- **NPCs** are defined in `public/data/npcs.json`. Each has an archetype (`entitled`/`friendly`/`clueless`), preferred areas, greeting pools and dialogue lines. Wandering uses waypoints from `map.json`. Each NPC is a `CharacterModel.Character`. Its look comes from `NPC_STYLES` in `NPC.js` (keyed by id) or, failing that, from `_deriveStyle()` (deterministic from id + archetype). The state machine has `idle`, `wandering`, `talking`, `sitting` (on a bench from `Seats.js`) and `playing` (owned by `MatchSystem`; `npc.playing` is true while booked into a match). Name tags are canvas sprites (pill with an archetype color dot) that fade with camera distance. The request marker is a bouncing 3D "!" mesh. Reactions are emoji sprites that float up and fade.
- **Missions** are defined in `public/data/missions.json`. Each mission has typed steps (`goTo`, `dialogue`, `pickup`, `deliver`, `choose`, `groom`). `MissionSystem` manages active missions (max 3; `source: "shift"` routines don't use a slot), the task board, radio dispatch and random encounters. `goTo` steps complete when the player enters the target area: `Game._updateInteractions` calls `MissionSystem.handleArrival(areaId)`, and `_detectCurrentArea` recognises court ids, `proShop`, `patio`, `garden` and `equipmentShed`. Hooks: `onMissionComplete(mission)` (pay, tips, stats, autosave), `onReaction(npcId, mood)`, `onRadioDispatch` / `onDispatchClosed` (the HUD dispatch card) and `onMissionUpdate`.
  - **Completability**: `MissionValidation.js` is the single source of truth. `Game` hands `buildWorldFacts()` to the mission system, which never offers or dispatches a mission with a dead step; `npm run validate` runs the same checks in CI.
  - **Findability**: the "!" marker goes only on the NPC of each active mission's *current* step (`getStepNpcId`) and on NPCs with an offered random encounter. Place-based steps (`goTo`, `pickup`/`deliver` `location`, `groom`) get a floating gold marker from `MissionMarkers` (pooled, hidden when you stand on the spot) and a minimap pin; both use `getStepTargetPoint(step)` → a static `{x, z, h}` from `Game._buildTargetPoints()` (court and area centres, set through `setWorldFacts`).
  - **Radio dispatch** offers a mission on a HUD card with **On it** / **Busy**; only "On it" makes it active. An unanswered card counts as Busy after `GAME.dispatchCardTimeout` (no penalty), then `dispatchDeclineCooldown` passes before the next. Dispatch only runs on shift and runs `rushDispatchScale`× faster inside rush windows. Accepting a random encounter plays its first dialogue step and advances.
  - Missions are one-shot per day: `newDay()` (Next day) lets repeatable missions return; shift routines come back every day.
- **Dialogue** flows through `DialogueSystem`, which controls `DialogueBox`, a typewriter overlay. Space, Enter, E or a tap finishes the line, then advances. Keys 1–9 pick a choice. Dialogues are keyed in `public/data/missions.json` under `dialogues`. A missing key logs one warning and shows a fallback line. Speaker names are color-coded by archetype.
- **Camera** follows the player or cart in third person with lerp smoothing. In cart mode it follows the cart's heading. On foot, the player rotates it with Q/R or by dragging on the right side of the screen (>35% width), scaled by the camera-sensitivity setting. Portrait screens get FOV 72 and a slightly pulled-back camera. `_snapCamera()` jumps straight to the follow pose after a save loads.
  - **Groom camera**: while grooming (in the cart, brush attached), **C** or the camera button on the grooming panel calls `CourtMaintenanceSystem.toggleGroomCamera()`. `_updateCamera` asks `computeGroomCameraPose(_camDesired, _camLook, cameraYaw)` first (a high-angle view 15 m up over the brush) and falls back to `_computeCameraPose` when it returns false. The flag resets when a session starts or ends, and the HUD button's `aria-pressed` is cleared in `hideGroomingHUD()`.
- **Sound** is fully procedural via the Web Audio API in `SoundSystem.js`. Footsteps, cart engine, UI clicks, pickups, notifications, bird chirps, the brush scrape loop (`setBrushScrape(level, speed)`), brush attach, groom chimes and completion, proximity warnings, cooler swap, trash pickup, mission complete, coins, radio chirps, rank-up and match ball hits / bounces (`playBallHit(volume, kind)`, distance-attenuated) are all synthesized at runtime. There are no audio files. The system initializes on the first user interaction (browser autoplay rules). `setMasterVolume`, `setMuted` and `setPaused` work before init too. `available` becomes false if Web Audio fails, and the pause menu then says so.
- **Court Maintenance** is managed by `CourtMaintenanceSystem.js`.
  - **Setup**: three adjacent clay courts (3, 4 and 5) are all groomed in a single session. The player attaches a drag brush to the golf cart at the equipment shed, then drives onto any clay court to begin.
  - **Paint mask**: each clay court keeps a `gridCols × gridRows` RGBA `DataTexture` over its whole pad at `GAME.groomMaskRes` (4) cells per unit (0.25 m cells; 64×112 over the 16×28 playing slab), sampled by the court surface shader. R = dirt, G = lateral position across the brush (draws bristle lines along the driven path), B/A = pull direction × stroke strength (lane shading). Cleanliness and coverage are read back from the cells over the playing slab (`getCleanliness`, `getCoverage`, cached until the mask changes).
  - **Strokes**: every frame the towed brush's footprint (`cart.getBrushWidth()` × `GAME.groomBrushDepth`) is swept from the previous brush position to the current one with `court.groomStroke(ax, az, bx, bz, hx, hz, width, depth, strength)`; one full pass at a good speed removes `groomPassClean` dirt. Above `groomSpeedLimit` strength falls off; above `groomSpeedPenalty` or in rain nothing is painted.
  - **Towed brush**: `GolfCart` models the brush as a trailer on a rigid bar (`groomTowLength` from the hitch, swing clamped to `groomTowMaxAngle`) plus a trailing drag mat on its own hinge. `cart.brushState` (`x, z, hx, hz, speed, angle, groundY`) is the brush centre and pull direction everything else reads. Visual only; physics never sees it.
  - **Wear**: `court.wearAt(x, z, radius, amount)` adds localized dirt (MatchSystem footwork and bounces, ×`GAME.matchWearScale`). `degradeSurface(amount)` adds a uniform layer: `courtDegradeAmount` every `courtDegradeInterval` s while the shift clock runs (`degradePaused` mirrors `weather.clockFrozen`), and `courtOvernightDegrade` on Next day (`degradeOvernight()`), so every morning starts with grooming to do.
  - **Feedback**: `GroomFX` floats a "Court N · 72%" label over each court and bursts sparkles at excellent / 100%; scrape loudness and pitch follow brush speed (`SoundSystem.setBrushScrape`); `GroomSummary` shows the rating card with a heatmap of the three masks and auto-hides after a few *game* seconds (ticked from `CourtMaintenanceSystem.update`, so it holds while paused).
  - **Technique**: fence perimeter first (stay close), then near the nets, then fill in the middles and the areas between courts. Proximity feedback shows the distance to the nearest fence or net (green optimal, yellow warning, red danger).
  - **Courtside tasks**: swap coolers, add cups and empty trash at the junctions between courts during the session.
  - **Rating**: "excellent" needs cleanliness ≥ `groomScoreThreshold`, coverage ≥ 70% and ≥ 80% of courtside tasks done.
  - **Rules**: a first-time tutorial from Hank teaches the technique. Courts wear from play and a light uniform tick, and rain blocks grooming. A clay court being groomed ends any match on it and can't be booked until the session ends.
  - **Integration**: the `groom` mission step integrates with `MissionSystem`, and `onGroomEnd` feeds `ShiftSystem.recordGroom` (the groom bonus is paid with the maintenance mission). `getState()`/`setState()`/`resumeGrooming()` save the masks (`v2:` base64, see the save table) and can reopen a session that was in progress when the game was saved; old 8×14 hex grids are upsampled on load.
- **Court Junctions** are defined in `map.json` under `areas.courtJunctions`. Each junction sits between two adjacent clay courts at the net line and holds igloo coolers and trash bins. `World.js` builds the 3D objects. During grooming, `CourtMaintenanceSystem` generates courtside tasks for each junction.
- **Player/Cart interaction**: `Player.enterCart()` seats the player mesh in the cart's driver seat (parented to the cart, `drive` clip ticked from the mesh's `onBeforeRender`), disables collision and hands movement to the cart. `getPosition()` then returns the cart position. `Player.exitCart()` places the player beside the cart and re-enables collision. The cart uses velocity-based driving (`currentSpeed` toward `SIZES.cartMaxSpeed × cart.maxSpeedScale`), not force-based; contacts are frictionless (see Physics). Body roll, pitch, bump, wheel steer, lights and brush dust are visual only and don't touch physics. Player and cart meshes are scaled down (`SIZES.playerScale` = 0.85, `SIZES.cartScale` = 0.75) to fit the court sizes.
- **Court collisions**: Nets and back fences have static CANNON.Box physics bodies, preventing the cart and player from driving through them. Net collision spans the full width at net height. Fence collision spans behind each baseline.
- **Perimeter path**: A golf cart path runs around the entire map perimeter, connecting to existing court and entrance paths for a continuous driving loop. The perimeter fence (stone piers, iron pickets, gated north entrance) keeps the original 2 m physics walls.

### Club expansion (members, buildings, errand props)

- **Members**: 20 in `public/data/npcs.json`. Beyond `entitled`/`friendly`/`clueless` there are `competitive`, `social`, `veteran`, `junior` and `staff` archetypes; each archetype's name-tag/dialogue colors and tip settings live in `npcs.json` (`archetypes`). Each member has a bio, quirks, voice, relationships (validated as two-sided), preferred time, tennis level/skill, greetings, small talk, mood/time/weather lines and post-match lines. Looks are hand-authored in `NPC_STYLES` (`NPC.js`). Missions may declare `requires` (prerequisite mission ids) and `hours` ([start, end]) — these gate *offering* only.
- **Staff**: `hank_morris` (grounds), `rafa_ibarra` (head pro), `jess_nakamura` (pro shop), `dani_kowalski` (lifeguard), `gus_papadakis` (snack bar), `marcus_bell` (fitness) and `otis_grant` (security) use the `staff` archetype and are in `schedule.json → exclude`. Optional npcs.json fields parsed by `parseDuty` in `NPC.js`: `post` (waypoint, facing, optional reserved seat, dwell, short wanders and breaks) and `patrol` (route of waypoints, chance, pause, speed). Staff return to their post when a mission step needs them; Otis walks home along his patrol route. `tips` and `hints` small-talk pools: hints are templates with `{name}` and `{place}` (filled from `MissionSystem._whereabouts` / `Game._describePlace`, preferring members an active mission waits on). Post/patrol waypoints are named `post_*` / `patrol_*` so members never wander to them. On the minimap, staff are mint and Hank is an orange "H" badge pinned to the edge; members involved in an active mission are sky blue (`MissionSystem.collectInvolvedNpcIds`).
- **Enterable buildings**: every building except the equipment shed (a drive-in bay for the cart) can be entered on foot. Walls are merged with the upper band after the lower band in the same mesh, so the indoor cutaway draws fewer indices instead of adding draw calls. Interiors are hidden beyond 32 m from the camera. Indoor areas (`clubhouseLobby`, `memberLounge`, `cafe`, `lockerRoom`, `fitnessCenter`, `poolHouse`) and `pool` are detected before the patio in `Game._detectCurrentArea` and are valid mission targets (`INDOOR_AREAS` / `OUTDOOR_EXTRA_AREAS` in `MissionValidation.js`). NPCs route through doors via `NavRooms.js`.
- **Errand props**: `ItemProps` shows each pickup item at its spot while the step is current, attaches carried items to the player's hand bones (or the cart's bag rack/seat), and sets items down at the delivery spot for 20 s. Resting spots are data in `map.json` → `itemSpots`, keyed `<area>_<pickup|deliver>[_<itemId>]` with `x, y, z, rot`. If you move a counter, table or bench, move its spot too.

### Mission variety and events (`systems/MissionGenerator.js`, `systems/EventSystem.js`)

- **Generated missions**: `missions.json → templates.list` holds ~30 parameterised templates (errands, staff runs, rival disputes / friend favours / family / couples from `npcs.json` relationships, lost & found, court prep for upcoming `schedule.json` matches, rain / wind / heat jobs, VIP escort, tournament director, member requests). `roles` are resolved in order (`npc`, `related` + `rel`, `matchPlayer`, `item` + `ownedBy` / `stockedAt`, `area`: list / `itemSource` / `npcArea` / `staffArea` / `court` / `upcomingMatch`, `text`) and fill `{role}`, `{role.first}`, `{role.label}`, `{Role}`, `{court.time}`. Dialogue text can be keyed by npc id or archetype (`'*'` default); `greet` / `idle` / `thanks` pull the speaker's own npcs.json lines. `builder: "request"` turns a member's `requests` line into steps (item errand, message relay, place check or groom). Items come from InventorySystem `ITEMS` live (unknown ones use `itemSources["*"]`). Every generated mission passes `missionErrors` before it is offered; generated dialogue steps carry `lines` ([{ speaker, text }]). Gates: `minDay`, `minRank`, `hours`, `weather`, `afterRain`, `events`.
- **Where they appear**: `_refreshTaskBoard` mixes authored and generated missions by weight (2–4 options, event `boardSize`; at most two daily repeatables and one maintenance job per board), `_topUpBoard` keeps ≥ 2 after a pick, `_dispatchRadio` always finds something, and `_checkGeneratedEncounter` gives a nearby free member a generated request now and then (one at a time, `GEN_ENCOUNTER_*`).
- **Anti-repetition** (`MissionSystem.history`, saved): accepted / completed missions by `sig` (template + key roles) with cooldowns (`cooldownDays`, default 2), members helped recently weigh less (`npcWeight`), templates rotate within a day, yesterday's offers are damped. Generated mission ids are unique (`g<day>-<seq>-<template>`) and are saved with their full definition.
- **Storylines**: authored chapters use `requires` + `hours` + `minDay` / `minRank` (validated): the Greenbriar Cup (day 3+), Hank's last season (rank 1–3), Kevin's doubles (day 2+), and the board's offer (Head of Grounds, day 10+). Rank-gated templates: `staff_relay` (Senior), `tournament_director` (Head of Grounds).
- **Events** (`public/data/events.json`, day 1 = Monday): `week.<mon..sun>` weighted ids, `wildcard.chance`, no repeat of the last two days. An event sets `dispatchRate` (`MissionSystem.eventDispatchScale`), `tipMultiplier` / `groomBonusMultiplier` (`ShiftSystem.eventTipMultiplier` / `eventGroomBonusMultiplier`), `boardSize`, `templateBoost` / `missionBoost`, forced morning `weather` (`weatherUntil`) and extra `schedule` matches (merged with `mergeSchedule` and pushed through `MatchSystem.setSchedule` at day start / load only). It is announced on the clock-in radio card, shown in the time pill (`HUD.setEventLabel`) and on the report card (`report.event`).
- **Measuring**: a headless multi-day sim of MissionSystem + ShiftSystem + EventSystem (player accepts board / radio / encounters, finishes each task in 80–220 s) went from 18 offers a day, 30 distinct missions ever, 79 % of offers repeated within 3 days and a regularly empty board / dry radio, to ~49 offers a day, 500+ distinct missions over 30 days, ~30 % offer repeats (18 % of completed missions) and no empty board or dry radio.

### Shift loop (`systems/ShiftSystem.js`, `ui/ShiftReport.js`)

- **Phases**: `preShift` (clock frozen at `GAME.shiftStartHour` 7:00, clock-in radio card, no dispatch) → `onShift` (clock runs; the opening checklist, `missions.json → shift.openingMission`, starts; rush windows from `shift.rushWindows` speed up dispatch; at `shiftClosingHour` 18:30 the closing duties are radioed in) → `ending` (clock frozen at `shiftEndHour` 19:00, waits for a quiet moment: no dialogue, not grooming) → `report` (game paused with reason `'report'`, report card) → **Next day** (`Game.startNextDay`: 7:00 the next morning, `missions.newDay()`, overnight court wear, clock-in card). The night is skipped. A shift is about 19 real minutes.
- **Money**: wages (`shift.hourlyWage` × hours worked), mission pay (`taskTypes[type].baseReward`, plus `groomBonus[rating]` on a maintenance mission after a groom) and tips. A tip rolls the client's archetype `tipChance` / `tipRange` (npcs.json), scaled by mood (`tipMoods`) and the Head of Grounds `tipBonus`. `onEarn` drives the HUD wallet and "+$X" floaters.
- **Rank**: points = lifetime earnings + rep × `shift.repPoints`; rep comes from tasks, satisfied members, grooms and checklists (`shift.rep`). `shift.ranks` (points strictly increasing, first at 0) are Rookie Attendant → Court Attendant → Senior Attendant → Grounds Lead → Head of Grounds. Perks are cumulative (later ranks override a key): `cartSpeed` (fraction), `brushWidth` (m), `capColor`, `tipBonus`.
- **Perk hooks**: `ShiftSystem.onPerks(perks)` → `Game._applyPerks`, which sets `cart.maxSpeedScale`, `cart.setBrushWidthBonus()` (paint width *and* the brush mesh) and `player.setCapColor()` (`Character.restyle({ hatColor, hatBrim })`, a cached geometry swap). `SIZES` / `GAME` are never mutated. `onPerks` also fires from `setState()`, so perks re-apply on every load.
- The report card shows tasks, tips, member happiness, court quality (`CourtMaintenanceSystem.getAverageCleanliness()`), pay breakdown, "Spent today" (shop), checklists and rank progress.

### Shop and spending (`systems/ShopSystem.js`, `ui/ShopUI.js`, `world/ClubUpgrades.js`, `public/data/shop.json`)

- **What wages buy** (all data in `shop.json`, checked by `validateShop` in `npm run validate`): **Tennis gear** (slots `racket`, `strings`, `shoes`, `grip`; `stats` add to `PlayerProfile.getTennisStats()`, most with a trade-off; `look` colours the racket frame / strings, shoes, wristband), **Lessons** with Coach Rafa (`lessons.list[].boosts` → `profile.applyLesson`; `perDay` 2, price `basePrice + priceStep × lessons taken` capped at `maxPrice`), **Style** (`uniform`, `hat`, `eyewear`: `look` = Player style keys), **Cart** (`cartPaint`, `cartCanopy`, `cartLights`, `cartHorn`, `cartRack`: `cart` = `GolfCart.restyle` keys + `horn`), **Club projects** (contributions add up across days; each `id` must be a `ClubUpgrades` builder). `minRank` (rank index) locks an item; every non-optional slot has one free `starter` item (granted and worn on new games and old saves).
- **Economy**: a shift pays about $300–450 (wage $144 + $90–200 task pay + $50–165 tips in full-shift test runs). Cosmetics $120–480, gear $120–1150, cart $180–900, lessons $150 → $400, projects $1,200–3,500 (about 3–10 shifts; all six ≈ $13,200).
- **Entry points**: the **Shop** action at the pro shop counter (`Game._nearShopCounter`, customer side of the Building counter) opens every tab; talking to Jess or Rafa with nothing mission-related (`Game._offerShopTalk`; `shop.json → vendors`) offers "Browse the shop" / "Book a lesson" or small talk; the pause menu **Locker** opens `ShopUI` in locker mode (equip owned items only, over the pause menu). `Game.openShop({ vendor, tab, mode })` pauses with reason `'shop'` (no pause menu); Esc / ✕ closes and resumes (`togglePause` closes the shop first).
- **State** lives in `PlayerProfile` (saved as `profile`): `owned`, `equipped`, `projects` (contributed $), `lessons`, `skills`, and `shop` (`day`, `spentToday`, `lessonsToday`, `spentTotal`; reset when the game day changes). Money goes through `profile.spend` → the shift wallet (rank points use lifetime earnings, so spending never costs rank). On load `profile.setState` emits `'load'` → `ShopSystem.applyAll()` re-grants starters, re-dresses the player / repaints the cart (`onLook`) and shows funded projects (`onProjectsChanged`).
- **Looks**: `Player.setOutfit(look)` builds one complete style patch (`OUTFIT_KEYS`, defaults from `PLAYER_STYLE`) and restyles only when it changes; a shop hat replaces the staff cap, otherwise the rank `capColor` (gold Grounds Lead cap) still applies, and buying a hat while the rank cap is earned leaves it in the Locker until chosen. `Character.restyle` keys its geometry cache on the full style diff, so cumulative patches are safe. `GolfCart.restyle(look)` swaps cached merged paint / matte / headlight geometries (no extra draw calls); `ShopSystem.honk()` plays the equipped horn (H while driving).
- **Club projects in the world** (`ClubUpgrades`, built hidden at load so shaders precompile, one or two merged meshes each on the buildings' prop / metal / lamp-glass materials, static bodies only while shown): koi + lily pads circling the fountain, a cup on the lounge trophy case (hidden beyond 32 m), brick planters by the entrance walk, a double-sided Court 1 scoreboard (canvas face redrawn only when `MatchSystem`'s court-1 score changes), patio heaters + colonnade lanterns (night glow), and a practice hitting wall with its own pad behind Court 2. All six add about 10 draw calls (overview, same frame: medium 301 → 312, low 229 → 236, high 533 → 549).
- **Feedback**: coin sound on every spend, wallet bump + status line in the shop, rank-up jingle when a project completes, and confetti + a toast when the shop closes. Members (not staff) mention funded projects in small talk (`SmallTalk.setClubTalkProvider` → `ShopSystem.clubTalk()`).

### Characters and clips (`entities/CharacterModel.js`, `CharacterAnimations.js`, `CharacterRig.js`)

- Every person is one `SkinnedMesh` with the shared 19-bone rig (`BONE_DEFS` in `CharacterRig.js`, including racket and ball prop bones that are hidden by scaling them to 0), all vertex-coloured with one material. The clips are **procedural**: `CLIP_DEFS` holds sparse key poses (per-bone Euler degrees, order `'YXZ'`, optional `hipsPos` and leg IK sole targets), resampled at 30 fps with Catmull-Rom and baked once into shared `THREE.AnimationClip`s. No external model or animation files.
- 22 clips: `idle`, `idle_look`, `idle_shift`, `idle_watch`, `walk`, `run`, `talk`, `greet`, `wave`, `react_happy`, `react_annoyed`, `shrug`, `sit`, `drive`, `ready`, `split_step`, `shuffle_left`, `shuffle_right`, `forehand`, `backhand`, `serve`, `pickup_ball`.
- API on `Character`: `setLocomotion(move01, cyclesPerSecond, run01)` + `update(dt)` (idle/walk/run blend); `play(name, { fade, loop, timeScale, then, onDone, startAt, fadeOut })` (looping clips become the base pose, one-shots fade back to it; returns the duration); `stop()`; `onClipEvent(clip, event, cb)` (`contact`, serve `release`, `grab`, `land`, every one-shot `end`; `'*'` = any clip); `getClipDuration`, `getClipEventTime`, `getContactPointWorld(name, out)` (racket head at contact, from the cached probe); `lookAt(target)`; `setSeated(on)`; `setLod(far)`; `restyle(patch)`; `updateEvery` (mixer every Nth frame on low / far).

### Matches (`systems/MatchSystem.js`, `public/data/schedule.json`)

- `schedule.json`: `maxConcurrent` (0–5), `format` (`gamesToWin` 1–6, `noAd`, `warmupSeconds`), `lateStartHours` (how long after `start` a match may still begin), `pool` (members for `"any"` and substitutes), `exclude` (never scheduled; Hank), and `matches[]` of `{ id, court, start, end, players }`. `court` is an id or a list of alternatives (first free wins); times are hours (`8.5`) or `"8:30"`; `players` are two npcs.json ids or `"any"`. A booked member who is busy (mission step, talking to you, already playing) is substituted from the pool after about 12 game minutes.
- Flow: `walkIn` (fence-aware route from `RoutePlanner`) → `warmup` → `setup` / `point` (serve with toss, rallies, net and out errors, winners, no-ad scoring) → `handshake` → `walkOut` to a preferred area. Rain sends players to the nearest benches (`rain` phase) and resumes when it clears; grooming a clay court ends its match; talking to a player pauses the rally and replays the point.
- The ball is analytic (`TennisBall`: parabolic segments on the match clock). Each contact is planned: the receiver runs to where the racket head will meet the ball (`getContactPointWorld`) and starts the swing exactly `contact` seconds early; the remaining flight is re-aimed at the real racket at swing start. One pooled ball per court, no per-frame allocation, frustum LOD on low.
- Wear on clay is queued and flushed to `court.wearAt` every 0.4 s (one texture upload per court). Hit and bounce "pocks" go through `SoundSystem.playBallHit(volume, kind)` with distance attenuation.
- Matches are not saved; after a load the schedule restarts any match still inside its late-start window. Dev: `__game.matches.debugStart('court1', ['chad_blake', 'tommy_chen'], { teleport: true, warmup: 0, gamesToWin: 1 })`, `.debugStop(id)`, `.list()`, `.enabled`.

### After-hours tennis (`src/tennis/`)

- **Entry**: the shift report's "Stay for a hit with Coach Rafa" button (`ShiftReport` `onTennis`), or talking to Rafa after `shiftClosingHour` (`TennisSession.offerFromNpc`, hooked in `Game._runAction` 'talk'). `begin()` sets 7:30 PM (clock frozen, rain cleared, weather rerolls held), takes Court 1 (`NPC.setAreaBusy`, any match there ends, its back fences / signs hidden for the camera), puts Rafa in the `playing` state and hides the regular HUD (`body.cc-tennis`). While `tennis.active`, `Game._update` hands the frame to `TennisSession.update(dt)`, which steps physics, NPCs, matches, world, weather and its own camera. Leaving (`end()`): Next day if the report was already shown, else the clock goes to 19:00 and the normal clock-out shows the report. Nothing is saved mid-session; a reload returns to the report card. XP and the record are written when a drill / match ends (or is abandoned via Menu), then autosaved.
- **Files**: `TennisSession.js` (flow, player control, flights and events, scoring glue, XP, coach tips), `TennisBallSim.js` (analytic ball with per-segment gravity for spin: `SPIN` table — topspin dips and kicks, slice floats and skids; `BallPredictor` walks bounces; `planFlight` solves the flight time for a wanted net clearance; court constants), `TennisAI.js` (Rafa: intercept search on the predicted flight + contact probe, `DIFFICULTY` easy/medium/hard, shot choice, serves, drill feeds), `TennisScore.js` (pure scoring: deuce/ad, tiebreak at 6–6 / 4–4 with every-two-points serve rotation, change of ends; formats `short` / `set` / `bo3`), `TennisHUD.js`, `TennisCamera.js`, `TennisFX.js` (landing marker, target rings), `TennisAudio.js` (pocks via `playBallHit`, net thud, crickets).
- **Controls**: move with the joystick / WASD (optional auto-move assist drifts toward the ideal hitting spot after a 0.22 s read); SWING button or Space / J — the racket meets the ball `LEAD` (0.18 s) after the press, quality comes from the predicted ball–racket distance at that instant (Perfect / Good / Early / Late / Stretch / whiff); the timing ring on the button closes at the ideal press. Stick direction at contact aims (left/right, up = deep, down = short). Shots: Flat / Topspin / Slice / Lob (buttons or 1–4). Serve: hold SWING, release in the green (0.72–0.93), stick aims; faults, lets (net cord) and double faults. Shot scatter / pace / net margin come from `PlayerProfile.getTennisStats()` (power, control, spin, speed, serve, stamina), fatigue and incoming pace.
- **Balance** (headless bot, 50 ms timing noise): Easy ≈ comfortable wins, Medium ≈ even, Hard ≈ losses; average rally 4–7 shots. Tune in `DIFFICULTY` (`TennisAI.js`) and the sigma / margin lines in `_playerShot`. XP is capped at `XP_CAP` per stat per session.
- **Rafa's AI**: `TennisAI.js` is his eyes, feet and racket. It searches the predicted flight for five strokes: forehand / backhand after the bounce, `volley_fh` / `volley_bh` out of the air, and `smash` on lobs and high balls. Each swing's lead is the clip's own `contact` event (`CLIP_DEFS`), full or compact (a later `startAt`, e.g. the block return), always at timeScale 1, and contact still goes through `scheduleContact` from the real racket probe. `TennisTactics.js` makes the decisions:
  - `Scout` tracks the player's error rate per wing, whiffs and serve pace.
  - `chooseShot` picks a shot family (drive, approach, passing shot, lob, drop shot, volley, drop volley, smash, overhead, block / drive return, defensive slice, dig). The target uses the difficulty's safety margins, then a Gaussian scatter and a situational mishit roll (stretch, pace, height, risk, `score.pressure()`, `momentum[1]`, rally length).
  - `chooseServe` mixes flat / slice / kick serves and occasional serve-and-volley on Hard. The kick bounces above head height at the baseline, so it stays rare.
  - `recoveryU` places him on the bisector of the player's reply angles.
  - Everything is keyed by `DIFFICULTY`. Easy stays back and gets more patient as a rally grows; Medium approaches sometimes; Hard approaches more and attacks the weaker wing.
  - Measured with the bot (50 ms noise, power 0.8, `short`): the bot wins 72.8% / 53.0% / 40.9% of points on Easy / Medium / Hard. Average rallies are 7.0 / 6.1 / 5.5 shots, and aces stay under 8% of serve points for both players.
  - `ai.stats` counts approaches, volleys, smashes, drops, block returns and so on for tuning.
- **Dev**: `__game.tennis.begin('debug')`, `.startMatch('short', 'easy')`, `.startDrill('fh'|'bh'|'volley'|'serve')`, `.externalClock = true` + `._tick(1/60)` for headless stepping, `.bot = { think(session, dt) { session.ctl.* } }` to drive it. The session adds about 6 draw calls (ball, marker, targets).

### Rendering pipeline (`src/graphics/`)

- **Renderer**: `WebGLRenderer` with `NeutralToneMapping` (Khronos PBR Neutral, which keeps the stylized palette true where ACES washed it out), exposure 1.0, sRGB output. `shadowMap.autoUpdate = false`: `_render()` sets `needsUpdate` once per frame so post passes don't re-render shadows. `renderer.info.autoReset = false`, and `game.renderStats` (`calls`, `triangles`) counts every pass: shadow, scene and post.
- **Lighting**: `WeatherSystem` owns one sun `DirectionalLight` (moonlight at night), a `HemisphereLight` and a tiny ambient floor. 14 hour keyframes (`KEYS`) set sun color and intensity, hemisphere colors and sky top/horizon colors; they are golden around 6–9 and 17–19:30. Weather adds overcast and rain darkening. The shadow frustum (±`shadowExtent`) follows `Game._computeShadowFocus()`, the ground point the camera looks at, and is texel-snapped. On medium and high the sky dome is rendered into a PMREM environment map. Fog color and distance track the horizon.
- **Sky** (`Sky.js`): gradient `SkyDome` with sun and moon discs, `Stars` (medium and high), low-poly `Clouds` whose count depends on tier and weather, and `Horizon` (rolling hills, a backdrop treeline ring and an outer ground ring), so the world never ends at a flat edge.
- **Post FX** (`PostFX.js`): **low** renders directly with canvas MSAA. **Medium** renders into a 4× MSAA HalfFloat target, then `GradeOutputPass` (tone map + sRGB + lift/gamma/gain, saturation, contrast, vignette, dither in one full-screen pass). **High** adds `GTAOPass` (transparent, alpha-tested and `userData.noAO` objects are excluded) and `UnrealBloomPass`. `postFX.updateFromEnv(EnvState)` regrades each frame (cooler at night, warmer at golden hour, flatter when overcast). `postFX.setGrade({...})` changes the base grade.
- **Night**: materials registered with `registerNightGlow` (windows, lamp glass, floodlights, signs) follow `EnvState.lampFactor`. `World._buildLights()` creates up to `maxLights` point lights: a warm carry light that follows the player, then the patio, fountain, parking and gate spots. They are hidden while off so daytime shaders don't pay for them. The cart turns on its headlights, taillights and light pool.
- **Rain and wind**: GPU-animated rain streaks (`RAIN_MAX` × `rainDensity`). Wetness (`EnvState.wetness`) soaks in about 10 s and dries over about 60 s, darkening and glossing materials registered with `registerWet`. Blowing leaves (one `InstancedMesh`) appear when windy. Trees and grass sway through `applyWindSway` uniforms in `Scenery.js`.
- **Courts** render their surface with one shader plane per court (zones, lines and clay dirt) — there is no line geometry. Hard courts that share a surround set `sharedPadLeft`/`sharedPadRight` in `map.json` to drop the inner edging. About 9 draw calls per court.
- **Buildings** are merged by material into about 10 draw calls each. The pro shop roof layer stops drawing (but keeps casting its shadow) while the camera follows the player inside (`Building.setCutaway`, driven from `onBeforeRender`, so there is no game-loop wiring).
- **Characters** (`CharacterModel.js`): one `SkinnedMesh` per person with a 19-bone skeleton driven by an `AnimationMixer` (see Characters and clips), all sharing one vertex-colored material, with a far LOD mesh (always used on low). `BlobShadows` is one `InstancedMesh` of soft contact shadows for all characters and carts. `CameraTracker` records the last rendered camera position so name tags can fade without extra wiring.

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
| `courtcall.save.v1` | `SaveSystem` | Versioned JSON snapshot (`SAVE_VERSION` = 1): time/day/weather, player + cart transforms (brush attached), in-cart flag, camera yaw, missions (active + step, completed, task board, timers), inventory, stats (incl. tips, shifts worked), clay court cleanliness + `courtGrids`, in-progress groom session (time, start cleanliness, tasks done, per-court coverage bit masks), degrade timer, `shift`, `events` (today's event), `missions.generated` (definitions of generated missions on the board / in progress) + `missions.history` (anti-repetition memory), flags (`tutorialSeen`, `groomTutorialSeen`). Roughly 110 KB, most of it the three court masks |
| `courtcall.save.v1.backup` | `SaveSystem` | Unreadable or corrupt saves are moved here (`{ reason, at, raw }`) instead of crashing |
| `courtcall.settings` | `SettingsStore` | `volume` (0–1), `muted`, `cameraSensitivity` (0.25–2.5) |
| `courtcall.quality` | `Quality` | `'low' \| 'medium' \| 'high'` (absent = auto-detect) |

- `courtGrids[courtId]` is the v2 paint-mask format `'v2:<cols>x<rows>:<base64>'` from `Court.getMaskData()` (the whole RGBA mask, lossless round trip; `sanitizeSave` accepts up to 256 KB per court). The pre-mask format, an 8×14 hex grid (2 or 6 hex chars per cell), is still accepted and bilinearly upsampled by `Court.setGridHex`, so old saves need no version bump.
- `shift` is `ShiftSystem.getState()`: `phase`, `wallet`, `lifetimeEarnings`, `lifetimeTips`, `rep`, `rankIndex`, `shiftsWorked` and the `current` shift counters (clock-in hour, tasks, pay, tips, moods, checklist flags, start rank/points, pending groom rating, wage). `sanitizeShift` clamps it; a save without it (pre-shift) derives the phase from the clock. A `report` phase reloads as `ending` so the report card is shown again. Matches are not saved.
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
| `GAME.dayDurationSeconds` | 2250 | Real seconds per in-game day (37.5 min; a 7 AM–7 PM shift ≈ 19 min) |
| `GAME.startHour` | 9 | Starting hour for a new game |
| `GAME.weatherCheckInterval` | 60 | Seconds between weather re-rolls |
| `GAME.weatherChangeProbability` | 0.3 | Chance the weather changes on a re-roll |
| `GAME.maxActiveMissions` | 3 | Simultaneous mission cap |
| `GAME.interactionRange` | 3 | Distance to interact with NPCs/objects |
| `GAME.radioDispatchInterval` | 90 | Seconds between radio dispatches |
| `GAME.taskBoardRefreshInterval` | 120 | Seconds between task board refreshes |
| `GAME.randomEncounterChance` | 0.15 | Per-frame-equivalent encounter chance (checked every 0.5 s) |
| `GAME.gravity` | -9.82 | Physics gravity |
| `GAME.groomCellSize` | 2 | Legacy 8×14 grid cell size (unused since the paint mask; old saves are upsampled) |
| `GAME.groomMaskRes` | 4 | Paint-mask cells per world unit (0.25 m cells) |
| `GAME.groomBrushDepth` | 0.55 | Brush footprint depth along the direction of travel |
| `GAME.groomPassClean` | 0.9 | Dirt removed by one full pass at a good speed |
| `GAME.groomTowLength` | 1.75 | Hitch → brush centre on the tow bar |
| `GAME.groomTowMaxAngle` | 1.2 | Max tow-bar swing from the cart's axis (radians) |
| `GAME.groomSpeedLimit` | 5 | Max speed for quality grooming (units/s) |
| `GAME.groomSpeedPenalty` | 8 | Above this speed, no grooming happens |
| `GAME.courtDegradeInterval` | 120 | Seconds between court degradation ticks |
| `GAME.courtDegradeAmount` | 0.01 | Uniform dirt per tick while the shift clock runs (was 0.05). Over a simulated shift a clay court with two matches loses ~0.14: ~0.075 from this tick, ~0.065 from play, concentrated on the baselines |
| `GAME.courtOvernightDegrade` | 0.12 | Uniform dirt added on Next day |
| `GAME.matchWearScale` | 6 | Multiplier on match footwork / bounce wear (`Court.wearAt`) |
| `GAME.groomBrushWidth` | 3 | Brush sweep width (world units; + `brushWidth` rank perk via `cart.getBrushWidth()`) |
| `GAME.groomScoreThreshold` | 0.85 | Cleanliness needed for "excellent" (also needs ≥70% coverage, ≥80% courtside tasks) |
| `GAME.proximityOptimalMin` | 0.5 | Min safe brush-center distance to fence/net |
| `GAME.proximityOptimalMax` | 3.0 | Max optimal brush-center distance (edge ~1.5m from fence) |
| `GAME.proximityWarnMax` | 4.5 | Warning distance — getting too far |
| `GAME.proximityDangerMin` | 0.3 | Danger — brush hitting fence/net |
| `GAME.coolerInteractRange` | 2.5 | Range to interact with courtside objects |
| `GAME.shiftStartHour` | 7 | Clock-in; each new day starts here (the night is skipped) |
| `GAME.shiftClosingHour` | 18.5 | Closing duties are radioed in |
| `GAME.shiftEndHour` | 19 | Clock-out → report card |
| `GAME.rushDispatchScale` | 2.25 | Radio dispatch runs this much faster in rush windows |
| `GAME.dispatchCardTimeout` | 25 | Seconds before an unanswered dispatch card counts as Busy |
| `GAME.dispatchDeclineCooldown` | 30 | Seconds until the next dispatch after Busy |

Outside `Constants.js`: wages, rush windows, rep values, `groomBonus` and ranks in `missions.json → shift`; mission pay in `missions.json → taskTypes`; tip odds in `npcs.json` (`archetypes.*.tipChance` / `tipRange`, `tipMoods`); match format in `schedule.json`; `AUTOSAVE_INTERVAL` = 30 s (`main.js`); `MINIMAP_INTERVAL` ≈ 83 ms / 12 fps and `TOAST_MAX` = 3 (`HUD.js`); per-tier graphics values in `QUALITY_SETTINGS` (`graphics/Quality.js`); lighting keyframes `KEYS`, `SUNRISE`/`SUNSET` and `WEATHER_TARGETS` (`WeatherSystem.js`); name-tag fade distances (`NPC.js`).

## Common Tasks

**Adding a new NPC:** Add an entry to `data/npcs.json` under `npcs[]` with id, name, archetype, shirtColor, preferredAreas, greetings, requests and dialoguePool. The NPC spawns and wanders automatically, with a look derived from its id and archetype. For a hand-authored look (hair, hat, skin, bottom, brows/mouth, racket, scale, ...), add an entry keyed by the id to `NPC_STYLES` in `src/entities/NPC.js`.

**Adding a mission template:** Add an entry to `missions.json → templates.list` (see "Mission variety and events"), give its `type` a `taskTypes` entry, and run `npm run validate`, which samples fills from every template and validates each result. A `random` template must open with a dialogue step by its `trigger` role. **Adding an event:** add it to `events.json → events` and list its id under one or more `week` days (or `wildcard`).

**Adding a new mission:** Add an entry to `data/missions.json` under `missions[]` with id, type, title, description, source (`taskBoard`/`radio`/`random`, or `shift` for a routine referenced by `shift.openingMission` / `closingMission`) and a steps array. A `random` mission needs a `triggerNpc`; `client` names the member who tips. Give the `type` a `taskTypes` entry (`baseReward`) or it pays nothing. Run `npm run validate` afterwards: a mission with a dead step is never offered in game. Add any dialogue scripts to the `dialogues` object. Supported step actions: `goTo`, `dialogue`, `pickup`, `deliver`, `choose`, `groom`. A `goTo` `target` must be something `Game._detectCurrentArea` returns (a court id, `proShop`, `patio`, `garden`, `equipmentShed`). For the minimap pin it also needs a `<target>_center` or `<target>` waypoint in `map.json`. For maintenance missions, use type `maintenance` and the `groom` step action with a `target` matching a clay court id (e.g., `court3`, `court4`, `court5`). All 3 clay courts are groomed in one session, so a `groom` step targeting any clay court triggers the multi-court grooming system. Saves reference missions by id, so renaming an id drops that mission from existing saves.

**Changing the map layout:** Edit `public/data/map.json`. Court positions, building locations, path routes and waypoints are all defined there, and the world rebuilds from this data on load. Keep new flat pieces on their own layer heights (see "No z-fighting").

**Tuning game feel:** Adjust values in `src/utils/Constants.js`: cart speed (`SIZES.cartMaxSpeed`), player speed (`SIZES.playerSpeed`; both are now reached exactly, see Physics), camera distance (`SIZES.cameraDistance`), day length (`GAME.dayDurationSeconds`), etc.

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

**Adding a shop item / lesson / project:** Add it to `public/data/shop.json` (`items[]` with `id`, `slot`, `name`, `desc`, `price`, optional `stats`, `look`, `cart`, `minRank`; `lessons.list[]` with `boosts`; `projects[]` with `cost`, `place`, `comments`) and run `npm run validate`. A new slot needs an entry in `slots` (with a free `starter` item unless `"optional": true`). A new project also needs a builder in `ClubUpgrades` and its id in `CLUB_UPGRADE_IDS` (`ShopSystem.js`); a new look key needs `PLAYER_LOOK_KEYS` / `CART_LOOK_KEYS` plus support in `Player` / `GolfCart`.

**Adding inventory items:** Add a new entry to the `ITEMS` object in `src/systems/InventorySystem.js` with a name and emoji. Current items: `towels`, `ball_hopper`, `water_bottles`, `racket`.

**Adding sounds:** All sounds are procedural in `src/systems/SoundSystem.js` using Web Audio API oscillators and noise buffers. Add new methods following the existing patterns: create an oscillator or gain, schedule ramps and connect to the master gain so volume, mute and pause apply. Wrap them in try/catch like the others.

**Adding a match:** Add an entry to `public/data/schedule.json → matches[]`: `{ "id": "pm-3", "court": ["court4", "court5"], "start": "17:00", "end": "18:45", "players": ["chad_blake", "any"] }`. Use a unique id, a court id or a list of alternatives from `map.json`, a window of at least 45 game minutes inside the shift (7:00–19:00), and exactly two players (npcs.json ids or `"any"` for a pick from `pool`; never an `exclude`d id or the same member twice). `maxConcurrent` caps simultaneous matches. Run `npm run validate`. To try it at once in dev: `__game.matches.debugStart(courtId, [a, b], { teleport: true, warmup: 0 })`.

**Adding an animation clip:** Add an entry to `CLIP_DEFS` in `src/entities/CharacterAnimations.js`: `{ duration, loop?, base?, keys: [{ t, ease?, <bone>: [x, y, z] degrees, hipsPos?, ik? }], events?: { contact: 0.52 } }`. Follow the sign conventions in `CharacterRig.js`, reuse a shared `base` (e.g. `STAND`) and keep the last key's pose equal to the first for loops. It is baked on first use and shared by every character; play it with `character.play('name')` and listen with `onClipEvent('name', 'contact', cb)`. `getContactPointWorld` works for any clip with a `contact` event. There is no external animation data.

**Adding a rank:** Add `{ "id", "title", "points", "perks"?, "unlock" }` to `missions.json → shift.ranks`; points must increase and the first rank stays at 0. Existing perk keys: `cartSpeed` (fraction, e.g. 0.1), `brushWidth` (metres), `capColor` (CSS colour), `tipBonus` (fraction). Perks are cumulative across reached ranks, a later rank overriding the same key. A new perk key needs a hook in `Game._applyPerks` (set a property on the object it affects; don't mutate `SIZES` / `GAME`); `tipBonus` is read in `ShiftSystem`. The report card and promotion toast show `unlock`.

**Tuning court maintenance:** Adjust values in `Constants.js` under the `GAME` object:
- `groomMaskRes`, `groomBrushDepth`, `groomPassClean`: paint-mask resolution and how much a pass cleans
- `groomTowLength` / `groomTowMaxAngle`: towed-brush feel
- `courtOvernightDegrade`, `matchWearScale`: overnight and match wear
- `groomSpeedLimit`: max effective speed
- `groomSpeedPenalty`: speed cutoff
- `courtDegradeInterval` / `courtDegradeAmount`: the uniform wear tick
- `groomBrushWidth`: sweep area
- `groomScoreThreshold`: rating threshold
- `proximityOptimalMin`/`Max`: fence/net sweet spot
- `proximityWarnMax`/`DangerMin`: warning thresholds
- `coolerInteractRange`: courtside task range

Proximity distances are measured from the **brush center** to the fence or net. The brush is 3 units wide (1.5 unit radius), so its edge is about 1.5 units closer than the reported distance. Court dirt colors are in `COLORS` under `clayCourtDirty` and `clayCourtClean`, and the dirt/stripe look is in the court surface shader in `Court.js`. Courtside object colors are in `COLORS` under `iglooCooler`, `trashBin`, etc.

**Adding/modifying court junctions:** Edit `public/data/map.json` under `areas.courtJunctions`. Each junction has a position and flags for `hasCooler`/`hasTrashBin`. The `World.js` class builds the 3D objects and `CourtMaintenanceSystem` generates courtside tasks from this data.

**Checking visuals and performance:** With the dev server running, drive the page with Playwright (or the browser console) through `window.__game`: set `timeOfDay`, weather and quality, place the camera, then read `game.renderStats.calls`. Compare the overview draw calls against the < 400 (medium) budget before and after a visual change.
