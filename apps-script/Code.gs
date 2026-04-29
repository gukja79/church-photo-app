/**
 * 교회 교실 사진 - Apps Script 백엔드
 *
 * 엔드포인트:
 *   - GET  ?action=ping                                       : 헬스 체크 (인증 불필요)
 *   - GET  ?action=status&date=...&token=...                  : 특정 날짜 업로드 현황
 *   - GET  ?action=listPhotos&date=...&folderName=...&token=  : 장소 폴더의 사진 메타 목록
 *   - GET  ?action=getPhoto&fileId=...&size=thumb|full&token  : 사진 바이너리(JSON+base64)
 *   - POST {action: 'auth',   pin}                            : PIN 검증 → 토큰 발급
 *   - POST {action: 'upload', token, ...}                     : 사진 업로드 (토큰 필수)
 *   - POST {action: 'status', token, date}                    : 업로드 현황 (POST로도 가능)
 *   - POST {action: 'listPhotos', token, date, folderName}    : 사진 목록 (POST로도 가능)
 *   - POST {action: 'deletePhoto', token, fileId}             : 사진 1장 휴지통 이동
 *
 * 폴더 구조 (부모 폴더 아래):
 *   YYYY-MM-DD/{folderName}/{filename}.jpg
 *   - folderName 예: 01_2층_1-14, 20_1층_여자화장실
 *
 * 파일명 규칙 (프론트에서 생성):
 *   {정렬숫자}_{전후}_{층}_{장소}_{HHmmss}_{NNN}.jpg
 *
 * 스크립트 속성 (프로젝트 설정 > 스크립트 속성):
 *   - PARENT_FOLDER_ID : 부모 폴더 ID (필수)
 *   - PIN              : PIN 숫자 (4-6자리). 미설정 시 인증 통과(개발 모드).
 *   - SECRET           : 토큰 서명 키. 첫 토큰 발급 시 자동 생성됨. 절대 노출 금지.
 *
 * 인증:
 *   - PIN을 변경하면 토큰의 'v' 필드(PIN 해시)가 더 이상 일치하지 않아 자동 무효화됨.
 *   - SECRET을 삭제(또는 변경)해도 모든 토큰 무효화됨.
 *   - 토큰 만료: 발급 시점으로부터 30일.
 */

var TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ===== 진입점 =====

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ success: false, error: '요청 본문 없음' });
    }
    var body = JSON.parse(e.postData.contents);
    var action = body.action || 'upload';

    // 토큰 발급은 PIN으로 직접 검증
    if (action === 'auth') return jsonResponse(handleAuth(body));

    // 그 외는 토큰 검증 필수
    if (!verifyToken_(body && body.token)) {
      return jsonResponse({ success: false, error: '인증이 필요합니다', code: 'AUTH_REQUIRED' });
    }

    if (action === 'upload')      return jsonResponse(handleUpload(body));
    if (action === 'status')      return jsonResponse(handleStatus(body.date));
    if (action === 'listPhotos')  return jsonResponse(handleListPhotos(body.date, body.folderName));
    if (action === 'deletePhoto') return jsonResponse(handleDeletePhoto(body.fileId));

    return jsonResponse({ success: false, error: '알 수 없는 action: ' + action });
  } catch (err) {
    console.error(err);
    return jsonResponse({ success: false, error: String(err && err.message || err) });
  }
}

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var action = params.action || 'status';

    // ping: 인증 불필요. PIN 설정 여부도 함께 알려준다 (프론트가 PIN 화면 스킵 판단용)
    if (action === 'ping') {
      return jsonResponse({
        success: true,
        ping: 'pong',
        time: nowKstISO(),
        pinRequired: !!getProp_('PIN'),
      });
    }

    if (!verifyToken_(params.token)) {
      return jsonResponse({ success: false, error: '인증이 필요합니다', code: 'AUTH_REQUIRED' });
    }

    if (action === 'status')     return jsonResponse(handleStatus(params.date));
    if (action === 'listPhotos') return jsonResponse(handleListPhotos(params.date, params.folderName));
    if (action === 'getPhoto')   return jsonResponse(handleGetPhoto(params.fileId, params.size));

    return jsonResponse({ success: false, error: '알 수 없는 action: ' + action });
  } catch (err) {
    console.error(err);
    return jsonResponse({ success: false, error: String(err && err.message || err) });
  }
}

// ===== 핸들러 =====

function handleAuth(body) {
  var pin = body && body.pin;
  if (!verifyPin_(pin)) {
    return { success: false, error: 'PIN이 틀렸습니다' };
  }
  var configuredPin = getProp_('PIN');
  if (!configuredPin) {
    // 개발 모드: PIN 미설정 시 더미 토큰 발급
    return { success: true, token: 'dev', expiresAt: Date.now() + TOKEN_TTL_MS };
  }
  var token = issueToken_(configuredPin);
  return { success: true, token: token, expiresAt: Date.now() + TOKEN_TTL_MS };
}

function handleUpload(body) {
  var required = ['date', 'folderName', 'filename', 'data'];
  for (var i = 0; i < required.length; i++) {
    if (!body[required[i]]) {
      return { success: false, error: '필수 필드 누락: ' + required[i] };
    }
  }

  var parentId = getProp_('PARENT_FOLDER_ID');
  if (!parentId) {
    return { success: false, error: 'PARENT_FOLDER_ID가 스크립트 속성에 설정되지 않았습니다.' };
  }

  // ===== 동시성 제어 =====
  // 폴더 생성 + 일련번호 할당 + 파일 생성을 원자적으로 처리한다.
  // LockService.getScriptLock()은 이 스크립트의 모든 invocation에 대한 글로벌 락이므로
  // 모든 업로드가 한 줄로 처리됨 → 중복 폴더, 중복 파일명, race condition을 모두 막는다.
  // 한 요청은 평균 1-2초이므로 5-6명 동시 업로드 시 마지막 사용자도 10-15초 이내에 완료.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { success: false, error: '서버가 바쁩니다. 잠시 후 다시 시도해주세요.', code: 'BUSY' };
  }
  try {
    var root       = DriveApp.getFolderById(parentId);
    var dateFolder = getOrCreateFolder_(root, body.date);
    var locFolder  = getOrCreateFolder_(dateFolder, body.folderName);

    // 클라이언트가 보낸 일련번호(_001)는 힌트로만 취급하고, 폴더의 실제 파일을 스캔해 재할당.
    // → 다른 사용자가 같은 초에 올려도 자동으로 _002, _003... 으로 매겨진다.
    var prefix    = computeFilenamePrefix_(body.filename);
    var nextSeq   = findNextSeq_(locFolder, prefix);
    var finalName = prefix + '_' + padSeq_(nextSeq) + '.jpg';

    var mimeType = body.mimeType || 'image/jpeg';
    var bytes    = Utilities.base64Decode(body.data);
    var blob     = Utilities.newBlob(bytes, mimeType, finalName);
    var file     = locFolder.createFile(blob);

    // 사진 썸네일을 외부 브라우저(로그인 안 된 자원봉사자 휴대폰 등)에서도 보이게 하려고
    // ANYONE_WITH_LINK 보기 권한을 부여 시도. 공유 드라이브 정책으로 막혀도 무시하고 계속.
    // (파일 ID는 33자 랜덤이라 실질적으로 추측 불가능)
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e) {
      console.warn('파일 공유 설정 실패(무시): ' + (e && e.message || e));
    }

    return {
      success:    true,
      fileId:     file.getId(),
      fileUrl:    file.getUrl(),
      filename:   file.getName(),
      folderPath: body.date + '/' + body.folderName,
      uploadedAt: nowKstISO(),
      reassigned: (finalName !== body.filename),
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 특정 날짜·장소 폴더의 사진 메타 목록 반환.
 * 시간/Phase는 파일명 패턴에서 파싱.
 */
function handleListPhotos(date, folderName) {
  if (!folderName) return { success: false, error: 'folderName 필수' };
  if (!date) date = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');

  var parentId = getProp_('PARENT_FOLDER_ID');
  if (!parentId) return { success: false, error: 'PARENT_FOLDER_ID 미설정' };

  var root = DriveApp.getFolderById(parentId);
  var dateIt = root.getFoldersByName(date);
  if (!dateIt.hasNext()) return { success: true, date: date, folderName: folderName, photos: [] };

  var dateFolder = dateIt.next();
  var locIt = dateFolder.getFoldersByName(folderName);
  if (!locIt.hasNext()) return { success: true, date: date, folderName: folderName, photos: [] };

  var locFolder = locIt.next();
  var photos = [];
  var fIt = locFolder.getFiles();
  while (fIt.hasNext()) {
    var f = fIt.next();
    var name = f.getName();
    var meta = parseFilename_(name);
    if (!meta) continue;
    photos.push({
      fileId:   f.getId(),
      fileName: name,
      phase:    meta.phase,
      time:     meta.timeHHMM,
      seq:      meta.seq,
      // 이미지 자체는 별도 엔드포인트(getPhoto)로 받는다 — Workspace 정책 회피용 프록시.
    });
  }
  // 정렬: 모임 전 → 모임 후, 그 안에서 시간/일련번호 오름차순 (파일명이 그 순서)
  photos.sort(function(a, b) {
    if (a.phase !== b.phase) return a.phase === 'before' ? -1 : 1;
    return a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0;
  });
  return { success: true, date: date, folderName: folderName, photos: photos };
}

/**
 * 파일명에서 phase / 시간 / 일련번호 파싱.
 *  '1_전_2층_1-14_093015_001.jpg' →
 *   { phase: 'before', timeHHMM: '09:30', timeRaw: '093015', seq: 1 }
 */
function parseFilename_(name) {
  var parts = name.split('_');
  if (parts.length < 6) return null;
  var phase;
  if      (parts[0] === '1' && parts[1] === '전') phase = 'before';
  else if (parts[0] === '2' && parts[1] === '후') phase = 'after';
  else return null;
  var timeRaw = parts[parts.length - 2];
  if (!/^\d{6}$/.test(timeRaw)) return null;
  var seqMatch = /^(\d+)\.(jpg|jpeg)$/i.exec(parts[parts.length - 1]);
  if (!seqMatch) return null;
  return {
    phase:    phase,
    timeRaw:  timeRaw,
    timeHHMM: timeRaw.slice(0, 2) + ':' + timeRaw.slice(2, 4),
    seq:      parseInt(seqMatch[1], 10),
  };
}

/**
 * 사진 1장 휴지통 이동. 잘못 올린 사진 정리용.
 * 안전장치: 파일이 우리 PARENT_FOLDER 내부에 있는지(2단 깊이) 검증한 뒤에만 삭제.
 */
function handleDeletePhoto(fileId) {
  if (!fileId) return { success: false, error: 'fileId 필수' };
  var parentId = getProp_('PARENT_FOLDER_ID');
  if (!parentId) return { success: false, error: 'PARENT_FOLDER_ID 미설정' };

  var file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (e) {
    return { success: false, error: '파일을 찾을 수 없습니다' };
  }
  if (!isInManagedFolder_(file, parentId)) {
    return { success: false, error: '이 앱이 관리하는 폴더의 파일이 아닙니다' };
  }

  file.setTrashed(true);
  return { success: true, fileId: fileId };
}

/**
 * 사진 바이너리를 JSON + base64로 반환. (Apps Script가 raw 이미지 응답을 지원하지 않아서 우회)
 *  - size='thumb': Google 자동 썸네일 URL을 OAuth로 페치 (~50KB JPEG)
 *  - size='full' (기본): 원본 파일 그대로 (~500KB)
 *  - 클라이언트는 응답을 받아 atob → Blob → URL.createObjectURL → <img src>로 사용한다.
 */
function handleGetPhoto(fileId, size) {
  if (!fileId) return { success: false, error: 'fileId 필수' };
  var parentId = getProp_('PARENT_FOLDER_ID');
  if (!parentId) return { success: false, error: 'PARENT_FOLDER_ID 미설정' };

  var file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (e) {
    return { success: false, error: '파일을 찾을 수 없습니다' };
  }
  if (!isInManagedFolder_(file, parentId)) {
    return { success: false, error: '접근 권한이 없습니다' };
  }

  var blob;
  if (size === 'thumb') {
    blob = fetchThumbnailBlob_(fileId, 'w400') || file.getBlob();
  } else {
    blob = file.getBlob();
  }

  return {
    success:  true,
    data:     Utilities.base64Encode(blob.getBytes()),
    mimeType: blob.getContentType() || 'image/jpeg',
    size:     size === 'thumb' ? 'thumb' : 'full',
  };
}

/**
 * Google이 자동 생성하는 썸네일 URL을 스크립트의 OAuth 토큰으로 페치한다.
 *  - 사용자 측에서는 어떤 인증도 필요 없음 (앱이 대신 가져와서 base64로 전달)
 *  - 실패하면 null 반환 → 호출자가 원본으로 fallback
 *  - script.external_request 스코프 필요 (manifest에 이미 있음)
 */
function fetchThumbnailBlob_(fileId, sizeParam) {
  try {
    var url = 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(fileId) +
              '&sz=' + (sizeParam || 'w400');
    var resp = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
      followRedirects: true,
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() === 200) {
      var blob = resp.getBlob();
      if (!blob.getContentType()) blob.setContentType('image/jpeg');
      return blob;
    }
    console.warn('썸네일 페치 HTTP ' + resp.getResponseCode() + ' for ' + fileId);
  } catch (e) {
    console.warn('썸네일 페치 실패: ' + (e && e.message || e));
  }
  return null;
}

/**
 * 파일이 우리 PARENT_FOLDER 안의 (date)/(folderName) 구조에 있는지 검증.
 * 파일 → 부모(장소) → 부모(날짜) → 부모(=PARENT)
 */
function isInManagedFolder_(file, parentId) {
  try {
    var locIt = file.getParents();
    if (!locIt.hasNext()) return false;
    var locFolder = locIt.next();
    var dateIt = locFolder.getParents();
    if (!dateIt.hasNext()) return false;
    var dateFolder = dateIt.next();
    var rootIt = dateFolder.getParents();
    if (!rootIt.hasNext()) return false;
    return rootIt.next().getId() === parentId;
  } catch (e) {
    return false;
  }
}

/**
 * 파일명에서 끝의 일련번호(_NNN)와 확장자를 떼어낸 prefix.
 *   '1_전_2층_1-14_093015_001.jpg' → '1_전_2층_1-14_093015'
 */
function computeFilenamePrefix_(filename) {
  var stem = filename.replace(/\.(jpg|jpeg)$/i, '');
  var parts = stem.split('_');
  parts.pop(); // 끝의 일련번호 제거
  return parts.join('_');
}

/**
 * 폴더 안에서 같은 prefix를 갖는 파일들 중 가장 큰 일련번호 + 1을 반환.
 *   prefix '1_전_2층_1-14_093015' 일 때 폴더에 _001, _002 가 있으면 → 3
 */
function findNextSeq_(folder, prefix) {
  var max = 0;
  var it = folder.getFiles();
  while (it.hasNext()) {
    var name = it.next().getName();
    if (name.indexOf(prefix + '_') !== 0) continue;
    var rest = name.slice(prefix.length + 1);
    var m = /^(\d+)\.(jpg|jpeg)$/i.exec(rest);
    if (!m) continue;
    var n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max + 1;
}

function padSeq_(n) {
  return String(n).padStart(3, '0');
}

function handleStatus(date) {
  if (!date) return { success: false, error: 'date 파라미터가 필요합니다.' };

  var parentId = getProp_('PARENT_FOLDER_ID');
  if (!parentId) return { success: false, error: 'PARENT_FOLDER_ID 미설정' };

  var root = DriveApp.getFolderById(parentId);
  var dateIt = root.getFoldersByName(date);
  if (!dateIt.hasNext()) {
    return { success: true, date: date, locations: {} };
  }

  var dateFolder = dateIt.next();
  var locations  = {};
  var folderIt   = dateFolder.getFolders();
  while (folderIt.hasNext()) {
    var f = folderIt.next();
    locations[f.getName()] = countPhasesInFolder_(f);
  }
  return { success: true, date: date, locations: locations };
}

// ===== 인증 / 토큰 =====

function verifyPin_(pin) {
  var expected = getProp_('PIN');
  if (!expected) return true; // 개발 모드: PIN 미설정 시 통과
  return String(pin || '') === String(expected);
}

/**
 * 토큰 형식: base64url(JSON payload) + '.' + base64url(HMAC-SHA256 sig)
 * payload: { exp: ms, iat: ms, v: pinHash(8자) }
 *   - exp: 만료 시간(ms epoch)
 *   - v:   현재 PIN의 짧은 해시. PIN이 바뀌면 검증 실패 → 자동 로그아웃
 *
 * SECRET은 별도 자동 생성 키. PIN을 secret으로 쓰지 않는 이유:
 *   PIN이 4자리 숫자이면 토큰 가로챈 공격자가 brute-force로 PIN 추출 가능.
 *   SECRET은 UUID 기반이라 brute-force 불가능.
 */
function issueToken_(pin) {
  var payload = {
    exp: Date.now() + TOKEN_TTL_MS,
    iat: Date.now(),
    v:   pinFingerprint_(pin),
  };
  var b64   = base64UrlEncode_(stringToBytes_(JSON.stringify(payload)));
  var sig   = sign_(b64);
  return b64 + '.' + sig;
}

function verifyToken_(token) {
  // PIN 미설정 → 개발 모드. 토큰 무관하게 통과.
  var pin = getProp_('PIN');
  if (!pin) return true;

  if (!token || typeof token !== 'string') return false;
  var parts = token.split('.');
  if (parts.length !== 2) return false;

  // 서명 검증
  if (!safeEquals_(parts[1], sign_(parts[0]))) return false;

  try {
    var payload = JSON.parse(bytesToString_(base64UrlDecode_(parts[0])));
    if (!payload || typeof payload !== 'object') return false;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return false;
    if (payload.v !== pinFingerprint_(pin)) return false; // PIN이 바뀐 경우
    return true;
  } catch (e) {
    return false;
  }
}

function sign_(data) {
  var secret = getOrCreateSecret_();
  var raw = Utilities.computeHmacSha256Signature(data, secret);
  return base64UrlEncode_(raw);
}

function pinFingerprint_(pin) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pin));
  return base64UrlEncode_(raw).slice(0, 12);
}

function getOrCreateSecret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('SECRET');
  if (!s) {
    s = Utilities.getUuid() + '-' + Utilities.getUuid();
    props.setProperty('SECRET', s);
  }
  return s;
}

function safeEquals_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64UrlEncode_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}
function base64UrlDecode_(s) {
  var pad = s.length % 4;
  if (pad) s += new Array(5 - pad).join('=');
  return Utilities.base64DecodeWebSafe(s);
}
function stringToBytes_(s) {
  return Utilities.newBlob(s).getBytes();
}
function bytesToString_(bytes) {
  return Utilities.newBlob(bytes).getDataAsString();
}

// ===== 헬퍼 =====

function countPhasesInFolder_(folder) {
  var before = 0, after = 0;
  var it = folder.getFiles();
  while (it.hasNext()) {
    var name = it.next().getName();
    var parts = name.split('_');
    if (parts.length < 2) continue;
    if (parts[0] === '1' && parts[1] === '전') before++;
    else if (parts[0] === '2' && parts[1] === '후') after++;
  }
  return { before: before, after: after };
}

function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function nowKstISO() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', "yyyy-MM-dd'T'HH:mm:ssXXX");
}

// ===== 수동 점검용 =====

function testSetup() {
  var parentId = getProp_('PARENT_FOLDER_ID');
  if (!parentId) {
    throw new Error('PARENT_FOLDER_ID가 설정되지 않았습니다. 프로젝트 설정 > 스크립트 속성에 추가하세요.');
  }
  var root = DriveApp.getFolderById(parentId);
  Logger.log('부모 폴더 이름: ' + root.getName());
  Logger.log('부모 폴더 URL: ' + root.getUrl());
  Logger.log('PIN 설정 여부: ' + (getProp_('PIN') ? '예' : '아니오 (개발 모드)'));
  Logger.log('SECRET 자동 생성됨: ' + (!!getOrCreateSecret_()));
  Logger.log('서버 시간(KST): ' + nowKstISO());
}

/** 토큰 발급/검증 동작 확인 */
function testTokenRoundTrip() {
  var pin = getProp_('PIN');
  if (!pin) {
    Logger.log('PIN 미설정. 먼저 PIN 속성을 추가하고 다시 실행하세요.');
    return;
  }
  var t = issueToken_(pin);
  Logger.log('토큰: ' + t);
  Logger.log('verify(현재 PIN 기준): ' + verifyToken_(t));
}

/**
 * 동시 업로드 안전성 시뮬레이션.
 *
 * Apps Script는 단일 함수 내에서 진짜 병렬 실행을 만들 수 없지만,
 * 이 테스트는 같은 prefix(같은 사용자·장소·초)에 빠르게 5번 업로드하는 상황을 재현하여
 *  - findNextSeq_ 가 매번 다음 번호를 정확히 반환하는지
 *  - 결과 파일명이 _001 ~ _005로 충돌 없이 매겨지는지
 * 를 검증한다.
 *
 * 끝나면 테스트 폴더(부모폴더/__test_concurrent)는 자동으로 휴지통으로 이동된다.
 *
 * 진짜 병렬성 검증은 사용자가 여러 브라우저 탭/디바이스에서 동시에 업로드해보는 게 가장 확실.
 */
function testConcurrent() {
  var parentId = getProp_('PARENT_FOLDER_ID');
  if (!parentId) throw new Error('PARENT_FOLDER_ID 미설정');
  var root = DriveApp.getFolderById(parentId);

  // 테스트 폴더 (이미 있으면 정리)
  var testRootIt = root.getFoldersByName('__test_concurrent');
  while (testRootIt.hasNext()) testRootIt.next().setTrashed(true);

  var testRoot   = root.createFolder('__test_concurrent');
  var dateFolder = getOrCreateFolder_(testRoot, '2026-04-29');
  var locFolder  = getOrCreateFolder_(dateFolder, '01_2층_1-14');

  // 1×1 투명 PNG (테스트용 작은 데이터)
  var tinyB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';
  var tinyBytes = Utilities.base64Decode(tinyB64);

  var prefix = '1_전_2층_1-14_093015';
  var allocated = [];

  // 케이스 A: 같은 prefix로 5번 빠르게 createFile.
  // 매 호출마다 findNextSeq_가 폴더를 스캔하여 다음 번호 반환 → 001~005 보장 기대.
  for (var i = 0; i < 5; i++) {
    var nextSeq   = findNextSeq_(locFolder, prefix);
    var finalName = prefix + '_' + padSeq_(nextSeq) + '.jpg';
    var blob      = Utilities.newBlob(tinyBytes, 'image/png', finalName);
    locFolder.createFile(blob);
    allocated.push(finalName);
  }
  Logger.log('[케이스 A] 같은 prefix 5연속: ' + JSON.stringify(allocated));

  // 케이스 B: getOrCreateFolder_ 멱등성 확인 (같은 이름 5번 호출해도 폴더 1개)
  var beforeCount = countSubfolders_(testRoot);
  for (var j = 0; j < 5; j++) getOrCreateFolder_(testRoot, '2026-04-29');
  var afterCount = countSubfolders_(testRoot);
  Logger.log('[케이스 B] getOrCreateFolder 5회 호출 전/후 하위 폴더 개수: ' + beforeCount + ' / ' + afterCount + ' (같아야 OK)');

  // 케이스 C: 다른 prefix(다른 초)와 섞여 있어도 영향 없는지
  var otherPrefix = '1_전_2층_1-14_093016';
  for (var k = 0; k < 3; k++) {
    var s = findNextSeq_(locFolder, otherPrefix);
    var n = otherPrefix + '_' + padSeq_(s) + '.jpg';
    locFolder.createFile(Utilities.newBlob(tinyBytes, 'image/png', n));
  }
  // 다시 원래 prefix로 추가 시 _006부터 와야 함
  var followupSeq = findNextSeq_(locFolder, prefix);
  Logger.log('[케이스 C] 다른 prefix 3장 추가 후 원래 prefix 다음 번호 (6 기대): ' + followupSeq);

  // 정리
  testRoot.setTrashed(true);
  Logger.log('테스트 폴더 휴지통 이동 완료. 결과는 위 로그를 확인하세요.');
}

function countSubfolders_(folder) {
  var n = 0;
  var it = folder.getFolders();
  while (it.hasNext()) { it.next(); n++; }
  return n;
}

// ===== 마이그레이션 (구 구조 → 신 구조) =====
// 한 번만 사용. 필요 없으면 아래 블록 전체 삭제 가능.

var LOCATION_ORDER = [
  { floor: '2층', name: '1-14' }, { floor: '2층', name: '1-13' },
  { floor: '2층', name: '1-12' }, { floor: '2층', name: '1-11' },
  { floor: '2층', name: '1-10' }, { floor: '2층', name: '1-9' },
  { floor: '2층', name: '1-8' },  { floor: '2층', name: '1-7' },
  { floor: '2층', name: '1-6' },  { floor: '2층', name: '1-5' },
  { floor: '3층', name: '2-5' },  { floor: '3층', name: '2-4' },
  { floor: '3층', name: '2-3' },  { floor: '3층', name: '2-2' },
  { floor: '3층', name: '2-1' },  { floor: '3층', name: '1-1' },
  { floor: '3층', name: '1-2' },  { floor: '3층', name: '1-3' },
  { floor: '3층', name: '1-4' },
  { floor: '1층', name: '여자화장실' },
  { floor: '1층', name: '중앙화장실' },
  { floor: '1층', name: '우측화장실' },
];

function findNewFolderName_(floor, locationName) {
  for (var i = 0; i < LOCATION_ORDER.length; i++) {
    if (LOCATION_ORDER[i].floor === floor && LOCATION_ORDER[i].name === locationName) {
      return String(i + 1).padStart(2, '0') + '_' + floor + '_' + locationName;
    }
  }
  return null;
}

function migrateDate(date) {
  if (!date) throw new Error('date 인자 필요. 예: migrateDate("2026-04-29")');
  var parentId = getProp_('PARENT_FOLDER_ID');
  if (!parentId) throw new Error('PARENT_FOLDER_ID 미설정');
  var root = DriveApp.getFolderById(parentId);
  var dateIt = root.getFoldersByName(date);
  if (!dateIt.hasNext()) {
    Logger.log('해당 날짜 폴더 없음: ' + date);
    return;
  }
  var dateFolder = dateIt.next();
  var movedFiles = 0, skipped = 0;
  var floorsToCleanup = [];
  var floorIt = dateFolder.getFolders();
  while (floorIt.hasNext()) {
    var floorFolder = floorIt.next();
    var floorName = floorFolder.getName();
    if (/^\d{2}_/.test(floorName)) { skipped++; continue; }

    var locFoldersToCleanup = [];
    var locIt = floorFolder.getFolders();
    while (locIt.hasNext()) {
      var locFolder = locIt.next();
      var newName = findNewFolderName_(floorName, locFolder.getName());
      if (!newName) { Logger.log('매핑 못 찾음: ' + floorName + '/' + locFolder.getName()); continue; }
      var newFolder = getOrCreateFolder_(dateFolder, newName);
      var ids = [];
      var fIt = locFolder.getFiles();
      while (fIt.hasNext()) ids.push(fIt.next().getId());
      for (var i = 0; i < ids.length; i++) { DriveApp.getFileById(ids[i]).moveTo(newFolder); movedFiles++; }
      locFoldersToCleanup.push(locFolder);
    }
    for (var j = 0; j < locFoldersToCleanup.length; j++) {
      var lf = locFoldersToCleanup[j];
      if (!lf.getFiles().hasNext() && !lf.getFolders().hasNext()) lf.setTrashed(true);
    }
    floorsToCleanup.push(floorFolder);
  }
  for (var k = 0; k < floorsToCleanup.length; k++) {
    var ff = floorsToCleanup[k];
    if (!ff.getFiles().hasNext() && !ff.getFolders().hasNext()) ff.setTrashed(true);
  }
  Logger.log('이동 파일: ' + movedFiles + '개 / 신 구조 폴더 유지: ' + skipped + '개');
}

function testMigrate() { migrateDate('2026-04-29'); }
