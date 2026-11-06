const CERT_HINT = 'HTTPS 证书未被信任，请在 AdGuard/杀毒软件中把红果短剧加入例外，或暂时关闭 HTTPS 过滤后再试';

function isCertificateError(error) {
  const code = String(error?.code || '');
  return code === 'ERR_TLS_CERT' || /CERT_|UNABLE_TO_VERIFY|SELF_SIGNED_CERT|HOSTNAME_MISMATCH/.test(code);
}

function certificateMessage(error) {
  return isCertificateError(error) ? CERT_HINT : '';
}

module.exports = { CERT_HINT, isCertificateError, certificateMessage };
