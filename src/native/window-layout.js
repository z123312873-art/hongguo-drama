// Keep the complete window inside the current display, including after unplugging a monitor.
function fitWindowBounds(mode, current, workArea, previous) {
  if (!['portrait', 'landscape'].includes(mode)) throw new Error('Invalid window layout');
  const height = Math.min(mode === 'portrait' ? 940 : (previous?.height || 750), workArea.height);
  const width = Math.min(mode === 'portrait' ? Math.min(620, Math.round(height * 0.74)) : (previous?.width || 1100), workArea.width);
  const origin = mode === 'landscape' && previous ? previous : {
    x: Math.round(current.x + (current.width - width) / 2),
    y: Math.round(current.y + (current.height - height) / 2),
  };
  return {
    x: Math.max(workArea.x, Math.min(origin.x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(origin.y, workArea.y + workArea.height - height)),
    width, height,
  };
}
// Window resizing changes available space, never the user's chosen text size.
function getWindowScale(value = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(2, Math.max(0.5, value)) : 1;
}
// One size rule for Windows 10, Windows 11, and every DPI. Electron's work area
// is already in device-independent pixels, so 100/125/150/175 percent and
// 1366×768 through 4K do not need separate cases.
function initialWindowSize(workArea) {
  const widthLimit = Math.max(1, Math.floor(Number(workArea?.width) || 1100));
  const heightLimit = Math.max(1, Math.floor(Number(workArea?.height) || 750));
  const width = Math.min(1100, widthLimit);
  const height = Math.min(750, heightLimit);
  return {
    width,
    height,
    minWidth: Math.min(900, width),
    minHeight: Math.min(620, height),
  };
}

// Show before maximize. On Windows 10 and 11, maximizing a hidden window leaves
// the renderer unpainted at the current DPI, which looks like a blank white page.
function revealMaximized(win) {
  if (!win || win.isDestroyed?.()) return [];
  const order = [];
  const visible = typeof win.isVisible === 'function' ? win.isVisible() === true : false;
  if (!visible && typeof win.show === 'function') {
    win.show();
    order.push('show');
  }
  if (typeof win.maximize === 'function' && win.isMaximized?.() !== true) {
    win.maximize();
    order.push('maximize');
  }
  return order;
}

function saveWindowZoom(store, direction) {
  if (!['in', 'out', 'reset'].includes(direction)) throw new Error('Invalid zoom direction');
  const settings = store.getSettings() || {};
  const current = getWindowScale(settings.ui_zoom);
  const next = direction === 'reset' ? 1 : Math.round((current + (direction === 'in' ? 0.1 : -0.1)) * 10) / 10;
  store.saveSettings({ ...settings, ui_zoom: getWindowScale(next) });
}
module.exports = { fitWindowBounds, getWindowScale, saveWindowZoom, initialWindowSize, revealMaximized };
