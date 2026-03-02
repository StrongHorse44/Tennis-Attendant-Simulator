/**
 * HUD - mini-map, task list, time/weather, inventory, action button, radio indicator
 */
export class HUD {
  constructor(weatherSystem, missionSystem, inventorySystem) {
    this.weather = weatherSystem;
    this.missions = missionSystem;
    this.inventory = inventorySystem;

    this.container = null;
    this.timeWeatherEl = null;
    this.miniMapCanvas = null;
    this.miniMapCtx = null;
    this.actionButton = null;
    this.actionCallback = null;
    this.taskListEl = null;
    this.taskListOpen = false;
    this.inventoryEl = null;
    this.radioIndicator = null;
    this.radioCallback = null;
    this.notificationEl = null;
    this.notificationTimer = 0;

    this._create();
    this._setupTaskListSwipe();
  }

  _create() {
    const ui = document.getElementById('ui-root');

    // Time & Weather (top-left)
    this.timeWeatherEl = document.createElement('div');
    Object.assign(this.timeWeatherEl.style, {
      position: 'fixed',
      top: '12px',
      left: '12px',
      background: 'rgba(20,20,20,0.7)',
      borderRadius: '10px',
      padding: '8px 14px',
      color: '#fff',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      fontSize: '14px',
      zIndex: '90',
      backdropFilter: 'blur(4px)',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
    });
    ui.appendChild(this.timeWeatherEl);

    // Mini-map (top-right)
    const miniMapContainer = document.createElement('div');
    Object.assign(miniMapContainer.style, {
      position: 'fixed',
      top: '12px',
      right: '12px',
      width: '120px',
      height: '120px',
      borderRadius: '12px',
      overflow: 'hidden',
      border: '2px solid rgba(255,255,255,0.3)',
      zIndex: '90',
      background: 'rgba(20,20,20,0.6)',
      backdropFilter: 'blur(4px)',
    });
    this.miniMapCanvas = document.createElement('canvas');
    this.miniMapCanvas.width = 120;
    this.miniMapCanvas.height = 120;
    miniMapContainer.appendChild(this.miniMapCanvas);
    ui.appendChild(miniMapContainer);
    this.miniMapCtx = this.miniMapCanvas.getContext('2d');

    // Action button (bottom-right)
    this.actionButton = document.createElement('button');
    Object.assign(this.actionButton.style, {
      position: 'fixed',
      bottom: '40px',
      right: '30px',
      width: '70px',
      height: '70px',
      borderRadius: '50%',
      background: 'rgba(45, 90, 61, 0.85)',
      border: '3px solid rgba(244, 232, 193, 0.6)',
      color: '#f4e8c1',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      fontSize: '11px',
      fontWeight: 'bold',
      textAlign: 'center',
      cursor: 'pointer',
      zIndex: '100',
      touchAction: 'manipulation',
      display: 'none',
      lineHeight: '1.2',
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
    });
    this.actionButton.addEventListener('click', () => {
      if (this.actionCallback) this.actionCallback();
    });
    this.actionButton.addEventListener('touchend', (e) => {
      e.preventDefault();
      if (this.actionCallback) this.actionCallback();
    });
    ui.appendChild(this.actionButton);

    // Task list panel (left side, swipe to open)
    this.taskListEl = document.createElement('div');
    Object.assign(this.taskListEl.style, {
      position: 'fixed',
      top: '0',
      left: '-260px',
      width: '250px',
      height: '100%',
      background: 'rgba(20,20,20,0.9)',
      zIndex: '150',
      padding: '60px 16px 16px',
      transition: 'left 0.3s ease',
      overflowY: 'auto',
      backdropFilter: 'blur(8px)',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      color: '#fff',
    });

    const taskHeader = document.createElement('div');
    Object.assign(taskHeader.style, {
      fontSize: '16px',
      fontWeight: 'bold',
      color: '#f4e8c1',
      marginBottom: '12px',
      textTransform: 'uppercase',
      letterSpacing: '1px',
    });
    taskHeader.textContent = 'Active Tasks';
    this.taskListEl.appendChild(taskHeader);

    this.taskListContent = document.createElement('div');
    this.taskListEl.appendChild(this.taskListContent);
    ui.appendChild(this.taskListEl);

    // Task list toggle tab
    this.taskListTab = document.createElement('div');
    Object.assign(this.taskListTab.style, {
      position: 'fixed',
      top: '50%',
      left: '0',
      width: '24px',
      height: '60px',
      background: 'rgba(45, 90, 61, 0.8)',
      borderRadius: '0 8px 8px 0',
      zIndex: '151',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#f4e8c1',
      fontSize: '14px',
      transform: 'translateY(-50%)',
      transition: 'left 0.3s ease',
    });
    this.taskListTab.textContent = '\u25B6';
    this.taskListTab.addEventListener('click', () => this._toggleTaskList());
    ui.appendChild(this.taskListTab);

    // Inventory (bottom-center, above joystick)
    this.inventoryEl = document.createElement('div');
    Object.assign(this.inventoryEl.style, {
      position: 'fixed',
      bottom: '160px',
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      gap: '8px',
      zIndex: '90',
    });
    ui.appendChild(this.inventoryEl);

    // Radio indicator (top-center)
    this.radioIndicator = document.createElement('div');
    Object.assign(this.radioIndicator.style, {
      position: 'fixed',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(231, 76, 60, 0.9)',
      borderRadius: '20px',
      padding: '8px 16px',
      color: '#fff',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      fontSize: '13px',
      fontWeight: 'bold',
      zIndex: '95',
      cursor: 'pointer',
      display: 'none',
      animation: 'pulse 1.5s infinite',
    });
    this.radioIndicator.textContent = '\uD83D\uDCFB New Dispatch';
    this.radioIndicator.addEventListener('click', () => {
      this.radioIndicator.style.display = 'none';
      if (this.radioCallback) this.radioCallback();
    });
    ui.appendChild(this.radioIndicator);

    // Notification toast
    this.notificationEl = document.createElement('div');
    Object.assign(this.notificationEl.style, {
      position: 'fixed',
      top: '50px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(45, 90, 61, 0.9)',
      borderRadius: '10px',
      padding: '10px 20px',
      color: '#f4e8c1',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      fontSize: '14px',
      zIndex: '200',
      display: 'none',
      textAlign: 'center',
      maxWidth: '80vw',
      backdropFilter: 'blur(4px)',
    });
    ui.appendChild(this.notificationEl);

    // CSS animation
    const style = document.createElement('style');
    style.textContent = `
      @keyframes pulse {
        0%, 100% { transform: translateX(-50%) scale(1); }
        50% { transform: translateX(-50%) scale(1.05); }
      }
    `;
    document.head.appendChild(style);

    // Wire up inventory changes
    this.inventory.onChange(() => this.updateInventory());
  }

  _setupTaskListSwipe() {
    let startX = 0;
    let isDragging = false;

    document.addEventListener('touchstart', (e) => {
      if (e.touches[0].clientX < 30) {
        startX = e.touches[0].clientX;
        isDragging = true;
      }
    });

    document.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      const dx = e.touches[0].clientX - startX;
      if (dx > 50 && !this.taskListOpen) {
        this._toggleTaskList();
        isDragging = false;
      }
    });

    document.addEventListener('touchend', () => {
      isDragging = false;
    });
  }

  _toggleTaskList() {
    this.taskListOpen = !this.taskListOpen;
    this.taskListEl.style.left = this.taskListOpen ? '0' : '-260px';
    this.taskListTab.style.left = this.taskListOpen ? '250px' : '0';
    this.taskListTab.textContent = this.taskListOpen ? '\u25C0' : '\u25B6';
  }

  setActionButton(label, callback) {
    if (!label) {
      this.actionButton.style.display = 'none';
      this.actionCallback = null;
      return;
    }
    this.actionButton.textContent = label;
    this.actionButton.style.display = 'flex';
    this.actionButton.style.alignItems = 'center';
    this.actionButton.style.justifyContent = 'center';
    this.actionCallback = callback;
  }

  showNotification(text, duration = 3) {
    this.notificationEl.textContent = text;
    this.notificationEl.style.display = 'block';
    this.notificationTimer = duration;
  }

  showRadioDispatch(mission, callback) {
    this.radioIndicator.style.display = 'block';
    this.radioCallback = () => {
      this.showNotification(`New task: ${mission.title}`);
      if (callback) callback(mission);
    };
  }

  updateTimeWeather() {
    const time = this.weather.getTimeString();
    const icon = this.weather.getWeatherIcon();
    const period = this.weather.getPeriod();
    this.timeWeatherEl.innerHTML = `
      <span style="font-size: 18px">${icon}</span>
      <span>${time}</span>
      <span style="font-size: 11px; opacity: 0.6; text-transform: capitalize">${period}</span>
    `;
  }

  updateMiniMap(playerPos, npcs, cartPos, mapData) {
    const ctx = this.miniMapCtx;
    const w = 120;
    const h = 120;
    const scale = w / 130;
    const offsetX = 65;
    const offsetZ = 55;

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = 'rgba(60, 100, 60, 0.8)';
    ctx.fillRect(0, 0, w, h);

    // Draw paths
    ctx.strokeStyle = 'rgba(200, 190, 160, 0.6)';
    ctx.lineWidth = 1.5;
    if (mapData && mapData.paths) {
      for (const path of mapData.paths) {
        ctx.beginPath();
        for (let i = 0; i < path.points.length; i++) {
          const mx = (path.points[i].x + offsetX) * scale;
          const my = (path.points[i].z + offsetZ) * scale;
          if (i === 0) ctx.moveTo(mx, my);
          else ctx.lineTo(mx, my);
        }
        ctx.stroke();
      }
    }

    // Draw courts
    ctx.fillStyle = 'rgba(74, 144, 217, 0.5)';
    if (mapData && mapData.areas && mapData.areas.courts) {
      for (const court of mapData.areas.courts) {
        const mx = (court.center.x + offsetX) * scale - 6;
        const my = (court.center.z + offsetZ) * scale - 10;
        ctx.fillRect(mx, my, 12, 20);
      }
    }

    // Draw buildings
    ctx.fillStyle = 'rgba(245, 230, 202, 0.6)';
    if (mapData && mapData.areas && mapData.areas.proShop) {
      const ps = mapData.areas.proShop;
      const mx = (ps.center.x + offsetX) * scale - 5;
      const my = (ps.center.z + offsetZ) * scale - 4;
      ctx.fillRect(mx, my, 10, 8);
    }

    // Draw cart
    if (cartPos) {
      ctx.fillStyle = '#FFD700';
      const cx = (cartPos.x + offsetX) * scale;
      const cy = (cartPos.z + offsetZ) * scale;
      ctx.fillRect(cx - 2, cy - 2, 4, 4);
    }

    // Draw NPCs
    if (npcs) {
      for (const npc of npcs) {
        const pos = npc.mesh.position;
        const nx = (pos.x + offsetX) * scale;
        const ny = (pos.z + offsetZ) * scale;

        ctx.fillStyle = npc.archetype === 'entitled' ? '#E74C3C' :
                       npc.archetype === 'friendly' ? '#27AE60' : '#3498DB';
        ctx.beginPath();
        ctx.arc(nx, ny, 2, 0, Math.PI * 2);
        ctx.fill();

        if (npc.hasRequest) {
          ctx.fillStyle = '#F1C40F';
          ctx.beginPath();
          ctx.arc(nx, ny - 4, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Draw player
    if (playerPos) {
      const px = (playerPos.x + offsetX) * scale;
      const py = (playerPos.z + offsetZ) * scale;

      ctx.fillStyle = '#FFFFFF';
      ctx.strokeStyle = '#1E5631';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Active mission markers
    const missions = this.missions.getActiveMissions();
    for (const mission of missions) {
      const step = this.missions.getCurrentStep(mission.id);
      if (step && step.target && mapData && mapData.waypoints) {
        const wp = mapData.waypoints[step.target + '_center'] || mapData.waypoints[step.target];
        if (wp) {
          const mx = (wp.x + offsetX) * scale;
          const my = (wp.z + offsetZ) * scale;
          ctx.fillStyle = '#F1C40F';
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(mx, my - 5);
          ctx.lineTo(mx + 4, my + 3);
          ctx.lineTo(mx - 4, my + 3);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }
    }
  }

  updateTaskList() {
    const missions = this.missions.getActiveMissions();
    this.taskListContent.innerHTML = '';

    if (missions.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color: rgba(255,255,255,0.4); font-size: 13px; padding: 10px 0;';
      empty.textContent = 'No active tasks. Check the task board in the Pro Shop!';
      this.taskListContent.appendChild(empty);
      return;
    }

    for (const mission of missions) {
      const el = document.createElement('div');
      Object.assign(el.style, {
        background: 'rgba(255,255,255,0.08)',
        borderRadius: '8px',
        padding: '10px 12px',
        marginBottom: '8px',
        borderLeft: '3px solid ' + (
          mission.type === 'reservation' ? '#F1C40F' :
          mission.type === 'conflict' ? '#E74C3C' : '#3498DB'
        ),
      });

      const title = document.createElement('div');
      title.style.cssText = 'font-weight: bold; font-size: 13px; margin-bottom: 4px;';
      title.textContent = mission.title;
      el.appendChild(title);

      const step = this.missions.getCurrentStep(mission.id);
      if (step) {
        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 12px; color: rgba(255,255,255,0.6);';
        desc.textContent = step.prompt;
        el.appendChild(desc);
      }

      this.taskListContent.appendChild(el);
    }
  }

  updateInventory() {
    this.inventoryEl.innerHTML = '';
    const items = this.inventory.getItems();

    for (const item of items) {
      const slot = document.createElement('div');
      Object.assign(slot.style, {
        width: '48px',
        height: '48px',
        borderRadius: '10px',
        background: 'rgba(20,20,20,0.7)',
        border: '2px solid rgba(255,255,255,0.2)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '24px',
        backdropFilter: 'blur(4px)',
      });
      slot.textContent = item.icon || '\uD83D\uDCE6';
      slot.title = item.name;
      this.inventoryEl.appendChild(slot);
    }

    // Empty slots
    for (let i = items.length; i < this.inventory.maxSlots; i++) {
      const slot = document.createElement('div');
      Object.assign(slot.style, {
        width: '48px',
        height: '48px',
        borderRadius: '10px',
        background: 'rgba(20,20,20,0.3)',
        border: '2px dashed rgba(255,255,255,0.1)',
      });
      this.inventoryEl.appendChild(slot);
    }
  }

  update(dt) {
    // Notification timer
    if (this.notificationTimer > 0) {
      this.notificationTimer -= dt;
      if (this.notificationTimer <= 0) {
        this.notificationEl.style.display = 'none';
      }
    }
  }
}
