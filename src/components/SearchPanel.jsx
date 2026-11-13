import React, { useState, useRef, useEffect } from 'react';
import './HongguoDownload.css';
import { Search, RefreshCw, ExternalLink } from './icons';
import { isSubmitKey } from './episodeRange';
import { readSearchHistory, saveSearchTerm, removeSearchTerm, clearSearchHistory, rememberCatalogTitles, getSearchSuggestions } from '../searchHistory';

import useMediaSources from './useMediaSources';
import { mediaSourceLabel } from './mediaSourcesModel.mjs';
import { canonicalTitle } from '../chineseScript.mjs';
import CoverImage from './CoverImage';

export function rankSearchResults(results, keyword) {
  const normalize = value => typeof canonicalTitle === 'function'
    ? canonicalTitle(value)
    : String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const query = normalize(keyword), seen = new Set();
  return results.filter(item => {
    const key = `${item.source}:${item.series_id}`;
    if (!item.series_id || !item.series_title || seen.has(key)) return false;
    seen.add(key); return true;
  }).map(item => {
    const title = normalize(item.series_title);
    return { ...item, relevance: title === query ? 0 : title.includes(query) ? 1 : 2 };
  }).sort((a, b) => a.relevance - b.relevance);
}





const DEFAULT_SOURCE = 'hongguo';
const ALL_SOURCES = 'all';
const AUTO_PAGES = 4;
const MANUAL_PAGES = 5;
const LAST_PAGE = 50;
const RESULT_LIMIT = 1000;
const EAGER_COVERS = 24;
const IDLE_PAGER = { next: [], loading: false, error: '' };

function followingPage(response, source, page) {
  if (response?.hasMore !== true || page >= LAST_PAGE) return null;
  const next = Number(response.nextPage);
  return { source, page: Number.isInteger(next) && next > page ? Math.min(next, LAST_PAGE) : page + 1 };
}

function SearchPanel({ onSelectSeries, onSelectStart, onSwitchToInput, active = true }) {
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const { sources: mediaSources, revision: sourceRevision, loading: sourcesLoading, error: sourcesError } = useMediaSources();
  const requestVersion = useRef(0);
  const pendingSearch = useRef(null);
  useEffect(() => () => { requestVersion.current++; }, []);
  const [keyword, setKeyword] = useState('');
  const [history, setHistory] = useState(readSearchHistory);
  const [historyError, setHistoryError] = useState('');
  const inputRef = useRef(null);
  const suggestWrapRef = useRef(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const suggestions = getSearchSuggestions(keyword, history);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const [searchWarning, setSearchWarning] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [pickingId, setPickingId] = useState('');
  const [pager, setPager] = useState(IDLE_PAGER);

  useEffect(() => {
    if (!active) {
      setPager(current => current.loading ? { ...current, loading: false } : current);
      requestVersion.current++;
      pendingSearch.current = null;
      setPickingId('');
      setLoading(false);
      setSuggestOpen(false);
    }
  }, [active]);

  useEffect(() => {
    if (!suggestOpen) return undefined;
    const close = (event) => {
      const target = event.target;
      if (target && suggestWrapRef.current?.contains?.(target)) return;
      setSuggestOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setSuggestOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [suggestOpen]);

  useEffect(() => {
    requestVersion.current++; pendingSearch.current = null;
    setLoading(false); setPickingId(''); setResults(null); setError(''); setSearchWarning(''); setPageTitle(''); setPager(IDLE_PAGER);
    if (source !== ALL_SOURCES && !mediaSources.some(item => item.id === source)) setSource(ALL_SOURCES);
  }, [sourceRevision, mediaSources]);

  const switchSource = (next) => {
    if (next === source) return;
    requestVersion.current++;
    pendingSearch.current = null;
    setSource(next);
    setLoading(false);
    setPickingId('');
    setResults(null);
    setError('');
    setSearchWarning('');
    setPageTitle('');
    setPager(IDLE_PAGER);
  };

  const changeKeyword = (value) => {
    requestVersion.current++;
    pendingSearch.current = null;
    setKeyword(value);
    setLoading(false);
    setPickingId('');
    setResults(null);
    setError('');
    setSearchWarning('');
    setPager(IDLE_PAGER);
  };

  const clearHistory = () => {
    try {
      clearSearchHistory();
      setHistory([]);
      setHistoryError('');
    } catch {
      setHistoryError('搜索历史清除失败，请重试。');
    }
  };

  const removeHistory = (term) => {
    try {
      setHistory(removeSearchTerm(term));
      setHistoryError('');
    } catch {
      setHistoryError('这条搜索历史删除失败，请重试。');
    }
  };

  const loadPages = async (request, kw, queue, budget, shown) => {
    let merged = shown, next = queue, failure = '';
    setPager({ next, loading: true, error: '' });
    while (next.length && budget > 0 && merged.length < RESULT_LIMIT) {
      const [{ source: pageSource, page }, ...rest] = next;
      let response;
      try { response = await window.electronAPI.searchSeries(kw, { source: pageSource, page }); }
      catch (failed) { response = { success: false, error: failed?.message }; }
      if (request !== requestVersion.current) return;
      if (!response?.success) { failure = `${mediaSourceLabel(pageSource, mediaSources)}：${response?.error || '载入失败，请重试'}`; break; }
      const rows = (response.results || []).map(item => ({ ...item, source: pageSource }));
      const ranked = rankSearchResults([...merged, ...rows], kw);
      const following = ranked.length > merged.length ? followingPage(response, pageSource, page) : null;
      next = following ? [...rest, following] : rest;
      budget -= 1;
      if (ranked.length > merged.length) {
        merged = ranked;
        rememberCatalogTitles(rows);
        setResults(merged);
      }
      setPager({ next, loading: true, error: '' });
    }
    setPager({ next: merged.length < RESULT_LIMIT ? next : [], loading: false, error: failure });
  };

  const loadMore = () => {
    if (pager.loading || loading || !pager.next.length || !results) return;
    loadPages(requestVersion.current, keyword.trim(), pager.next, MANUAL_PAGES, results);
  };

  const doSearch = async () => {
    if (sourcesLoading) return;
    const kw = keyword.trim();
    setSuggestOpen(false);
    if (!kw) {
      setError('请输入剧名关键词');
      return;
    }
    const key = JSON.stringify([source, kw]);
    if (pendingSearch.current?.key === key) return;
    const request = ++requestVersion.current;
    pendingSearch.current = { key, request };
    setPickingId('');
    setLoading(true);
    setError('');
    setSearchWarning('');
    setResults(null);
    setPageTitle('');
    setPager(IDLE_PAGER);
    try {
      const sources = source === ALL_SOURCES ? mediaSources.map(item => item.id) : [source];
      const responses = await Promise.allSettled(sources.map(async (searchSource) => {
        const res = await window.electronAPI.searchSeries(kw, { source: searchSource });
        if (!res?.success) throw new Error(res?.error || '搜索失败，请重试');
        return res;
      }));
      if (request !== requestVersion.current) return;
      const merged = [], failures = [], warnings = [], queue = [];
      responses.forEach((response, index) => {
        const searchSource = sources[index];
        if (response.status === 'fulfilled') {
          merged.push(...(response.value.results || []).map(item => ({ ...item, source: searchSource })));
          if (response.value.partial) warnings.push(`${mediaSourceLabel(searchSource, mediaSources)}：${response.value.error || '补充搜索未完成，可稍后重试。'}`);
          if (sources.length === 1) setPageTitle(response.value.pageTitle || '');
          const following = followingPage(response.value, searchSource, 1);
          if (following) queue.push(following);
        } else {
          failures.push(`${mediaSourceLabel(searchSource, mediaSources)}：${response.reason?.message || '搜索失败'}`);
        }
      });
      rememberCatalogTitles(merged);
      if (responses.some((response) => response.status === 'fulfilled')) {
        try {
          setHistory(saveSearchTerm(kw));
          setHistoryError('');
        } catch {
          setHistoryError('搜索结果已显示，但本机搜索历史保存失败。');
        }
      }
      const ranked = rankSearchResults(merged, kw);
      setResults(ranked);
      setSearchWarning(warnings.join('；'));
      if (failures.length) setError(`${failures.join('；')}。${merged.length ? '已显示其他来源的结果。' : ''}请重试或切换来源。`);
      if (queue.length && ranked.length) loadPages(request, kw, queue, AUTO_PAGES, ranked);
    } catch (e) {
      if (request !== requestVersion.current) return;
      setError('搜索异常: ' + e.message);
      setResults([]);
    } finally {
      if (pendingSearch.current?.request === request) pendingSearch.current = null;
      if (request === requestVersion.current) setLoading(false);
    }
  };


  const pick = async (item) => {
    const request = ++requestVersion.current;
    setPager(current => current.loading ? { ...current, loading: false } : current);
    setPickingId(item.series_id);
    setError('');
    onSelectStart?.(item);
    try {
      const res = await window.electronAPI.searchResolve(item.series_id);
      if (request !== requestVersion.current) return;
      if (res && res.success && res.data) {
        onSelectSeries(res.data);
      } else {
        setError((res && res.error) || '拉取分集失败');
      }
    } catch (e) {
      if (request === requestVersion.current) setError('拉取分集异常: ' + e.message);
    } finally {
      if (request === requestVersion.current) setPickingId('');
    }
  };

  const showBrowser = async () => {
    try {
      const res = await window.electronAPI.searchWindowShow(true);
      if (res?.success === false) throw new Error(res.error || '来源页面打开失败');
    } catch (e) { setError(e.message || '来源页面打开失败，请重试'); }
  };

  const matched = (results || []).filter(item => item.relevance < 2);
  const others = (results || []).filter(item => item.relevance === 2);
  const card = (item, index) => (
    <button
      type="button"
      disabled={pickingId !== ''}
      key={`${item.source}:${item.series_id}`}
      className={`search-card ${pickingId === item.series_id ? 'picking' : ''}`}
      onClick={() => pickingId === '' && pick(item)}
      title={`点击查看并下载：${item.series_title}`}
    >
      <div className="search-cover">
        <CoverImage src={item.cover} alt={item.series_title} eager={index < EAGER_COVERS} />
      </div>
      <div className="search-card-body">
        <div className="search-card-title">{item.series_title}</div>
        <div className="search-card-sub">
          {pickingId === item.series_id ? (
            <>
              <RefreshCw size={13} className="spin" /> 正在拉取分集…
            </>
          ) : (
            <><span className="badge">{mediaSourceLabel(item.source, mediaSources)}</span>查看剧集</>
          )}
        </div>
      </div>
    </button>
  );

  return (
    <div className="hongguo-card">
      <div className="card-header-title">
        <Search size={18} />
        <span>搜索短剧</span>
        <label className="source-control">来源<select className="input-field" aria-label="短剧来源" value={source} onChange={(e) => switchSource(e.target.value)}><option value="all">全部来源</option>{mediaSources.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select></label>
      </div>

      {sourcesError && <p className="settings-hint" role="status">来源列表更新失败，暂用上次列表；可在设置重新保存来源后重试。</p>}
      <div className="input-group">
        <div className="search-suggest-wrap" ref={suggestWrapRef}>
        <input
          type="text"
          className="input-field"
          aria-label="搜索短剧名称"
          aria-autocomplete="list"
          aria-expanded={suggestOpen && suggestions.length > 0}
          aria-controls="local-search-suggestions"
          ref={inputRef}
          autoComplete="off"
          placeholder="输入剧名，例如：一村人养一个神"
          value={keyword}
          onFocus={() => setSuggestOpen(true)}
          onBlur={(event) => {
            if (event?.relatedTarget && suggestWrapRef.current?.contains?.(event.relatedTarget)) return;
            setSuggestOpen(false);
          }}
          onChange={(e) => { changeKeyword(e.target.value); setSuggestOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setSuggestOpen(false); return; }
            if (isSubmitKey(e)) { setSuggestOpen(false); doSearch(); }
          }}
        />
        {suggestOpen && suggestions.length > 0 && <ul className="search-suggest-list" id="local-search-suggestions" role="listbox" aria-label="搜索联想">
          {suggestions.map(({ term, source: origin }) => <li key={term}>
            <button type="button" role="option" onMouseDown={(event) => { event.preventDefault(); changeKeyword(term); setSuggestOpen(false); }}>
              <span>{term}</span>
              <small>{origin}</small>
            </button>
          </li>)}
        </ul>}
        </div>
        <button className="btn btn-primary" onClick={doSearch} disabled={loading || sourcesLoading}>
          {loading ? (
            <>
              <RefreshCw size={16} className="spin" />
              <span>搜索中...</span>
            </>
          ) : (
            <>
              <Search size={16} />
              <span>搜索</span>
            </>
          )}
        </button>
      </div>
      {history.length > 0 && <div className="search-history">
        <div className="search-history-heading"><span>本机搜索历史</span><button type="button" className="btn-chip" onClick={clearHistory}>清除历史</button></div>
        <div className="search-history-terms">{history.map((term) => <span className="search-history-term" key={term}><button type="button" className="btn-chip" title={term} onClick={() => { changeKeyword(term); inputRef.current?.focus(); }}>{term}</button><button type="button" className="search-history-remove" aria-label={`删除搜索历史：${term}`} title="删除这条搜索历史" onClick={() => removeHistory(term)}>×</button></span>)}</div>
      </div>}
      {historyError && <p className="search-history-error" role="alert">{historyError}</p>}

      {results === null && !loading && !error && (
        <div className="search-welcome"><Search size={36} /><h3>好故事，从一个名字开始</h3><p>输入完整剧名或关键词，发现你想看的短剧。</p></div>
      )}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {searchWarning && <p className="settings-hint" role="status">{searchWarning} 已显示本次查到的结果。</p>}

      {loading && (
        <div className="search-loading">
          <RefreshCw size={18} className="spin" />
          <span>正在寻找相关短剧，首次加载可能需要几秒…</span>
        </div>
      )}

      {results && results.length === 0 && !loading && !error && (
        <div className="search-empty">
          <p>没有找到相关短剧{pageTitle ? `（页面标题：${pageTitle}）` : ''}</p>
          <div className="search-empty-actions">
            {source === 'hongguo' && <button className="btn btn-outline" onClick={showBrowser}>
              <ExternalLink size={15} />
              打开来源页面
            </button>}
            {source === 'hongguo' && onSwitchToInput && (
              <button className="btn btn-outline" onClick={onSwitchToInput}>
                改用链接 / ID 下载
              </button>
            )}
          </div>
        </div>
      )}

      {results && results.length > 0 && (
        <>
          <div className="search-summary">
            <strong>找到 {results.length} 部</strong>
            <span className="search-summary-chip">标题匹配 {matched.length}</span>
            {others.length > 0 && <span className="search-summary-chip is-muted">其他相关 {others.length}</span>}
            <span className="search-summary-state" role="status">
              {pager.loading ? <><RefreshCw size={13} className="spin" /> 正在载入更多结果…</>
                : pager.error ? `更多结果没有载入完成：${pager.error}`
                  : pager.next.length ? '还有更多结果' : '已显示全部结果'}
            </span>
            {!pager.loading && pager.next.length > 0 && <button type="button" className="btn btn-outline btn-sm" disabled={pickingId !== ''} onClick={loadMore}>{pager.error ? '重试载入' : '载入更多'}</button>}
          </div>
          {matched.length > 0 && <div className="search-grid">{matched.map((item, index) => card(item, index))}</div>}
          {others.length > 0 && <>
            <h3 className="search-group-title">其他相关结果</h3>
            <div className="search-grid">{others.map((item, index) => card(item, matched.length + index))}</div>
          </>}
        </>
      )}
    </div>
  );
}

export default SearchPanel;
