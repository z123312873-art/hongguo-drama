// CJS tests and the main process load the ESM module. The renderer imports the
// .mjs file directly so the packaged window never calls Node require().
module.exports = require('./next-season.mjs');
