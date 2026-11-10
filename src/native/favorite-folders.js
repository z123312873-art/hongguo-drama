const crypto = require('node:crypto');
const { readId } = require('./cloud-favorites');
const { validateName, folderError } = require('./folder-rules');
const LIST_PATH = '/reading/distribution/bookshelf_folder/list/v1/';
const DETAIL_PATH = '/reading/distribution/bookshelf_folder/detail/v1/';
const UPDATE_PATH = '/reading/distribution/bookshelf_folder/update/v1/';
const ITEM_PATH = '/reading/distribution/bookshelf_folder/item/update/v1/';
const FAVORITES_PATH = '/reading/bookapi/bookshelf/video/list/v';
const invalid = () => folderError('FOLDER_UNREADABLE');

function payload(response) {
  if (String(response?.code) !== '0' || !response.data || typeof response.data.has_more !== 'boolean') throw invalid();
  return response.data;
}
function members(items) {
  if (!Array.isArray(items) || items.length > 10000) throw invalid();
  const seen = new Set();
  return items.map(item => {
    const id = readId(item?.item_id), bookType = Number(item?.book_type);
    if (!id || !Number.isSafeInteger(bookType) || bookType < 0) throw invalid();
    const key = `${bookType}:${id}`;
    if (seen.has(key)) throw invalid();
    seen.add(key);
    const contentType = Number(item.content_type);
    return { id, bookType, contentType: Number.isSafeInteger(contentType) && contentType > 0 ? contentType : 1 };
  });
}
function folderItems(items) {
  return members(items).filter(item => item.bookType === 2).map(item => item.id);
}
function record(folder, entries, count) {
  const id = readId(folder.folder_id), name = folder.folder_name;
  if (!id || typeof name !== 'string' || !name.trim()) throw invalid();
  const isPublish = typeof folder.is_publish === 'boolean' ? folder.is_publish : null;
  const sorted = [...entries].sort((a, b) => `${a.bookType}:${a.id}`.localeCompare(`${b.bookType}:${b.id}`));
  const revision = crypto.createHash('sha256').update(JSON.stringify([id, name, isPublish, count, sorted])).digest('hex');
  return { id, name, itemCount: count, isPublish, revision, members: entries, itemIds: entries.filter(item => item.bookType === 2).map(item => item.id) };
}
function publicFolder(folder) {
  const { members: _members, ...value } = folder;
  return value;
}
async function readFolderItems(request, folder) {
  const id = readId(folder.folder_id), count = Number(folder.item_count);
  if (!id || !Number.isSafeInteger(count) || count < 0 || count > 10000) throw invalid();
  const preview = members(folder.items === undefined ? [] : folder.items);
  if (preview.length > count) throw invalid();
  if (preview.length === count) return record(folder, preview, count);
  const entries = [], seen = new Set();
  let latest = folder;
  for (let offset = 0, page = 0; page < 200; page++) {
    const body = `{"folder_id":${id},"offset":${offset},"limit":50,"target_id":"","has_detail":true}`;
    const data = payload(await request('POST', DETAIL_PATH, {}, body));
    if (readId(data.folder_id) !== id || Number(data.item_count ?? count) !== count) throw invalid();
    const rows = members(data.items);
    for (const item of rows) {
      const key = `${item.bookType}:${item.id}`;
      if (seen.has(key)) throw invalid();
      seen.add(key);
      entries.push(item);
    }
    latest = { ...folder, ...data };
    if (entries.length > count) throw invalid();
    if (!data.has_more) {
      if (entries.length !== count) throw invalid();
      return record(latest, entries, count);
    }
    if (!rows.length) throw invalid();
    offset += rows.length;
  }
  throw invalid();
}
async function fetchRecords(request) {
  const folders = new Map();
  for (let offset = 0, page = 0; page < 200; page++) {
    const data = payload(await request('POST', LIST_PATH, {}, { offset, count: 50, preview_items_limit: 50, target_id: '', has_detail: true }));
    if (!Array.isArray(data.folders) || data.folders.length > 1000) throw invalid();
    for (const row of data.folders) {
      const folder = await readFolderItems(request, row);
      if (folders.has(folder.id)) throw invalid();
      folders.set(folder.id, folder);
    }
    if (!data.has_more) {
      if (!Number.isSafeInteger(Number(data.folder_count)) || Number(data.folder_count) !== folders.size) throw invalid();
      return [...folders.values()];
    }
    if (!data.folders.length) throw invalid();
    offset += data.folders.length;
  }
  throw invalid();
}
async function fetchFolders(request) {
  return (await fetchRecords(request)).map(publicFolder);
}
async function favoriteRows(request, userId) {
  const response = await request('GET', FAVORITES_PATH, { target_user_id: userId });
  if (String(response?.code) !== '0' || !Array.isArray(response.data?.video_shelf_info) || response.data.has_more === true) throw invalid();
  const rows = response.data.video_shelf_info;
  if (rows.length > 10000) throw invalid();
  const seen = new Set();
  return rows.map(row => {
    const id = readId(row?.series_id) || readId(row?.book_id) || readId(row?.series_id_str) || readId(row?.book_id_str);
    if (!id || seen.has(id)) throw invalid();
    seen.add(id);
    const contentType = Number(row.content_type);
    return { id, contentType: Number.isSafeInteger(contentType) && contentType > 0 ? contentType : 1 };
  });
}
async function changeFolder(request, input, { now = () => Date.now() } = {}) {
  const operation = input?.operation;
  if (!['create', 'rename', 'delete', 'add', 'remove'].includes(operation)) throw folderError('FOLDER_INPUT');
  if (operation === 'delete' && input.confirmed !== true) throw folderError('FOLDER_CONFIRM');
  const requestedName = ['create', 'rename'].includes(operation) ? validateName(input.name) : '';
  const before = await fetchRecords(request);
  let folder, name = requestedName;
  if (operation !== 'create') {
    const id = readId(input.folderId);
    folder = before.find(item => item.id === id);
    if (!folder) throw folderError('FOLDER_GONE');
    if (typeof input.revision !== 'string' || input.revision !== folder.revision) throw folderError('FOLDER_CHANGED');
    if (typeof folder.isPublish !== 'boolean') throw invalid();
  }
  if (requestedName) name = validateName(requestedName, before, folder?.id);
  const itemId = ['add', 'remove'].includes(operation) ? readId(input.itemId) : '';
  if (['add', 'remove'].includes(operation) && !itemId) throw folderError('FOLDER_ITEM');
  let favoritesBefore, contentType = 1;
  if (['add', 'remove'].includes(operation)) {
    const member = folder.members.find(item => item.bookType === 2 && item.id === itemId);
    if ((operation === 'add' && member) || (operation === 'remove' && !member)) return { folders: before.map(publicFolder), folderId: folder.id, unchanged: true };
    favoritesBefore = await favoriteRows(request, input.userId);
    const favorite = favoritesBefore.find(item => item.id === itemId);
    if (operation === 'add' && !favorite) throw folderError('FOLDER_ITEM');
    contentType = operation === 'remove' ? member.contentType : favorite.contentType;
  }
  if (operation === 'delete') favoritesBefore = await favoriteRows(request, input.userId);
  if (operation === 'rename' && name === folder.name) return { folders: before.map(publicFolder), folderId: folder.id, unchanged: true };
  let path, body;
  if (['create', 'rename', 'delete'].includes(operation)) {
    const type = { create: 1, rename: 3, delete: 2 }[operation];
    const named = operation === 'delete' ? '' : `,"folder_name":${JSON.stringify(name)}`;
    const published = operation === 'create' ? false : folder.isPublish;
    path = UPDATE_PATH;
    body = `{"operate_data":[{"operate_type":${type},"folder_id":${folder?.id || '0'}${named},"modify_time":0,"is_publish":${published}}]}`;
  } else {
    path = ITEM_PATH;
    body = `{"operators":[{"operate_type":${operation === 'add' ? 1 : 2},"item_id":${JSON.stringify(itemId)},"folder_id":${folder.id},"book_type":2,"content_type":${contentType},"origin_folder_id":0,"modify_time":${now()}}]}`;
  }
  let sent = false;
  try {
    sent = true;
    const response = await request('POST', path, {}, body);
    if (String(response?.code) !== '0' || !response.data || typeof response.data !== 'object') throw folderError('FOLDER_UNCONFIRMED');
    const after = await fetchRecords(request);
    let target = after.find(item => item.id === folder?.id);
    if (operation === 'create') {
      const added = after.filter(item => item.name === name && !before.some(old => old.id === item.id));
      if (added.length !== 1) throw folderError('FOLDER_UNCONFIRMED');
      target = added[0];
    }
    if (operation === 'delete' ? !!target : !target) throw folderError('FOLDER_UNCONFIRMED');
    if (operation === 'rename' && target.name !== name) throw folderError('FOLDER_UNCONFIRMED');
    if (operation === 'add' && !target.itemIds.includes(itemId)) throw folderError('FOLDER_UNCONFIRMED');
    if (operation === 'remove' && target.itemIds.includes(itemId)) throw folderError('FOLDER_UNCONFIRMED');
    if (favoritesBefore) {
      const favoritesAfter = await favoriteRows(request, input.userId);
      const oldIds = favoritesBefore.map(item => item.id).sort(), newIds = favoritesAfter.map(item => item.id).sort();
      if (JSON.stringify(oldIds) !== JSON.stringify(newIds)) throw folderError('FOLDER_SIDE_EFFECT');
    }
    return { folders: after.map(publicFolder), folderId: target?.id || folder.id, deletedId: operation === 'delete' ? folder.id : '' };
  } catch (error) {
    if (error.code === 'FOLDER_ACCOUNT') throw error;
    const result = error.code === 'FOLDER_SIDE_EFFECT' ? error : folderError('FOLDER_UNCONFIRMED');
    result.uncertain = sent;
    throw result;
  }
}
module.exports = { fetchFolders, folderItems, changeFolder, LIST_PATH, DETAIL_PATH, UPDATE_PATH, ITEM_PATH };
