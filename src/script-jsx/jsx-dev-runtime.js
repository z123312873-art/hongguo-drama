import { Fragment, jsxDEV as realJsxDEV } from 'react/jsx-dev-runtime';
import { isTraditional } from '../scriptPreference.js';
import { convertConfig } from './convert.mjs';

export { Fragment };
export function jsxDEV(type, config, key, isStaticChildren, source, self) {
  return realJsxDEV(type, isTraditional() ? convertConfig(config) : config, key, isStaticChildren, source, self);
}
