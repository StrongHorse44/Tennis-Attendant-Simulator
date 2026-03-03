# PLAN.md — Court Call: Development Plan

## Current Architecture

### System Dependency Graph

```
Game (main.js) ─── orchestrates everything
 ├── Renderer (Three.js)
 ├── Physics (Cannon.js)
 ├── InputSystem ──→ Joystick (touch/mouse input)
 ├── Player ←──→ GolfCart (enter/exit coupling)
 ├── NPC[] ──→ waypoints from map.json
 ├── World ──→ Court, Building, Garden (built from map.json)
 ├── WeatherSystem (standalone, updates lighting + particles)
 ├── SoundSystem (standalone, procedural Web Audio)
 ├── DialogueSystem ──→ DialogueBox (UI overlay)
 ├── MissionSystem ──→ DialogueSystem, InventorySystem, NPC[]
 ├── InventorySystem (standalone, 3-slot item store)
 └── HUD ──→ WeatherSystem, MissionSystem, InventorySystem
```

### Data Flow

```
map.json ──→ World (builds environment) + NPC waypoints + area bounds
npcs.json ──→ NPC[] (spawns characters with dialogue pools)
missions.json ──→ MissionSystem (task templates + dialogue scripts)
Constants.js ──→ everything (colors, sizes, tuning values)
```

### Module Responsibilities

| Module | Lines | Role |
|--------|-------|------|
| `main.js` | ~610 | Game loop, camera, interaction detection, system wiring |
| `World.js` | ~300 | Builds ground, paths, courts, buildings, garden from map data |
| `Player.js` | ~225 | Player mesh, physics, walk animation, cart enter/exit |
| `GolfCart.js` | ~250 | Cart mesh, physics, velocity-based driving, wheel animation |
| `NPC.js` | ~350 | NPC mesh, AI state machine, name tags, reactions |
| `InputSystem.js` | ~200 | Keyboard, touch joystick, camera drag |
| `WeatherSystem.js` | ~250 | Day/night cycle, weather states, rain/wind particles |
| `DialogueSystem.js` | ~100 | Dialogue queue, branching choices |
| `MissionSystem.js` | ~300 | Mission lifecycle, task board, radio dispatch |
| `InventorySystem.js` | ~60 | 3-slot item management |
| `SoundSystem.js` | ~300 | Procedural audio via Web Audio API |
| `HUD.js` | ~450 | Mini-map, task list, action button, notifications |
| `DialogueBox.js` | ~150 | Bottom-center dialogue UI overlay |
| `Joystick.js` | ~100 | Virtual joystick for touch/mouse |

---

## Known Issues

### Bugs

| Issue | Severity | Location | Notes |
|-------|----------|----------|-------|
| Missing null check on `taskBoard` in map data | High | `main.js:344-357` | Crashes if `taskBoard` removed from map.json |
| Per-frame Vector3 allocations in camera update | Medium | `main.js:518,523` | GC pressure, potential frame drops on low-end devices |
| Raycaster + Vector2 allocated on every tap | Low | `main.js:257-261` | Should reuse instances |
| Biased shuffle in mission selection | Low | `MissionSystem.js:66` | `Math.random()-0.5` sort is not uniform |
| `Date.now()` in NPC breathing animation | Low | `NPC.js:281` | Won't respect pause/time-scale if added later |
| Mini-map fully redrawn every frame | Low | `HUD.js:312-427` | 120x120 canvas redraw 60x/sec |

### Silent Failures

| Issue | Location | Notes |
|-------|----------|-------|
| Asset loader has no fallback for 404/malformed JSON | `AssetLoader.js` | `Promise.all` rejects if any file fails |
| Game loop catches all errors and continues | `main.js:594` | Can cause infinite error spam |
| Sound system silently fails without user feedback | `SoundSystem.js:41-44` | User doesn't know audio is off |
| Missing dialogue keys log a warning but show nothing | `DialogueSystem.js:42` | Player gets no feedback |

---

## Planned Features

### Phase 1 — Core Polish (High Priority)

- [ ] **Pause menu** — Esc key pauses game loop, shows overlay with Resume / Settings / Quit
- [ ] **Save system** — `localStorage` persistence for completed missions, active progress, player stats
- [ ] **Volume control** — Master volume slider in pause/settings menu, mute toggle
- [ ] **Null checks on map data** — Guard against missing `taskBoard`, missing areas, etc.
- [ ] **Reuse Vector3 objects** — Pre-allocate temp vectors in `_updateCamera()` and `_handleTap()`

### Phase 2 — Gameplay Depth

- [ ] **Player reputation/stats** — Track missions completed, NPC satisfaction scores, tips earned
- [ ] **More mission types** — Court maintenance, lost & found, VIP arrivals, tournament setup
- [ ] **NPC scheduling** — NPCs follow daily routines (morning practice, lunch at patio, evening matches)
- [ ] **Tennis match spectating** — Watch NPCs play matches on courts with basic rally animation
- [ ] **More inventory items** — Sunscreen, first aid kit, snacks, club newsletters

### Phase 3 — Visual & Audio Polish

- [ ] **3D model pipeline** — GLTF/GLB loader for replacing primitive geometry with real models
- [ ] **Texture support** — Court surfaces, building walls, ground materials
- [ ] **Ambient audio** — Background music tracks, crowd murmur, ball-hitting sounds
- [ ] **Particle effects** — Dust clouds behind cart, splash from fountain, confetti on mission complete
- [ ] **Improved lighting** — Point lights in pro shop, patio string lights at night

### Phase 4 — UX & Accessibility

- [ ] **Tutorial overlay** — First-time-player walkthrough of controls and objectives
- [ ] **Gamepad support** — Controller input mapping in InputSystem
- [ ] **Key rebinding** — User-configurable keyboard controls
- [ ] **Fullscreen button** — UI toggle (not just F11)
- [ ] **Mobile text scaling** — Ensure minimum 16px body text, responsive to screen size
- [ ] **FPS counter** — Toggle-able performance overlay for debugging

### Phase 5 — Content Expansion

- [ ] **More NPCs** — Expand beyond 8, add coach/instructor archetypes
- [ ] **Club events** — Scheduled tournaments, social gatherings, seasonal decorations
- [ ] **Expanded map** — Pool area, restaurant, parking garage, practice wall
- [ ] **Dialogue variety** — More dialogue lines per NPC, mood-dependent responses
- [ ] **Achievements** — Track milestones (first mission, 10 deliveries, drive 1000 meters, etc.)

---

## Architecture Improvements

### Refactors to Consider

| Refactor | Benefit | Effort |
|----------|---------|--------|
| Extract `InteractionManager` from `main.js` | Reduces Game class from 610 lines, isolates interaction logic | Medium |
| Extract `CameraController` from `main.js` | Clean separation, easier to add camera modes | Low |
| Centralize area bounds checking into a utility | Removes duplicated bounds logic, easier to add areas | Low |
| Move magic numbers to `Constants.js` | Mini-map size (120), area detection offsets, UI sizes | Low |
| Fisher-Yates shuffle for mission randomization | Correct distribution for mission selection | Trivial |
| Pre-allocate temp vectors as class properties | Eliminates per-frame GC pressure | Low |
| Consistent animation timing (remove `Date.now()` from NPCs) | Enables pause/time-scale support | Low |

### Design Principles

- **Data-driven first** — New content should be added via JSON, not code changes
- **No fail states** — The game should always be playable; errors degrade gracefully
- **Mobile-first** — Touch targets 44px minimum, test on small screens
- **Low-poly aesthetic** — Geometric primitives until real models are ready
- **Procedural audio** — Keep sounds generated, no audio file dependencies
