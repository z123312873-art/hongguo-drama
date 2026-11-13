const EXPORT_BLOCK = /module\.exports\s*=\s*\{([\s\S]*?)\}\s*;?\s*$/;
const REQUIRE_LINE = /^(const|let)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\((['"])(\.{1,2}\/[^'"]+)\3\)\s*;?[ \t]*$/gm;
const NATIVE_FILE = /[/\\]src[/\\]native[/\\][^/\\]+\.js$/;

export function isRendererCjs(id, code) {
  return NATIVE_FILE.test(String(id).split('?')[0]) && /\bmodule\.exports\b/.test(code);
}

export function exportedNames(code) {
  const block = EXPORT_BLOCK.exec(code);
  if (!block) return [];
  const names = [];
  for (const part of block[1].replace(/\/\/[^\n]*/g, '').split(',')) {
    const found = /^\s*([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(part);
    if (found) names.push(found[1]);
  }
  return [...new Set(names)];
}

export function cjsToEsm(code) {
  let count = 0;
  const imports = [];
  const body = code.replace(REQUIRE_LINE, (_match, kind, target, _quote, from) => {
    const alias = `__cjs_dep_${count++}`;
    imports.push(`import * as ${alias} from ${JSON.stringify(from)};`);
    return `${kind} ${target} = ${alias}.default && typeof ${alias}.default === 'object' ? ${alias}.default : ${alias};`;
  });
  const names = exportedNames(code);
  const tail = names.map(name => `const __cjs_export_${name} = module.exports.${name}; export { __cjs_export_${name} as ${name} };`).join('\n');
  return `${imports.join('\n')}\nconst module = { exports: {} };\nconst exports = module.exports;\n${body}\nexport default module.exports;\n${tail}\n`;
}

export function developmentCjs() {
  return {
    name: 'development-renderer-cjs',
    apply: 'serve',
    enforce: 'pre',
    transform(code, id) {
      if (!isRendererCjs(id, code)) return null;
      return { code: cjsToEsm(code), map: null };
    },
  };
}
