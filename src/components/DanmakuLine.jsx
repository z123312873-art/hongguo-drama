import React from 'react';
import { splitDanmakuRuns } from './danmakuEmoji.mjs';


export default function DanmakuLine({ text }) {
  return splitDanmakuRuns(text).map((run, index) => run.emoji
    ? <span className="danmaku-emoji" key={index}>{run.text}</span>
    : <React.Fragment key={index}>{run.text}</React.Fragment>);
}
