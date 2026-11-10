'use strict';

const ID = /^[1-9]\d{0,24}$/;
function readId(value) {
  if (typeof value === 'string' && ID.test(value)) return value;
  if (Number.isSafeInteger(value) && value > 0 && ID.test(String(value))) return String(value);
  return '';
}

function validCatalog(data, seriesId) {
  if (!readId(seriesId) || readId(data?.series_id) !== seriesId || !Array.isArray(data.episodes) || !data.episodes.length) return false;
  const indices = new Set(), ids = new Set();
  for (const episode of data.episodes) {
    const id = readId(episode?.vid), index = Number(episode?.vid_index);
    if (!id || !Number.isInteger(index) || index < 1 || index > 100000 || indices.has(index) || ids.has(id)) return false;
    indices.add(index); ids.add(id);
  }
  return true;
}

module.exports = { readId, validCatalog };
