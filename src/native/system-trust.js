


function trustSystemCertificates(tls = require('node:tls')) {
  if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return { applied: false, reason: 'unsupported' };
  try {
    const system = tls.getCACertificates('system');
    if (!Array.isArray(system) || !system.length) return { applied: false, reason: 'empty' };
    const merged = [...new Set([...tls.getCACertificates('default'), ...system].filter(item => typeof item === 'string' && item))];
    tls.setDefaultCACertificates(merged);
    return { applied: true, count: merged.length };
  } catch (_) {
    return { applied: false, reason: 'error' };
  }
}

module.exports = { trustSystemCertificates };
