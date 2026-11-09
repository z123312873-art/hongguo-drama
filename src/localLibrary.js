const STORAGE_KEY = 'hongguo:public-library:v1';
const CHANGE_EVENT = 'hongguo:public-library-changed';
const CATEGORIES = ['real', 'ai', 'comic'];
const category = value => CATEGORIES.includes(value) ? value : '';

export const validPublishedAt = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && !Number.isNaN(new Date(value).getTime());
const usableOnlineTime = value => value == null ? null : validPublishedAt(value) ? value : null;
// The account a favorite was last confirmed in; null when it lives only on this computer.
const cloudUser = value => typeof value === 'string' && /^\d{1,30}$/.test(value) ? value : null;
const stored = item => ({ id: item.id, title: item.title, published_at: item.published_at, favorite: item.favorite, favorited_at: validPublishedAt(item.favorited_at) ? item.favorited_at : null, cover: item.cover || '', online_time: usableOnlineTime(item.online_time), cloud_user: cloudUser(item.cloud_user), category: category(item.category) });

export function readLocalLibrary() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items) || items.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' || typeof item.favorite !== 'boolean' || (item.published_at !== null && !validPublishedAt(item.published_at)) || (item.favorited_at != null && !validPublishedAt(item.favorited_at)))) {
      throw new Error('保存的数据格式不正确');
    }
    return { items: items.map(item => ({ ...item, online_time: usableOnlineTime(item.online_time), cloud_user: cloudUser(item.cloud_user), category: category(item.category) })), error: '' };
  } catch (error) {
    return { items: [], error: `无法读取本机收藏与日历：${error.message}。原有数据未改动。` };
  }
}

export function saveLocalSeries({ id, title, published_at, favorite, cover, online_time, category: kind }) {
  const current = readLocalLibrary();
  if (current.error) return current;
  const seriesId = String(id || '').trim();
  if (!seriesId || !String(title || '').trim()) return { ...current, error: '缺少剧集名称或编号，无法保存到本机。' };
  const previous = current.items.find(item => item.id === seriesId);
  const nextFavorite = typeof favorite === 'boolean' ? favorite : previous?.favorite ?? false;
  const favoritedAt = nextFavorite
    ? (previous?.favorite && validPublishedAt(previous.favorited_at) ? previous.favorited_at : Date.now())
    : null;
  const next = {
    id: seriesId,
    title: String(title).trim(),
    published_at: validPublishedAt(published_at) ? published_at : previous?.published_at ?? null,
    favorite: nextFavorite,
    favorited_at: favoritedAt,
    cover: typeof cover === 'string' && /^https?:\/\//i.test(cover) ? cover : previous?.cover || '',
    online_time: validPublishedAt(online_time) ? online_time : online_time === null ? null : usableOnlineTime(previous?.online_time),
    cloud_user: cloudUser(previous?.cloud_user),
    category: category(kind) || category(previous?.category),
  };
  const items = [...current.items.filter(item => item.id !== seriesId), next];
  try {
    // Persist public metadata and the heart-click time, never reviews.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.map(stored)));
    window.dispatchEvent(new Event(CHANGE_EVENT));
    return { items, error: '' };
  } catch (error) {
    return { ...current, error: `未能保存到本机：${error.message}。请释放存储空间后重试。` };
  }
}

export function removeLocalSeries(id) {
  const current = readLocalLibrary();
  if (current.error) return current;
  const items = current.items.filter(item => item.id !== id);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    window.dispatchEvent(new Event(CHANGE_EVENT));
    return { items, error: '' };
  } catch (error) {
    return { ...current, error: `未能移除本机记录：${error.message}。原有记录未改动。` };
  }
}

// Writes a whole list computed from the account (same checks as reading it back).
export function replaceLocalLibrary(items) {
  const current = readLocalLibrary();
  if (current.error) return current;
  try {
    const next = items.map(stored);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    const check = readLocalLibrary();
    if (check.error) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current.items.map(stored)));
      return { ...current, error: '手机收藏的资料不完整，没有写入这台电脑。' };
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
    return check;
  } catch (error) {
    return { ...current, error: `未能保存到本机：${error.message}。请释放存储空间后重试。` };
  }
}

export function subscribeLocalLibrary(callback) {
  const refresh = event => {
    if (event.type === 'storage' && event.key !== STORAGE_KEY && event.key !== null) return;
    callback(readLocalLibrary());
  };
  window.addEventListener(CHANGE_EVENT, refresh);
  window.addEventListener('storage', refresh);
  return () => {
    window.removeEventListener(CHANGE_EVENT, refresh);
    window.removeEventListener('storage', refresh);
  };
}

export function publicDateKey(timestamp) {
  if (!validPublishedAt(timestamp)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp);
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
