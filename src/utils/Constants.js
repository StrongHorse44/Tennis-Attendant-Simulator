// === Colors (pastel/warm low-poly palette) ===
export const COLORS = {
  // Environment
  sky: 0x87CEEB,
  skyEvening: 0xF4845F,
  skyNight: 0x2C3E50,
  ground: 0x7EC850,
  path: 0xD4C5A9,
  water: 0x5B9BD5,

  // Courts
  hardCourt: 0x4A90D9,
  hardCourtLines: 0xFFFFFF,
  clayCourt: 0xCC7744,
  clayCourtLines: 0xFFFFFF,
  courtFence: 0x888888,
  net: 0xEEEEEE,
  bench: 0x8B6914,

  // Buildings
  proShopWall: 0xF5E6CA,
  proShopRoof: 0xB85C38,
  clubhouseWall: 0xFAF0E6,
  clubhouseRoof: 0x8B4513,
  counter: 0x6B4226,
  shelf: 0xA0522D,

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
  netHeight: 1.5,
  fenceHeight: 3,

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
  cartMaxSpeed: 10,
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
  cameraLerpSpeed: 3,
  cameraLookAhead: 2,
};

// === Game Constants ===
export const GAME = {
  // Time
  dayDurationSeconds: 1800, // 30 minutes real time = 1 full day
  startHour: 7, // 7 AM
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
  gravity: -9.82,
  groundFriction: 0.8,
  cartFriction: 0.4,

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
  courtDegradeAmount: 0.05,   // how much dirtiness accumulates per tick (0-1)
  groomBrushWidth: 3,         // brush sweep width in world units (half each side)
  groomScoreThreshold: 0.85,  // coverage needed for "good" rating

  // Proximity feedback during grooming
  proximityOptimalMin: 0.15,  // minimum safe distance to fence/net (~6 inches)
  proximityOptimalMax: 1.0,   // optimal max distance to fence/net
  proximityWarnMax: 2.0,      // warning distance - getting too far
  proximityDangerMin: 0.1,    // danger - too close to fence/net

  // Courtside tasks
  coolerInteractRange: 2.5,   // how close cart must be to interact with cooler/bin
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
