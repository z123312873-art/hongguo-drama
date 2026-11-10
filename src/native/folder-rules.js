const MAX_NAME_LENGTH = 15;
const messages = {
  NAME_EMPTY: '請輸入收藏夾名稱。',
  NAME_LONG: `收藏夾名稱最多 ${MAX_NAME_LENGTH} 個字。`,
  NAME_INVALID: '收藏夾名稱不能含換行或控制字元。',
  NAME_DUPLICATE: '已有同名收藏夾，請換個名稱。',
  FOLDER_CHANGED: '手機上的收藏夾已有變動，請重新整理後再操作。',
  FOLDER_GONE: '這個收藏夾已不在手機上，請重新整理。',
  FOLDER_UNREADABLE: '收藏夾暫時無法完整讀取，已保留原有資料。請稍後重試。',
  FOLDER_UNCONFIRMED: '操作已送出，但尚未確認完成。請先重新整理，不要重複操作。',
  FOLDER_CONFIRM: '請先確認是否刪除這個收藏夾。',
  FOLDER_ITEM: '請先將這部劇加入手機收藏並完成同步。',
  FOLDER_BUSY: '收藏夾正在更新，請稍候。',
  FOLDER_ACCOUNT: '帳號已變更或登入已過期，請重新登入後再操作。',
  FOLDER_INPUT: '無法完成這項收藏夾操作，請重新整理後重試。',
  FOLDER_SIDE_EFFECT: '手機收藏也有變動，請重新整理確認；不會自動覆寫手機資料。',
};
function folderError(code) {
  return Object.assign(new Error(messages[code] || messages.FOLDER_UNREADABLE), { code });
}
function nameKey(value) {
  return String(value).trim().normalize('NFKC').toLocaleLowerCase('zh-TW');
}
function validateName(value, folders = [], exceptId = '') {
  if (typeof value !== 'string') throw folderError('NAME_EMPTY');
  const name = value.trim();
  if (!/[^\s\u200B-\u200D\uFEFF]/u.test(name)) throw folderError('NAME_EMPTY');
  if (/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(name)) throw folderError('NAME_INVALID');
  if (Array.from(name).some(char => char.length === 1 && char.charCodeAt(0) >= 0xD800 && char.charCodeAt(0) <= 0xDFFF)) throw folderError('NAME_INVALID');
  if (name.length > MAX_NAME_LENGTH) throw folderError('NAME_LONG');
  if (folders.some(folder => folder.id !== exceptId && nameKey(folder.name) === nameKey(name))) throw folderError('NAME_DUPLICATE');
  return name;
}
function publicError(error) {
  return messages[error?.code] || messages.FOLDER_UNREADABLE;
}
module.exports = { MAX_NAME_LENGTH, validateName, nameKey, folderError, publicError };
