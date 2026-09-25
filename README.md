# Court Call — Tennis Attendant Simulator

A relaxed 3D sandbox game where you play as a tennis attendant at an upscale private club. Clock in, drive a golf cart, groom the clay, sort out reservations, help club members while they play their matches, earn wages and tips, and work your way up from Rookie Attendant to Head of Grounds. No fail states. Just vibes.

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
| C | Toggle the overhead groom camera (while grooming) |
| Mouse drag | Rotate camera (on foot) |
| Click an NPC | Talk (when in range) |
| Esc / P | Pause / resume (Esc also steps back out of Settings) |

### Mobile
- **Virtual joystick** (bottom-left): move or steer
- **Action button** (bottom-right): context-sensitive interaction (enter cart, talk, pick up, etc.)
- **Tap an NPC** to start a conversation when in range; **tap the dialogue box** to advance
- **Drag on the right side of the screen** to rotate the camera (on foot)
- **Tap the task panel header** (top-left) or **swipe in from the left edge** to open the task list
- **Camera button** on the grooming panel: overhead groom camera
- **On it / Busy** buttons on a radio dispatch card: take the job or pass on it
- **Pause button** (round button under the minimap): pause menu

## Gameplay

You're the attendant at **Greenbriar Tennis & Social Club**. Your day involves:

- **Working a shift**: clock in at 7 AM, run the opening checklist, get through the rushes, handle closing duties and clock out at 7 PM
- **Driving the golf cart** around the club grounds
- **Helping club members** with reservations, complaints, and requests
- **Running errands**: delivering towels, retrieving ball hoppers, restocking water bottles
- **Mediating conflicts** between members with different personalities
- **Grooming the clay courts**: attach a drag brush to your cart and sweep all 3 clay courts (Courts 3, 4 & 5)
- **Checking the task board** in the Pro Shop for new assignments
- **Responding to radio dispatch**: take a job with **On it** or pass with **Busy** (no penalty)
- **Watching the members play**: matches run on a court schedule all day

On your first shift, the staff radio walks you through the basics.

### Your Shift

Each day is one shift, about 15 real minutes:

1. **7:00 AM**: the club manager radios in. Press **Clock in** to start the clock.
2. **Opening checklist**: a short round of the pro shop and patio. Checklists don't use a task slot.
3. **The day**: task board jobs, radio dispatches, members flagging you down. The **morning rush** (9:30–11:30) and the **after-work rush** (3:30–5:30) bring more radio calls.
4. **6:30 PM**: closing duties (a last round of the equipment shed and the pro shop).
5. **7:00 PM**: once nothing is in progress you clock out and get a **report card**: tasks done, tips, member happiness, court quality, your pay and your rank progress. **Next day** starts at 7 AM the next morning (the night is skipped).

**Pay and tips**: you earn an hourly wage, a fee for every finished task and a bonus for a good groom. Members may tip when a job is done: friendly regulars tip often and well, entitled members rarely, and a happy member tips more. Your wallet sits at the top of the screen.

**Staff rank**: money and reputation (finished tasks, happy members, clean courts, checklists) move you up the ladder, and each promotion unlocks a perk:

| Rank | Perk |
|------|------|
| Rookie Attendant | Your staff polo and a cart key |
| Court Attendant | Tuned cart motor: +10% top speed |
| Senior Attendant | Wide drag brush: +0.5 m sweep |
| Grounds Lead | The gold Grounds Lead cap |
| Head of Grounds | Members tip 20% more, cart tune up to +20% |

### Finding your way

Every task shows where to go. Places (a court, the pro shop, the shed) get a **floating gold marker** in the world and a pin on the minimap; members you need to talk to get a bouncing gold **!**. Only the member you need *right now* shows the "!".

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

Every member has their own look (hair, hats, outfits, expressions) and moves with a full set of animations: walking, running, talking, waving, shrugging, sitting on benches and playing tennis. Members wander between their favorite spots around the club, sit down for a rest and approach you with requests: look for the bouncing gold **!** above their heads. Reactions appear as floating emoji. Name tags fade in as you get closer.

### Member Matches

Members book the courts through the day and actually play: they walk on, warm up, serve, rally, miss into the net, hit winners, keep score and shake hands at the net before heading off. Rain sends them to the benches until it clears. Talking to a player pauses the rally. On the clay, their footwork scuffs the court where they play, mostly along the baselines, which is what you'll be grooming away. A clay court you start grooming is closed to play until you're done.

### Court Maintenance Minigame

The three adjacent clay courts (Courts 3, 4 & 5) need regular grooming. All three are swept in a single session. Here's how:

1. **Get in the golf cart** and drive to the **Equipment Shed** (near the garden)
2. Press **"Attach Brush"**: a drag brush hooks onto a tow bar behind the cart and swings wide through the turns
3. **Drive to any clay court** (Courts 3, 4 or 5, the terracotta ones in the back)
4. Press **"Start Groom"** to begin the grooming session
5. **Sweep the outside perimeter first**: stay close to the fence, but not so close you hit it
6. **Then sweep along the nets**: pick a side and drive close to the net on that court
7. **Sweep that half of the court**, then move to the other half and the areas between courts
8. Watch the **Grooming HUD** for cleanliness %, coverage, speed, and proximity indicators. Press **C** (or the camera button on the panel) for a high overhead view that shows the lanes you've missed
9. **Handle courtside tasks**: swap igloo coolers, add cups, and empty trash bins between the courts
10. Press **"Stop Groom"** when satisfied, and you'll get a rating card with a map of the three courts (bright is fresh clay, dark is missed or scuffed)

The brush paints the clay as it goes: fresh bristle lines and lane stripes follow exactly where you drove, and the brush kicks up clay dust. Each court shows a floating percentage while you groom, with a sparkle when it's done. The scrape gets louder the faster you go.

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
- Courts get dirty from play (worn baselines where members played), a little through the day, and overnight, so every morning has grooming to do
- You can groom anytime, or accept maintenance missions from the task board
- Don't try grooming in the rain, because wet clay can't be brushed!
- Completing all courtside tasks earns a higher rating

### Missions

Tasks come from three sources:

1. **Task Board**: clipboard on the Pro Shop wall, usually has up to 3 tasks available
2. **Radio Dispatch**: while you're on shift, a card offers a new task roughly every 90 seconds (faster during rushes). **On it** takes it, **Busy** passes (so does ignoring it)
3. **Random Encounters**: NPCs flag you down as you walk or drive past
4. **Shift routines**: the opening checklist and closing duties

Mission types:
- **Reservation Management**: resolve double bookings and scheduling mix-ups
- **Conflict Resolution**: mediate arguments between members
- **Errands**: pick up and deliver items (towels, ball hoppers, water bottles, rackets)
- **Court Maintenance**: groom clay courts with the drag brush attached to your cart

"Go to" steps complete as soon as you arrive at the place named in the task. Gold markers and minimap pins show every place you need to go, and the member you need next wears the "!". You can have up to 3 active missions at a time (checklists don't count). All missions resolve regardless of your choices; NPC satisfaction, and your tips, vary based on your decisions. Many tasks come back on later days.

### Inventory

Carry up to 3 items at once for errands:
- Fresh Towels
- Ball Hopper
- Water Bottles
- Tennis Racket

### Weather & Time

Your shift runs from 7 AM to 7 PM, about 15 real-time minutes; the clock waits for you to clock in and stops at 7 PM (the pause menu shows which day you're on). The lighting changes through the day:

- **Morning**: warm, golden early light
- **Afternoon**: bright midday sun with crisp shadows
- **Evening**: golden-hour sunset glow

Weather changes between sunny, cloudy, rainy and windy. Clouds build up when it's overcast. Rain brings streaks and darker, wet, shiny surfaces that dry slowly afterwards. Wind blows leaves around and makes the trees and grass sway.

### Sound

All audio is procedurally generated using the Web Audio API; no sound files are loaded. You'll hear:
- Footsteps while walking
- Cart engine hum while driving (pitch scales with speed)
- UI click and pickup sounds
- Notification chimes for new tasks
- Ambient bird chirps
- Brush scraping on clay during court grooming (louder and higher the faster you drive)
- The "pock" of tennis balls and bounces from the matches, fading with distance
- Radio chirps, coin sounds for tips and a fanfare when you're promoted
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
- **Reset progress**: after a confirmation, erases your day, wallet, rank, missions, inventory, court conditions and stats and restarts your first shift. Settings are kept.

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
- Saved: time of day and day number, weather, where you and the cart are (and whether you're driving / the brush is attached), your shift (phase, wallet, tips, reputation, rank), active and completed missions, the task board, your inventory, clay court conditions (down to every brush stroke), an in-progress grooming session, tutorial progress and your stats. Rank perks such as the gold cap come back when you load.
- Coming back shows a "Welcome back" message and puts you right where you left off.
- Settings (volume, mute, camera sensitivity) and graphics quality are stored separately, so **Reset progress** keeps them.
- If a save can't be read, it is set aside as a backup and a new game starts, so the game never gets stuck. In private browsing or with storage disabled, the game still plays, but progress can't be saved and you'll be told once.

## Project Structure

```
├── index.html               # Entry point (loading screen + canvas + UI root)
├── vite.config.js           # Vite configuration (port 3000, base /Tennis-Attendant-Simulator/)
├── package.json
├── .github/workflows/
│   └── deploy.yml           # GitHub Pages auto-deploy on push to main (validates data first)
├── scripts/
│   └── validate-data.mjs    # `npm run validate`
├── src/
│   ├── main.js              # Game initialization, loop, camera, interactions, pause, save/load, shift wiring
│   ├── world/               # Environment (World, Court, Building, Garden, Scenery)
│   ├── entities/            # Player, GolfCart, NPC, CharacterModel/Rig/Animations, Seats, TennisBall
│   ├── systems/             # Input, Weather, Dialogue, Missions (+ validation, markers), Shift, Matches,
│   │                        # RoutePlanner, Inventory, Sound, CourtMaintenance (+ GroomFX), Save
│   ├── graphics/            # Quality tiers, EnvState, Materials, Textures, GeometryUtils, Sky, PostFX
│   ├── ui/                  # theme, Joystick, DialogueBox, HUD, PauseMenu, GroomSummary, ShiftReport
│   └── utils/               # Constants, AssetLoader
└── public/
    ├── data/
    │   ├── map.json         # Club layout, courts, paths, waypoints
    │   ├── npcs.json        # NPC definitions, dialogue pools, tipping
    │   ├── missions.json    # Mission templates, dialogue scripts, pay, shift + ranks
    │   └── schedule.json    # Member match bookings (court, time window, players)
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
  "client": "npc_id (optional: who tips when it's done)",
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

`goTo` targets must be a court id (`court1`–`court5`), `proShop`, `patio`, `garden` or `equipmentShed`. Run `npm run validate` afterwards: it reports any step that can't be completed (the game never offers such a mission).

### Add a Match

Add an entry to `public/data/schedule.json` under `matches`:

```json
{ "id": "pm-3", "court": ["court4", "court5"], "start": "17:00", "end": "18:45", "players": ["chad_blake", "any"] }
```

`court` can be one court or a list of alternatives (the first free one is used). Times are in-game hours. `"any"` picks a free member from `pool`. `npm run validate` checks court and member ids, the time window and the player count.

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
| `npm run validate` | Check the JSON data (missions, shift, ranks, match schedule); also runs before every deploy |

## Visual Style

A warm, stylized "sun-drenched country club" look. Everything is built from rounded low-poly primitives with procedurally generated textures: striped lawns, speckled terracotta clay, acrylic hard courts, clapboard, shingles, pavers and wood grain. Club colors are forest green and cream. Characters are stylized skinned figures animated with a library of 22 hand-keyed procedural clips (no model or animation files). Lighting moves from golden mornings through bright afternoons to golden-hour evenings and deep-blue nights with glowing lamps. Beyond the fence, rolling hills and a treeline fade into the haze. Trees, benches, lamps and flowers are instanced and static scenery is merged, so the whole club draws in a few hundred draw calls and runs well on phones. Real low-poly models can be swapped in later by placing them in `public/assets/`.

## License

MIT
