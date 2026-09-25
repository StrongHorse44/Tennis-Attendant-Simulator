// === Colors (pastel/warm low-poly palette) ===
export const COLORS = {
  // Environment
  sky: 0x87CEEB,
  skyEvening: 0xF4845F,
  skyNight: 0x2C3E50,
  ground: 0x7EC850,
  path: 0xD4C5A9,
  cartPathTint: 0xF8EAD0,     // multiplies the light concrete texture -> warm sandstone cart paths
  water: 0x5B9BD5,

  // Courts
  hardCourt: 0x4A90D9,
  hardCourtLines: 0xFFFFFF,
  clayCourt: 0xCC7744,
  clayCourtLines: 0xFFFFFF,
  courtFence: 0x888888,
  net: 0xEEEEEE,
  bench: 0x8B6914,
  // Court overhaul (Court.js)
  courtHardInner: 0x5085c4,   // US-Open blue; lifted so it lands near #2f6db3 on screen after grading
  courtHardOuter: 0x618c66,   // green surround; lands near #3f7d55 on screen
  courtLine: 0xf0eee6,        // painted / taped lines (kept below pure white so they don't clip)
  courtFenceGreen: 0x2b4a36,  // powder-coated posts, rails, chain-link
  courtWindscreen: 0x1f4a34,
  courtCurb: 0xcfc8b8,
  courtBenchWood: 0x9c6b3c,
  courtLampGlow: 0xfff1d6,
  tennisBall: 0xd4e157,

  // Buildings
  proShopWall: 0xF5E6CA,
  proShopRoof: 0xB85C38,
  clubhouseWall: 0xFAF0E6,
  clubhouseRoof: 0x8B4513,
  counter: 0x6B4226,
  shelf: 0xA0522D,
  // Building overhaul (Building.js)
  bldSiding: 0xf4e7cb,       // cream clapboard tint (pro shop)
  bldStucco: 0xfbf1de,       // cream plaster tint (clubhouse)
  bldTrim: 0xf2eee3,         // white trim, kept below pure white
  bldTrimGreen: 0x2d5a3d,    // club forest green: doors, shutters, fascia
  bldRoofGreen: 0x5a8a68,    // pro shop shingles (multiplied by grey shingle texture)
  bldRoofSlate: 0x7c8894,    // clubhouse slate shingles
  bldRidge: 0x3a4148,
  bldStone: 0xb7ad9c,        // plinth
  bldBrick: 0x9e5238,
  bldBrass: 0xc9a54c,
  bldCopper: 0x6fa48f,       // verdigris cupola roof
  bldWainscot: 0x7d9c83,     // interior lower wall (sage)
  bldInteriorWall: 0xf1e6cc,
  bldFloorWood: 0xb98a55,

  // Garden
  hedge: 0x2E8B57,
  flowers: [0xFF69B4, 0xFFD700, 0xFF6347, 0x9370DB],
  fountain: 0xD3D3D3,
  fountainWater: 0x6FB7E0,

  // Vehicles & Objects
  golfCart: 0xF0F0F0,
  golfCartSeat: 0x333333,
  golfCartRoof: 0xE8E8E8,
  car: [0xC0392B, 0x2980B9, 0x27AE60, 0xF39C12],

  // Player
  playerSkin: 0xFFDBB4,
  playerPolo: 0x1E5631,
  playerShorts: 0xC2B280,
  playerShoes: 0xFFFFFF,
  playerCollar: 0xF4E8C1,      // cream collar / trim on staff polo
  playerCap: 0x2D5A3D,         // staff cap (club forest green)
  clubGold: 0xC9A24A,          // brass/gold crest accents

  // Golf cart (stylized club cart)
  golfCartBody: 0xEDE8DA,      // cream-white body (kept < 0.9 albedo)
  golfCartAccent: 0x2D5A3D,    // forest green stripe
  golfCartCanopy: 0x2D5A3D,    // forest green canopy
  golfCartCanopyTrim: 0xF4E8C1,
  golfCartUpholstery: 0xD8C7A0,
  golfCartFrame: 0x2B2E31,
  golfCartTire: 0x1E1F21,
  golfCartRim: 0xC4C8CC,
  golfCartHeadlight: 0xFFF1C8,
  golfCartTaillight: 0xE0301E,

  // NPCs
  npcEntitled: 0xE74C3C,
  npcFriendly: 0x27AE60,
  npcClueless: 0x3498DB,

  // Court Maintenance
  dragBrushFrame: 0x888888,
  dragBrushBristles: 0x8B7355,
  clayCourtDirty: 0xAA5533,
  clayCourtClean: 0xCC7744,
  groomTrail: 0xDD9966,

  // Courtside objects
  iglooCooler: 0xE87440,
  iglooCoolerLid: 0xF0F0F0,
  trashBin: 0x555555,
  trashBinLid: 0x444444,
  cupHolder: 0x8B7355,
  cup: 0xF5F5DC,

  // Environment art (World.js / Garden.js / Scenery.js)
  clubGreen: 0x2d5a3d,
  clubCream: 0xf1e6c4,
  ironWork: 0x1f2622,
  teak: 0xb07a48,
  stoneCap: 0xe8e0cc,
  pathEdging: 0xb89478,
  shedWood: 0x4c7a55,
  shedRoof: 0x4a5a55,
  carPaint: [0x9e2b25, 0x2b4a7a, 0x2f5d45, 0xd8c8a4, 0xe6e4dc, 0x9ea4a8],
  umbrellaStripe: [0x2d5a3d, 0xf1e6c4],
  soil: 0x4a3426,
  coolerOrange: 0xe8702a,
  coolerWhite: 0xf2efe6,
  binGreen: 0x2f5a3e,

  // UI
  uiPrimary: 0x2d5a3d,
  uiAccent: 0xf4e8c1,
  uiDanger: 0xe74c3c,
  uiText: '#f4e8c1',
  uiBg: 'rgba(45, 90, 61, 0.85)',
};

// === Sizes ===
export const SIZES = {
  // World
  mapWidth: 120,
  mapDepth: 100,

  // Courts
  courtWidth: 16,
  courtDepth: 28,
  courtSpacing: 4,
  clayCourtBuffer: 4,  // extra clay runoff on outer sides of clay courts (1/4 court width)
  netHeight: 1.5,
  fenceHeight: 3,
  courtSurfaceY: 0.15,  // top of every court pad (matches the court physics box) — props on courts sit here

  // Buildings
  proShopWidth: 14,
  proShopDepth: 10,
  proShopHeight: 4,
  clubhouseWidth: 18,
  clubhouseDepth: 8,
  clubhouseHeight: 3.5,

  // Player
  playerHeight: 1.8,
  playerRadius: 0.35,
  playerSpeed: 8,
  playerRunSpeed: 14,

  // Golf Cart
  cartLength: 2.8,
  cartWidth: 1.6,
  cartHeight: 1.2,
  cartMaxSpeed: 7,
  cartAcceleration: 5,
  cartBrakeForce: 12,
  cartSteerSpeed: 1.5,

  // Entity scaling (applied to meshes and physics)
  cartScale: 0.75,
  playerScale: 0.85,

  // NPC
  npcHeight: 1.7,
  npcRadius: 0.35,
  npcSpeed: 1.5,
  npcWanderRadius: 30,

  // Camera
  cameraDistance: 8,
  cameraHeight: 5,
  cameraIndoorDistance: 5.2,   // follow distance while the player is inside a building (cutaway view)
  cameraIndoorHeight: 7.4,     // camera height indoors: steep enough to see over the cut walls
  cameraLerpSpeed: 3,
  cameraLookAhead: 2,
};

// === Game Constants ===
export const GAME = {
  // Time
  dayDurationSeconds: 1800, // 30 minutes real time = 1 full day
  startHour: 9, // 9 AM — open in warm, bright daylight
  morningEnd: 11,
  afternoonEnd: 17,
  eveningEnd: 20,

  // Weather
  weatherChangeProbability: 0.3,
  weatherCheckInterval: 60, // seconds real time
  rainParticleCount: 500,
  windStrength: 5,

  // Missions
  maxActiveMissions: 3,
  taskBoardRefreshInterval: 120, // seconds
  radioDispatchInterval: 90,
  randomEncounterChance: 0.15,

  // Inventory
  maxInventorySlots: 3,

  // Physics
  gravity: -9.82,           // contacts are frictionless (see Game.init): bodies are velocity/position driven

  // NPCs
  maxNPCs: 8,
  npcSpawnInterval: 30,
  interactionRange: 3,
  dialogueAdvanceDelay: 200,

  // Court Maintenance
  groomCellSize: 2,           // grid cell size in world units
  groomSpeedLimit: 5,         // max speed for quality grooming (units/s)
  groomSpeedPenalty: 8,       // above this speed, no grooming happens
  courtDegradeInterval: 120,  // seconds between court degradation ticks
  courtDegradeAmount: 0.01,   // uniform dirt per tick (0-1) while the clock runs; matches add about as much again (Court.wearAt)
  courtOvernightDegrade: 0.12, // uniform dirt added overnight (Next day): wind, dew and debris → a morning groom
  matchWearScale: 6,          // multiplier on match footwork / bounce wear (MatchSystem → Court.wearAt)
  groomBrushWidth: 3,         // brush sweep width in world units (half each side)
  groomScoreThreshold: 0.85,  // cleanliness needed for "excellent" (plus coverage ≥ 70%, tasks ≥ 80%)
  groomMaskRes: 4,            // paint-mask cells per world unit (4 → 0.25 m cells, 64×112 over the playing slab)
  groomBrushDepth: 0.55,      // depth of the brush footprint along the direction of travel (world units)
  groomPassClean: 0.9,        // dirt removed by one full pass of the brush at a good speed
  groomTowLength: 1.75,       // hitch pivot → brush centre (world units); the towed brush swings on this bar
  groomTowMaxAngle: 1.2,      // radians: tow bar can't swing further than this from the cart's axis

  // Proximity feedback during grooming (distances are brush-center-to-fence/net)
  // Brush is 3 units wide, so brush edge is ~1.5 units closer than center
  proximityOptimalMin: 0.5,   // minimum safe distance (brush edge nearly touching)
  proximityOptimalMax: 3.0,   // optimal max distance (brush edge ~1.5m from fence)
  proximityWarnMax: 4.5,      // warning distance - getting too far
  proximityDangerMin: 0.3,    // danger - brush hitting fence/net

  // Courtside tasks
  coolerInteractRange: 2.5,   // how close cart must be to interact with cooler/bin

  // Shift loop (ShiftSystem). 12 in-game hours at 24 / dayDurationSeconds h/s ≈ 15 real minutes.
  // Wages, rush windows, ranks and checklists are data in missions.json → "shift".
  shiftStartHour: 7,          // clock-in (the next day starts here; the night is skipped)
  shiftClosingHour: 18.5,     // closing duties are radioed in
  shiftEndHour: 19,           // clock-out → end-of-shift report card
  rushDispatchScale: 2.25,    // radio dispatch timer runs this much faster inside rush windows
  dispatchCardTimeout: 25,    // seconds before an unanswered dispatch card counts as "Busy"
  dispatchDeclineCooldown: 30,// seconds until the next dispatch after "Busy"
};

// === Directions for waypoints ===
export const AREAS = {
  ENTRANCE: 'entrance',
  PRO_SHOP: 'proShop',
  COURT_1: 'court1',
  COURT_2: 'court2',
  COURT_3: 'court3',
  COURT_4: 'court4',
  COURT_5: 'court5',
  GARDEN: 'garden',
  PATIO: 'patio',
  PARKING: 'parking',
  EQUIPMENT_SHED: 'equipmentShed',
};
