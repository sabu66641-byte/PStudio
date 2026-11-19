/* Archived experimental rules.
 * This file is intentionally NOT loaded by PStudio and is NOT part of PStudio Core.
 * Preserved for reference only; do not import or register these rules in the default runtime.
 */
(() => {
  'use strict';

  const states = new Map();

  function applyStatus(targetId, status, duration = 8) {
    states.set(String(targetId), {
      status: String(status).toLowerCase(),
      expires: Date.now() + Math.max(0, Number(duration) || 0) * 1000
    });
  }

  function resolvePair(previous, next) {
    const pair = [previous, next].sort().join('|');
    const rules = {
      'hydro|pyro': ['vaporize', 1.5],
      'cryo|pyro': ['melt', 1.5],
      'dendro|pyro': ['burning', 1.2],
      'electro|hydro': ['electro-charged', 1.2],
      'cryo|electro': ['superconduct', 1.2],
      'cryo|hydro': ['freeze', 1.0],
      'dendro|hydro': ['bloom', 1.2],
      'dendro|electro': ['quicken', 1.25]
    };
    return rules[pair] || ['', 1];
  }

  window.PStudioArchivedExperimentalRules = Object.freeze({
    applyStatus,
    resolvePair
  });
})();
