'use strict';

function parseJson(value) {
  const input = String(value);
  let output = '', quoted = false, escaped = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      output += char;
    } else if (char === '-' || /\d/.test(char)) {
      const match = input.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!match) { output += char; continue; }
      const number = match[0];
      output += !/[.eE]/.test(number) && !Number.isSafeInteger(Number(number)) ? JSON.stringify(number) : number;
      i += number.length - 1;
    } else output += char;
  }
  return JSON.parse(output);
}

module.exports = { parseJson };
