const phases = { transcoding: '正在转档', finalizing: '正在整理文件', verifying: '正在检查文件' };
export function downloadPhaseLabel(task) {
  return task?.status === 'downloading' ? phases[task.phase] || '下载中' : '';
}
export function downloadProgressText(task) {
  if (task?.status !== 'downloading') return '';
  const label = downloadPhaseLabel(task);
  if (!phases[task.phase]) return `${label} ${Math.max(0, Math.min(99, Number(task.progress) || 0))}%`;
  const seconds = Number(task.phaseSeconds);
  return task.phase === 'transcoding' && Number.isFinite(seconds) && seconds > 0 ? `${label} · 已处理 ${Math.floor(seconds)} 秒` : `${label}…`;
}
