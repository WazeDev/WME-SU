// ==UserScript==
// @name        WME Straighten Up!
// @namespace   https://greasyfork.org/users/166843
// @version     2026.03.31.00
// @description Straighten selected WME segment(s) by aligning along straight line between two end points and removing geometry nodes.
// @author      JS55CT
// @match       http*://*.waze.com/*editor*
// @exclude     http*://*.waze.com/user/editor*
// @require     https://greasyfork.org/scripts/509664/code/WME%20Utils%20-%20Bootstrap.js
// @require     https://greasyfork.org/scripts/24851-wazewrap/code/WazeWrap.js
// @require     https://cdn.jsdelivr.net/npm/@turf/turf@7/turf.min.js
// @grant       GM_xmlhttpRequest
// @connect     greasyfork.org
// @license     GPLv3
// ==/UserScript==

// Original credit to jonny3D and impulse200, dBsooner

/* global I18n, GM_info, GM_xmlhttpRequest, WazeWrap, bootstrap, $, jQuery, turf */

(async function () {
  'use strict';

  // ── Script metadata ──────────────────────────────────────────────────
  const SHOW_UPDATE_MESSAGE = true;
  const SCRIPT_VERSION_CHANGES = ['BUGFIX: Check for micro dog leg (mDL)'];
  const SCRIPT_VERSION = GM_info.script.version.toString();
  const DOWNLOAD_URL = 'https://greasyfork.org/scripts/388349-wme-straighten-up/code/WME%20Straighten%20Up!.user.js';
  const SCRIPT_PAGE_URL = 'https://greasyfork.org/scripts/388349-wme-straighten-up/';
  const SETTINGS_STORE_NAME = 'WMESU';
  const LOAD_BEGIN_TIME = performance.now();

  // ── Debug & execution state ──────────────────────────────────────────
  let debug = true; // Set to false before release
  let wmeSdk; // WME SDK instance - assigned by bootstrap()

  // ── UI element cache ─────────────────────────────────────────────────
  const elemCache = {
    b: document.createElement('b'),
    br: document.createElement('br'),
    div: document.createElement('div'),
    li: document.createElement('li'),
    ol: document.createElement('ol'),
    option: document.createElement('option'),
    p: document.createElement('p'),
    select: document.createElement('select'),
    'wz-button': document.createElement('wz-button'),
    'wz-card': document.createElement('wz-card'),
    'wz-chip': document.createElement('wz-chip'),
    'wz-chip-select': document.createElement('wz-chip-select'),
    'wz-checkable-chip': document.createElement('wz-checkable-chip'),
  };

  // ── Settings & timeouts ──────────────────────────────────────────────
  let settings = {};
  const timeouts = { saveSettingsToStorage: undefined };

  /**
   * Batch-fetches node objects from SDK by ID array
   * @param {number[]} nodeIds - Array of node IDs
   * @returns {Object[]} Array of node objects from SDK
   */
  function getNodesByIds(nodeIds) {
    return nodeIds.map((nodeId) => wmeSdk.DataModel.Nodes.getById({ nodeId }));
  }

  /**
   * Batch-fetches segment objects from SDK by ID array
   * @param {number[]} segmentIds - Array of segment IDs
   * @returns {Object[]} Array of segment objects from SDK
   */
  function getSegmentsByIds(segmentIds) {
    logDebug(`getSegmentsByIds called with IDs: ${segmentIds}`);
    const segments = segmentIds.map((segmentId) => {
      const seg = wmeSdk.DataModel.Segments.getById({ segmentId });
      logDebug(`SDK returned for segment ${segmentId}:`, seg);
      return seg;
    });
    return segments;
  }

  /**
   * Detects if selected segments form a continuous connected path
   * Returns true if segments have multiple disconnected components
   * @param {Object[]} segments - Array of segment objects
   * @returns {boolean} True if multiple connected components detected (non-continuous)
   */
  function hasMultipleConnectedComponents(segments) {
    if (!segments || segments.length <= 1) {
      return false;
    }

    try {
      // Build a map of node IDs to segments that use that node
      const nodeToSegments = {};

      segments.forEach(seg => {
        if (!seg?.fromNodeId || !seg?.toNodeId) {
          logWarning(`Segment ${seg?.id} missing node IDs, skipping connectivity check`);
          return;
        }

        if (!nodeToSegments[seg.fromNodeId]) nodeToSegments[seg.fromNodeId] = [];
        if (!nodeToSegments[seg.toNodeId]) nodeToSegments[seg.toNodeId] = [];

        nodeToSegments[seg.fromNodeId].push(seg.id);
        nodeToSegments[seg.toNodeId].push(seg.id);
      });

      // Track which segments belong to which connected component using union-find
      const componentMap = new Map(); // segmentId -> componentId
      let componentCount = 0;

      // Assign segments to connected components
      const visited = new Set();

      for (const segment of segments) {
        if (visited.has(segment.id)) continue;

        // BFS to find all segments in this connected component
        const queue = [segment.id];
        const component = componentCount++;

        while (queue.length > 0) {
          const segId = queue.shift();
          if (visited.has(segId)) continue;

          visited.add(segId);
          componentMap.set(segId, component);

          // Find the actual segment object
          const seg = segments.find(s => s.id === segId);
          if (!seg) continue;

          // Find other segments connected through this segment's nodes
          const connectedNodeIds = [seg.fromNodeId, seg.toNodeId];
          connectedNodeIds.forEach(nodeId => {
            if (nodeToSegments[nodeId]) {
              nodeToSegments[nodeId].forEach(connectedSegId => {
                if (!visited.has(connectedSegId)) {
                  queue.push(connectedSegId);
                }
              });
            }
          });
        }
      }

      const isNonContinuous = componentCount > 1;
      logDebug(`Segment connectivity check: ${componentCount} connected component(s) - ${isNonContinuous ? 'NON-CONTINUOUS' : 'continuous'}`);

      return isNonContinuous;
    } catch (err) {
      logError('Error checking segment connectivity:', err);
      return false; // Assume continuous on error to allow proceeding
    }
  }

  // ===== SHORTCUT VALIDATION & MIGRATION =====
  /**
   * Validates and migrates shortcut from any format to { raw, combo }
   * Handles old string format, new object format, and invalid data
   * @param {*} shortcutValue - Shortcut value from any source (string, object, etc)
   * @param {string} source - Source label for logging ("localStorage", "server", etc)
   * @returns {{ raw: string|null, combo: string|null }} - Validated/migrated shortcut
   */
  function validateAndMigrateShortcut(shortcutValue, source = 'settings') {
    if (!shortcutValue) {
      return { raw: null, combo: null };
    }

    if (typeof shortcutValue === 'string') {
      // Old format: string value from previous version
      logDebug(`Detected old shortcut format (${source}): "${shortcutValue}"`);
      const raw = comboToRawKeycodes(shortcutValue);
      const combo = shortcutKeycodesToCombo(raw);
      if (raw && combo) {
        logDebug(`Migrated shortcut from old format: RAW="${raw}", COMBO="${combo}"`);
        return { raw, combo };
      } else {
        logWarning(`Failed to migrate old shortcut format (${source}), resetting to null`);
        return { raw: null, combo: null };
      }
    }

    if (typeof shortcutValue === 'object' && shortcutValue !== null) {
      // New format: should be { raw, combo }
      if (typeof shortcutValue.raw === 'string' && typeof shortcutValue.combo === 'string') {
        // Valid new format
        logDebug(`Loaded shortcut (${source}, valid): RAW="${shortcutValue.raw}", COMBO="${shortcutValue.combo}"`);
        return { raw: shortcutValue.raw, combo: shortcutValue.combo };
      }
      if (shortcutValue.raw === null && shortcutValue.combo === null) {
        // Valid: no shortcut set
        logDebug(`Loaded shortcut (${source}): (none)`);
        return { raw: null, combo: null };
      }
      // Invalid structure
      logWarning(`Invalid shortcut format (${source}), resetting to null`);
      return { raw: null, combo: null };
    }

    // Invalid type
    logWarning(`Invalid shortcut type (${source}): ${typeof shortcutValue}, resetting to null`);
    return { raw: null, combo: null };
  }

  // ===== SHORTCUT HANDLING WITH SDK FIX =====
  // The SDK returns different formats at different times, so we normalize to both RAW and COMBO formats
  // RAW: "modifier,keycode" (e.g., "0,48", "4,88", "3,75") - for consistent storage
  // COMBO: "key" or "MOD+key" (e.g., "0", "A+X", "CS+K") - for display and SDK registration

  const MOD_LOOKUP = { C: 1, S: 2, A: 4 };
  const MOD_FLAGS = [
    { flag: 1, char: 'C' },
    { flag: 2, char: 'S' },
    { flag: 4, char: 'A' },
  ];
  const KEYCODE_MAP = Object.fromEntries([...Array.from({ length: 26 }, (_, i) => [65 + i, String.fromCharCode(65 + i)]), ...Array.from({ length: 10 }, (_, i) => [48 + i, String(i)])]);

  /**
   * Converts SDK combo/raw format to normalized RAW format "modifier,keycode"
   * Handles inconsistent SDK return values (sometimes combo, sometimes raw)
   */
  function comboToRawKeycodes(comboStr) {
    if (!comboStr || typeof comboStr !== 'string') return comboStr;

    // Already in raw form (modifier,keycode)
    if (/^\d+,\d+$/.test(comboStr)) return comboStr;

    // Single digit/letter (no modifiers) - SDK returns "0" but we need "0,48"
    if (/^[A-Z0-9]$/.test(comboStr)) {
      return `0,${comboStr.charCodeAt(0)}`;
    }

    // Combo format like "A+X", "CS+K", etc.
    const match = comboStr.match(/^([ACS]+)\+([A-Z0-9])$/);
    if (!match) return comboStr;

    const [, modStr, keyStr] = match;
    const modValue = modStr.split('').reduce((acc, m) => acc | (MOD_LOOKUP[m] || 0), 0);
    return `${modValue},${keyStr.charCodeAt(0)}`;
  }

  /**
   * Converts RAW format "modifier,keycode" to human-readable COMBO format
   * Used for display and SDK registration
   */
  function shortcutKeycodesToCombo(keycodeStr) {
    if (!keycodeStr || keycodeStr === 'None') return null;

    // Already in combo form
    if (/^([ACS]+\+)?[A-Z0-9]$/.test(keycodeStr)) return keycodeStr;

    // Handle raw format "modifier,keycode"
    const parts = keycodeStr.split(',');
    if (parts.length !== 2) return keycodeStr;

    const intMod = parseInt(parts[0], 10);
    const keyNum = parseInt(parts[1], 10);
    if (isNaN(intMod) || isNaN(keyNum)) return keycodeStr;

    const modLetters = MOD_FLAGS.filter(({ flag }) => intMod & flag)
      .map(({ char }) => char)
      .join('');

    const keyChar = KEYCODE_MAP[keyNum] || String(keyNum);

    return modLetters ? `${modLetters}+${keyChar}` : keyChar;
  }

  /**
   * Logs a message to console with script name prefix
   * @param {string} message - Message to log
   * @param {*} data - Optional data object to log
   */
  function log(message, data = '') {
    console.log(`${GM_info.script.name}:`, message, data);
  }

  /**
   * Logs an error to console with Error object
   * @param {string} message - Error message
   * @param {*} data - Optional error details
   */
  function logError(message, data = '') {
    console.error(`${GM_info.script.name}:`, new Error(message), data);
  }

  /**
   * Logs a warning to console
   * @param {string} message - Warning message
   * @param {*} data - Optional warning details
   */
  function logWarning(message, data = '') {
    console.warn(`${GM_info.script.name}:`, message, data);
  }

  /**
   * Logs a debug message (only when debug=true)
   * @param {string} message - Debug message
   * @param {*} data - Optional debug data
   */
  function logDebug(message, data = '') {
    if (debug) log(message, data);
  }

  /**
   * Deep or shallow merge objects (like jQuery.extend)
   * @param {boolean|object} [deep=false] - If true, do deep merge; otherwise first param is source
   * @param {...object} objects - Objects to merge
   * @returns {object} Merged object
   */
  function $extend(...args) {
    const extended = {},
      deep = Object.prototype.toString.call(args[0]) === '[object Boolean]' ? args[0] : false,
      merge = function (obj) {
        Object.keys(obj).forEach((prop) => {
          if (Object.prototype.hasOwnProperty.call(obj, prop)) {
            if (deep && Object.prototype.toString.call(obj[prop]) === '[object Object]') extended[prop] = $extend(true, extended[prop], obj[prop]);
            else if (obj[prop] !== undefined && obj[prop] !== null) extended[prop] = obj[prop];
          }
        });
      };
    for (let i = deep ? 1 : 0, { length } = args; i < length; i++) {
      if (args[i]) merge(args[i]);
    }
    return extended;
  }

  /**
   * Creates a DOM element with attributes and event listeners
   * @param {string} type - Element type cached in elemCache (div, button, p, etc.)
   * @param {object} attrs - Attributes to set (class, id, textContent, innerHTML, disabled, checked, etc.)
   * @param {object[]} eventListener - Array of {eventName: callback} objects to attach as listeners
   * @returns {Element} Configured DOM element
   */
  function createElem(type = '', attrs = {}, eventListener = []) {
    const el = elemCache[type]?.cloneNode(false) || elemCache.div.cloneNode(false),
      applyEventListeners = function ([evt, cb]) {
        return this.addEventListener(evt, cb);
      };
    Object.keys(attrs).forEach((attr) => {
      if (attrs[attr] !== undefined && attrs[attr] !== 'undefined' && attrs[attr] !== null && attrs[attr] !== 'null') {
        if (attr === 'disabled' || attr === 'checked' || attr === 'selected' || attr === 'textContent' || attr === 'innerHTML') el[attr] = attrs[attr];
        else el.setAttribute(attr, attrs[attr]);
      }
    });
    if (eventListener.length > 0) {
      eventListener.forEach((obj) => {
        Object.entries(obj).map(applyEventListeners.bind(el));
      });
    }
    return el;
  }

  /**
   * Clears a pending timeout
   * @param {Object} obj - Timeout info {timeout: 'name', toIndex: optional}
   */
  function checkTimeout(obj) {
    if (obj.toIndex) {
      if (timeouts[obj.timeout]?.[obj.toIndex]) {
        window.clearTimeout(timeouts[obj.timeout][obj.toIndex]);
        delete timeouts[obj.timeout][obj.toIndex];
      }
    } else {
      if (timeouts[obj.timeout]) window.clearTimeout(timeouts[obj.timeout]);
      timeouts[obj.timeout] = undefined;
    }
  }

  /**
   * Loads user settings from localStorage and merges with server settings
   * Validates and migrates old shortcut format if needed
   * @async
   * @returns {Promise<void>}
   */
  async function loadSettingsFromStorage() {
    const defaultSettings = {
        conflictingNames: 'warning',
        longJnMove: 'warning',
        microDogLegs: 'warning',
        nonContinuousSelection: 'warning',
        sanityCheck: 'warning',
        simplifyTolerance: 1, // Tolerance in meters: 1 (Low) to 10 (Max)
        runStraightenUpShortcut: { raw: null, combo: null }, // Store both formats like ZoomShortcuts
        lastSaved: 0,
        lastVersion: undefined,
      },
      loadedSettings = JSON.parse(localStorage.getItem(SETTINGS_STORE_NAME));
    settings = $extend(true, {}, defaultSettings, loadedSettings);

    // Validate and migrate shortcut format from localStorage
    const migrated = validateAndMigrateShortcut(settings.runStraightenUpShortcut, 'localStorage');
    const needsMigration = JSON.stringify(settings.runStraightenUpShortcut) !== JSON.stringify(migrated);
    settings.runStraightenUpShortcut = migrated;

    // Save migrated settings so we don't need to migrate again on next load
    if (needsMigration) {
      settings.lastVersion = SCRIPT_VERSION;
      settings.lastSaved = Date.now();
      localStorage.setItem(SETTINGS_STORE_NAME, JSON.stringify(settings));
      logDebug('Settings migrated and saved to localStorage');
    }

    const serverSettings = await WazeWrap.Remote.RetrieveSettings(SETTINGS_STORE_NAME);
    if (serverSettings?.lastSaved > settings.lastSaved) {
      $extend(settings, serverSettings);
      logDebug('Server settings are newer, merged into local settings');

      // Validate and migrate server shortcut using the same helper
      settings.runStraightenUpShortcut = validateAndMigrateShortcut(settings.runStraightenUpShortcut, 'server');
    }
    timeouts.saveSettingsToStorage = window.setTimeout(saveSettingsToStorage, 5000);
    return Promise.resolve();
  }

  /**
   * Saves user settings to localStorage
   * Queries SDK for current shortcut state to detect user changes
   */
  function saveSettingsToStorage() {
    checkTimeout({ timeout: 'saveSettingsToStorage' });
    if (localStorage) {
      // Query SDK for current shortcut value (in case user changed it) 
      if (wmeSdk && wmeSdk.Shortcuts && wmeSdk.Shortcuts.getAllShortcuts) {
        try {
          const allShortcuts = wmeSdk.Shortcuts.getAllShortcuts();
          const suShortcut = allShortcuts.find((s) => s.shortcutId === 'runStraightenUpShortcut');
          if (suShortcut) {
            const sdkValue = suShortcut.shortcutKeys;
            const raw = comboToRawKeycodes(sdkValue);
            const combo = shortcutKeycodesToCombo(raw);
            const newShortcut = { raw, combo };

            // Only log and update if value actually changed
            if (JSON.stringify(settings.runStraightenUpShortcut) !== JSON.stringify(newShortcut)) {
              logDebug(`Shortcut changed in SDK: "${sdkValue}" → raw="${raw}", combo="${combo}"`);
              settings.runStraightenUpShortcut = newShortcut;
            }
          }
        } catch (err) {
          logError('Failed to query shortcut from SDK:', err);
        }
      }
      settings.lastVersion = SCRIPT_VERSION;
      settings.lastSaved = Date.now();
      localStorage.setItem(SETTINGS_STORE_NAME, JSON.stringify(settings));
      logDebug('Settings saved.');
    }
  }

  /**
   * Displays "What's New" update notification on version change
   */
  function showScriptInfoAlert() {
    if (SHOW_UPDATE_MESSAGE && SCRIPT_VERSION !== settings.lastVersion) {
      let releaseNotes = "<p>What's New:</p>";
      if (SCRIPT_VERSION_CHANGES.length > 0) {
        releaseNotes += '<ul>';
        for (let idx = 0; idx < SCRIPT_VERSION_CHANGES.length; idx++) releaseNotes += `<li>${SCRIPT_VERSION_CHANGES[idx]}</li>`;
        releaseNotes += '</ul>';
      } else {
        releaseNotes += '<ul><li>Nothing major.</li></ul>';
      }
      WazeWrap.Interface.ShowScriptUpdate(GM_info.script.name, SCRIPT_VERSION, releaseNotes, SCRIPT_PAGE_URL);
    }
  }

  /**
   * Determines direction indicator between two coordinates
   * @param {number} a - First coordinate
   * @param {number} b - Second coordinate
   * @returns {number} -1 (a>b), 0 (equal), 1 (a<b)
   */
  function getDeltaDirect(a, b) {
    let d = 0.0;
    if (a < b) d = 1.0;
    else if (a > b) d = -1.0;
    return d;
  }

  /**
   * Checks if selected segments share at least one street ID (primary or alternate)
   * First segment establishes the "acceptable street IDs" pool (primary + all alternates)
   * All subsequent segments must have at least one street ID matching that pool
   * @param {Object[]} segmentSelectionArr - Array of segment objects
   * @returns {boolean} True if all segments have name continuity with first segment
   */
  function checkNameContinuity(segmentSelectionArr = []) {
    const streetIds = [],
      streetIdsForEach = (streetId) => {
        streetIds.push(streetId);
      };
    for (let idx = 0, { length } = segmentSelectionArr; idx < length; idx++) {
      if (idx > 0) {
        if (segmentSelectionArr[idx].primaryStreetId > 0 && streetIds.includes(segmentSelectionArr[idx].primaryStreetId))
          // eslint-disable-next-line no-continue
          continue;
        const segStreetIds = segmentSelectionArr[idx].alternateStreetIds || [];
        if (segStreetIds.length > 0) {
          let included = false;
          for (let idx2 = 0, len = segStreetIds.length; idx2 < len; idx2++) {
            included = streetIds.includes(segStreetIds[idx2]);
            if (included) break;
          }
          if (included === true)
            // eslint-disable-next-line no-continue
            continue;
          else return false;
        }
        return false;
      }
      if (idx === 0) {
        if (segmentSelectionArr[idx].primaryStreetId > 0) streetIds.push(segmentSelectionArr[idx].primaryStreetId);
        const segStreetIds0 = segmentSelectionArr[idx].alternateStreetIds || [];
        if (segStreetIds0.length > 0) segStreetIds0.forEach(streetIdsForEach);
      }
    }
    return true;
  }

  /**
   * Calculates distance between two WGS84 (EPSG:4326) coordinates using Turf.js
   * Wrapper around turf.distance() for compatibility with existing code
   * @param {number} lon1 - Longitude 1
   * @param {number} lat1 - Latitude 1
   * @param {number} lon2 - Longitude 2
   * @param {number} lat2 - Latitude 2
   * @param {string} [measurement='kilometers'] - Unit: 'meters', 'miles', 'feet', 'kilometers', 'nautical miles', 'degrees', or 'radians'
   * @returns {number} Distance in specified unit
   */
  function distanceBetweenPoints(lon1, lat1, lon2, lat2, measurement = 'kilometers') {
    // Turf.distance expects [lon, lat] coordinates
    const from = [lon1, lat1];
    const to = [lon2, lat2];

    // Map measurement names to Turf units (turf uses 'meters', 'miles', 'feet', etc.)
    const unitMap = {
      'meters': 'meters',
      'miles': 'miles',
      'feet': 'feet',
      'kilometers': 'kilometers',
      'nm': 'nauticalmiles',
      'nautical miles': 'nauticalmiles',
      'degrees': 'degrees',
      'radians': 'radians'
    };

    const turfUnit = unitMap[measurement] || 'kilometers';
    return turf.distance(from, to, { units: turfUnit });
  }

  /**
   * Calculates angle at point2 using dot product of vectors
   * Used for detecting nearly-straight geometry nodes
   * @param {number[]} point1 - First point [lon, lat]
   * @param {number[]} point2 - Middle point (vertex) [lon, lat]
   * @param {number[]} point3 - Third point [lon, lat]
   * @returns {number} Angle in degrees (0-180)
   */
  function calculateAngle(point1, point2, point3) {
    const v1 = [point1[0] - point2[0], point1[1] - point2[1]];
    const v2 = [point3[0] - point2[0], point3[1] - point2[1]];
    const dotProduct = v1[0] * v2[0] + v1[1] * v2[1];
    const mag1 = Math.sqrt(v1[0] * v1[0] + v1[1] * v1[1]);
    const mag2 = Math.sqrt(v2[0] * v2[0] + v2[1] * v2[1]);
    if (mag1 === 0 || mag2 === 0) return 0;
    const cosAngle = dotProduct / (mag1 * mag2);
    const clampedCos = Math.max(-1, Math.min(1, cosAngle)); // Clamp to [-1, 1]
    return Math.acos(clampedCos) * (180 / Math.PI);
  }

  /**
   * Checks if removing a node would cross a turn instruction threshold
   * Used to detect intentional micro dog legs that control turn instructions
   * Turn thresholds from WME-JAI: Keep/Turn boundary is 45.5°, U-Turn thresholds at 168.24°
   * @param {number} angleWithNode - Turn angle at junction with the geometry node
   * @param {number} angleWithoutNode - Turn angle at junction without the geometry node
   * @returns {boolean} True if removal would cross a threshold (change turn instruction)
   */
  function checkMicroDogLegThreshold(angleWithNode, angleWithoutNode) {
    const TURN_THRESHOLDS = [43.5, 45.5, 166.74, 168.24];
    for (let threshold of TURN_THRESHOLDS) {
      // Check if angles straddle the threshold (crossing it)
      if ((angleWithNode < threshold && angleWithoutNode >= threshold) ||
          (angleWithNode > threshold && angleWithoutNode <= threshold)) {
        return true; // Crosses threshold - would change turn instruction
      }
    }
    return false; // Safe to remove
  }


  /**
   * Detects micro dog legs: geometry nodes within 2m of junction nodes
   * Indicates possible mapping issues that should be fixed before straightening
   * @param {number[]} distinctNodes - Array of node IDs to check
   * @param {number} singleSegmentId - Optional: only check this segment
   * @returns {boolean} True if micro dog legs detected
   */
  function checkForMicroDogLegs(distinctNodes, singleSegmentId) {
    if (!distinctNodes || distinctNodes.length < 1) return false;
    const nodesChecked = [],
      nodesObjArr = getNodesByIds(distinctNodes); // Use SDK helper
    if (!nodesObjArr || nodesObjArr.length < 1) return false;
    const checkGeoComp = function (geoComp) {
      const testNode4326 = { lon: geoComp[0], lat: geoComp[1] };
      if (this.lon !== testNode4326.lon || this.lat !== testNode4326.lat) {
        if (distanceBetweenPoints(this.lon, this.lat, testNode4326.lon, testNode4326.lat, 'meters') < 2) return false;
      }
      return true;
    };
    for (let idx = 0, { length } = nodesObjArr; idx < length; idx++) {
      if (!nodesChecked.includes(nodesObjArr[idx])) {
        nodesChecked.push(nodesObjArr[idx]);
        // Get segment IDs from node and fetch segment objects (SDK uses properties, not methods)
        const segmentIds = nodesObjArr[idx].segmentIds || [];
        const segmentsObjArr = getSegmentsByIds(segmentIds) || [],
          node4326 = {
            lon: nodesObjArr[idx].geometry.coordinates[0],
            lat: nodesObjArr[idx].geometry.coordinates[1],
          };
        for (let idx2 = 0, len = segmentsObjArr.length; idx2 < len; idx2++) {
          const segObj = segmentsObjArr[idx2];
          if (!singleSegmentId || (singleSegmentId && segObj.id === singleSegmentId)) {
            if (!segObj.geometry.coordinates.every(checkGeoComp.bind(node4326))) return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Main straightening algorithm: aligns segments along line from endpoint to endpoint
   * Removes intermediate geometry nodes and moves junction nodes to align with endpoints
   * Performs multiple validation checks (name continuity, micro dog legs, long moves, etc.)
   * @param {boolean} sanityContinue - User confirmed sanity check (>10 segments)
   * @param {boolean} nonContinuousContinue - User confirmed non-continuous selection
   * @param {boolean} conflictingNamesContinue - User confirmed conflicting street names
   * @param {boolean} microDogLegsContinue - User confirmed micro dog legs present
   * @param {boolean} longJnMoveContinue - User confirmed long junction node moves
   * @param {Object} passedObj - Pre-calculated straightening data (internal use)
   * @returns {void}
   */
  function doStraightenSegments(sanityContinue, nonContinuousContinue, conflictingNamesContinue, microDogLegsContinue, longJnMoveContinue, passedObj) {
    log('doStraightenSegments called');
    logDebug(`Parameters: sanityContinue=${sanityContinue}, longJnMoveContinue=${longJnMoveContinue}, passedObj=${passedObj ? 'yes' : 'no'}`);

    // ════════════════════════════════════════════════════════════════════════════════
    // SECTION 1: RETRIEVE SELECTION
    // Gets the currently selected segments from the WME editor
    // ════════════════════════════════════════════════════════════════════════════════
    const selection = wmeSdk.Editing.getSelection();
    logDebug(`Selection: ${selection ? `objectType=${selection.objectType}, ids=${selection.ids?.length || 0}` : 'null'}`);

    const segments = selection && selection.objectType === 'segment' && selection.ids ? getSegmentsByIds(selection.ids) : [];
    const segmentSelection = {
      segments: segments,
      multipleConnectedComponents: hasMultipleConnectedComponents(segments),
    };
    logDebug(`Segment selection: ${segmentSelection.segments.length} segments found, multipleConnectedComponents=${segmentSelection.multipleConnectedComponents}`);

    // ════════════════════════════════════════════════════════════════════════════════
    // SECTION 2: EXECUTE STRAIGHTENING (if all validations passed)
    // Only runs when passedObj exists, meaning user has confirmed all warning dialogs
    // Applies the pre-calculated geometry updates and node movements
    // ════════════════════════════════════════════════════════════════════════════════
    if (longJnMoveContinue && passedObj) {
      logDebug('Processing with passed object (continuing from confirmation)');
      const { segmentsToRemoveGeometryArr, nodesToMoveArr, distinctNodes, endPointNodeIds } = passedObj;
      logDebug(`${I18n.t('wmesu.log.StraighteningSegments')}: ${distinctNodes.join(', ')} (${distinctNodes.length})`);
      logDebug(`${I18n.t('wmesu.log.EndPoints')}: ${endPointNodeIds.join(' & ')}`);
      logDebug(`Segments to update: ${segmentsToRemoveGeometryArr?.length || 0}, Nodes to move: ${nodesToMoveArr?.length || 0}`);

      if (segmentsToRemoveGeometryArr?.length > 0) {
        logDebug(`Updating geometry for ${segmentsToRemoveGeometryArr.length} segment(s)`);
        // Use SDK method to update segment geometry
        segmentsToRemoveGeometryArr.forEach((obj) => {
          try {
            wmeSdk.DataModel.Segments.updateSegment({
              segmentId: obj.segment.id,
              geometry: obj.newGeo,
            });
            logDebug(`${I18n.t('wmesu.log.RemovedGeometryNodes')} # ${obj.segment.id}`);
          } catch (err) {
            logError(`Failed to update segment ${obj.segment.id}:`, err);
          }
        });
      }
      if (nodesToMoveArr?.length > 0) {
        logDebug(`Moving ${nodesToMoveArr.length} node(s)`);
        // Use SDK method to move nodes
        let straightened = false;
        nodesToMoveArr.forEach((node) => {
          if (Math.abs(node.geometry.coordinates[0] - node.nodeGeo.coordinates[0]) > 0.00000001 || Math.abs(node.geometry.coordinates[1] - node.nodeGeo.coordinates[1]) > 0.00000001) {
            logDebug(
              `${I18n.t('wmesu.log.MovingJunctionNode')} # ${node.node.id} ` +
                `- ${I18n.t('wmesu.common.From')}: ${node.geometry.coordinates[0]},${node.geometry.coordinates[1]} - ` +
                `${I18n.t('wmesu.common.To')}: ${node.nodeGeo.coordinates[0]},${node.nodeGeo.coordinates[1]}`,
            );
            try {
              wmeSdk.DataModel.Nodes.moveNode({
                id: node.node.id,
                geometry: node.nodeGeo,
              });
              straightened = true;
            } catch (err) {
              logError(`Failed to move node ${node.node.id}:`, err);
            }
          }
        });
        if (!straightened) {
          logDebug(I18n.t('wmesu.log.AllNodesStraight'));
          WazeWrap.Alerts.info(GM_info.script.name, I18n.t('wmesu.log.AllNodesStraight'));
        }
      }
    } else if (segmentSelection.segments.length > 1) {
      // ════════════════════════════════════════════════════════════════════════════════
      // SECTION 3: MULTI-SEGMENT PROCESSING WITH VALIDATION CHECKS
      // ════════════════════════════════════════════════════════════════════════════════
      logDebug(`Processing ${segmentSelection.segments.length} segments`);

      // Arrays to collect segments and nodes that need updating
      const segmentsToRemoveGeometryArr = [],  // Segments needing geometry node removal
        nodesToMoveArr = [];                   // Junction nodes that need repositioning

      // ────────────────────────────────────────────────────────────────────────────────
      // VALIDATION CHECK 1: SANITY CHECK
      // Prevents accidental mass edits by requiring confirmation for >10 segments
      // Flag: sanityContinue - stays true once confirmed, prevents repeated prompts
      // ────────────────────────────────────────────────────────────────────────────────
      if (segmentSelection.segments.length > 10 && !sanityContinue) {
        logDebug('Sanity check: more than 10 segments');
        if (settings.sanityCheck === 'error') {
          WazeWrap.Alerts.error(GM_info.script.name, I18n.t('wmesu.error.TooManySegments'));
          return;
        }
        if (settings.sanityCheck === 'warning') {
          WazeWrap.Alerts.confirm(
            GM_info.script.name,
            I18n.t('wmesu.prompts.SanityCheckConfirm'),
            () => {
              doStraightenSegments(true, false, false, false, false, undefined);
            },
            () => {},
            I18n.t('wmesu.common.Yes'),
            I18n.t('wmesu.common.No'),
          );
          return;
        }
      }
      sanityContinue = true;

      // ────────────────────────────────────────────────────────────────────────────────
      // VALIDATION CHECK 2: NON-CONTINUOUS SEGMENTS
      // Detects if selected segments are not all connected to each other
      // Can cause unexpected results when straightening disconnected groups
      // Flag: nonContinuousContinue - stays true once confirmed
      // ────────────────────────────────────────────────────────────────────────────────
      if (segmentSelection.multipleConnectedComponents === true && !nonContinuousContinue) {
        if (settings.nonContinuousSelection === 'error') {
          WazeWrap.Alerts.error(GM_info.script.name, I18n.t('wmesu.error.NonContinuous'));
          return;
        }
        if (settings.nonContinuousSelection === 'warning') {
          WazeWrap.Alerts.confirm(
            GM_info.script.name,
            I18n.t('wmesu.prompts.NonContinuousConfirm'),
            () => {
              doStraightenSegments(sanityContinue, true, false, false, false, undefined);
            },
            () => {},
            I18n.t('wmesu.common.Yes'),
            I18n.t('wmesu.common.No'),
          );
          return;
        }
      }
      nonContinuousContinue = true;

      // ────────────────────────────────────────────────────────────────────────────────
      // VALIDATION CHECK 3: NAME CONTINUITY
      // Ensures all selected segments share at least one street name (primary or alternate)
      // Straightening segments with different street names could create mapping errors
      // Flag: conflictingNamesContinue - stays true once confirmed
      // ────────────────────────────────────────────────────────────────────────────────
      if (settings.conflictingNames !== 'nowarning') {
        const continuousNames = checkNameContinuity(segmentSelection.segments);
        if (!continuousNames && !conflictingNamesContinue && settings.conflictingNames === 'error') {
          WazeWrap.Alerts.error(GM_info.script.name, I18n.t('wmesu.error.ConflictingNames'));
          return;
        }
        if (!continuousNames && !conflictingNamesContinue && settings.conflictingNames === 'warning') {
          WazeWrap.Alerts.confirm(
            GM_info.script.name,
            I18n.t('wmesu.prompts.ConflictingNamesConfirm'),
            () => {
              doStraightenSegments(sanityContinue, nonContinuousContinue, true, false, false, undefined);
            },
            () => {},
            I18n.t('wmesu.common.Yes'),
            I18n.t('wmesu.common.No'),
          );
          return;
        }
      }
      conflictingNamesContinue = true;

      // ════════════════════════════════════════════════════════════════════════════════
      // SECTION 4: DATA PREPARATION & GEOMETRY SIMPLIFICATION
      // Collects all endpoint nodes and prepares simplified geometry
      // ════════════════════════════════════════════════════════════════════════════════

      // allNodeIds: every node ID from every segment's from/to endpoints (includes duplicates)
      // dupNodeIds: node IDs that appear multiple times (junction nodes connecting segments)
      // endPointNodeIds: node IDs appearing only once (true start/end of selection)
      const allNodeIds = [],
        dupNodeIds = [];
      let endPointNodeIds,
        longMove = false;

      // Collect all endpoint nodes and prepare geometry for simplification
      for (let idx = 0, { length } = segmentSelection.segments; idx < length; idx++) {
        allNodeIds.push(segmentSelection.segments[idx].fromNodeId);
        allNodeIds.push(segmentSelection.segments[idx].toNodeId);
        // Process all segments (already filtered by objectType === 'segment')
        const newGeo = structuredClone(segmentSelection.segments[idx].geometry);
        // Remove the geometry nodes
        if (newGeo.coordinates.length > 2) {
          newGeo.coordinates.splice(1, newGeo.coordinates.length - 2);
          segmentsToRemoveGeometryArr.push({ segment: segmentSelection.segments[idx], geometry: segmentSelection.segments[idx].geometry, newGeo });
        }
      }

      // Identify which nodes appear more than once (these are junction nodes connecting segments)
      allNodeIds.forEach((nodeId, idx) => {
        if (allNodeIds.indexOf(nodeId, idx + 1) > -1) {
          if (!dupNodeIds.includes(nodeId)) dupNodeIds.push(nodeId);
        }
      });

      // distinctNodes: unique node IDs in the selection (removes duplicates)
      // These will be used to calculate straightening positions for all junction nodes
      const distinctNodes = [...new Set(allNodeIds)];

      // ────────────────────────────────────────────────────────────────────────────────
      // VALIDATION CHECK 4: MICRO DOG LEGS
      // Detects if any junction nodes have geometry nodes within 2m (potential mapping issues)
      // Straightening with micro dog legs could make the issues worse
      // Flag: microDogLegsContinue - stays true once confirmed
      // ────────────────────────────────────────────────────────────────────────────────
      if (!microDogLegsContinue && checkForMicroDogLegs(distinctNodes, undefined) === true) {
        if (settings.microDogLegs === 'error') {
          WazeWrap.Alerts.error(GM_info.script.name, I18n.t('wmesu.error.MicroDogLegs'));
          return;
        }
        if (settings.microDogLegs === 'warning') {
          WazeWrap.Alerts.confirm(
            GM_info.script.name,
            I18n.t('wmesu.prompts.MicroDogLegsConfirm'),
            () => {
              doStraightenSegments(sanityContinue, nonContinuousContinue, conflictingNamesContinue, true, false, undefined);
            },
            () => {},
            I18n.t('wmesu.common.Yes'),
            I18n.t('wmesu.common.No'),
          );
          return;
        }
      }
      microDogLegsContinue = true;

      // ════════════════════════════════════════════════════════════════════════════════
      // SECTION 5: IDENTIFY ENDPOINTS & CALCULATE STRAIGHTENING LINE
      // Determines which nodes are the true endpoints and calculates the straightening line
      // ════════════════════════════════════════════════════════════════════════════════

      // Determine endpoint nodes based on segment connectivity
      // If continuous: endpoints are nodes that appear only once (not junctions)
      // If discontinuous: endpoints are first segment's start and last segment's end
      if (segmentSelection.multipleConnectedComponents === false) endPointNodeIds = distinctNodes.filter((nodeId) => !dupNodeIds.includes(nodeId));
      else endPointNodeIds = [segmentSelection.segments[0].fromNodeId, segmentSelection.segments[segmentSelection.segments.length - 1].toNodeId];

      // Get the actual endpoint node objects and their coordinates
      const endPointNodeObjs = getNodesByIds(endPointNodeIds),
        endPointNode1Geo = structuredClone(endPointNodeObjs[0].geometry),
        endPointNode2Geo = structuredClone(endPointNodeObjs[1].geometry);

      // Normalize endpoints so endpoint1 is always westward (lower longitude) of endpoint2
      // This ensures consistent straightening direction regardless of selection order
      if (getDeltaDirect(endPointNode1Geo.coordinates[0], endPointNode2Geo.coordinates[0]) < 0) {
        let [t] = endPointNode1Geo.coordinates;
        [endPointNode1Geo.coordinates[0]] = endPointNode2Geo.coordinates;
        endPointNode2Geo.coordinates[0] = t;
        [, t] = endPointNode1Geo.coordinates;
        [, endPointNode1Geo.coordinates[1]] = endPointNode2Geo.coordinates;
        endPointNode2Geo.coordinates[1] = t;
        endPointNodeIds.push(endPointNodeIds[0]);
        endPointNodeIds.splice(0, 1);
        endPointNodeObjs.push(endPointNodeObjs[0]);
        endPointNodeObjs.splice(0, 1);
      }

      // Create straightening line as a Turf LineString for Turf.js perpendicular projection
      // This line passes through both endpoint nodes and represents the straightening target
      const straighteningLine = turf.lineString([
        endPointNode1Geo.coordinates,
        endPointNode2Geo.coordinates
      ]);

      // ════════════════════════════════════════════════════════════════════════════════
      // SECTION 6: CALCULATE NODE POSITIONS & DETECT LONG MOVES
      // For each junction node: calculate its perpendicular projection onto the straightening line
      // Also determines if any node would move >10m (triggers separate validation)
      // Uses turf.nearestPointOnLine() to project each node onto the straightening line
      // ════════════════════════════════════════════════════════════════════════════════

      distinctNodes.forEach((nodeId) => {
        if (!endPointNodeIds.includes(nodeId)) {
          const node = wmeSdk.DataModel.Nodes.getById({ nodeId }),
            nodeGeo = structuredClone(node.geometry);

          // Use Turf to calculate perpendicular projection of this node onto the straightening line
          const nodePoint = turf.point(node.geometry.coordinates);
          const projectedPoint = turf.nearestPointOnLine(straighteningLine, nodePoint);
          const projectedCoords = projectedPoint.geometry.coordinates;

          nodeGeo.coordinates[0] = projectedCoords[0];
          nodeGeo.coordinates[1] = projectedCoords[1];

          const connectedSegObjs = {};
          const segmentIds = node.segmentIds || [];
          for (let idx = 0, { length } = segmentIds; idx < length; idx++) {
            const segId = segmentIds[idx];
            connectedSegObjs[segId] = structuredClone(wmeSdk.DataModel.Segments.getById({ segmentId: segId }).geometry);
          }

          // Calculate distance node would move to check for long moves (>10m)
          const originalCoords = node.geometry.coordinates;
          const moveDistance = distanceBetweenPoints(originalCoords[0], originalCoords[1], projectedCoords[0], projectedCoords[1], 'meters');
          if (moveDistance > 10) longMove = true;

          nodesToMoveArr.push({
            node,
            geometry: node.geometry,
            nodeGeo,
            connectedSegObjs,
          });
        }
      });

      // ────────────────────────────────────────────────────────────────────────────────
      // VALIDATION CHECK 5: LONG JUNCTION NODE MOVES
      // Prevents accidentally moving junction nodes more than 10m (could create misalignment)
      // Flag: longJnMoveContinue - stays true once confirmed
      // When confirmed with passedObj, the actual updates are applied (Section 2)
      // ────────────────────────────────────────────────────────────────────────────────
      if (longMove && settings.longJnMove === 'error') {
        WazeWrap.Alerts.error(GM_info.script.name, I18n.t('wmesu.error.LongJnMove'));
        return;
      }
      if (longMove && settings.longJnMove === 'warning') {
        WazeWrap.Alerts.confirm(
          GM_info.script.name,
          I18n.t('wmesu.prompts.LongJnMoveConfirm'),
          () => {
            doStraightenSegments(sanityContinue, nonContinuousContinue, conflictingNamesContinue, microDogLegsContinue, true, {
              segmentsToRemoveGeometryArr,
              nodesToMoveArr,
              distinctNodes,
              endPointNodeIds,
            });
          },
          () => {},
          I18n.t('wmesu.common.Yes'),
          I18n.t('wmesu.common.No'),
        );
        return;
      }
      doStraightenSegments(sanityContinue, nonContinuousContinue, conflictingNamesContinue, microDogLegsContinue, true, {
        segmentsToRemoveGeometryArr,
        nodesToMoveArr,
        distinctNodes,
        endPointNodeIds,
      });
    } else if (segmentSelection.segments.length === 1) {
      // ════════════════════════════════════════════════════════════════════════════════
      // SECTION 7: SINGLE SEGMENT PROCESSING
      // For a single segment: only removes geometry nodes (no junction node movement needed)
      // Still performs micro dog leg check before proceeding
      // ════════════════════════════════════════════════════════════════════════════════
      logDebug('Processing single segment');
      const seg = segmentSelection.segments[0];
      logDebug(`Segment ID: ${seg.id}`);

      // ────────────────────────────────────────────────────────────────────────────────
      // VALIDATION CHECK 4B: MICRO DOG LEGS (single segment variant)
      // ────────────────────────────────────────────────────────────────────────────────
      if (!microDogLegsContinue && checkForMicroDogLegs([seg.fromNodeId, seg.toNodeId], seg.id) === true) {
        if (settings.microDogLegs === 'error') {
          WazeWrap.Alerts.error(GM_info.script.name, I18n.t('wmesu.error.MicroDogLegs'));
          return;
        }
        if (settings.microDogLegs === 'warning') {
          WazeWrap.Alerts.confirm(
            GM_info.script.name,
            I18n.t('wmesu.prompts.MicroDogLegsConfirm'),
            () => {
              doStraightenSegments(sanityContinue, nonContinuousContinue, conflictingNamesContinue, true, false, undefined);
            },
            () => {},
            I18n.t('wmesu.common.Yes'),
            I18n.t('wmesu.common.No'),
          );
          return;
        }
      }
      microDogLegsContinue = true;
      const newGeo = structuredClone(seg.geometry);
      // Remove the geometry nodes using SDK method
      if (newGeo.coordinates.length > 2) {
        newGeo.coordinates.splice(1, newGeo.coordinates.length - 2);
        wmeSdk.DataModel.Segments.updateSegment({
          segmentId: seg.id,
          geometry: newGeo,
        });
        logDebug(`${I18n.t('wmesu.log.RemovedGeometryNodes')} # ${seg.id}`);
      }
    } else {
      // ════════════════════════════════════════════════════════════════════════════════
      // SECTION 8: NO VALID SEGMENTS SELECTED
      // Alert user to select at least one segment before running the script
      // ════════════════════════════════════════════════════════════════════════════════
      logDebug('No segments selected or segments not found');
      logWarning(I18n.t('wmesu.log.NoSegmentsSelected'));
    }
  }

  /**
   * Simplifies selected segments using Ramer-Douglas-Peucker algorithm via Turf.js
   * Preserves original path shape, detects intentional micro dog legs
   * @param {boolean} microDogLegsContinue - If true, skip micro dog leg confirmation prompt
   * @param {number} tolerance - Simplification tolerance in meters (default 1m)
   */
  function doSimplifySegments(microDogLegsContinue = false, tolerance = 1) {
    log('doSimplifySegments called');
    logDebug(`microDogLegsContinue=${microDogLegsContinue}, tolerance=${tolerance}m`);

    try {
      // Get selected segments
      const selection = wmeSdk.Editing.getSelection();
      if (!selection || selection.objectType !== 'segment' || !selection.ids || selection.ids.length === 0) {
        logWarning(I18n.t('wmesu.log.NoSegmentsSelected'));
        return;
      }

      const segmentIds = selection.ids;
      logDebug(`Simplifying ${segmentIds.length} segment(s) with ${tolerance}m tolerance`);

      const microDogLegViolations = []; // Store violations for user confirmation
      const segmentsToUpdate = []; // Store segments with changes
      let hasViolations = false;

      // Convert tolerance from meters to degrees for Turf.simplify()
      // Coordinates are in WGS84 (degrees), so we need to convert the tolerance
      // At the equator, 1 meter ≈ 1/111111 degrees
      // At higher latitudes, this varies, but we'll use equatorial approximation for simplicity
      const toleranceDegrees = tolerance / 111111;

      // Process each segment independently
      for (let segIdx = 0; segIdx < segmentIds.length; segIdx++) {
        const segmentId = segmentIds[segIdx];
        const segment = wmeSdk.DataModel.Segments.getById({ segmentId });

        if (!segment || !segment.geometry || !segment.geometry.coordinates) {
          logDebug(`Skipping segment ${segmentId} - no geometry found`);
          continue;
        }

        const coords = segment.geometry.coordinates;
        if (coords.length < 3) {
          logDebug(`Skipping segment ${segmentId} - only ${coords.length} coordinates`);
          continue;
        }

        // Use turf.simplify() with Ramer-Douglas-Peucker algorithm
        const lineString = turf.lineString(coords);
        const simplified = turf.simplify(lineString, { tolerance: toleranceDegrees });
        const newCoords = simplified.geometry.coordinates;

        // If no change, skip
        if (newCoords.length === coords.length) {
          logDebug(`Segment ${segmentId}: no simplification needed`);
          continue;
        }

        // Identify removed nodes
        const nodesToRemove = [];
        for (let i = 0; i < coords.length; i++) {
          const coord = coords[i];
          const found = newCoords.some((nc) => nc[0] === coord[0] && nc[1] === coord[1]);
          if (!found) {
            nodesToRemove.push(i);
          }
        }

        // Get segment endpoint nodes for micro dog leg detection
        const fromNode = segment.fromNode || segment.getFromNode?.();
        const toNode = segment.toNode || segment.getToNode?.();

        // Check for micro dog legs near junctions
        for (let nodeIdx of nodesToRemove) {
          const curCoord = coords[nodeIdx];
          let isMicroDogLeg = false;

          // Check distance to fromNode
          if (fromNode && fromNode.geometry && distanceBetweenPoints(
            curCoord[0], curCoord[1],
            fromNode.geometry.coordinates[0], fromNode.geometry.coordinates[1],
            'meters'
          ) < 2) {
            // Near fromNode - check if removal changes turn instruction
            if (nodeIdx > 0 && nodeIdx < coords.length - 1) {
              const angleWith = calculateAngle(coords[nodeIdx - 1], curCoord, coords[nodeIdx + 1]);
              const angleWithout = calculateAngle(coords[nodeIdx - 1], coords[nodeIdx + 1], nodeIdx + 2 < coords.length ? coords[nodeIdx + 2] : coords[nodeIdx + 1]);
              if (checkMicroDogLegThreshold(angleWith, angleWithout)) {
                isMicroDogLeg = true;
                hasViolations = true;
                microDogLegViolations.push({
                  segmentId,
                  nodeIndex: nodeIdx,
                  junctionType: 'fromNode',
                  angleWith: angleWith.toFixed(1),
                  angleWithout: angleWithout.toFixed(1),
                });
              }
            }
          }

          // Check distance to toNode
          if (!isMicroDogLeg && toNode && toNode.geometry && distanceBetweenPoints(
            curCoord[0], curCoord[1],
            toNode.geometry.coordinates[0], toNode.geometry.coordinates[1],
            'meters'
          ) < 2) {
            // Near toNode - check if removal changes turn instruction
            if (nodeIdx > 0 && nodeIdx < coords.length - 1) {
              const angleWith = calculateAngle(nodeIdx - 2 >= 0 ? coords[nodeIdx - 2] : coords[nodeIdx - 1], curCoord, coords[nodeIdx + 1]);
              const angleWithout = calculateAngle(nodeIdx - 2 >= 0 ? coords[nodeIdx - 2] : coords[nodeIdx - 1], coords[nodeIdx + 1], nodeIdx + 2 < coords.length ? coords[nodeIdx + 2] : coords[nodeIdx + 1]);
              if (checkMicroDogLegThreshold(angleWith, angleWithout)) {
                isMicroDogLeg = true;
                hasViolations = true;
                microDogLegViolations.push({
                  segmentId,
                  nodeIndex: nodeIdx,
                  junctionType: 'toNode',
                  angleWith: angleWith.toFixed(1),
                  angleWithout: angleWithout.toFixed(1),
                });
              }
            }
          }
        }

        // Add to update list if not a micro dog leg violation or user confirmed
        if (!hasViolations || microDogLegsContinue) {
          segmentsToUpdate.push({
            segmentId,
            originalCoordCount: coords.length,
            newCoords,
            nodesToRemove,
          });
          logDebug(`Segment ${segmentId}: ${coords.length} → ${newCoords.length} nodes`);
        }
      }

      // Handle micro dog leg violations
      if (hasViolations && !microDogLegsContinue) {
        logWarning(`Micro dog legs detected: ${microDogLegViolations.length} node(s) near junctions`);
        WazeWrap.Alerts.confirm(
          'WME Straighten Up! - Simplify',
          `Warning: Removing ${microDogLegViolations.length} geometry node(s) would alter turn instructions at ${new Set(microDogLegViolations.map((v) => v.segmentId)).size} junction(s).\n\nThese appear to be intentional micro dog legs used to force turn instructions. Consider using Turn Instruction Override (TIO) or Voice Instruction Override (VIO) instead.\n\nRemove these nodes anyway?`,
          () => {
            logDebug('User confirmed micro dog leg removal');
            doSimplifySegments(true, tolerance); // Recursive call with flag=true
          },
          () => {
            logDebug('User cancelled micro dog leg removal');
          }
        );
        return;
      }

      // Update segments
      let successCount = 0;
      for (let segUpdate of segmentsToUpdate) {
        try {
          logDebug(`Updating segment ${segUpdate.segmentId}: ${segUpdate.originalCoordCount} → ${segUpdate.newCoords.length} nodes`);

          wmeSdk.DataModel.Segments.updateSegment({
            segmentId: segUpdate.segmentId,
            geometry: {
              type: 'LineString',
              coordinates: segUpdate.newCoords,
            },
          });

          successCount++;
        } catch (err) {
          logError(`Failed to update segment ${segUpdate.segmentId}: ${err.message}`);
        }
      }

      // Show result
      if (successCount > 0) {
        const totalNodesRemoved = segmentsToUpdate.reduce((sum, s) => sum + s.nodesToRemove.length, 0);
        WazeWrap.Alerts.info(
          'WME Straighten Up! - Simplify',
          `Simplified ${successCount} segment(s): removed ${totalNodesRemoved} redundant node(s) with ${tolerance}m tolerance`
        );
        log(`Simplification complete: ${successCount} segments, ${totalNodesRemoved} nodes removed`);
      } else {
        WazeWrap.Alerts.info('WME Straighten Up! - Simplify', 'No redundant nodes found to remove');
      }
    } catch (err) {
      logError(`doSimplifySegments error: ${err.message}`);
      WazeWrap.Alerts.error('WME Straighten Up! - Simplify', `Error: ${err.message}`);
    }
  }

  /**
   * Updates "Do It" button state based on current segment selection
   * Enables button only when segments are selected
   */
  function insertSimplifyStreetGeometryButtons() {
    // Check if we actually have a selection
    const selection = wmeSdk.Editing.getSelection();
    // Button can be in Segment Edit panel (new) or sidebar (legacy)
    const btn = document.getElementById('WME-SU-SEGMENT-EDIT') || document.getElementById('WME-SU');

    if (!selection || selection.objectType !== 'segment' || !selection.ids || selection.ids.length === 0) {
      logDebug('No segments selected. Disabling button if found.');
      if (btn) btn.disabled = true;
      return;
    }

    // If button doesn't exist yet, try to insert it into the Segment Edit panel
    if (!btn) {
      logDebug('Button not found, attempting to insert into Segment Edit panel');
      // Try multiple strategies to find the Segment Edit panel
      let segmentEditPanel = null;

      // Strategy 1: Look for form-group elements (what WME-SIMPLE uses)
      segmentEditPanel = document.querySelector('div.form-group');
      if (segmentEditPanel) logDebug('Found Segment Edit panel via form-group selector');

      // Strategy 2: Look for WME's panel component
      if (!segmentEditPanel) {
        segmentEditPanel = document.querySelector('wz-card, [role="region"]');
        if (segmentEditPanel) logDebug('Found Segment Edit panel via wz-card/region selector');
      }

      // Strategy 3: Look in the main editor area
      if (!segmentEditPanel) {
        const mainEditor = document.querySelector('[class*="edit"], [id*="edit"]');
        if (mainEditor) {
          segmentEditPanel = mainEditor.querySelector('form, div[role="region"]');
          if (segmentEditPanel) logDebug('Found Segment Edit panel in main editor area');
        }
      }

      if (segmentEditPanel) {
        logDebug('Found Segment Edit panel, inserting button');
        const newPanel = createSegmentEditButtonPanel();
        // Check if we already have one
        const existing = segmentEditPanel.querySelector('div.wme-su-segment-edit-panel');
        if (existing) {
          existing.replaceWith(newPanel);
          logDebug('Replaced existing button panel');
        } else {
          segmentEditPanel.prepend(newPanel);
          logDebug('Prepended new button panel');
        }
      } else {
        logDebug('Could not find Segment Edit panel using any strategy');
      }
      return;
    }

    logDebug(`${selection.ids.length} segments selected. Enabling button.`);
    btn.disabled = false;
  }

  /**
   * Loads and registers i18n translations for UI strings
   * @returns {Promise<void>}
   */
  function loadTranslations() {
    return new Promise((resolve) => {
      const translations = {
          en: {
            StraightenUp: 'Straighten Up!',
            StraightenUpTitle: 'Click here to straighten the selected segment(s) by removing geometry nodes and moving junction nodes as needed.',
            common: {
              DoIt: 'Do It',
              From: 'from',
              Help: 'Help',
              No: 'No',
              Note: 'Note',
              NothingMajor: 'Nothing major.',
              To: 'to',
              Warning: 'Warning',
              WhatsNew: "What's new",
              Yes: 'Yes',
            },
            error: {
              ConflictingNames:
                'You selected segments that do not share at least one name in common amongst all the segments and have the conflicting names setting set to error. ' + 'Segments not straightened.',
              LongJnMove:
                'One or more of the junction nodes that were to be moved would have been moved further than 10m and you have the long junction node move setting set to ' +
                'give error. Segments not straightened.',
              MicroDogLegs:
                'One or more of the junctions nodes in the selection have a geonode within 2 meters. This is usually the sign of a micro dog leg (mDL).<br><br>' +
                'You have the setting for possibe micro doglegs set to give error. Segments not straightened.',
              NonContinuous: 'You selected segments that are not all connected and have the non-continuous selected segments setting set to give error. Segments not straightened.',
              TooManySegments: 'You selected too many segments and have the sanity check setting set to give error. Segments not straightened.',
            },
            help: {
              Note01: 'This script uses the action manager, so changes can be undone before saving.',
              Warning01: 'Enabling (Give warning, No warning) any of these settings can cause unexpected results. Use with caution!',
              Step01: 'Select the starting segment.',
              Step02: 'ALT+click the ending segment.',
              Step02note: 'If the segments you wanted to straighten are not all selected, unselect them and start over using CTRL+click to select each segment instead.',
              Step03: 'Click "Straighten up!" button in the sidebar.',
            },
            log: {
              AllNodesStraight: "All junction nodes that would be moved are already considered 'straight'. No junction nodes were moved.",
              EndPoints: 'End points',
              MovingJunctionNode: 'Moving junction node',
              NoSegmentsSelected: 'No segments selected.',
              RemovedGeometryNodes: 'Removed geometry nodes for segment',
              Segment: I18n.t('objects.segment.name'),
              StraighteningSegments: 'Straightening segments',
            },
            prompts: {
              ConflictingNamesConfirm: 'You selected segments that do not share at least one name in common amongst all the segments. Are you sure you wish to continue straightening?',
              LongJnMoveConfirm: 'One or more of the junction nodes that are to be moved would be moved further than 10m. Are you sure you wish to continue straightening?',
              MicroDogLegsConfirm:
                'One or more of the junction nodes in the selection have a geonode within 2 meters. This is usually the sign of a micro dog leg (mDL).<br>' +
                'This geonode could exist on any segment connected to the junction nodes, not just the segments you selected.<br><br>' +
                '<b>You should not continue until you are certain there are no micro dog legs.<b><br><br>' +
                'Are you sure you wish to continue straightening?',
              NonContinuousConfirm: 'You selected segments that do not all connect. Are you sure you wish to continue straightening?',
              SanityCheckConfirm: 'You selected many segments. Are you sure you wish to continue straightening?',
            },
            settings: {
              GiveError: 'Give error',
              GiveWarning: 'Give warning',
              NoWarning: 'No warning',
              ConflictingNames: 'Segments with conflicting names',
              ConflictingNamesTitle: 'Select what to do if the selected segments do not share at least one name among their primary and alternate names (based on name, city and state).',
              LongJnMove: 'Long junction node moves',
              LongJnMoveTitle: 'Select what to do if one or more of the junction nodes would move further than 10m.',
              MicroDogLegs: 'Possible micro doglegs (mDL)',
              MicroDogLegsTitle: 'Select what to do if one or more of the junction nodes in the selection have a geometry node within 2m of itself, which is a possible micro dogleg (mDL).',
              NonContinuousSelection: 'Non-continuous selected segments',
              NonContinuousSelectionTitle: 'Select what to do if the selected segments are not continuous.',
              SanityCheck: 'Sanity check',
              SanityCheckTitle: 'Select what to do if you selected a many segments.',
            },
          },
          ru: {
            StraightenUp: 'Выпрямить сегменты!',
            StraightenUpTitle: 'Нажмите, чтобы выпрямить выбранные сегменты, удалив лишние геометрические точки и переместив узлы перекрёстков в ровную линию.',
            common: {
              DoIt: 'Сделай это',
              From: 'с',
              Help: 'Помощь',
              No: 'Нет',
              Note: 'Примечание',
              NothingMajor: 'Не критично.',
              To: 'до',
              Warning: 'Предупреждение',
              WhatsNew: 'Что нового',
              Yes: 'Да',
            },
            error: {
              ConflictingNames: 'Вы выбрали сегменты, которые не имеют хотя бы одного общего названия улицы среди выделенных.' + 'Сегменты не были выпрямлены.',
              LongJnMove:
                'Для выпрямления сегментов, их узлы должны быть перемещены более чем на 10 м, но в настройках у вас установлено ограничение перемещения на такое большое ' +
                'расстояние. Сегменты не были выпрямлены.',
              MicroDogLegs:
                'Один или несколько узлов выбранных сегментов имеют точку в пределах 2 метров. Обычно это признак “<a href=”https://wazeopedia.waze.com/wiki/Benelux/Junction_Arrows” target=”blank”>микроискривления</a>”.<br><br>' +
                'В настройках для возможных микроискривлений у вас выставлено ограничение, чтобы выдать ошибку. Сегменты не были выпрямлены.',
              NonContinuous: 'Вы выбрали сегменты, которые не соединены между собой, но в настройках у вас установлено ограничение для работы с такими сегментами. Сегменты не были ' + 'выпрямлены.',
              TooManySegments: 'Вы выбрали слишком много сегментов, но в настройках у вас включено ограничение на количество одновременно обрабатываемых сегментов. Сегменты не были ' + 'выпрямлены.',
            },
            help: {
              Note01: 'Этот скрипт использует историю действий, поэтому перед их сохранением изменения можно отменить.',
              Warning01: 'Настройка любого из этих параметров в положение (Выдать предупреждение, Не предупреждать) может привести к неожиданным результатам. Используйте с осторожностью!',
              Step01: 'Выделите начальный сегмент.',
              Step02: 'При помощи Alt-кнопки, выделите конечный сегмент.',
              Step02note: 'Если выделены не все нужные вам сегменты, при помощи Ctrl-кнопки можно дополнительно выделить или снять выделения сегментов.',
              Step03: 'Нажмите ‘Выпрямить сегменты!’ на левой панели.',
            },
            log: {
              AllNodesStraight: 'Все узлы, которые нужно было выпрямить, уже выровнены в линию. Сегменты оставлены без изменений.',
              EndPoints: 'конечные точки',
              MovingJunctionNode: 'Перемещение узла',
              NoSegmentsSelected: 'Сегменты не выделены.',
              RemovedGeometryNodes: 'Удалены лишние точки сегмента',
              Segment: I18n.t('objects.segment.name'),
              StraighteningSegments: 'Выпрямление сегментов',
            },
            prompts: {
              ConflictingNamesConfirm: 'Вы выбрали сегменты, которые не имеют хотя бы одного общего названия среди всех сегментов. Вы уверены, что хотите продолжить выпрямление?',
              LongJnMoveConfirm: 'Один или несколько узлов будут перемещены более, чем на 10 метров. Вы уверены, что хотите продолжить выпрямление?',
              MicroDogLegsConfirm:
                'Один или несколько узлов выбранных сегментов имеют точки в пределах 2 метров. Обычно это признак “<a href=”https://wazeopedia.waze.com/wiki/Benelux/Junction_Arrows” target=”blank”>микроискривления</a>”.<br>' +
                'Такая точка может находиться в любом сегменте, соединенном с выбранными вами сегментами и узлами, а не только на них самих.<br><br>' +
                '<b>Вы не должны продолжать до тех пор, пока не убедитесь, что у вас нет “микроискривлений”.<b><br><br>' +
                'Вы уверены,что готовы продолжать выпрямление?',
              NonContinuousConfirm: 'Вы выбрали сегменты, которые не соединяются друг с другом. Вы уверены, что хотите продолжить выпрямление?',
              SanityCheckConfirm: 'Вы выбрали слишком много сегментов. Вы уверены, что хотите продолжить выпрямление?',
            },
            settings: {
              GiveError: 'Выдать ошибку',
              GiveWarning: 'Выдать предупреждение',
              NoWarning: 'Не предупреждать',
              ConflictingNames: 'Сегменты с разными названиями',
              ConflictingNamesTitle:
                'Выберите, что делать, если выбранные сегменты не содержат хотя бы одно название среди своих основных и альтернативных названий (на основе улицы, ' + 'города и района).',
              LongJnMove: 'Перемещение узлов на большие расстояния',
              LongJnMoveTitle: 'Выберите, что делать, если один или несколько узлов будут перемещаться дальше, чем на 10 метров.',
              MicroDogLegs: 'Допускать “<a href=”https://wazeopedia.waze.com/wiki/Benelux/Junction_Arrows” target=”blank”>микроискривления</a>”',
              MicroDogLegsTitle: 'Выберите, что делать, если один или несколько узлов соединения в выделении имеют точку в пределах 2 м от себя, что является возможным “микроискривлением”.',
              NonContinuous: 'Не соединённые сегменты',
              NonContinuousTitle: 'Выберите, что делать, если выбранные сегменты не соединены друг с другом.',
              SanityCheck: 'Ограничение нагрузки',
              SanityCheckTitle: 'Выберите, что делать, если вы выбрали слишком много сегментов.',
            },
          },
        },
        locale = I18n.currentLocale();
      I18n.translations[locale].wmesu = translations.en;
      translations['en-US'] = { ...translations.en };
      I18n.translations[locale].wmesu = $extend(true, {}, translations.en, translations[locale]);
      resolve();
    });
  }

  /**
   * Starts the script after SDK and WazeWrap initialization
   * Loads settings, registers UI components, shortcuts, and event listeners
   * @async
   */
  async function start() {
    log('Initializing.');
    // Check user rank using SDK
    const userInfo = wmeSdk.State.getUserInfo();
    logDebug('User info:', userInfo);
    if (!userInfo || userInfo.rank < 2) {
      logWarning(`Script requires rank ≥ 2. User rank: ${userInfo?.rank || 'unknown'}`);
      return;
    }
    await loadSettingsFromStorage();
    await loadTranslations();
    const onSelectionChange = function () {
        const setting = this.id.substr(6);
        if (this.value.toLowerCase() !== settings[setting]) {
          settings[setting] = this.value.toLowerCase();
          saveSettingsToStorage();
        }
      },
      // ────────────────────────────────────────────────────────────────────────────────
      // HELPER FUNCTIONS: UI construction for card-based layout
      // ────────────────────────────────────────────────────────────────────────────────

      /**
       * Find Direction section with resilient multi-strategy selector
       * Handles WME UI refactoring by trying multiple selectors
       * @param {Element} [searchContext=document] - Element to search within
       * @returns {Element|null} Direction section element or null if not found
       */
      findDirectionSection = (searchContext = document) => {
        try {
          // Strategy 1: Primary selector (current WME structure)
          let directionEl = searchContext.querySelector('[class*="direction-editor"]');
          if (directionEl) return directionEl;

          // Strategy 2: Alternative class patterns (for future WME versions)
          directionEl = searchContext.querySelector('[class*="direction"]');
          if (directionEl && directionEl.textContent.toLowerCase().includes('two way')) {
            return directionEl;
          }

          // Strategy 3: Find wz-label containing "Direction" text
          const labels = Array.from(searchContext.querySelectorAll('wz-label'));
          for (const label of labels) {
            if (label.textContent.includes('Direction')) {
              // Return the closest containing div (the direction control section)
              return label.closest('div[class*="direction"]') || label.closest('div');
            }
          }

          // Strategy 4: Look for text content pattern (fallback)
          const allDivs = Array.from(searchContext.querySelectorAll('div'));
          for (const div of allDivs) {
            if (div.textContent.includes('Two way') && div.textContent.includes('direction')) {
              return div;
            }
          }

          return null;
        } catch (err) {
          logWarning('Error finding direction section:', err);
          return null;
        }
      },

      /**
       * Creates a card div with an icon header and returns { card, body }
       */
      makeCard = (iconClass, title) => {
        const card = document.createElement('div');
        card.className = 'su-card';
        const cardHeader = document.createElement('div');
        cardHeader.className = 'su-card-header';
        const icon = document.createElement('i');
        icon.className = `fa ${iconClass}`;
        const titleSpan = document.createElement('span');
        titleSpan.textContent = title;
        cardHeader.appendChild(icon);
        cardHeader.appendChild(titleSpan);
        card.appendChild(cardHeader);
        const body = document.createElement('div');
        body.className = 'su-card-body';
        card.appendChild(body);
        return { card, body };
      },

      /**
       * Creates a flex row with a label on left and control on right
       * @param {string} labelText - Label to display
       * @param {Element} control - Control element (select, etc.)
       * @param {string} extraClass - Extra CSS class for row
       * @param {string} tooltipText - Optional tooltip text (shows as info icon)
       */
      makeRow = (labelText, control, extraClass, tooltipText) => {
        const row = document.createElement('div');
        row.className = `su-row${extraClass ? ` ${extraClass}` : ''}`;
        const labelEl = document.createElement('span');
        labelEl.className = 'su-row-label';
        labelEl.textContent = labelText;

        // Add info icon if tooltip provided
        if (tooltipText) {
          const infoIcon = document.createElement('span');
          infoIcon.className = 'su-info-icon';
          infoIcon.setAttribute('data-tooltip', tooltipText);
          labelEl.appendChild(infoIcon);
        }

        row.appendChild(labelEl);
        row.appendChild(control);
        return row;
      },

      /**
       * Creates a <select> element wired to onSelectionChange
       */
      makeSelect = (settingKey) => {
        const select = document.createElement('select');
        select.id = `WMESU-${settingKey}`;
        select.title = I18n.t(`wmesu.settings.${settingKey.charAt(0).toUpperCase()}${settingKey.slice(1)}Title`);

        const docFrags = document.createDocumentFragment();
        docFrags.appendChild(createElem('option', { value: 'nowarning', selected: settings[settingKey] === 'nowarning', textContent: I18n.t('wmesu.settings.NoWarning') }));
        docFrags.appendChild(createElem('option', { value: 'warning', selected: settings[settingKey] === 'warning', textContent: I18n.t('wmesu.settings.GiveWarning') }));
        docFrags.appendChild(createElem('option', { value: 'error', selected: settings[settingKey] === 'error', textContent: I18n.t('wmesu.settings.GiveError') }));
        select.appendChild(docFrags);

        select.addEventListener('change', onSelectionChange);
        return select;
      },

      /**
       * Creates the "WME Straighten Up!" button for insertion into Segment Edit panel
       * Simplified button without card header for better space utilization
       * @returns {HTMLElement} form-group element containing the button
       */
      createSegmentEditButtonPanel = () => {
        const formGroup = document.createElement('div');
        formGroup.className = 'form-group wme-su-segment-edit-panel';
        formGroup.style.marginBottom = '12px';

        // Card with title
        const buttonCard = makeCard('fa-arrows', 'WME Straighten Up!');

        // Buttons container (flex row for side-by-side layout)
        const buttonsContainer = document.createElement('div');
        buttonsContainer.style.display = 'flex';
        buttonsContainer.style.gap = '8px';
        buttonsContainer.style.padding = '10px';

        // "Straighten" button styled as chip
        const straightenBtn = createElem(
          'wz-button',
          {
            id: 'WME-SU-SEGMENT-EDIT',
            color: 'outline',
            size: 'sm',
            style: 'height: 26px;',
            textContent: 'Straighten',
          },
          [{ click: doStraightenSegments }],
        );
        buttonsContainer.appendChild(straightenBtn);

        // "Simplify" button styled as chip
        const simplifyBtn = createElem(
          'wz-button',
          {
            id: 'WME-SU-SIMPLIFY',
            color: 'outline',
            size: 'sm',
            style: 'height: 28px;',
            textContent: 'Simplify',
          },
          [{ click: () => doSimplifySegments(false, settings.simplifyTolerance) }],
        );
        buttonsContainer.appendChild(simplifyBtn);

        buttonCard.body.appendChild(buttonsContainer);
        formGroup.appendChild(buttonCard.card);

        return formGroup;
      },

      tabContent = () => {
        const docFrags = document.createDocumentFragment();
        logDebug('Building sidebar tab content...');

        // ────────────────────────────────────────────────────────────────────────────────
        // CSS: Scoped styles for .wme-su-panel (card layout, flexbox, responsive)
        // ────────────────────────────────────────────────────────────────────────────────
        const style = document.createElement('style');
        style.textContent = [
          '.wme-su-panel { padding: 8px; box-sizing: border-box; }',
          '.wme-su-panel .su-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding: 8px 10px; background: linear-gradient(135deg, #0066cc, #0052a3); color: #fff; border-radius: 8px; }',
          '.wme-su-panel .su-header-left { display: flex; align-items: center; gap: 6px; }',
          '.wme-su-panel .su-header-icon { color: #fff; font-size: 1.2em; }',
          '.wme-su-panel .su-header-name { font-weight: 700; font-size: 13px; color: #fff; }',
          '.wme-su-panel .su-header-version { font-size: 10px; opacity: 0.8; color: #fff; }',
          '.wme-su-panel .su-card { border: 1px solid var(--hairline, #ddd); border-radius: 8px; margin-bottom: 8px; overflow: hidden; }',
          '.wme-su-panel .su-card-header { display: flex; align-items: center; gap: 7px; padding: 7px 10px; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid var(--hairline, #ddd); background: linear-gradient(135deg, #f8f9fa, #f0f1f3); color: #333; }',
          '.wme-su-panel .su-card-header:hover { background: linear-gradient(135deg, #f0f1f3, #e8eaed); }',
          '.wme-su-panel .su-card-header i { color: #0066cc; font-size: 11px; width: 14px; text-align: center; }',
          '.wme-su-panel .su-card-body { padding: 2px 0; }',
          '.wme-su-panel .su-row { display: flex; justify-content: space-between; align-items: center; padding: 5px 10px; min-height: 32px; box-sizing: border-box; }',
          '.wme-su-panel .su-sub-row { padding-left: 22px; }',
          '.wme-su-panel .su-row.disabled { opacity: 0.4; pointer-events: none; }',
          '.wme-su-panel select { font-size: 12px; border: 1px solid var(--hairline, #ccc); border-radius: 4px; padding: 3px 5px; width: 130px; max-width: 130px; box-sizing: border-box; background: var(--background_default, #fff); color: var(--content_default, #333); }',
          '.wme-su-panel input[type="number"] { font-size: 12px; border: 1px solid var(--hairline, #ccc); border-radius: 4px; padding: 3px 5px; width: 52px; text-align: right; box-sizing: border-box; background: var(--background_default, #fff); color: var(--content_default, #333); }',
          '.wme-su-panel .su-button-group { margin-bottom: 8px; }',
          '.wme-su-panel .su-footer { margin-top: 8px; font-size: 11px; }',
          '.wme-su-panel .su-help-list { margin: 0; padding-left: 16px; font-size: 11px; line-height: 1.4; }',
          '.wme-su-panel .su-help-list li { margin-bottom: 2px; }',
          '.wme-su-panel .su-row-label { flex: 1; font-size: 12px; padding-right: 8px; line-height: 1.3; display: flex; align-items: center; }',
          '.wme-su-panel .su-info-icon { display: inline-block; margin-left: 4px; color: #0066cc; font-size: 11px; cursor: help; position: relative; opacity: 0.7; transition: opacity 0.2s; flex-shrink: 0; }',
          '.wme-su-panel .su-info-icon:hover { opacity: 1; }',
          '.wme-su-panel .su-info-icon::before { content: "ⓘ"; }',
          '.wme-su-panel .su-info-icon:hover::after { content: attr(data-tooltip); display: block; position: absolute; bottom: 100%; left: -60px; right: auto; background: #1a1a1a; color: #fff; padding: 6px 8px; border-radius: 4px; font-size: 9px; white-space: normal; width: 130px; z-index: 10000; line-height: 1.3; box-shadow: 0 2px 8px rgba(0,0,0,0.3); font-weight: 400; margin-bottom: 4px; }',
          '.wme-su-panel wz-button[color="outline"] { background-color: #d3d3d3 !important; color: #333 !important; border: none !important; }',
          '.wme-su-panel wz-button[color="outline"]:hover { background-color: #b0b0b0 !important; }',
          '.wme-su-panel wz-button[color="primary"] { background-color: #0066cc !important; color: #fff !important; }',
          '[wz-theme="dark"] .wme-su-panel wz-button[color="outline"] { background-color: #555 !important; color: #ddd !important; }',
          '[wz-theme="dark"] .wme-su-panel wz-button[color="outline"]:hover { background-color: #666 !important; }',
          '[wz-theme="dark"] .wme-su-panel wz-button[color="primary"] { background-color: #0066cc !important; color: #fff !important; }',
          '[wz-theme="dark"] .wme-su-panel .su-header { background: linear-gradient(135deg, #0052a3, #003d7a); }',
          '[wz-theme="dark"] .wme-su-panel .su-card-header { background: linear-gradient(135deg, #2a2c30, #202124); color: #e8eaed; }',
          '[wz-theme="dark"] .wme-su-panel .su-card-header:hover { background: linear-gradient(135deg, #333538, #2a2c30); }',
          '[wz-theme="dark"] .wme-su-panel .su-card-header i { color: #33ccff; }',
        ].join('\n');
        docFrags.appendChild(style);

        // ────────────────────────────────────────────────────────────────────────────────
        // Header: Script name + version
        // ────────────────────────────────────────────────────────────────────────────────
        const header = document.createElement('div');
        header.className = 'su-header';
        const headerLeft = document.createElement('div');
        headerLeft.className = 'su-header-left';
        const headerIcon = document.createElement('i');
        headerIcon.className = 'fa fa-arrows su-header-icon';
        const headerName = document.createElement('span');
        headerName.className = 'su-header-name';
        headerName.textContent = GM_info.script.name;
        headerLeft.appendChild(headerIcon);
        headerLeft.appendChild(headerName);
        const headerVersion = document.createElement('span');
        headerVersion.className = 'su-header-version';
        headerVersion.textContent = `v${SCRIPT_VERSION}`;
        header.appendChild(headerLeft);
        header.appendChild(headerVersion);
        docFrags.appendChild(header);

        // ────────────────────────────────────────────────────────────────────────────────
        // Validation Settings Card
        // (Button now inserted into Segment Edit panel via jQuery segment.wme event)
        // ────────────────────────────────────────────────────────────────────────────────
        const validationCard = makeCard('fa-check-circle', 'Validation Settings');
        validationCard.body.appendChild(
          makeRow(
            I18n.t('wmesu.settings.SanityCheck'),
            makeSelect('sanityCheck'),
            undefined,
            I18n.t('wmesu.settings.SanityCheckTitle'),
          ),
        );
        validationCard.body.appendChild(
          makeRow(
            I18n.t('wmesu.settings.NonContinuousSelection'),
            makeSelect('nonContinuousSelection'),
            undefined,
            I18n.t('wmesu.settings.NonContinuousSelectionTitle'),
          ),
        );
        validationCard.body.appendChild(
          makeRow(
            I18n.t('wmesu.settings.ConflictingNames'),
            makeSelect('conflictingNames'),
            undefined,
            I18n.t('wmesu.settings.ConflictingNamesTitle'),
          ),
        );
        validationCard.body.appendChild(
          makeRow(
            I18n.t('wmesu.settings.MicroDogLegs'),
            makeSelect('microDogLegs'),
            undefined,
            I18n.t('wmesu.settings.MicroDogLegsTitle'),
          ),
        );
        validationCard.body.appendChild(
          makeRow(
            I18n.t('wmesu.settings.LongJnMove'),
            makeSelect('longJnMove'),
            undefined,
            I18n.t('wmesu.settings.LongJnMoveTitle'),
          ),
        );
        docFrags.appendChild(validationCard.card);

        // ────────────────────────────────────────────────────────────────────────────────
        // Simplify Options Card
        // ────────────────────────────────────────────────────────────────────────────────
        const simplifyCard = makeCard('fa-compress', 'Simplify Options');
        const toleranceRow = document.createElement('div');
        toleranceRow.className = 'su-row';
        toleranceRow.style.justifyContent = 'flex-start';
        toleranceRow.style.alignItems = 'center';
        toleranceRow.style.gap = '3px';
        toleranceRow.style.flexWrap = 'nowrap';
        toleranceRow.style.padding = '5px 6px';

        const toleranceLabel = document.createElement('label');
        toleranceLabel.textContent = 'Tol:';
        toleranceLabel.style.fontSize = '10px';
        toleranceLabel.style.fontWeight = '600';
        toleranceLabel.style.whiteSpace = 'nowrap';
        toleranceLabel.style.flexShrink = 0;
        toleranceLabel.style.marginRight = '2px';

        const toleranceChips = document.createElement('div');
        toleranceChips.style.display = 'flex';
        toleranceChips.style.gap = '2px';
        toleranceChips.style.flexWrap = 'nowrap';
        toleranceChips.style.flex = '1';

        const toleranceOptions = [
          { value: 1, label: '1m' },
          { value: 3, label: '3m' },
          { value: 5, label: '5m' },
          { value: 10, label: '10' },
        ];

        // Store button refs for toggling selected state
        const toleranceButtons = {};

        toleranceOptions.forEach((opt) => {
          const isSelected = settings.simplifyTolerance === opt.value;
          const btn = createElem(
            'wz-button',
            {
              id: `WMESU-toleranceBtn-${opt.value}`,
              color: isSelected ? 'primary' : 'outline',
              size: 'xs',
              textContent: opt.label,
              style: 'padding: 1px 4px; font-size: 9px; min-width: 28px;',
            },
            [
              {
                click: () => {
                  // Update all buttons: selected = primary, others = outline
                  toleranceOptions.forEach((o) => {
                    const btn = toleranceButtons[o.value];
                    if (btn) {
                      btn.color = o.value === opt.value ? 'primary' : 'outline';
                    }
                  });
                  settings.simplifyTolerance = opt.value;
                  saveSettingsToStorage();
                  logDebug(`Simplify tolerance changed to ${opt.value}m`);
                },
              },
            ],
          );
          toleranceButtons[opt.value] = btn;
          toleranceChips.appendChild(btn);
        });

        toleranceRow.appendChild(toleranceLabel);
        toleranceRow.appendChild(toleranceChips);
        simplifyCard.body.appendChild(toleranceRow);

        const toleranceHelp = document.createElement('div');
        toleranceHelp.style.fontSize = '10px';
        toleranceHelp.style.color = '#999';
        toleranceHelp.style.padding = '4px 10px 0 10px';
        toleranceHelp.textContent = 'Lower = detail, Higher = aggressive';
        simplifyCard.body.appendChild(toleranceHelp);

        docFrags.appendChild(simplifyCard.card);

        // ────────────────────────────────────────────────────────────────────────────────
        // Help Card (compact version)
        // ────────────────────────────────────────────────────────────────────────────────
        const helpCard = makeCard('fa-question-circle', I18n.t('wmesu.common.Help'));
        const helpList = document.createElement('ul');
        helpList.className = 'su-help-list';
        const li1 = document.createElement('li');
        li1.appendChild(document.createTextNode(I18n.t('wmesu.help.Step01')));
        helpList.appendChild(li1);
        const li2 = document.createElement('li');
        li2.appendChild(document.createTextNode(I18n.t('wmesu.help.Step02')));
        helpList.appendChild(li2);
        const li3 = document.createElement('li');
        li3.appendChild(document.createTextNode(I18n.t('wmesu.help.Step03')));
        helpList.appendChild(li3);
        helpCard.body.appendChild(helpList);
        docFrags.appendChild(helpCard.card);

        return docFrags;
      };
    // Register sidebar tab using SDK
    const { tabLabel, tabPane } = await wmeSdk.Sidebar.registerScriptTab();
    tabLabel.textContent = 'SU!';
    tabLabel.title = GM_info.script.name;
    tabPane.className = 'wme-su-panel';
    tabPane.appendChild(tabContent());
    tabPane.id = 'WMESUSettings';
    logDebug('Enabling MOs.');
    // Listen to selection changes using SDK
    wmeSdk.Events.on({
      eventName: 'wme-selection-changed',
      eventHandler: insertSimplifyStreetGeometryButtons,
    });
    // Check initial selection
    const initialSelection = wmeSdk.Editing.getSelection();
    if (initialSelection && initialSelection.objectType === 'segment' && initialSelection.ids?.length > 0) insertSimplifyStreetGeometryButtons();

    // ────────────────────────────────────────────────────────────────────────────────
    // Register jQuery event handlers for Segment Edit panel button insertion
    // WME fires 'segment.wme' when single segment is selected for editing
    // WME fires 'segments.wme' when multiple segments are selected (not used in current context)
    // ────────────────────────────────────────────────────────────────────────────────

    // Verify dependencies are ready
    if (typeof $ === 'undefined' || typeof jQuery === 'undefined') {
      logError('jQuery NOT available! segment.wme events cannot be registered.');
    } else {
      logDebug(`jQuery v${jQuery.fn.jquery || 'unknown'} available, registering event handlers`);
    }

    // Verify SDK is fully initialized
    if (!wmeSdk?.Editing?.getSelection || !wmeSdk?.DataModel?.Segments) {
      logError('SDK not fully initialized! Some features may not work.');
    } else {
      logDebug('SDK verified and ready');
    }

    // Debug: Log all jQuery events to see what's firing
    if (debug) {
      const originalTrigger = jQuery.fn.trigger;
      jQuery.fn.trigger = function(eventType, ...args) {
        if (typeof eventType === 'string') {
          if (eventType.includes('.wme')) {
            logDebug(`jQuery event TRIGGERED: ${eventType}`);
          } else if (eventType.includes('segment') || eventType.includes('node') || eventType.includes('place')) {
            logDebug(`jQuery event TRIGGERED (non-.wme): ${eventType}`);
          }
        }
        return originalTrigger.call(this, eventType, ...args);
      };
      logDebug('jQuery event trigger monitoring enabled (logging .wme and object-related events)');
    }

    // Listen for segment.wme jQuery events (fallback if WME starts firing them)
    $(document).on('segment.wme', (_event, element, model) => {
      logDebug(`segment.wme fired for segment ${model?.id}`);

      try {
        // Check permissions
        if (!wmeSdk?.DataModel?.Segments?.hasPermissions) {
          logWarning('SDK not ready for permission check');
          return;
        }

        if (!wmeSdk.DataModel.Segments.hasPermissions({ segmentId: model.id })) {
          element.querySelector('div.wme-su-segment-edit-panel')?.remove();
          return;
        }

        const existingPanel = element.querySelector('div.wme-su-segment-edit-panel');
        if (existingPanel) {
          return;
        }

        // Use resilient selector to find Direction section
        const directionSection = findDirectionSection(element);

        if (directionSection) {
          try {
            const panel = createSegmentEditButtonPanel();
            directionSection.insertAdjacentElement('afterend', panel);
          } catch (insertErr) {
            logWarning('Failed to insert after Direction:', insertErr);
            element.prepend(createSegmentEditButtonPanel());
          }
        } else {
          // Fallback to prepending
          element.prepend(createSegmentEditButtonPanel());
        }
      } catch (err) {
        logError('Error in segment.wme handler:', err);
      }
    });

    // Fallback: Use MutationObserver to detect when Segment Edit panel changes
    // (segment.wme jQuery events don't fire in current WME version)
    // With debouncing to prevent excessive DOM operations
    let observerTimeout;
    const observer = new MutationObserver((_mutations) => {
      // Debounce: only run insertion check after DOM mutations settle
      clearTimeout(observerTimeout);
      observerTimeout = setTimeout(() => {
        try {
          // Verify SDK is ready and segments are selected
          if (!wmeSdk?.Editing?.getSelection) {
            return;
          }

          const selection = wmeSdk.Editing.getSelection();
          if (selection?.objectType !== 'segment' || !selection?.ids?.length) {
            return;
          }

          // Check if button already exists
          const existingButton = document.getElementById('WME-SU-SEGMENT-EDIT');
          if (existingButton) {
            return;
          }

          // Try to find Direction section using resilient selector
          const directionSection = findDirectionSection();

          if (directionSection) {
            try {
              // Check if button already in parent context
              if (!directionSection.parentElement.querySelector('div.wme-su-segment-edit-panel')) {
                const panel = createSegmentEditButtonPanel();
                directionSection.insertAdjacentElement('afterend', panel);
                logDebug('Button inserted after Direction section');
              }
            } catch (insertErr) {
              logWarning('Failed to insert after Direction section:', insertErr);
              // Fallback: try attributes form
              const attributesForm = document.querySelector('form.attributes-form');
              if (attributesForm && !attributesForm.querySelector('div.wme-su-segment-edit-panel')) {
                const panel = createSegmentEditButtonPanel();
                attributesForm.prepend(panel);
                logDebug('Button inserted into attributes form (fallback)');
              }
            }
          } else {
            // Direction section not found, try fallback
            const attributesForm = document.querySelector('form.attributes-form');
            if (attributesForm && !attributesForm.querySelector('div.wme-su-segment-edit-panel')) {
              const panel = createSegmentEditButtonPanel();
              attributesForm.prepend(panel);
              logDebug('Button inserted into attributes form (fallback)');
            }
          }
        } catch (err) {
          logError('MutationObserver error:', err);
        }
      }, 100); // Wait 100ms for DOM to settle
    });

    // Only watch segment edit panel if we can find it, otherwise watch body
    const segmentEditPanel = document.querySelector('[id*="segment-edit"]') || document.body;
    observer.observe(segmentEditPanel, { childList: true, subtree: true });
    logDebug('MutationObserver activated with debouncing');

    $(document).on('segments.wme', (_event, element, models) => {
      logDebug(`segments.wme fired for ${models.length} segments`);

      try {
        // Verify SDK methods exist
        if (!wmeSdk?.DataModel?.Segments) {
          logWarning('SDK not ready for segments check');
          return;
        }

        const hasEditableSegments = models.some(model =>
          wmeSdk.DataModel.Segments.isRoadTypeDrivable?.({ roadType: model.roadType }) &&
          wmeSdk.DataModel.Segments.hasPermissions?.({ segmentId: model.id })
        );

        if (!hasEditableSegments) {
          element.querySelector('div.wme-su-segment-edit-panel')?.remove();
          return;
        }

        const existingPanel = element.querySelector('div.wme-su-segment-edit-panel');
        if (existingPanel) {
          return;
        }

        // Use resilient selector to find Direction section
        const directionSection = findDirectionSection(element);

        if (directionSection) {
          try {
            const panel = createSegmentEditButtonPanel();
            directionSection.insertAdjacentElement('afterend', panel);
          } catch (insertErr) {
            logWarning('Failed to insert after Direction:', insertErr);
            element.prepend(createSegmentEditButtonPanel());
          }
        } else {
          // Fallback to prepending
          element.prepend(createSegmentEditButtonPanel());
        }
      } catch (err) {
        logError('Error in segments.wme handler:', err);
      }
    });

    // Save settings and cleanup on page unload
    window.addEventListener('beforeunload', () => {
      try {
        // Stop observing DOM mutations to prevent memory leaks
        if (observer) {
          observer.disconnect();
          logDebug('MutationObserver cleaned up');
        }

        // Remove button elements from DOM
        document.getElementById('WME-SU-SEGMENT-EDIT')?.remove();
        document.querySelectorAll('div.wme-su-segment-edit-panel').forEach(el => el.remove());

        // Clear any pending observer timeouts
        if (observerTimeout) {
          clearTimeout(observerTimeout);
        }

        // Save settings
        saveSettingsToStorage();
        logDebug('Settings saved and cleanup completed on page unload');
      } catch (err) {
        logWarning('Error during cleanup:', err);
      }
    });

    // Register shortcut with SDK - like ZoomShortcuts does, handle duplicate key errors
    try {
      // SDK expects combo format for shortcutKeys
      const shortcutCombo = settings.runStraightenUpShortcut?.combo || null;

      wmeSdk.Shortcuts.createShortcut({
        shortcutId: 'runStraightenUpShortcut',
        shortcutKeys: shortcutCombo, // SDK expects COMBO format
        description: 'Straighten Up',
        callback: () => {
          // Button can be in Segment Edit panel (new) or sidebar (legacy)
          let btn = document.getElementById('WME-SU-SEGMENT-EDIT') || document.getElementById('WME-SU');
          if (btn && !btn.disabled) {
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          } else {
            logWarning('Straighten Up button not found or is disabled');
          }
        },
      });
      logDebug('Shortcut registered with SDK:', shortcutCombo || '(none)');
    } catch (err) {
      // Handle duplicate key conflicts by resetting to null - like ZoomShortcuts does
      if (err.message && err.message.includes('already in use')) {
        logWarning(`Duplicate key detected for runStraightenUpShortcut, resetting: ${err.message}`);
        settings.runStraightenUpShortcut = { raw: null, combo: null };

        // Try to register again with null (no shortcut)
        try {
          wmeSdk.Shortcuts.createShortcut({
            shortcutId: 'runStraightenUpShortcut',
            shortcutKeys: null,
            description: 'Straighten Up',
            callback: () => {
              // Button can be in Segment Edit panel (new) or sidebar (legacy)
              let btn = document.getElementById('WME-SU-SEGMENT-EDIT') || document.getElementById('WME-SU');
              if (btn && !btn.disabled) {
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              } else {
                logWarning('Straighten Up button not found or is disabled');
              }
            },
          });
          logDebug('Successfully registered runStraightenUpShortcut with no shortcut key');
          saveSettingsToStorage(); // Save the reset
        } catch (retryErr) {
          logError(`Failed to register runStraightenUpShortcut even with null keys: ${retryErr.message}`);
        }
      } else {
        logError('Failed to register shortcut:', err);
      }
    }

    showScriptInfoAlert();
    log(`Fully initialized in ${Math.round(performance.now() - LOAD_BEGIN_TIME)} ms.`);
  }

  /**
   * Bootstrap script using WME-Utils Bootstrapper
   * Initializes SDK, WazeWrap, and starts main initialization
   * @async
   */
  async function initScript() {
    wmeSdk = await bootstrap({
      scriptId: SETTINGS_STORE_NAME,
      useWazeWrap: true,
      scriptUpdateMonitor: {
        downloadUrl: DOWNLOAD_URL,
      },
    });
    await start();
  }

  initScript();
})();
