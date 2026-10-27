const dns = require('node:dns');
const https = require('node:https');

// Direct mode ignores a local filter's HTTP proxy. AdGuard and similar tools
// often point the system proxy or DNS at themselves even when one app is excluded.
let direct = false;
const cache = new Map();
const OFFICIAL = /(^|\.)((?:fqnovel|snssdk|hongguoduanju|qznovelvod|fqnovelvod|douyinvod)\.com)$/i;

function setDirectConnect(value) {
  direct = value !== false;
}

function filteredAddress(address) {
  return address === '0.0.0.0'
    || address.startsWith('127.')
    || /^198\.(18|19)\./.test(address)
    || /^10\./.test(address)
    || /^192\.168\./.test(address)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(address);
}

function resolveThroughPublicDns(hostname) {
  const hit = cache.get(hostname);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.addresses);
  return new Promise((resolve, reject) => {
    const request = https.get(`https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { Accept: 'application/dns-json' }, timeout: 4000,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          const rows = (data.Answer || []).filter(item => item.type === 1 && typeof item.data === 'string' && !filteredAddress(item.data));
          if (response.statusCode !== 200 || !rows.length) throw new Error('empty');
          const addresses = rows.map(item => ({ address: item.data, family: 4 }));
          cache.set(hostname, { addresses, expires: Date.now() + 60 * 1000 });
          resolve(addresses);
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('timeout')));
  });
}

function lookupPastFilter(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const settings = typeof options === 'number' ? { family: options } : options || {};
  dns.lookup(hostname, { all: true, family: 4 }, (error, addresses) => {
    const hijacked = Boolean(error) || !addresses?.length || addresses.every(item => filteredAddress(item.address));
    if (direct && hijacked && OFFICIAL.test(hostname)) {
      resolveThroughPublicDns(hostname).then(list => {
        if (settings.all) callback(null, list);
        else callback(null, list[0].address, 4);
      }, () => callback(error || new Error('域名解析失败')));
      return;
    }
    if (error) return callback(error);
    if (settings.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family || 4);
  });
}

function directAxiosOptions() {
  return direct ? { proxy: false, lookup: lookupPastFilter } : {};
}

module.exports = { setDirectConnect, directAxiosOptions, lookupPastFilter, filteredAddress };
