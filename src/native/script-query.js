// Main-process entry. The renderer imports chineseScript.mjs directly so Vite
// does not leave a Node require() call in the sandboxed window.
const { toSimplified, canonicalTitle } = require('../chineseScript.mjs');

module.exports = { toSimplified, canonicalTitle };
