# Court Call — Tennis Attendant Simulator

A relaxed 3D sandbox game where you play as a tennis attendant at an upscale private club. Drive a golf cart, manage reservations, help club members, and keep the place running — all at your own pace. No fail states, no time pressure. Just vibes.

Built with Three.js + Cannon.js, playable in any modern browser.

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
| A / Arrow Left | Move left |
| D / Arrow Right | Move right |
| E / Space | Interact (enter cart, talk, pick up) |

### Mobile
- **Virtual joystick** (bottom-left) — move/steer
- **Action button** (bottom-right) — context-sensitive interaction
- **Tap NPCs** — start conversation
- **Swipe from left edge** — open task list

## Gameplay

You're the attendant at **Greenbriar Tennis & Social Club**. Your day involves:

- **Driving the golf cart** around the club grounds
- **Helping club members** with reservations, complaints, and requests
- **Running errands** — delivering towels, retrieving equipment, restocking supplies
- **Mediating conflicts** between members with different personalities
- **Checking the task board** in the Pro Shop for new assignments
- **Responding to radio dispatch** for urgent requests

### Club Areas

- **Main Entrance & Parking** — where you start, golf cart spawn
- **Pro Shop** — walk inside, check the task board, grab supplies
- **4 Tennis Courts** — 2 hard courts, 2 clay courts in a 2x2 grid
- **Garden** — hedges, flower beds, and a fountain
- **Clubhouse Patio** — where members hang out and flag you down

### NPCs

Club members come in three types:

- **Entitled Members** (red) — demanding, never satisfied, rarely tip
- **Friendly Regulars** (green) — kind, make small talk, tip generously
- **New Members** (blue) — confused, need directions, ask lots of questions

Members wander the club, play tennis, sit at the patio, and approach you with requests (look for the floating **!** icon).

### Missions

Tasks come from three sources:

1. **Task Board** — clipboard on the Pro Shop wall, always has 2-3 tasks
2. **Radio Dispatch** — pulses at the top of the screen when a new task arrives
3. **Random Encounters** — NPCs flag you down as you walk/drive past

Mission types:
- **Reservation Management** — resolve double bookings and scheduling mix-ups
- **Conflict Resolution** — mediate arguments between members
- **Errands** — pick up and deliver items (towels, ball hoppers, water bottles, rackets)

### Weather & Time

A full day passes in 10 real-time minutes with dynamic lighting changes:

- **Morning** — warm sunrise light, possible sun glare
- **Afternoon** — bright midday sun
- **Evening** — golden hour sunset
- **Night** — dim moonlight

Weather changes randomly between sunny, cloudy, rainy, and windy — each with visual effects (rain particles, wind debris, lens flare).

## Project Structure

```
├── index.html               # Entry point
├── vite.config.js            # Vite configuration
├── package.json
├── .github/workflows/
│   └── deploy.yml            # GitHub Pages auto-deploy on push to main
├── src/
│   ├── main.js               # Game initialization and loop
│   ├── world/                # Environment (World, Court, Building, Garden)
│   ├── entities/             # Player, GolfCart, NPC
│   ├── systems/              # Input, Weather, Dialogue, Missions, Inventory
│   ├── ui/                   # Joystick, DialogueBox, HUD
│   └── utils/                # Constants, AssetLoader
└── public/
    ├── data/
    │   ├── map.json          # Club layout, courts, paths, waypoints
    │   ├── npcs.json         # NPC definitions and dialogue pools
    │   └── missions.json     # Mission templates and dialogue scripts
    └── assets/               # Future: models, textures, audio
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
  "type": "reservation|conflict|errand",
  "title": "Mission Title",
  "description": "Short description",
  "source": "taskBoard|radio|random",
  "steps": [
    { "action": "goTo", "target": "court1", "prompt": "Head to Court 1." },
    { "action": "dialogue", "npcId": "npc_id", "dialogueKey": "key" },
    { "action": "pickup", "location": "proShop", "item": "towels" },
    { "action": "deliver", "location": "court4", "item": "towels" },
    { "action": "choose", "prompt": "What do you do?", "choices": [...] }
  ]
}
```

### Modify the Map

Edit `public/data/map.json` to change court positions, add buildings, adjust path routes, or create new waypoints. The world rebuilds from this data on load.

## Tech Stack

- [Three.js](https://threejs.org/) — 3D rendering
- [Cannon-es](https://pmndrs.github.io/cannon-es/) — physics engine
- [Vite](https://vitejs.dev/) — dev server and bundler

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |

## Visual Style

Low-poly stylized aesthetic using geometric primitives (boxes, cylinders, spheres). Soft pastel and warm colors. All objects are placeholder geometry — real low-poly models can be swapped in later by placing them in `public/assets/` and updating the entity classes.

## License

MIT
