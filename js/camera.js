/* ===============================================
   camera.js - 카메라 입력 + 이미지 리사이즈 + 시간/파일명 유틸
   - Canvas API로 긴 변 1920px / JPEG 80% 압축
   - KST 시간은 Intl.DateTimeFormat로 안전하게 추출
   - 파일명 규칙: {정렬숫자}_{전후}_{층}_{장소}_{HHmmss}_{NNN}.jpg
   =============================================== */

const Camera = (() => {
  // ---------- KST 시간 ----------
  function getKstParts(date = new Date()) {
    // Intl로 'Asia/Seoul' 시간을 안전하게 추출 (로컬 시간대와 무관)
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const map = {};
    for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
    if (map.hour === '24') map.hour = '00'; // hour12:false 보정
    return {
      yyyy: map.year,
      mm:   map.month,
      dd:   map.day,
      hh:   map.hour,
      mi:   map.minute,
      ss:   map.second,
    };
  }

  function todayKST(date = new Date()) {
    const { yyyy, mm, dd } = getKstParts(date);
    return `${yyyy}-${mm}-${dd}`;
  }

  function timeKST(date = new Date()) {
    const { hh, mi, ss } = getKstParts(date);
    return `${hh}${mi}${ss}`;
  }

  // ---------- 이미지 리사이즈 ----------
  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error('이미지 로딩 실패'));
      img.src = src;
    });
  }

  /** 긴 변 maxSide / JPEG quality 로 압축 */
  async function resize(file, { maxSide = 1920, quality = 0.8 } = {}) {
    const dataURL = await readAsDataURL(file);
    const img = await loadImage(dataURL);

    let { width, height } = img;
    const longest = Math.max(width, height);
    if (longest > maxSide) {
      const ratio = maxSide / longest;
      width  = Math.round(width  * ratio);
      height = Math.round(height * ratio);
    }

    const canvas = document.createElement('canvas');
    canvas.width  = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);

    const blob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
    });
    const resizedDataURL = canvas.toDataURL('image/jpeg', quality);

    return {
      blob,
      dataURL:      resizedDataURL,
      width,
      height,
      originalSize: file.size,
      resizedSize:  blob ? blob.size : 0,
      originalName: file.name,
      mimeType:     'image/jpeg',
    };
  }

  // ---------- 파일명 규칙 ----------
  /**
   * 새 파일명 규칙: {정렬숫자}_{전후}_{층}_{장소}_{HHmmss}_{NNN}.jpg
   * 예) 1_전_2층_1-14_093015_001.jpg
   *     2_후_1층_여자화장실_113045_001.jpg
   */
  function makeFilename({ phase, floor, locationName, seq = 1, date = new Date() }) {
    const sortNum  = phase === 'before' ? '1' : '2';
    const phaseKor = phase === 'before' ? '전' : '후';
    const time     = timeKST(date);
    const nnn      = String(seq).padStart(3, '0');
    return `${sortNum}_${phaseKor}_${floor}_${locationName}_${time}_${nnn}.jpg`;
  }

  // ---------- Blob → base64 (api.js에서도 쓰지만 여기 두기) ----------
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        const idx = result.indexOf(',');
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  return {
    resize,
    makeFilename,
    todayKST,
    timeKST,
    getKstParts,
    blobToBase64,
  };
})();
