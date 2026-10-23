// Classic JSX still calls createElement. The Vite build uses src/script-jsx instead.
import React from 'react';
import { isTraditional } from './scriptPreference.js';
import { convertConfig } from './script-jsx/convert.mjs';

const original = React.createElement;

React.createElement = function createElement(type, props, ...children) {
  if (!isTraditional()) return original.call(this, type, props, ...children);
  const config = convertConfig({ ...props, children });
  const { children: nextChildren, ...nextProps } = config;
  const childArgs = nextChildren === undefined ? [] : Array.isArray(nextChildren) ? nextChildren : [nextChildren];
  return original.call(this, type, props ? nextProps : props, ...childArgs);
};
