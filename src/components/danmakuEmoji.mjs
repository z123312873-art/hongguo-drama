// 红果弹幕把官方表情写成 [赞]、[送花] 这类代码。对照的是平台表情名，显示成通用 emoji。
// 不认识的方括号原样留下，避免把普通标注当成表情。

const EMOJI = {
  微笑: '😊', 偷笑: '🤭', 笑: '😄', 什么: '😳', 什麼: '😳', 害羞: '🥰',
  爱慕: '😍', 愛慕: '😍', 飞吻: '😘', 飛吻: '😘', 奸笑: '😏', 尬笑: '😅',
  思考: '🤔', 撇嘴: '😒', 做鬼脸: '🤪', 做鬼臉: '🤪', 酷: '😎', 翻白眼: '🙄',
  惊呆: '😲', 驚呆: '😲', 震惊: '😱', 震驚: '😱', 送心: '💕', 委屈: '🥺',
  快哭了: '😢', 笑哭: '😂', 哭: '😭', 大笑: '🤣', 舔屏: '🤤', 怒: '😡',
  捂脸: '🤦', 捂臉: '🤦', 吐: '🤮', 恐惧: '😨', 恐懼: '😨', 抓狂: '🤯',
  敬礼: '🫡', 敬禮: '🫡', 石化: '🗿', OK: '👌', 赞: '👍', 贊: '👍',
  爱心: '❤️', 愛心: '❤️', 伤心: '💔', 傷心: '💔', KISS: '💋', 懂了: '👀',
  探究: '🧐', 重拳出击: '👊', 重拳出擊: '👊', 吃瓜: '🍉', 盯: '👁️',
  你细品: '🫣', 你細品: '🫣', 赶稿中: '✍️', 趕稿中: '✍️', 注意: '⚠️',
  饱了: '🫃', 飽了: '🫃', 码住: '📌', 碼住: '📌', 学会了: '✅', 學會了: '✅',
  顶帖: '🔝', 頂帖: '🔝', 求爆更: '🔥', 求关注: '🙏', 求關注: '🙏', 爽: '😆',
  鼓掌: '👏', 没看够: '🥹', 沒看夠: '🥹', 送花: '🌹',
};

export function presentDanmakuText(value) {
  const text = String(value ?? '');
  if (!text.includes('[')) return text;
  return text.replace(/\[[^\[\]\n]{1,12}\]/g, tag => EMOJI[tag.slice(1, -1)] || tag);
}

export function clipDanmakuText(value, max = 80) {
  const text = presentDanmakuText(value);
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

function emojiCluster(char) {
  const code = char.codePointAt(0);
  return code === 0x200d || code === 0xfe0f || code === 0xfe0e || /\p{Extended_Pictographic}/u.test(char);
}

// 表情往往比一个汉字宽。宽度估小了，后一条会在间距还没留够时出发。
export function measureDanmakuText(value, fontSize) {
  const text = String(value || '');
  let units = 0;
  let emoji = false;
  for (const char of text) {
    if (emojiCluster(char)) { units += 1.35; emoji = true; }
    else units += 1;
  }
  // 没有表情时沿用原来的字宽，时间轴续发间距不变。表情按更宽的字形留空。
  if (!emoji) return (Array.from(text).length + 1) * fontSize;
  return Math.ceil((units + 0.4) * fontSize);
}

export function splitDanmakuRuns(value) {
  const runs = [];
  let buffer = '';
  let emoji = false;
  const push = () => {
    if (!buffer) return;
    runs.push({ emoji, text: buffer });
    buffer = '';
  };
  for (const char of String(value || '')) {
    const next = emojiCluster(char);
    if (buffer && next !== emoji) push();
    emoji = next;
    buffer += char;
  }
  push();
  return runs;
}
