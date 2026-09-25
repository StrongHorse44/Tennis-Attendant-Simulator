# Court Call — Tennis Attendant Simulator

A relaxed 3D sandbox game where you play as a tennis attendant at an upscale private club. Drive a golf cart, manage reservations, help club members and keep the place running, all at your own pace. No fail states, no time pressure. Just vibes.

Built with Three.js + Cannon.js and playable in any modern browser. Everything is procedural: no model, texture or audio files are loaded.

**[Play it now](https://StrongHorse44.github.io/Tennis-Attendant-Simulator/)**

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:3000/Tennis-Attendant-Simulator/](http://localhost:3000/Tennis-Attendant-Simulator/) in your browser.

## Controls

### Desktop
| Key | Action |
|-----|--------|
| W / Arrow Up | Move forward / accelerate (in cart) |
| S / Arrow Down | Move backward / reverse (in cart) |
| A / Arrow Left | Move left / steer left (in cart) |
| D / Arrow Right | Move right / steer right (in cart) |
| E / Space / Enter | Interact (enter/exit cart, talk, pick up, deliver, attach brush, groom) |
| E / Space / Enter (in dialogue) | Finish the current line, then advance to the next |
| 1 – 9 | Pick a dialogue choice |
| Q / R | Rotate camera left / right (on foot; in the cart the camera follows the cart) |
| Mouse drag | Rotate camera (on foot) |
| Click an NPC | Talk (when in range) |
| Esc / P | Pause / resume (Esc also steps back out of Settings) |

### Mobile
- **Virtual joystick** (bottom-left): move or steer
- **Action button** (bottom-right): context-sensitive interaction (enter cart, talk, pick up, etc.)
- **Tap an NPC** to start a conversation when in range; **tap the dialogue box** to advance
- **Drag on the right side of the screen** to rotate the camera (on foot)
- **Tap the task panel header** (top-left) or **swipe in from the left edge** to open the task list
- **Pause button** (round button under the minimap): pause menu

## Gameplay

You're the attendant at **Greenbriar Tennis & Social Club**. Your day involves:

- **Driving the golf cart** around the club grounds
- **Helping club members** with reservations, complaints, and requests
- **Running errands**: delivering towels, retrieving ball hoppers, restocking water bottles
- **Mediating conflicts** between members with different personalities
- **Grooming the clay courts**: attach a drag brush to your cart and sweep all 3 clay courts (Courts 3, 4 & 5)
- **Checking the task board** in the Pro Shop for new assignments
- **Responding to radio dispatch** for urgent requests

On your first shift, the staff radio walks you through the basics.

### Club Areas

- **Main Entrance & Parking**: where you start, and where the golf cart is parked
- **Pro Shop**: walk inside (the roof cuts away so you can see), check the task board, grab supplies
- **5 Tennis Courts**: 2 hard courts (blue with a green surround) and 3 adjacent clay courts (terracotta)
- **Garden**: hedges, flower beds and an animated fountain
- **Clubhouse Patio**: umbrella tables where members hang out and flag you down
- **Equipment Shed**: near the garden, pick up the drag brush for court grooming

### NPCs

Club members come in three archetypes, shown by the colored dot on their name tag and the color of their name in dialogue:

- **Entitled Members** (red): demanding, never satisfied, rarely tip
- **Friendly Regulars** (green): kind, make small talk, tip generously
- **New Members** (blue): confused, need directions, ask lots of questions

Every member has their own look (hair, hats, outfits, expressions). Members wander between their favorite spots around the club and approach you with requests: look for the bouncing gold **!** above their heads. Reactions appear as floating emoji. Name tags fade in as you get closer.

### Court Maintenance Minigame

The three adjacent clay courts (Courts 3, 4 & 5) need regular grooming. All three are swept in a single session. Here's how:

1. **Get in the golf cart** and drive to the **Equipment Shed** (near the garden)
2. Press **"Attach Brush"**: a drag brush hooks onto the cart's rear
3. **Drive to any clay court** (Courts 3, 4 or 5, the terracotta ones in the back)
4. Press **"Start Groom"** to begin the grooming session
5. **Sweep the outside perimeter first**: stay close to the fence, but not so close you hit it
6. **Then sweep along the nets**: pick a side and drive close to the net on that court
7. **Sweep that half of the court**, then move to the other half and the areas between courts
8. Watch the **Grooming HUD** for cleanliness %, coverage, speed, and proximity indicators
9. **Handle courtside tasks**: swap igloo coolers, add cups, and empty trash bins between the courts
10. Press **"Stop Groom"** when satisfied, and you'll get a performance rating

Groomed clay shows fresh drag-brush stripes in the direction you drove, and the brush kicks up clay dust as you go.

**Proximity feedback** (distance from the *center* of the brush to the nearest fence or net; the brush edge is about 1.5 m closer):
- **Green, "Good"**: 0.5–3 m, sweeping efficiently
- **Yellow, "Get closer"**: 3–4.5 m, move closer for better coverage
- **Red, "Too close!"** under 0.3 m (you're about to hit it), or **"Too far!"** beyond 4.5 m

**Courtside Tasks:**
Between each pair of courts (at the net junctions), you'll find igloo coolers and trash bins. During grooming, stop near them and press the action button to:
- **Swap cooler**: replace it with a fresh one
- **Add cups**: stock the cup holder on the cooler
- **Empty trash**: clear out the trash bin

**Rating:** *Excellent* needs at least 85% cleanliness, 70% coverage and 80% of the courtside tasks done.

**Tips:**
- Your first time triggers a tutorial from **Hank Morris**, the Head Groundskeeper
- Courts get dirty over time from play; darker patches show accumulated dirt
- You can groom anytime, or accept maintenance missions from the task board
- Don't try grooming in the rain, because wet clay can't be brushed!
- Completing all courtside tasks earns a higher rating

### Missions

Tasks come from three sources:

1. **Task Board**: clipboard on the Pro Shop wall, usually has up to 3 tasks available
2. **Radio Dispatch**: new tasks arrive roughly every 90 seconds
3. **Random Encounters**: NPCs flag you down as you walk or drive past

Mission types:
- **Reservation Management**: resolve double bookings and scheduling mix-ups
- **Conflict Resolution**: mediate arguments between members
- **Errands**: pick up and deliver items (towels, ball hoppers, water bottles, rackets)
- **Court Maintenance**: groom clay courts with the drag brush attached to your cart

"Go to" steps complete as soon as you arrive at the place named in the task. The minimap highlights the members you need to talk to. You can have up to 3 active missions at a time. All missions resolve regardless of your choices; NPC satisfaction varies based on your decisions.

### Inventory

Carry up to 3 items at once for errands:
- Fresh Towels
- Ball Hopper
- Water Bottles
- Tennis Racket

### Weather & Time

Your shift starts at 9 AM. A full day passes in 30 real-time minutes (the pause menu shows which day you're on), with lighting that changes through the day:

- **Morning**: warm, golden early light
- **Afternoon**: bright midday sun with crisp shadows
- **Evening**: golden-hour sunset glow
- **Night**: deep-blue moonlight and stars, with lamps, court floodlights, clubhouse windows and the cart's headlights all lit

Weather changes between sunny, cloudy, rainy and windy. Clouds build up when it's overcast. Rain brings streaks and darker, wet, shiny surfaces that dry slowly afterwards. Wind blows leaves around and makes the trees and grass sway.

### Sound

All audio is procedurally generated using the Web Audio API; no sound files are loaded. You'll hear:
- Footsteps while walking
- Cart engine hum while driving (pitch scales with speed)
- UI click and pickup sounds
- Notification chimes for new tasks
- Ambient bird chirps
- Brush scraping on clay during court grooming
- Metallic clank when attaching/detaching the drag brush
- Completion chime when finishing a grooming session
- Proximity warning beeps when too close to fence/net
- Water slosh when swapping coolers
- Crinkle sound when emptying trash

Browsers only allow audio after you interact, so sound starts with your first tap or key press.

## Pause Menu & Settings

Press **Esc** or **P**, or tap the round pause button under the minimap. The game fully freezes: time, weather, missions, members and sound. The menu shows the day, time, weather and your stats (tasks done, courts groomed, best groom rating) and offers:

- **Resume**
- **Settings**
  - **Master volume** slider and **Mute** switch
  - **Graphics quality**: Low / Medium / High (applied instantly)
  - **Camera sensitivity**: 0.25× – 2.5× for drag / Q-R rotation
- **Save**: save right now (the game also autosaves)
- **Reset progress**: after a confirmation, erases your day, missions, inventory, court conditions and stats and restarts your first shift. Settings are kept.

The game also pauses automatically when you switch tabs or minimise the browser.

### Graphics quality

| Tier | What you get | Best for |
|------|--------------|----------|
| **Low** | No shadows or post effects, lighter grass and rain, fewer clouds, simpler far characters | Older phones |
| **Medium** | Soft sun shadows, anti-aliasing, color grading and vignette, sky reflections, stars, a couple of night lights | Most phones and laptops |
| **High** | Sharper, wider shadows, ambient occlusion, bloom on lamps and windows, denser grass, more lights | Desktops |

The first time you play, a tier is picked for your device. Any tier you choose is remembered.

## Saving

Progress is saved automatically in your browser's `localStorage`:

- Every 30 seconds of play, whenever you finish a task or a grooming session, and when you switch tabs or close the page. You can also save manually from the pause menu.
- Saved: time of day and day number, weather, where you and the cart are (and whether you're driving / the brush is attached), active and completed missions, the task board, your inventory, clay court conditions (down to each patch you groomed), an in-progress grooming session, tutorial progress and your stats.
- Coming back shows a "Welcome back" message and puts you right where you left off.
- Settings (volume, mute, camera sensitivity) and graphics quality are stored separately, so **Reset progress** keeps them.
- If a save can't be read, it is set aside as a backup and a new game starts, so the game never gets stuck. In private browsing or with storage disabled, the game still plays, but progress can't be saved and you'll be told once.

## Project Structure

```
├── index.html               # Entry point (loading screen + canvas + UI root)
├── vite.config.js           # Vite configuration (port 3000, base /Tennis-Attendant-Simulator/)
├── package.json
├── .github/workflows/
│   └── deploy.yml           # GitHub Pages auto-deploy on push to main
├── src/
│   ├── main.js              # Game initialization, loop, camera, interactions, pause, save/load
│   ├── world/               # Environment (World, Court, Building, Garden, Scenery)
│   ├── entities/            # Player, GolfCart, NPC, CharacterModel
│   ├── systems/             # Input, Weather, Dialogue, Missions, Inventory, Sound, CourtMaintenance, Save
│   ├── graphics/            # Quality tiers, EnvState, Materials, Textures, GeometryUtils, Sky, PostFX
│   ├── ui/                  # theme, Joystick, DialogueBox, HUD, PauseMenu
│   └── utils/               # Constants, AssetLoader
└── public/
    ├── data/
    │   ├── map.json         # Club layout, courts, paths, waypoints
    │   ├── npcs.json        # NPC definitions and dialogue pools
    │   └── missions.json    # Mission templates and dialogue scripts
    └── assets/              # Future: models, textures, audio
```

See [CLAUDE.md](CLAUDE.md) for architecture details and [PLAN.md](PLAN.md) for the roadmap.

## Adding Content

The game is data-driven. To add content, edit the JSON files in `public/data/`:

### Add an NPC

Add an entry to `public/data/npcs.json`:

```json
{
  "id": "your_npc_id",
  "name": "Display Name",
  "archetype": "entitled|friendly|clueless",
  "shirtColor": "#HEX",
  "preferredAreas": ["patio", "court1"],
  "greetings": ["Hello!", "Hey there!"],
  "requests": ["Can you help me with..."],
  "dialoguePool": {
    "satisfied": ["Thanks!"],
    "unsatisfied": ["Hmph."],
    "idle": ["Nice weather."]
  }
}
```

New NPCs get a unique look generated from their id and archetype. For a hand-picked look (hair, hat, outfit, expression), add an entry to `NPC_STYLES` in `src/entities/NPC.js`.

### Add a Mission

Add an entry to `public/data/missions.json`:

```json
{
  "id": "unique_mission_id",
  "type": "reservation|conflict|errand|maintenance",
  "title": "Mission Title",
  "description": "Short description",
  "source": "taskBoard|radio|random",
  "steps": [
    { "action": "goTo", "target": "court1", "prompt": "Head to Court 1." },
    { "action": "dialogue", "npcId": "npc_id", "dialogueKey": "key" },
    { "action": "pickup", "location": "proShop", "item": "towels" },
    { "action": "deliver", "location": "court4", "item": "towels" },
    { "action": "choose", "prompt": "What do you do?", "choices": [...] },
    { "action": "groom", "target": "court3", "prompt": "Groom Court 3." }
  ]
}
```

`goTo` targets must be a court id (`court1`–`court5`), `proShop`, `patio`, `garden` or `equipmentShed`.

### Modify the Map

Edit `public/data/map.json` to change court positions, add buildings, adjust path routes, or create new waypoints. The world rebuilds from this data on load.

## Tech Stack

- [Three.js](https://threejs.org/) (`^0.170.0`): 3D rendering, including post-processing addons (GTAO, bloom)
- [Cannon-es](https://pmndrs.github.io/cannon-es/) (`^0.20.0`): physics engine
- [Vite](https://vitejs.dev/) (`^6.2.0`): dev server and bundler
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API): procedural sound generation
- [Fraunces](https://fonts.google.com/specimen/Fraunces) and [Inter](https://fonts.google.com/specimen/Inter) from Google Fonts (optional; system fonts are used if they can't load)

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server on port 3000 |
| `npm run build` | Build for production to `dist/` |
| `npm run preview` | Preview production build |

## Visual Style

A warm, stylized "sun-drenched country club" look. Everything is built from rounded low-poly primitives with procedurally generated textures: striped lawns, speckled terracotta clay, acrylic hard courts, clapboard, shingles, pavers and wood grain. Club colors are forest green and cream. Lighting moves from golden mornings through bright afternoons to golden-hour evenings and deep-blue nights with glowing lamps. Beyond the fence, rolling hills and a treeline fade into the haze. Trees, benches, lamps and flowers are instanced and static scenery is merged, so the whole club draws in a few hundred draw calls and runs well on phones. Real low-poly models can be swapped in later by placing them in `public/assets/`.

## License

MIT
