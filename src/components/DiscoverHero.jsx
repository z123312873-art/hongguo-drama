import React, { useEffect, useRef, useState } from 'react';
import { Play } from './icons';
import { HERO_INTERVAL_MS, heroOffsetPercent, heroSlides } from '../discoverHero.mjs';
import './DiscoverHero.css';

function HeroArt({ item }) {
  const [failed, setFailed] = useState(false);
  if (!item.cover || failed) return null;
  return <img className="discover-hero-poster" src={item.cover} alt="" onError={() => setFailed(true)} />;
}

function DiscoverHero({ items, active = true, busy = false, onPlay }) {
  const lineup = Array.isArray(items) ? items : [];
  const slides = heroSlides(lineup);
  const lineupKey = lineup.map(item => `${item.series_id}:${item.rank}`).join('|');
  const [index, setIndex] = useState(0);
  const [animate, setAnimate] = useState(true);
  const [paused, setPaused] = useState(false);
  const held = useRef({ hover: false, focus: false });
  const hold = (key, value) => {
    held.current[key] = value;
    setPaused(held.current.hover || held.current.focus);
  };

  useEffect(() => {
    setIndex(0);
    setAnimate(true);
  }, [lineupKey]);

  useEffect(() => {
    if (!active || paused || lineup.length < 2) return undefined;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setAnimate(true);
      setIndex(current => (current >= lineup.length ? 0 : current + 1));
    }, HERO_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, paused, lineup.length, lineupKey, index]);

  useEffect(() => {
    if (index !== lineup.length || lineup.length < 2) return undefined;
    const timer = setTimeout(() => {
      setAnimate(false);
      setIndex(0);
    }, 700);
    return () => clearTimeout(timer);
  }, [index, lineup.length]);

  useEffect(() => {
    if (animate) return undefined;
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(frame);
  }, [animate, index]);

  if (lineup.length === 0) return null;
  const shown = index >= lineup.length ? 0 : index;
  const offset = heroOffsetPercent(index, slides.length);

  const settle = (event) => {
    if (event.target !== event.currentTarget || event.propertyName !== 'transform') return;
    if (index === lineup.length) {
      setAnimate(false);
      setIndex(0);
    }
  };

  return (
    <section
      className="discover-hero"
      aria-roledescription="carousel"
      aria-label="综合热播推荐"
      onMouseEnter={() => hold('hover', true)}
      onMouseLeave={() => hold('hover', false)}
      onFocus={() => hold('focus', true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hold('focus', false);
      }}
    >
      <div className="discover-hero-frame">
        <div
          className="discover-hero-track"
          style={{
            '--hero-count': slides.length,
            transform: `translateX(${offset}%)`,
            transition: animate ? undefined : 'none',
          }}
          onTransitionEnd={settle}
        >
          {slides.map((item, slideIndex) => {
            const visible = slideIndex === index;
            const meta = [
              item.heat,
              item.episode_label || (item.episode_count > 0 ? `${item.episode_count} 集` : ''),
              ...(Array.isArray(item.tags) ? item.tags.slice(0, 3) : []),
            ].filter(Boolean);
            return (
              <article
                key={`${item.series_id}-${slideIndex}`}
                className="discover-hero-slide"
                aria-hidden={visible ? undefined : true}
              >
                <HeroArt item={item} />
                <div className="discover-hero-shade" />
                <div className="discover-hero-copy">
                  <p className="discover-hero-kicker">综合热播 · 第 {item.rank} 名</p>
                  <h3 className="discover-hero-title">{item.series_title}</h3>
                  {meta.length > 0 && <p className="discover-hero-meta">{meta.join(' · ')}</p>}
                  {item.introduction && <p className="discover-hero-intro">{item.introduction}</p>}
                  <div className="discover-hero-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy || !visible}
                      tabIndex={visible ? 0 : -1}
                      title="打开详情，不会下载"
                      onClick={() => onPlay?.(item)}
                    >
                      <Play size={15} />播放
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
      {lineup.length > 1 && (
        <div className="discover-hero-dots" role="tablist" aria-label="选择推荐">
          {lineup.map((item, dotIndex) => (
            <button
              key={item.series_id}
              type="button"
              role="tab"
              aria-selected={shown === dotIndex}
              aria-label={item.series_title}
              onClick={() => {
                setAnimate(true);
                setIndex(dotIndex);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default DiscoverHero;
