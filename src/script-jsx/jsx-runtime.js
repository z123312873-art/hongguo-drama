import { Fragment, jsx as realJsx, jsxs as realJsxs } from 'react/jsx-runtime';
import { isTraditional } from '../scriptPreference.js';
import { convertConfig } from './convert.mjs';

function propsFor(config) {
  return isTraditional() ? convertConfig(config) : config;
}

export { Fragment };
export function jsx(type, config, key) {
  return realJsx(type, propsFor(config), key);
}
export function jsxs(type, config, key) {
  return realJsxs(type, propsFor(config), key);
}
