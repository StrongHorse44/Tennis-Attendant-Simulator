import { GAME } from '../utils/Constants.js';

/**
 * InventorySystem - carry up to 3 items
 */
export class InventorySystem {
  constructor() {
    this.items = [];
    this.maxSlots = GAME.maxInventorySlots;
    this.onChangeCallbacks = [];
  }

  onChange(cb) {
    this.onChangeCallbacks.push(cb);
  }

  _notify() {
    for (const cb of this.onChangeCallbacks) cb(this.items);
  }

  canPickup() {
    return this.items.length < this.maxSlots;
  }

  pickup(item) {
    if (!this.canPickup()) return false;
    this.items.push(item);
    this._notify();
    return true;
  }

  hasItem(itemId) {
    return this.items.some(i => i.id === itemId);
  }

  removeItem(itemId) {
    const idx = this.items.findIndex(i => i.id === itemId);
    if (idx >= 0) {
      this.items.splice(idx, 1);
      this._notify();
      return true;
    }
    return false;
  }

  getItems() {
    return [...this.items];
  }

  getItemNames() {
    return this.items.map(i => i.name);
  }
}

// Item definitions
export const ITEMS = {
  towels: { id: 'towels', name: 'Fresh Towels', icon: '\uD83E\uDDF3' },
  ball_hopper: { id: 'ball_hopper', name: 'Ball Hopper', icon: '\uD83E\uDD4E' },
  water_bottles: { id: 'water_bottles', name: 'Water Bottles', icon: '\uD83D\uDCA7' },
  racket: { id: 'racket', name: 'Tennis Racket', icon: '\uD83C\uDFBE' },
};
