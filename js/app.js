/* ===============================================
   app.js - 메인 앱 로직 (3단계: PIN 인증 추가)
   - 화면 라우팅: PIN / 홈 / 장소 상세 / 카메라
   - 시작 시 토큰 없으면 PIN 화면, 있으면 홈
   - PIN 4자리 키패드, 흔들림 효과, 자동 로그인(30일)
   - 로그아웃 버튼 (홈 우측 상단)
   =============================================== */

const App = (() => {
  // ---------- 상태 ----------
  const state = {
    locations:       [],
    floorOrder:      [],
    floorLabels:     {},
    selected:        null,
    phase:           null,
    photos:          [],
    today:           '',
    statusMap:       {},
    uploading:       false,
    locationPhotos:  [], // 현재 선택된 장소의 오늘 사진들
    lightbox: {
      open:   false,
      list:   [],
      index:  0,
      touchStartX: 0,
      touchStartY: 0,
    },
  };

  const pinState = {
    buffer: '',
    busy:   false,
  };

  // ---------- DOM 핸들 ----------
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ---------- 유틸 ----------
  function formatTodayLabel(yyyymmdd) {
    const [y, m, d] = yyyymmdd.split('-');
    return `${y}년 ${parseInt(m, 10)}월 ${parseInt(d, 10)}일`;
  }
  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  // locations.json 배열 순서 → '{seq}_{floor}_{name}'
  function getLocationIndex(loc) {
    return state.locations.findIndex((l) => l.id === loc.id);
  }
  function getFolderName(loc) {
    const idx = getLocationIndex(loc);
    if (idx < 0) return `__미지정_${loc.floor}_${loc.name}`;
    return `${String(idx + 1).padStart(2, '0')}_${loc.floor}_${loc.name}`;
  }

  // ---------- 데이터 로드 ----------
  async function loadLocations() {
    const res = await fetch('./js/locations.json', { cache: 'no-cache' });
    const data = await res.json();
    state.locations   = data.locations   || [];
    state.floorOrder  = data.floorOrder  || [];
    state.floorLabels = data.floorLabels || {};
  }

  async function refreshStatus() {
    try {
      if (!Api.getApiUrl()) {
        state.statusMap = {};
        return;
      }
      const res = await Api.getStatus(state.today);
      state.statusMap = res.locations || {};
    } catch (err) {
      if (err && err.code === 'AUTH_REQUIRED') {
        showPinScreen('인증이 만료되었습니다. 다시 로그인해주세요.');
        throw err;
      }
      console.warn('[status 조회 실패]', err);
      state.statusMap = {};
    }
  }

  // ---------- 화면 전환 ----------
  function showScreen(name) {
    $$('.screen').forEach((el) => el.classList.add('hidden'));
    const target = document.getElementById(`screen-${name}`);
    if (target) target.classList.remove('hidden');
    window.scrollTo(0, 0);
  }

  // ---------- PIN 화면 ----------
  function showPinScreen(message) {
    pinState.buffer = '';
    pinState.busy = false;
    renderPinDisplay();
    setKeypadBusy(false);
    if (message) setPinMessage(message, 'info');
    else setPinMessage('');
    showScreen('pin');
  }

  function renderPinDisplay() {
    const dots = $$('#pin-display .pin-dot');
    dots.forEach((d, i) => {
      d.classList.toggle('filled', i < pinState.buffer.length);
    });
  }

  // type: undefined → 에러(빨강) / 'info' → 회색 / 'loading' → 회색 + 스피너
  function setPinMessage(msg, type) {
    const el = $('#pin-message');
    el.textContent = msg;
    el.classList.remove('info', 'loading');
    if (type === 'info' || type === 'loading') el.classList.add(type);
  }

  // 처리 중일 때 키패드/도트를 시각적으로 비활성화
  function setKeypadBusy(isBusy) {
    const keypad  = $('.pin-keypad');
    const display = $('#pin-display');
    if (keypad)  keypad.classList.toggle('busy',  isBusy);
    if (display) display.classList.toggle('busy', isBusy);
    $$('.pin-key').forEach((k) => { k.disabled = isBusy; });
  }

  function pinPressDigit(digit) {
    if (pinState.busy) return;
    if (pinState.buffer.length >= 4) return;
    pinState.buffer += digit;
    setPinMessage('');
    renderPinDisplay();
    if (pinState.buffer.length === 4) {
      submitPin();
    }
  }

  function pinBackspace() {
    if (pinState.busy) return;
    pinState.buffer = pinState.buffer.slice(0, -1);
    setPinMessage('');
    renderPinDisplay();
  }

  async function submitPin() {
    pinState.busy = true;
    setKeypadBusy(true);
    setPinMessage('확인 중…', 'loading');

    // 콜드 스타트 대비 단계별 안내. 응답 도착 시 모두 취소.
    const slowTimer = setTimeout(() => {
      setPinMessage('잠시만 기다려주세요…', 'loading');
    }, 1500);
    const coldTimer = setTimeout(() => {
      setPinMessage('서버가 깨어나는 중입니다…', 'loading');
    }, 5000);
    const clearTimers = () => {
      clearTimeout(slowTimer);
      clearTimeout(coldTimer);
    };

    try {
      const res = await Auth.login(pinState.buffer);
      clearTimers();
      if (res && res.success) {
        // 성공: 도트(●●●●)는 그대로 유지. 화면이 home으로 바뀌면 자연스럽게 사라진다.
        // afterLogin에서 status 조회로 약간 더 대기할 수 있어 메시지/스피너도 그대로 둔다.
        await afterLogin();
        // 화면 전환 후 다음 PIN 진입을 위해 정리
        pinState.buffer = '';
        renderPinDisplay();
        setPinMessage('');
      } else {
        pinFailed((res && res.error) || 'PIN이 틀렸습니다');
      }
    } catch (err) {
      clearTimers();
      pinFailed(err.message || 'PIN 확인 실패');
    } finally {
      pinState.busy = false;
      setKeypadBusy(false);
    }
  }

  function pinFailed(msg) {
    const display = $('#pin-display');
    display.classList.remove('shake');
    // reflow로 애니메이션 재시작
    void display.offsetWidth;
    display.classList.add('shake');
    setTimeout(() => display.classList.remove('shake'), 500);

    pinState.buffer = '';
    renderPinDisplay();
    setPinMessage(msg); // 기본(빨강)
  }

  async function afterLogin() {
    state.today = Camera.todayKST();
    try {
      await refreshStatus();
    } catch (err) {
      // refreshStatus에서 AUTH_REQUIRED 시 이미 PIN 화면 복귀 처리됨
      if (err && err.code === 'AUTH_REQUIRED') return;
    }
    renderHome();
    showScreen('home');
  }

  // ---------- 홈 렌더 ----------
  function renderHome() {
    state.today = Camera.todayKST();
    $('#today-label').textContent = formatTodayLabel(state.today);

    const container = $('#floors-container');
    container.innerHTML = '';

    state.floorOrder.forEach((floor) => {
      const items = state.locations.filter((l) => l.floor === floor);
      if (items.length === 0) return;

      const section = document.createElement('section');
      section.className = 'floor-section';

      const title = document.createElement('h2');
      title.textContent = state.floorLabels[floor] || floor;
      section.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'location-grid';

      items.forEach((loc) => {
        const stat = state.statusMap[getFolderName(loc)] || { before: 0, after: 0 };
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'location-card';
        card.dataset.locationId = loc.id;
        card.innerHTML = `
          <div class="name">${loc.name}</div>
          <div class="stats">Before ${stat.before}장 / After ${stat.after}장</div>
          <div class="dots">
            <span class="dot ${stat.before > 0 ? 'before-done' : ''}" title="Before"></span>
            <span class="dot ${stat.after  > 0 ? 'after-done'  : ''}" title="After"></span>
          </div>
        `;
        card.addEventListener('click', () => onSelectLocation(loc));
        grid.appendChild(card);
      });

      section.appendChild(grid);
      container.appendChild(section);
    });
  }

  // ---------- 장소/Phase ----------
  function onSelectLocation(loc) {
    state.selected = loc;
    $('#location-title').textContent    = loc.name;
    $('#location-subtitle').textContent = state.floorLabels[loc.floor] || loc.floor;
    state.locationPhotos = [];
    renderLocationPhotos();
    showScreen('location');
    refreshLocationPhotos();
  }

  // ---------- 오늘 사진 목록 ----------
  async function refreshLocationPhotos({ silent = false } = {}) {
    if (!state.selected) return;
    if (!Auth.isAuthenticated()) { showPinScreen('PIN을 다시 입력해주세요.'); return; }
    const refreshBtn = document.querySelector('[data-action="refresh-photos"]');
    if (refreshBtn && !silent) refreshBtn.classList.add('spinning');
    try {
      const res = await Api.listPhotos(state.today, getFolderName(state.selected));
      state.locationPhotos = res.photos || [];
      renderLocationPhotos();
    } catch (err) {
      if (err && err.code === 'AUTH_REQUIRED') {
        showPinScreen('PIN을 다시 입력해주세요.');
        return;
      }
      console.warn('[사진 목록 조회 실패]', err);
      // 조용히 실패 — 빈 그리드로 보임
    } finally {
      if (refreshBtn) refreshBtn.classList.remove('spinning');
    }
  }

  function renderLocationPhotos() {
    const before = state.locationPhotos.filter((p) => p.phase === 'before');
    const after  = state.locationPhotos.filter((p) => p.phase === 'after');
    fillPhotoGroup('before', before);
    fillPhotoGroup('after',  after);
  }

  function fillPhotoGroup(phase, photos) {
    const group = document.getElementById(`photo-group-${phase}`);
    const grid  = document.getElementById(`grid-${phase}`);
    const count = document.getElementById(`count-${phase}`);
    count.textContent = String(photos.length);
    group.classList.toggle('has-items', photos.length > 0);
    grid.innerHTML = '';
    photos.forEach((p, idxInPhase) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'photo-item loading';
      btn.dataset.fileId = p.fileId;
      btn.innerHTML = `
        <img alt="${p.fileName}" />
        <span class="photo-time">${p.time}</span>
      `;
      const img = btn.querySelector('img');

      // 썸네일은 프록시로 받아 Blob URL로 표시
      Api.getPhotoBlobUrl(p.fileId, 'thumb')
        .then((url) => {
          img.onload = () => btn.classList.remove('loading');
          img.onerror = () => { btn.classList.remove('loading'); btn.classList.add('broken'); };
          img.src = url;
        })
        .catch((err) => {
          if (err && err.code === 'AUTH_REQUIRED') {
            showPinScreen('PIN을 다시 입력해주세요.');
            return;
          }
          console.warn('[썸네일 로딩 실패]', p.fileId, err);
          btn.classList.remove('loading');
          btn.classList.add('broken');
        });

      btn.addEventListener('click', () => openLightbox(phase, idxInPhase));
      grid.appendChild(btn);
    });
  }

  // ---------- 라이트박스 ----------
  function openLightbox(phase, indexInPhase) {
    const list = state.locationPhotos.filter((p) => p.phase === phase);
    if (list.length === 0) return;
    state.lightbox.open = true;
    state.lightbox.list = list;
    state.lightbox.index = Math.max(0, Math.min(indexInPhase, list.length - 1));
    renderLightbox();
    $('#lightbox').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    state.lightbox.open = false;
    $('#lightbox').classList.add('hidden');
    document.body.style.overflow = '';
    $('#lightbox-img').src = '';
  }

  function lightboxNext() {
    if (!state.lightbox.open) return;
    if (state.lightbox.index < state.lightbox.list.length - 1) {
      state.lightbox.index++;
      renderLightbox();
    }
  }
  function lightboxPrev() {
    if (!state.lightbox.open) return;
    if (state.lightbox.index > 0) {
      state.lightbox.index--;
      renderLightbox();
    }
  }

  function renderLightbox() {
    const lb = state.lightbox;
    const p  = lb.list[lb.index];
    if (!p) return;
    const img = $('#lightbox-img');
    const loading = $('#lightbox-loading');
    loading.textContent = '불러오는 중…';
    loading.classList.remove('hidden');
    img.style.opacity = '0.0';
    img.onload  = null;
    img.onerror = null;
    img.src = '';

    // 풀 사이즈는 프록시로 받음. 캐시 hit이면 즉시.
    Api.getPhotoBlobUrl(p.fileId, 'full')
      .then((url) => {
        // 인덱스가 그 사이 바뀌었으면 무시 (스와이프 빠르게 했을 때)
        if (state.lightbox.list[state.lightbox.index] !== p) return;
        img.onload  = () => { loading.classList.add('hidden'); img.style.opacity = '1'; };
        img.onerror = () => { loading.textContent = '사진을 불러오지 못했습니다.'; img.style.opacity = '0'; };
        img.src = url;
      })
      .catch((err) => {
        if (err && err.code === 'AUTH_REQUIRED') {
          closeLightbox();
          showPinScreen('PIN을 다시 입력해주세요.');
          return;
        }
        loading.textContent = '사진을 불러오지 못했습니다.';
        img.style.opacity = '0';
      });

    const phaseKor = p.phase === 'before' ? '모임 전' : '모임 후';
    $('#lightbox-meta').textContent = `${phaseKor} · ${p.time} · (${lb.index + 1}/${lb.list.length})`;
    $('.lightbox-prev').classList.toggle('disabled', lb.index === 0);
    $('.lightbox-next').classList.toggle('disabled', lb.index === lb.list.length - 1);
  }

  async function deleteCurrentPhoto() {
    if (!state.lightbox.open) return;
    const p = state.lightbox.list[state.lightbox.index];
    if (!p) return;
    const phaseKor = p.phase === 'before' ? '모임 전' : '모임 후';
    if (!confirm(`이 사진을 삭제하시겠습니까?\n${phaseKor} · ${p.time}\n(휴지통으로 이동되며 30일 안에 복구 가능)`)) return;
    try {
      await Api.deletePhoto(p.fileId);
      Api.removeFromPhotoCache(p.fileId);
      // 로컬 상태에서 제거
      state.locationPhotos = state.locationPhotos.filter((x) => x.fileId !== p.fileId);
      state.lightbox.list  = state.lightbox.list.filter((x) => x.fileId !== p.fileId);
      // 인덱스 보정
      if (state.lightbox.index >= state.lightbox.list.length) {
        state.lightbox.index = state.lightbox.list.length - 1;
      }
      renderLocationPhotos();
      // 홈 카드 카운트도 갱신
      refreshStatus().then(() => renderHome()).catch(() => {});
      if (state.lightbox.list.length === 0) closeLightbox();
      else renderLightbox();
    } catch (err) {
      if (err && err.code === 'AUTH_REQUIRED') {
        closeLightbox();
        showPinScreen('PIN을 다시 입력해주세요.');
        return;
      }
      alert('삭제 실패: ' + (err.message || err));
    }
  }

  function onSelectPhase(phase) {
    state.phase  = phase;
    state.photos = [];
    const phaseKor = phase === 'before' ? '모임 전' : '모임 후';
    $('#camera-title').textContent    = `${state.selected.name} · ${phaseKor}`;
    $('#camera-subtitle').textContent = state.floorLabels[state.selected.floor] || state.selected.floor;
    renderPreview();
    showScreen('camera');
  }

  // ---------- 카메라 ----------
  function openCamera() {
    if (state.uploading) return;
    const input = $('#file-input');
    input.value = '';
    input.click();
  }

  async function onFilesSelected(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    for (const file of files) {
      try {
        const result = await Camera.resize(file, { maxSide: 1920, quality: 0.8 });
        state.photos.push({
          id:           uid(),
          blob:         result.blob,
          dataURL:      result.dataURL,
          width:        result.width,
          height:       result.height,
          originalSize: result.originalSize,
          resizedSize:  result.resizedSize,
          mimeType:     result.mimeType,
          status:       'pending',
          error:        null,
          fileUrl:      null,
        });
      } catch (err) {
        console.error('[리사이즈 실패]', file.name, err);
        alert(`사진 처리 실패: ${file.name}`);
      }
    }
    renderPreview();
  }

  // ---------- 미리보기 ----------
  function renderPreview() {
    const empty   = $('#preview-empty');
    const grid    = $('#preview-grid');
    const addMore = $('#add-more-btn');
    const footer  = $('#upload-footer');
    const label   = $('#upload-btn-label');
    const upBtn   = $('#upload-btn');

    if (state.photos.length === 0) {
      empty.classList.remove('hidden');
      grid.classList.add('hidden');
      addMore.classList.add('hidden');
      footer.classList.add('hidden');
      grid.innerHTML = '';
      return;
    }

    empty.classList.add('hidden');
    grid.classList.remove('hidden');
    addMore.classList.remove('hidden');
    footer.classList.remove('hidden');

    grid.innerHTML = '';
    state.photos.forEach((p) => {
      const card = document.createElement('div');
      card.className = `preview-card status-${p.status}`;
      const sizeKB = (p.resizedSize / 1024).toFixed(0);
      card.innerHTML = `
        <img src="${p.dataURL}" alt="" />
        <div class="file-info">${sizeKB} KB · ${p.width}×${p.height}</div>
        <div class="status-overlay">
          <span class="status-badge"></span>
          <span class="status-text"></span>
        </div>
        <button class="remove-btn" aria-label="삭제" data-id="${p.id}">✕</button>
      `;
      const text = card.querySelector('.status-text');
      const removeBtn = card.querySelector('.remove-btn');
      if (p.status === 'uploading') text.textContent = '업로드 중…';
      else if (p.status === 'done') text.textContent = '완료';
      else if (p.status === 'failed') text.textContent = '실패';
      else text.textContent = '';
      if (state.uploading) removeBtn.disabled = true;
      removeBtn.addEventListener('click', () => removePhoto(p.id));
      grid.appendChild(card);
    });

    const remaining = state.photos.filter(p => p.status !== 'done').length;
    if (state.uploading) {
      const totalToUpload = state.photos.filter(p => p.status === 'uploading' || p.status === 'pending' || p.status === 'failed').length;
      const doneNow       = state.photos.filter(p => p.status === 'done').length;
      label.textContent = `업로드 중… ${doneNow}/${doneNow + totalToUpload}`;
      upBtn.disabled = true;
      addMore.style.display = 'none';
    } else {
      const failed = state.photos.filter(p => p.status === 'failed').length;
      label.textContent = failed > 0 ? `재시도 (${failed}장)` : `사진 ${remaining}장 업로드`;
      upBtn.disabled = remaining === 0;
      addMore.style.display = '';
    }
  }

  function removePhoto(id) {
    if (state.uploading) return;
    state.photos = state.photos.filter((p) => p.id !== id);
    renderPreview();
  }

  // ---------- 업로드 ----------
  async function onUpload() {
    if (state.uploading) return;
    if (!Api.getApiUrl()) {
      alert(
        'API URL이 아직 설정되지 않았습니다.\n' +
        "콘솔에서 localStorage.setItem('API_URL_OVERRIDE', '...') 또는 js/api.js의 API_URL 상수를 수정하세요."
      );
      return;
    }
    if (!Auth.isAuthenticated()) {
      showPinScreen('PIN을 다시 입력해주세요.');
      return;
    }

    state.uploading = true;
    const targets = state.photos.filter(p => p.status !== 'done');
    targets.forEach(p => { p.status = 'pending'; p.error = null; });
    renderPreview();

    const batchDate = new Date();
    const folderName = getFolderName(state.selected);

    let success = 0, fail = 0;
    let seq = 1;
    let authBroken = false;

    for (const photo of targets) {
      if (authBroken) {
        photo.status = 'failed';
        photo.error  = '인증 만료';
        fail++;
        renderPreview();
        continue;
      }
      photo.status = 'uploading';
      renderPreview();

      const filename = Camera.makeFilename({
        phase:        state.phase,
        floor:        state.selected.floor,
        locationName: state.selected.name,
        seq:          seq++,
        date:         batchDate,
      });

      const payload = {
        date:     state.today,
        folderName,
        filename,
        mimeType: photo.mimeType,
        blob:     photo.blob,
      };

      try {
        const res = await Api.uploadPhoto(payload);
        photo.status  = 'done';
        photo.fileUrl = res.fileUrl;
        success++;
      } catch (err) {
        if (err && err.code === 'AUTH_REQUIRED') {
          authBroken = true;
          photo.status = 'failed';
          photo.error  = '인증 만료';
          fail++;
        } else {
          // 1회 자동 재시도
          console.warn('[업로드 실패, 1회 재시도]', filename, err);
          try {
            const res = await Api.uploadPhoto(payload);
            photo.status  = 'done';
            photo.fileUrl = res.fileUrl;
            success++;
          } catch (err2) {
            if (err2 && err2.code === 'AUTH_REQUIRED') {
              authBroken = true;
              photo.status = 'failed';
              photo.error  = '인증 만료';
            } else {
              photo.status = 'failed';
              photo.error  = err2.message;
            }
            fail++;
          }
        }
      }
      renderPreview();
    }

    state.uploading = false;
    renderPreview();

    if (authBroken) {
      alert('인증이 만료되었습니다. PIN을 다시 입력해주세요.');
      showPinScreen('PIN을 다시 입력해주세요.');
      return;
    }

    if (fail === 0) {
      try { await refreshStatus(); } catch (e) { /* 인증 만료 시 이미 PIN으로 이동 */ }
      try { await refreshLocationPhotos({ silent: true }); } catch (e) { /* 무시 */ }
      renderHome();
      alert(`업로드 완료! (${success}장)`);
      state.photos = [];
      renderPreview();
      // 업로드된 사진이 곧바로 보이도록 장소 상세 화면으로 복귀
      showScreen('location');
    } else {
      alert(
        `완료: ${success}장 / 실패: ${fail}장\n\n` +
        `실패한 사진은 화면에 남아있습니다. 하단 "재시도" 버튼으로 다시 시도하세요.`
      );
    }
  }

  // ---------- 로그아웃 ----------
  function onLogout() {
    if (state.uploading) {
      alert('업로드 중에는 로그아웃할 수 없습니다.');
      return;
    }
    if (!confirm('로그아웃 하시겠습니까?')) return;
    Auth.logout();
    Api.clearPhotoCache();
    state.statusMap      = {};
    state.locationPhotos = [];
    state.selected       = null;
    state.photos         = [];
    showPinScreen();
  }

  // ---------- 이벤트 바인딩 ----------
  function bindEvents() {
    document.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      const action = target?.dataset.action;
      if (action === 'back-to-home') {
        if (state.uploading) return;
        state.selected = null;
        renderHome();
        showScreen('home');
      } else if (action === 'back-to-location') {
        if (state.uploading) return;
        state.photos = [];
        renderPreview();
        showScreen('location');
      } else if (action === 'open-camera') {
        openCamera();
      } else if (action === 'logout') {
        onLogout();
      } else if (action === 'refresh-photos') {
        refreshLocationPhotos();
      } else if (action === 'lightbox-close') {
        closeLightbox();
      } else if (action === 'lightbox-prev') {
        lightboxPrev();
      } else if (action === 'lightbox-next') {
        lightboxNext();
      } else if (action === 'lightbox-delete') {
        deleteCurrentPhoto();
      }
    });

    // 라이트박스 배경 클릭으로 닫기 (이미지/버튼 클릭은 제외)
    $('#lightbox').addEventListener('click', (e) => {
      if (e.target.id === 'lightbox' || e.target.classList.contains('lightbox-stage')) {
        closeLightbox();
      }
    });

    // 라이트박스 좌우 스와이프
    const lb = $('#lightbox');
    lb.addEventListener('touchstart', (e) => {
      if (!state.lightbox.open) return;
      state.lightbox.touchStartX = e.touches[0].clientX;
      state.lightbox.touchStartY = e.touches[0].clientY;
    }, { passive: true });
    lb.addEventListener('touchend', (e) => {
      if (!state.lightbox.open) return;
      const dx = e.changedTouches[0].clientX - state.lightbox.touchStartX;
      const dy = e.changedTouches[0].clientY - state.lightbox.touchStartY;
      // 가로 스와이프가 세로보다 명확할 때만
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        if (dx > 0) lightboxPrev(); else lightboxNext();
      }
    }, { passive: true });

    // 라이트박스 키보드 (데스크톱)
    document.addEventListener('keydown', (e) => {
      if (!state.lightbox.open) return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft')  lightboxPrev();
      else if (e.key === 'ArrowRight') lightboxNext();
    });

    $$('.phase-btn').forEach((btn) => {
      btn.addEventListener('click', () => onSelectPhase(btn.dataset.phase));
    });

    $('#file-input').addEventListener('change', (e) => onFilesSelected(e.target.files));
    $('#upload-btn').addEventListener('click', onUpload);

    // PIN 키패드
    document.addEventListener('click', (e) => {
      const digitBtn = e.target.closest('[data-pin-digit]');
      if (digitBtn) { pinPressDigit(digitBtn.dataset.pinDigit); return; }
      const actionBtn = e.target.closest('[data-pin-action]');
      if (actionBtn && actionBtn.dataset.pinAction === 'backspace') { pinBackspace(); return; }
    });

    // 데스크톱: 키보드로도 PIN 입력 가능 (편의)
    document.addEventListener('keydown', (e) => {
      if ($('#screen-pin').classList.contains('hidden')) return;
      if (/^[0-9]$/.test(e.key)) { pinPressDigit(e.key); }
      else if (e.key === 'Backspace') { pinBackspace(); }
    });
  }

  // ---------- 시작 ----------
  async function init() {
    try {
      await loadLocations();
      state.today = Camera.todayKST();
      bindEvents();

      // 1) 이미 로그인된 토큰이 있으면 바로 홈으로
      if (Auth.isAuthenticated()) {
        await afterLogin();
        return;
      }

      // 2) 토큰 없음 — 백엔드의 PIN 설정 여부 확인하여
      //    개발 모드(PIN 미설정)면 PIN 화면 스킵하고 dev 토큰 자동 발급
      try {
        const ping = await Api.ping();
        if (ping && ping.pinRequired === false) {
          Auth.setToken('dev', Date.now() + 30 * 24 * 60 * 60 * 1000);
          await afterLogin();
          return;
        }
      } catch (e) {
        console.warn('[ping 실패]', e);
        // 그래도 PIN 화면을 띄움
      }

      showPinScreen();
      console.log('[App 시작]', {
        오늘:    state.today,
        장소수:  state.locations.length,
        API_URL: Api.getApiUrl() || '(미설정)',
      });
    } catch (err) {
      console.error('[초기화 실패]', err);
      alert('앱 초기화에 실패했습니다. 새로고침 해주세요.');
    }
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
