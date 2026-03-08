# CLAUDE.md — Court Call: Tennis Attendant Simulator

This file provides context for Claude Code when working on this project.

## Project Overview

Court Call is a 3D browser-based sandbox game where the player works as a tennis attendant at an upscale private club. Built with Three.js + Cannon.js, bundled with Vite, using vanilla JavaScript (no frameworks). Mobile-first with touch controls. Deployed to GitHub Pages with a base URL of `/Tennis-Attendant-Simulator/`.

## Tech Stack

- **Three.js** (`three ^0.170.0`) — 3D rendering (scenes, meshes, lighting, camera)
- **Cannon.js** (`cannon-es ^0.20.0`) — physics engine (rigid bodies, collisions)
- **Vite** (`^6.2.0`) — dev server and production bundler
- **Web Audio API** — all sounds are procedurally generated (no audio files)
- **Vanilla JavaScript** (ES modules, no React/Vue/etc.)
- All game data lives in **JSON config files** under `public/data/` (served as static assets)

## Commands

- `npm run dev` — start Vite dev server on port 3000
- `npm run build` — production build to `dist/`
- `npm run preview` — preview production build

There are no tests, linters, or formatters configured yet.

## Project Structure

```
├── index.html              # Entry point (loading screen + canvas + UI root)
├── vite.config.js          # Vite config (port 3000, base: /Tennis-Attendant-Simulator/)
├── package.json
├── .github/workflows/
│   └── deploy.yml          # GitHub Pages auto-deploy on push to main
├── src/
│   ├── main.js             # Game class: init, game loop, camera, interaction logic
│   ├── world/
│   │   ├── World.js        # Assembles ground, paths, courts, buildings, garden, equipment shed, parking
│   │   ├── Court.js        # Tennis court with surface, lines, net, fencing, benches, dirt grid (clay)
│   │   ├── Building.js     # Pro shop (interior) and clubhouse structures
│   │   └── Garden.js       # Garden with hedges, flower beds, fountain, trees
│   ├── entities/
│   │   ├── Player.js       # Player character: mesh, physics body, walk animation
│   │   ├── GolfCart.js     # Drivable cart: physics, steering, wheel animation, brush attachment
│   │   └── NPC.js          # NPC: wandering AI, name tags, exclamation marks, reactions
│   ├── systems/
│   │   ├── InputSystem.js  # Keyboard (WASD/arrows/Space/E/Q/R) + touch + camera drag
│   │   ├── WeatherSystem.js# Day/night cycle, weather states, rain/wind particles
│   │   ├── DialogueSystem.js# Dialogue queue, branching choices, NPC conversation flow
│   │   ├── MissionSystem.js# Task board, radio dispatch, random encounters, step logic
│   │   ├── InventorySystem.js # Carry up to 3 items for errands
│   │   ├── CourtMaintenanceSystem.js # Clay court grooming minigame
│   │   └── SoundSystem.js  # Procedural Web Audio API sounds (no audio files)
│   ├── ui/
│   │   ├── Joystick.js     # Virtual joystick (touch + mouse fallback)
│   │   ├── DialogueBox.js  # Bottom-center dialogue overlay with choices
│   │   └── HUD.js          # Mini-map, task list, time/weather, inventory, action button, grooming overlay
│   └── utils/
│       ├── Constants.js    # Colors, sizes, game tuning values, area enums
│       └── AssetLoader.js  # JSON data loader with cache
└── public/
    ├── data/
    │   ├── map.json        # Club layout: areas, courts, paths, waypoints
    │   ├── npcs.json       # NPC definitions: names, archetypes, dialogue pools
    │   └── missions.json   # Mission templates, dialogue scripts, branching choices
    └── assets/             # Future: models, textures, audio files
```

## Architecture Notes

- **Game loop** is in `src/main.js` — the `Game` class owns the scene, physics world, all systems, and entities. The `_gameLoop()` method runs via `requestAnimationFrame`. A try/catch wraps the loop body and logs errors to console.
- **Physics** uses Cannon.js. The ground is a `CANNON.Plane`, buildings/walls are static `CANNON.Box` bodies, player/NPCs are `CANNON.Sphere` bodies, and the cart is a dynamic `CANNON.Box` (400 kg, Y-axis angular lock to prevent flipping).
- **World building** is data-driven. `World.js` reads `data/map.json` and instantiates courts, buildings, paths, etc. To add or move areas, edit `public/data/map.json`.
- **NPCs** are defined in `public/data/npcs.json`. Each has an archetype (`entitled`/`friendly`/`clueless`), preferred areas, greeting pools, and dialogue lines. NPC wandering uses waypoints from `map.json`. NPCs have a state machine: `idle` → `wandering` → `talking` → `playing`.
- **Missions** are defined in `public/data/missions.json`. Each mission has typed steps (`goTo`, `dialogue`, `pickup`, `deliver`, `choose`, `groom`). The `MissionSystem` manages active missions (max 3), the task board, and radio dispatch.
- **Dialogue** flows through `DialogueSystem` which controls `DialogueBox` (the UI overlay). Dialogues are keyed in `public/data/missions.json` under the `dialogues` object. Speaker names are color-coded by archetype.
- **Camera** follows the player/cart in third-person with lerp smoothing. In cart mode, the camera auto-follows cart heading. On foot, the player can rotate the camera with Q/R keys or by dragging on the right side of the screen (>35% width).
- **Sound** is fully procedural via the Web Audio API in `SoundSystem.js`. All sounds (footsteps, cart engine, UI clicks, pickups, notifications, bird chirps, brush scraping, brush attach, groom complete, proximity warnings, cooler swap, trash pickup) are synthesized at runtime — there are no audio files. The system auto-initializes on first user interaction to comply with browser autoplay policies.
- **Court Maintenance** is managed by `CourtMaintenanceSystem.js`. Three adjacent clay courts (3, 4 & 5) share a grid-based dirt system. All three are groomed in a single session. Players attach a drag brush to the golf cart at the equipment shed, then drive onto any clay court to begin. The recommended sweep pattern: fence perimeter first (stay close), then near the nets, then fill in the middles and between courts. Proximity feedback shows distance to nearest fence/net with color-coded status (green=optimal, yellow=warning, red=danger). Courtside tasks (swap coolers, add cups, empty trash) at the junctions between courts must be completed during the session. The system tracks coverage, speed, cleanliness, and courtside task completion, and rates performance. A first-time tutorial from Hank teaches the technique. Courts degrade over time. Rain blocks grooming. The `groom` mission step type integrates with `MissionSystem`.
- **Court Junctions** are defined in `map.json` under `areas.courtJunctions`. Each junction sits between two adjacent clay courts at the net line and holds igloo coolers and trash bins. `World.js` builds the 3D objects. During grooming, `CourtMaintenanceSystem` generates courtside tasks for each junction.
- **Player/Cart interaction**: `Player.enterCart()` hides the player mesh, disables collision, and delegates movement to the cart. `Player.exitCart()` positions the player beside the cart and re-enables collision. The cart uses velocity-based driving (not force-based) since box-on-plane friction eats applied forces.

## Key Conventions

- All visual objects use **low-poly geometric primitives** (boxes, cylinders, spheres, cones). No external 3D models yet — those go in `public/assets/` when ready.
- Colors are centralized in `src/utils/Constants.js` under `COLORS`.
- Game tuning values (speeds, timers, ranges) are in `Constants.js` under `SIZES` and `GAME`.
- The JSON data files are designed to be hand-editable. When adding content (new NPCs, missions, dialogue), edit the JSON files rather than source code.
- UI elements are created as DOM elements appended to `#ui-root`, not rendered in the 3D canvas. All touch targets are minimum 44px.
- The game has **no fail states**. Missions always resolve; NPC satisfaction varies based on player choices.
- Canvas textures are used for name tags, exclamation marks, court labels, and building signs.
- NPCs show a floating `!` icon when they have a request, and display reaction emojis that float up and fade.

## Key Tuning Values (Constants.js)

| Constant | Value | Description |
|----------|-------|-------------|
| `SIZES.playerSpeed` | 8 | Walk speed (units/s) |
| `SIZES.cartMaxSpeed` | 10 | Cart top speed (units/s) |
| `SIZES.cartAcceleration` | 5 | Cart acceleration (units/s^2) |
| `SIZES.cameraDistance` | 8 | Camera follow distance |
| `SIZES.cameraHeight` | 5 | Camera height above target |
| `GAME.dayDurationSeconds` | 600 | Real seconds per in-game day (10 min) |
| `GAME.maxActiveMissions` | 3 | Simultaneous mission cap |
| `GAME.interactionRange` | 3 | Distance to interact with NPCs/objects |
| `GAME.radioDispatchInterval` | 90 | Seconds between radio dispatches |
| `GAME.gravity` | -9.82 | Physics gravity |
| `GAME.groomCellSize` | 2 | Grid cell size for court dirt (world units) |
| `GAME.groomSpeedLimit` | 5 | Max speed for quality grooming (units/s) |
| `GAME.groomSpeedPenalty` | 8 | Above this speed, no grooming happens |
| `GAME.courtDegradeInterval` | 120 | Seconds between court degradation ticks |
| `GAME.groomBrushWidth` | 3 | Brush sweep radius (world units) |
| `GAME.groomScoreThreshold` | 0.85 | Cleanliness needed for "excellent" rating |
| `GAME.proximityOptimalMin` | 0.5 | Min safe distance to fence/net (world units) |
| `GAME.proximityOptimalMax` | 2.0 | Max optimal distance to fence/net |
| `GAME.proximityWarnMax` | 3.5 | Warning distance — getting too far |
| `GAME.proximityDangerMin` | 0.3 | Danger — too close to fence/net |
| `GAME.coolerInteractRange` | 2.5 | Range to interact with courtside objects |

## Common Tasks

**Adding a new NPC:** Add an entry to `data/npcs.json` under `npcs[]` with id, name, archetype, shirtColor, preferredAreas, greetings, requests, and dialoguePool. The NPC will automatically spawn and wander.

**Adding a new mission:** Add an entry to `data/missions.json` under `missions[]` with id, type, title, description, source (`taskBoard`/`radio`/`random`), and steps array. Add any dialogue scripts to the `dialogues` object. Supported step actions: `goTo`, `dialogue`, `pickup`, `deliver`, `choose`, `groom`. For maintenance missions, use type `maintenance` and the `groom` step action with a `target` matching a clay court id (e.g., `court3`, `court4`, `court5`). All 3 clay courts are groomed in one session — a `groom` step targeting any clay court triggers the multi-court grooming system.

**Changing the map layout:** Edit `public/data/map.json`. Court positions, building locations, path routes, and waypoints are all defined there. The world rebuilds from this data on load.

**Tuning game feel:** Adjust values in `src/utils/Constants.js` — cart speed (`SIZES.cartMaxSpeed`), player speed (`SIZES.playerSpeed`), camera distance (`SIZES.cameraDistance`), day length (`GAME.dayDurationSeconds`), etc.

**Adding inventory items:** Add a new entry to the `ITEMS` object in `src/systems/InventorySystem.js` with a name and emoji. Current items: `towels`, `ball_hopper`, `water_bottles`, `racket`.

**Adding sounds:** All sounds are procedural in `src/systems/SoundSystem.js` using Web Audio API oscillators and noise buffers. Add new methods following the existing patterns (create oscillator/gain, schedule ramps, connect to master gain).

**Tuning court maintenance:** Adjust values in `Constants.js` under the `GAME` object — `groomCellSize` (grid resolution), `groomSpeedLimit` (max effective speed), `groomSpeedPenalty` (speed cutoff), `courtDegradeInterval` (how fast courts get dirty), `groomBrushWidth` (sweep area), `groomScoreThreshold` (rating threshold), `proximityOptimalMin`/`Max` (fence/net sweet spot), `proximityWarnMax`/`DangerMin` (warning thresholds), `coolerInteractRange` (courtside task range). Court dirt colors are in `COLORS` under `clayCourtDirty` and `clayCourtClean`. Courtside object colors are in `COLORS` under `iglooCooler`, `trashBin`, etc.

**Adding/modifying court junctions:** Edit `public/data/map.json` under `areas.courtJunctions`. Each junction has a position and flags for `hasCooler`/`hasTrashBin`. The `World.js` class builds the 3D objects and `CourtMaintenanceSystem` generates courtside tasks from this data.
