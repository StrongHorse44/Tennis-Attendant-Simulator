# Court Call — Tennis Attendant Simulator

A relaxed 3D sandbox game where you play as a tennis attendant at an upscale private club. Drive a golf cart, manage reservations, help club members, and keep the place running — all at your own pace. No fail states, no time pressure. Just vibes.

Built with Three.js + Cannon.js, playable in any modern browser. All sounds are procedurally generated — no audio files needed.

**[Play it now](https://StrongHorse44.github.io/Tennis-Attendant-Simulator/)**

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Controls

### Desktop
| Key | Action |
|-----|--------|
| W / Arrow Up | Move forward |
| S / Arrow Down | Move backward |
| A / Arrow Left | Move left / steer left (in cart) |
| D / Arrow Right | Move right / steer right (in cart) |
| E / Space | Interact (enter/exit cart, talk, pick up, deliver) |
| Q | Rotate camera left |
| R | Rotate camera right |

### Mobile
- **Virtual joystick** (bottom-left) — move/steer
- **Action button** (bottom-right) — context-sensitive interaction (enter cart, talk, pick up, etc.)
- **Tap NPCs** — start conversation when in range
- **Drag right side of screen** — rotate camera
- **Swipe from left edge** — open task list

## Gameplay

You're the attendant at **Greenbriar Tennis & Social Club**. Your day involves:

- **Driving the golf cart** around the club grounds
- **Helping club members** with reservations, complaints, and requests
- **Running errands** — delivering towels, retrieving ball hoppers, restocking water bottles
- **Mediating conflicts** between members with different personalities
- **Grooming the clay courts** — attach a drag brush to your cart and sweep Courts 3 & 4
- **Checking the task board** in the Pro Shop for new assignments
- **Responding to radio dispatch** for urgent requests

### Club Areas

- **Main Entrance & Parking** — where you start, golf cart spawn
- **Pro Shop** — walk inside, check the task board, grab supplies
- **4 Tennis Courts** — 2 hard courts (blue), 2 clay courts (orange) in a 2x2 grid
- **Garden** — hedges, flower beds, and an animated fountain
- **Clubhouse Patio** — where members hang out and flag you down
- **Equipment Shed** — near the garden, pick up the drag brush for court grooming

### NPCs

Club members come in three archetypes:

- **Entitled Members** (red ring) — demanding, never satisfied, rarely tip
- **Friendly Regulars** (green ring) — kind, make small talk, tip generously
- **New Members** (blue ring) — confused, need directions, ask lots of questions

Members wander the club, play tennis, sit at the patio, and approach you with requests (look for the floating **!** icon). Reactions appear as floating emoji above their heads.

### Court Maintenance Minigame

The two clay courts (Courts 3 & 4) need regular grooming to stay in playing condition. Here's how it works:

1. **Get in the golf cart** and drive to the **Equipment Shed** (near the garden)
2. Press **"Attach Brush"** — a 6-foot drag brush hooks onto the cart's rear
3. **Drive to a clay court** (Courts 3 or 4, the orange ones in the back)
4. Press **"Start Groom"** to begin the grooming session
5. **Drive slowly in a spiral pattern** — start from the outside edges and work inward
6. Watch the **Grooming HUD** (top-right) for cleanliness %, coverage, and speed
7. Keep your speed under 5 for effective grooming (the indicator turns red if too fast)
8. Press **"Stop Groom"** when satisfied — you'll get a performance rating

**Tips:**
- Your first time triggers a tutorial from **Hank Morris**, the Head Groundskeeper
- Courts get dirty over time from play — darker overlay patches show where dirt has accumulated
- You can groom anytime for fun, or accept maintenance missions from the task board
- Don't try grooming in the rain — wet clay can't be brushed!
- Hank will assign you court grooming tasks via the task board and radio dispatch

### Missions

Tasks come from three sources:

1. **Task Board** — clipboard on the Pro Shop wall, always has 2-3 tasks available
2. **Radio Dispatch** — new tasks arrive roughly every 90 seconds
3. **Random Encounters** — NPCs flag you down as you walk/drive past

Mission types:
- **Reservation Management** — resolve double bookings and scheduling mix-ups
- **Conflict Resolution** — mediate arguments between members
- **Errands** — pick up and deliver items (towels, ball hoppers, water bottles, rackets)
- **Court Maintenance** — groom clay courts with the drag brush attached to your cart

You can have up to 3 active missions at a time. All missions resolve regardless of your choices — NPC satisfaction varies based on your decisions.

### Inventory

Carry up to 3 items at once for errands:
- Fresh Towels
- Ball Hopper
- Water Bottles
- Tennis Racket

### Weather & Time

A full day passes in 10 real-time minutes with dynamic lighting changes:

- **Morning (7-11)** — warm sunrise light
- **Afternoon (11-17)** — bright midday sun
- **Evening (17-20)** — golden hour sunset
- **Night (20-7)** — dim moonlight

Weather changes randomly between sunny, cloudy, rainy, and windy — each with visual effects (rain particles, wind debris, lens flare).

### Sound

All audio is procedurally generated using the Web Audio API — no sound files are loaded. You'll hear:
- Footsteps while walking
- Cart engine hum while driving (pitch scales with speed)
- UI click and pickup sounds
- Notification chimes for new tasks
- Ambient bird chirps
- Brush scraping on clay during court grooming
- Metallic clank when attaching/detaching the drag brush
- Completion chime when finishing a grooming session

## Project Structure

```
├── index.html               # Entry point (loading screen + canvas + UI root)
├── vite.config.js           # Vite configuration (port 3000)
├── package.json
├── .github/workflows/
│   └── deploy.yml           # GitHub Pages auto-deploy on push to main
├── src/
│   ├── main.js              # Game initialization, loop, camera, interactions
│   ├── world/               # Environment (World, Court, Building, Garden)
│   ├── entities/            # Player, GolfCart, NPC
│   ├── systems/             # Input, Weather, Dialogue, Missions, Inventory, Sound, CourtMaintenance
│   ├── ui/                  # Joystick, DialogueBox, HUD
│   └── utils/               # Constants, AssetLoader
└── public/
    ├── data/
    │   ├── map.json         # Club layout, courts, paths, waypoints
    │   ├── npcs.json        # NPC definitions and dialogue pools
    │   └── missions.json    # Mission templates and dialogue scripts
    └── assets/              # Future: models, textures, audio
```

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

### Modify the Map

Edit `public/data/map.json` to change court positions, add buildings, adjust path routes, or create new waypoints. The world rebuilds from this data on load.

## Tech Stack

- [Three.js](https://threejs.org/) (`^0.170.0`) — 3D rendering
- [Cannon-es](https://pmndrs.github.io/cannon-es/) (`^0.20.0`) — physics engine
- [Vite](https://vitejs.dev/) (`^6.2.0`) — dev server and bundler
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API) — procedural sound generation

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server on port 3000 |
| `npm run build` | Build for production to `dist/` |
| `npm run preview` | Preview production build |

## Visual Style

Low-poly stylized aesthetic using geometric primitives (boxes, cylinders, spheres, cones). Soft pastel and warm colors. All objects are placeholder geometry — real low-poly models can be swapped in later by placing them in `public/assets/` and updating the entity classes.

## License

MIT
