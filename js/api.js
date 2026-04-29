/* ===============================================
   api.js - Apps Script 백엔드 통신
   - CORS 프리플라이트를 피하려고 Content-Type을 'text/plain'으로 보냄
   - 모든 요청에 토큰을 자동 첨부 (auth/ping 제외)
   - 백엔드가 AUTH_REQUIRED 코드를 반환하면 AuthError를 throw
   =============================================== */

const Api = (() => {
  // ★ Apps Script 웹앱 URL
  //   형식: https://script.google.com/macros/s/AKfy.../exec
  const API_URL = 'https://script.google.com/macros/s/AKfycbxrG7kvI82DmWrf_WPSsYOA2UB4To8Z962otQxZ8WR1MXUWSgqGsEONqXu-ThwdoNSx/exec';

  function getApiUrl() {
    return localStorage.getItem('API_URL_OVERRIDE') || API_URL;
  }
  function ensureUrl() {
    const url = getApiUrl();
    if (!url) throw new Error('API_URL이 설정되지 않았습니다.');
    return url;
  }

  function handleAuthFailure(data) {
    if (data && data.code === 'AUTH_REQUIRED') {
      Auth.clearToken();
      throw new AuthError(data.error || '인증이 필요합니다');
    }
  }

  /** 모든 POST 요청은 이 함수를 통한다. 토큰 자동 첨부. */
  async function postJSON(payload, { withToken = true } = {}) {
    const url = ensureUrl();
    const body = { ...payload };
    if (withToken && body.token === undefined) body.token = Auth.getToken();

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    handleAuthFailure(data);
    return data;
  }

  async function getJSON(params, { withToken = true } = {}) {
    const url = ensureUrl();
    const merged = { ...params };
    if (withToken && merged.token === undefined) {
      const t = Auth.getToken();
      if (t) merged.token = t;
    }
    const qs = new URLSearchParams(merged).toString();
    const res = await fetch(`${url}?${qs}`, { method: 'GET', redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    handleAuthFailure(data);
    return data;
  }

  // ---------- 사진 업로드 ----------
  async function uploadPhoto({ date, folderName, filename, mimeType, blob }) {
    const data = await Camera.blobToBase64(blob);
    const res = await postJSON({
      action: 'upload',
      date, folderName, filename, mimeType, data,
    });
    if (!res.success) throw new Error(res.error || '업로드 실패');
    return res;
  }

  // ---------- 업로드 현황 ----------
  async function getStatus(date) {
    const res = await getJSON({ action: 'status', date });
    if (!res.success) throw new Error(res.error || '상태 조회 실패');
    return res;
  }

  // ---------- 사진 목록 ----------
  async function listPhotos(date, folderName) {
    const res = await getJSON({ action: 'listPhotos', date, folderName });
    if (!res.success) throw new Error(res.error || '사진 목록 조회 실패');
    return res;
  }

  // ---------- 사진 삭제 ----------
  async function deletePhoto(fileId) {
    const res = await postJSON({ action: 'deletePhoto', fileId });
    if (!res.success) throw new Error(res.error || '삭제 실패');
    return res;
  }

  // ---------- 사진 바이너리 (프록시) ----------
  // Apps Script가 raw 이미지를 직접 응답할 수 없어서 base64 JSON으로 받아 Blob URL을 만든다.
  // 메모리 캐시에 저장하여 같은 사진을 재요청하지 않는다.
  // 같은 사진의 동시 요청은 inflight Promise를 공유하여 중복 페치 방지.
  const _photoCache    = new Map(); // 'fileId:size' → blob URL
  const _photoInflight = new Map(); // 'fileId:size' → Promise<string>

  function _photoKey(fileId, size) {
    return fileId + ':' + (size === 'full' ? 'full' : 'thumb');
  }

  async function getPhotoBlobUrl(fileId, size = 'thumb') {
    const key = _photoKey(fileId, size);
    if (_photoCache.has(key))    return _photoCache.get(key);
    if (_photoInflight.has(key)) return _photoInflight.get(key);

    const promise = (async () => {
      const url = ensureUrl()
        + '?action=getPhoto'
        + '&fileId='  + encodeURIComponent(fileId)
        + '&size='    + encodeURIComponent(size === 'full' ? 'full' : 'thumb')
        + '&token='   + encodeURIComponent(Auth.getToken() || '');

      const res = await fetch(url, { method: 'GET', redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      handleAuthFailure(data);
      if (!data.success) throw new Error(data.error || '사진 로딩 실패');

      // base64 → Uint8Array → Blob → Object URL
      const bin = atob(data.data);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const blob = new Blob([buf], { type: data.mimeType || 'image/jpeg' });
      const blobUrl = URL.createObjectURL(blob);
      _photoCache.set(key, blobUrl);
      return blobUrl;
    })();

    _photoInflight.set(key, promise);
    try {
      return await promise;
    } finally {
      _photoInflight.delete(key);
    }
  }

  function clearPhotoCache() {
    _photoCache.forEach((url) => { try { URL.revokeObjectURL(url); } catch (_) {} });
    _photoCache.clear();
    _photoInflight.clear();
  }

  function removeFromPhotoCache(fileId) {
    ['thumb', 'full'].forEach((size) => {
      const key = _photoKey(fileId, size);
      if (_photoCache.has(key)) {
        try { URL.revokeObjectURL(_photoCache.get(key)); } catch (_) {}
        _photoCache.delete(key);
      }
      _photoInflight.delete(key);
    });
  }

  // ---------- PIN 인증 (토큰 발급) ----------
  // auth는 토큰 첨부 X. 서버가 PIN으로 직접 검증.
  async function auth(pin) {
    return postJSON({ action: 'auth', pin }, { withToken: false });
  }

  // ---------- 헬스 체크 ----------
  // ping은 토큰 첨부 X. PIN 설정 여부도 함께 알려준다.
  async function ping() {
    return getJSON({ action: 'ping' }, { withToken: false });
  }

  return {
    uploadPhoto, getStatus, listPhotos, deletePhoto,
    getPhotoBlobUrl, clearPhotoCache, removeFromPhotoCache,
    auth, ping, getApiUrl,
  };
})();
