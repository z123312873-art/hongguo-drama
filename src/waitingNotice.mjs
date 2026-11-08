export const WAITING_NOTICE = '您目前的预约收藏短剧，尚未上线，请耐心等候';
export const WAITING_DISMISS_MS = 2000;

export function isWaitingNotice(value) {
  return value === WAITING_NOTICE;
}

export function noticeAfterNavigate(current) {
  return isWaitingNotice(current) ? '' : current;
}

export function noticeAfterDelay(current) {
  return isWaitingNotice(current) ? '' : current;
}
