/* ===============================================
   auth.js - PIN 인증 / 토큰 관리
   - 토큰은 localStorage에 저장 (만료 30일)
   - 백엔드는 PIN 변경 시 토큰을 자동 무효화
   =============================================== */

const Auth = (() => {
  const TOKEN_KEY   = 'AUTH_TOKEN';
  const EXPIRES_KEY = 'AUTH_EXPIRES_AT';

  function getToken() {
    const t = localStorage.getItem(TOKEN_KEY);
    if (!t) return null;
    const exp = parseInt(localStorage.getItem(EXPIRES_KEY) || '0', 10);
    if (exp && Date.now() >= exp) {
      clearToken();
      return null;
    }
    return t;
  }

  function setToken(token, expiresAt) {
    localStorage.setItem(TOKEN_KEY, token);
    if (expiresAt) localStorage.setItem(EXPIRES_KEY, String(expiresAt));
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXPIRES_KEY);
  }

  function isAuthenticated() {
    return !!getToken();
  }

  /**
   * PIN으로 로그인 시도. 성공하면 토큰 저장.
   * 반환: { success, error?, token?, expiresAt? }
   */
  async function login(pin) {
    const res = await Api.auth(pin);
    if (res && res.success && res.token) {
      setToken(res.token, res.expiresAt || (Date.now() + 30 * 24 * 60 * 60 * 1000));
    }
    return res;
  }

  function logout() {
    clearToken();
  }

  return { getToken, setToken, clearToken, isAuthenticated, login, logout };
})();

/** 인증 실패(만료/PIN 변경) 시 던지는 전용 에러. app.js에서 PIN 화면으로 보낸다. */
class AuthError extends Error {
  constructor(message) {
    super(message || '인증 필요');
    this.name = 'AuthError';
    this.code = 'AUTH_REQUIRED';
  }
}
