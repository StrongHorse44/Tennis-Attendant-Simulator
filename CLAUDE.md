# CLAUDE.md — Court Call: Tennis Attendant Simulator

This file provides context for Claude Code when working on this project.

## Project Overview

Court Call is a 3D browser-based sandbox game where the player works as a tennis attendant at an upscale private club. Built with Three.js + Cannon.js, bundled with Vite, using vanilla JavaScript (no frameworks). Mobile-first with touch controls.

## Tech Stack

- **Three.js** — 3D rendering (scenes, meshes, lighting, camera)
- **Cannon.js** (`cannon-es`) — physics engine (rigid bodies, collisions)
- **Vite** — dev server and production bundler
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
├── vite.config.js           # Vite config (port 3000, public dir)
├── package.json
├── .github/workflows/
│   └── deploy.yml           # GitHub Pages auto-deploy on push to main
├── src/
│   ├── main.js              # Game class: init, game loop, camera, interaction logic
│   ├── world/
│   │   ├── World.js         # Assembles ground, paths, courts, buildings, garden, parking
│   │   ├── Court.js         # Tennis court with surface, lines, net, fencing, benches
│   │   ├── Building.js      # Pro shop (interior) and clubhouse structures
│   │   └── Garden.js        # Garden with hedges, flower beds, fountain, trees
│   ├── entities/
│   │   ├── Player.js        # Player character: mesh, physics body, walk animation
│   │   ├── GolfCart.js      # Drivable cart: physics, steering, wheel animation
│   │   └── NPC.js           # NPC: wandering AI, name tags, exclamation marks, reactions
│   ├── systems/
│   │   ├── InputSystem.js   # Keyboard (WASD/arrows/Space/E) + touch tap events
│   │   ├── WeatherSystem.js # Day/night cycle, weather states, rain/wind particles
│   │   ├── DialogueSystem.js# Dialogue queue, branching choices, NPC conversation flow
│   │   ├── MissionSystem.js # Task board, radio dispatch, random encounters, step logic
│   │   └── InventorySystem.js # Carry up to 3 items for errands
│   ├── ui/
│   │   ├── Joystick.js      # Virtual joystick (touch + mouse fallback)
│   │   ├── DialogueBox.js   # Bottom-center dialogue overlay with choices
│   │   └── HUD.js           # Mini-map, task list, time/weather, inventory, action button
│   └── utils/
│       ├── Constants.js     # Colors, sizes, game tuning values, area enums
│       └── AssetLoader.js   # JSON data loader with cache
└── public/
    ├── data/
    │   ├── map.json         # Club layout: areas, courts, paths, waypoints
    │   ├── npcs.json        # NPC definitions: names, archetypes, dialogue pools
    │   └── missions.json    # Mission templates, dialogue scripts, branching choices
    └── assets/              # Future: models, textures, audio files
```

## Architecture Notes

- **Game loop** is in `src/main.js` — the `Game` class owns the scene, physics world, all systems, and entities. The `_gameLoop()` method runs via `requestAnimationFrame`.
- **Physics** uses Cannon.js. The ground is a `CANNON.Plane`, buildings/walls are static `CANNON.Box` bodies, player/NPCs are `CANNON.Sphere` bodies, and the cart is a dynamic `CANNON.Box`.
- **World building** is data-driven. `World.js` reads `data/map.json` and instantiates courts, buildings, paths, etc. To add or move areas, edit `public/data/map.json`.
- **NPCs** are defined in `public/data/npcs.json`. Each has an archetype (`entitled`/`friendly`/`clueless`), preferred areas, greeting pools, and dialogue lines. NPC wandering uses waypoints from `map.json`.
- **Missions** are defined in `public/data/missions.json`. Each mission has typed steps (`goTo`, `dialogue`, `pickup`, `deliver`, `choose`). The `MissionSystem` manages active missions, the task board, and radio dispatch.
- **Dialogue** flows through `DialogueSystem` which controls `DialogueBox` (the UI overlay). Dialogues are keyed in `public/data/missions.json` under the `dialogues` object.
- **Camera** follows the player/cart in third-person with lerp smoothing. Transitions between on-foot and cart mode are handled in `_updateCamera()`.

## Key Conventions

- All visual objects use **low-poly geometric primitives** (boxes, cylinders, spheres, cones). No external 3D models yet — those go in `public/assets/` when ready.
- Colors are centralized in `src/utils/Constants.js` under `COLORS`.
- Game tuning values (speeds, timers, ranges) are in `Constants.js` under `SIZES` and `GAME`.
- The JSON data files are designed to be hand-editable. When adding content (new NPCs, missions, dialogue), edit the JSON files rather than source code.
- UI elements are created as DOM elements appended to `#ui-root`, not rendered in the 3D canvas. All touch targets are minimum 44px.
- The game has **no fail states**. Missions always resolve; NPC satisfaction varies based on player choices.

## Common Tasks

**Adding a new NPC:** Add an entry to `data/npcs.json` under `npcs[]` with id, name, archetype, shirtColor, preferredAreas, greetings, requests, and dialoguePool. The NPC will automatically spawn and wander.

**Adding a new mission:** Add an entry to `data/missions.json` under `missions[]` with id, type, title, description, source (`taskBoard`/`radio`/`random`), and steps array. Add any dialogue scripts to the `dialogues` object. Supported step actions: `goTo`, `dialogue`, `pickup`, `deliver`, `choose`.

**Changing the map layout:** Edit `public/data/map.json`. Court positions, building locations, path routes, and waypoints are all defined there. The world rebuilds from this data on load.

**Tuning game feel:** Adjust values in `src/utils/Constants.js` — cart speed (`SIZES.cartMaxSpeed`), player speed (`SIZES.playerSpeed`), camera distance (`SIZES.cameraDistance`), day length (`GAME.dayDurationSeconds`), etc.
