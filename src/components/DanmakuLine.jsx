import React from 'react';
import { splitDanmakuRuns } from './danmakuEmoji.mjs';

// 表情单独成段，不继承正文的描边。Windows 10 和 11 的彩色表情一加粗或加阴影，就会出现黑边。
export default function DanmakuLine({ text }) {
  return splitDanmakuRuns(text).map((run, index) => run.emoji
    ? <span className="danmaku-emoji" key={index}>{run.text}</span>
    : <React.Fragment key={index}>{run.text}</React.Fragment>);
}
