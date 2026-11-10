'use strict';

const { readId } = require('./cloud-favorites');
const LIST_PATH = '/reading/distribution/bookshelf_folder/list/v1/';
const DETAIL_PATH = '/reading/distribution/bookshelf_folder/detail/v1/';
const invalid = () => new Error('收藏夾暫時無法完整讀取');

function payload(response) {
  if (String(response?.code) !== '0' || !response.data || typeof response.data.has_more !== 'boolean') throw invalid();
  return response.data;
}

function folderItems(items) {
  if (!Array.isArray(items) || items.length > 10000) throw invalid();
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') throw invalid();
    if (Number(item.book_type) !== 2) continue;
    const id = readId(item.item_id);
    if (!id) throw invalid();
    ids.add(id);
  }
  return [...ids];
}

async function readFolderItems(request, folder) {
  const id = readId(folder.folder_id);
  const count = Number(folder.item_count);
  if (!id || !Number.isSafeInteger(count) || count < 0 || count > 10000 || typeof folder.folder_name !== 'string' || !folder.folder_name.trim()) throw invalid();
  const items = folder.items === undefined ? [] : folder.items;
  const preview = folderItems(items);
  if (items.length > count) throw invalid();
  if (items.length === count) return { id, name: folder.folder_name, itemIds: preview };
  const ids = new Set(), seen = new Set();
  for (let offset = 0, page = 0; page < 200; page++) {
    const body = `{"folder_id":${id},"offset":${offset},"limit":50,"target_id":"","has_detail":true}`;
    const data = payload(await request('POST', DETAIL_PATH, {}, body));
    if (readId(data.folder_id) !== id) throw invalid();
    const rows = folderItems(data.items);
    for (const item of data.items) {
      const key = `${item.book_type}:${item.item_id}`;
      if (seen.has(key)) throw invalid();
      seen.add(key);
    }
    rows.forEach(value => ids.add(value));
    if (!data.has_more && offset + data.items.length < Number(data.item_count ?? count)) throw invalid();
    if (!data.has_more) return { id, name: String(data.folder_name || folder.folder_name), itemIds: [...ids] };
    if (!data.items.length) throw invalid();
    offset += data.items.length;
  }
  throw invalid();
}

async function fetchFolders(request) {
  const folders = new Map();
  for (let offset = 0, page = 0; page < 200; page++) {
    const data = payload(await request('POST', LIST_PATH, {}, { offset, count: 50, preview_items_limit: 50, target_id: '', has_detail: true }));
    if (!Array.isArray(data.folders) || data.folders.length > 1000) throw invalid();
    for (const row of data.folders) {
      const folder = await readFolderItems(request, row);
      if (folders.has(folder.id)) throw invalid();
      folders.set(folder.id, folder);
    }
    if (!data.has_more && Number(data.folder_count) > folders.size) throw invalid();
    if (!data.has_more) return [...folders.values()];
    if (!data.folders.length) throw invalid();
    offset += data.folders.length;
  }
  throw invalid();
}

module.exports = { fetchFolders, folderItems, LIST_PATH, DETAIL_PATH };
