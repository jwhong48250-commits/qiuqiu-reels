/**
 * ------------------------------------------------------------
 * 구조/데이터 흐름 설계 (먼저 읽고 구현)
 * ------------------------------------------------------------
 *
 * [UI]
 * - <video> : getUserMedia로 받은 웹캠 스트림을 렌더링
 * - <canvas>: 같은 크기로 오버레이, 손 랜드마크/연결선 드로잉
 * - 다크 테마, 중앙 배치, "셀피처럼" 보이도록 화면은 좌우 반전(미러링) 처리
 *
 * [데이터 흐름]
 * 1) 사용자가 Start 버튼 클릭
 *    - 카메라 권한 요청 및 스트림 연결
 *    - 오디오 정책 대응: 클릭 이벤트로 오디오를 "언락" (play가 막히지 않도록)
 * 2) MediaPipe Hands 초기화
 *    - CameraUtils로 매 프레임 video를 Hands로 전달
 * 3) onResults(results) 콜백에서
 *    - 캔버스 클리어 및 랜드마크/커넥션 드로잉
 *    - results.multiHandedness로 Left/Right 구분
 *      * 주의: UI는 미러링되어 보이지만, 모델 라벨은 원본 이미지 기준.
 *      * 따라서 MIRROR_VIEW=true인 경우, 사용자 관점의 좌/우와 맞추기 위해 라벨을 스왑.
 *    - 각 손별로 fist 제스처 판별 (tip-손목 거리 기반 + 손 크기 정규화)
 *    - 상태 플래그(isLeftFist/isRightFist)로 "쥐는 순간"만 1회 오디오 트리거
 *
 * [핵심 모듈]
 * - setupCamera(video): getUserMedia + video 재생
 * - initHands(onResults): MediaPipe Hands 생성/옵션/콜백 연결
 * - isFist(landmarks): 주먹 판별(정규화된 거리 임계값)
 * - triggerAudioOnce(label, fistNow): 상태 전이 감지 후 audio.play()
 * ------------------------------------------------------------
 */

// ====== Config ======
const MIRROR_VIEW = true; // CSS에서 video/canvas를 scaleX(-1) 처리한 것과 일치
const FIST_THRESHOLD = 0.55; // (tip→wrist 거리) / (손크기) 가 이 값보다 작으면 "접힘"으로 간주
const MIN_CONFIDENCE = 0.6;

// ====== DOM ======
const videoEl = document.getElementById('video');
const canvasEl = document.getElementById('canvas');
const ctx = canvasEl.getContext('2d');
const hudEl = document.getElementById('hud');
const gateEl = document.getElementById('gate');
const startBtn = document.getElementById('startBtn');
const audioLeft = document.getElementById('audioLeft');   // sound1.mp3
const audioRight = document.getElementById('audioRight'); // sound2.mp3
const audioVictory = document.getElementById('audioVictory'); // sound3.mp3

// ====== State (debounce / edge-trigger) ======
let isLeftFist = false;
let isRightFist = false;
let lastFrameAt = performance.now();

/**
 * ------------------------------------------------------------
 * 텍스트 시퀀스 게임: 상태/제어 로직 설계
 * ------------------------------------------------------------
 *
 * [상태 변수]
 * - targetString: "촵츄촵촵츄촵츄촵촵츄"
 * - currentIndex: 현재 처리해야 할 글자 인덱스
 * - leftReady/rightReady: "손을 폈다가 다시 쥐어야 다음 입력 인정"을 위한 동작 완료 플래그
 *   - fistNow가 false(폈음)인 프레임에서 ready=true로 '재장전'
 *   - fistNow가 true로 바뀌는 순간(edge) + ready=true 일 때만 1회 입력 이벤트로 처리
 * - pendingVictory: 마지막 글자('츄') 성공 시, 그 sound1이 끝나는 시점(ended)에서 sound3 자동 재생 예약
 *
 * [입력 규칙]
 * - target[currentIndex] === '촵'  → 오른손 주먹(= Right fist edge) 성공
 * - target[currentIndex] === '츄'  → 왼손 주먹(= Left fist edge) 성공
 * - 그 외 입력(반대손 주먹 edge) → 즉시 리셋(currentIndex=0)
 *
 * [오디오/빠른 템포(Interrupt) 제어]
 * - Lock(무시) 대신 Interrupt(즉시 개입) 방식:
 *   - 올바른 입력이 들어오면, 재생 중이던 오디오(좌/우/승리)를 즉시 pause + currentTime=0 으로 끊고
 *     새 오디오를 play()
 * - 무한 중복 재생 방지:
 *   - leftReady/rightReady(손을 폈다가 다시 쥐어야 재장전)로 edge 입력을 1회로 제한
 *   - 따라서 주먹 유지 중 프레임마다 다다다 재생되지 않음
 *
 * [프레임 처리 흐름]
 * - onResults:
 *   - 각 손의 fistNow 계산
 *   - edge(OFF→ON) 감지 및 ready 기반으로 (leftPunch / rightPunch) 이벤트 추출
 *   - 프레임 내 이벤트가 있으면 processGameInput()에서 1개만 처리
 * ------------------------------------------------------------
 */

// ====== Text sequence game state ======
const targetString = '촵츄촵촵츄촵츄촵촵츄';
let currentIndex = 0;
let leftReady = true;
let rightReady = true;
let pendingVictory = false;
let isFinishing = false;
let victoryTimeoutId = null;

const gameLineEl = document.getElementById('gameLine');
const gameHintEl = document.getElementById('gameHint');
const restartBtn = document.getElementById('restartBtn');

// ====== Utilities ======
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function dist2D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function getUserPerspectiveLabel(modelLabel) {
  // modelLabel: 'Left' | 'Right' (MediaPipe Hands)
  if (!MIRROR_VIEW) return modelLabel;
  return modelLabel === 'Left' ? 'Right' : 'Left';
}

function safePlay(audioEl) {
  try {
    const p = audioEl.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {
    // ignore autoplay / transient errors; HUD will still show states.
  }
}

// ====== Audio Interrupt control ======
function stopAudio(audioEl) {
  try {
    audioEl.pause();
    audioEl.currentTime = 0;
  } catch (_) {
    // ignore
  }
}

function stopAllAudios() {
  stopAudio(audioLeft);
  stopAudio(audioRight);
  stopAudio(audioVictory);
}

function playInterrupt(audioEl) {
  // 새 오디오 재생 전: 현재 재생 중인 모든 오디오를 즉시 끊는다
  stopAllAudios();
  safePlay(audioEl);
  return true;
}

// ====== Gesture: fist detection ======
function handSize(landmarks) {
  // 손 크기 정규화: wrist(0) ↔ middle_mcp(9) 거리
  const wrist = landmarks[0];
  const middleMcp = landmarks[9];
  return dist2D(wrist, middleMcp);
}

function isFist(landmarks) {
  // 주먹 정의(요구사항 반영, Metric 전면 변경):
  // - 엄지(1~4)는 완전히 무시
  // - 4개 손가락(검지/중지/약지/새끼) 각각에 대해:
  //   tip의 y가 mcp의 y보다 "더 아래"에 있으면(= y값이 더 크면) 접힘으로 간주
  // - 4개 모두 성립할 때만 fist
  //
  // MediaPipe 좌표계: y가 클수록 화면상 아래쪽
  const pairs = [
    { tip: 8, mcp: 5 },   // index
    { tip: 12, mcp: 9 },  // middle
    { tip: 16, mcp: 13 }, // ring
    { tip: 20, mcp: 17 }, // pinky
  ];

  return pairs.every(({ tip, mcp }) => landmarks[tip].y > landmarks[mcp].y);
}

// ====== Game rendering ======
function renderGameLine() {
  const chars = Array.from(targetString);
  const doneCount = Math.max(0, Math.min(currentIndex, chars.length));
  const html = chars
    .map((ch, idx) => {
      const cls =
        idx < doneCount ? 'char done' : idx === doneCount ? 'char current' : 'char upcoming';
      return `<span class="${cls}">${ch}</span>`;
    })
    .join('');
  gameLineEl.innerHTML = html;

  const nextChar = chars[doneCount];
  if (doneCount >= chars.length) {
    gameHintEl.innerHTML = `<span class="kbd"><span class="key">완료</span> 마지막 사운드가 끝나면 보너스 사운드가 재생됩니다</span>`;
    return;
  }

  const expected = nextChar === '촵'
    ? `<span class="kbd">현재 글자 <span class="key">촵</span> → <span class="key">오른손 주먹</span></span>`
    : `<span class="kbd">현재 글자 <span class="key">츄</span> → <span class="key">왼손 주먹</span></span>`;

  const anyPlaying =
    (!audioLeft.paused && !audioLeft.ended) ||
    (!audioRight.paused && !audioRight.ended) ||
    (!audioVictory.paused && !audioVictory.ended);
  const audioState = anyPlaying
    ? `<span class="kbd">오디오 <span class="key">재생 중</span> (정답 입력 시 즉시 교체)</span>`
    : `<span class="kbd">오디오 <span class="key">대기</span></span>`;

  gameHintEl.innerHTML = `${expected}${audioState}`;
}

function resetGame() {
  currentIndex = 0;
  pendingVictory = false;
  isFinishing = false;
  if (victoryTimeoutId !== null) {
    clearTimeout(victoryTimeoutId);
    victoryTimeoutId = null;
  }
  renderGameLine();
}

function restartAll() {
  stopAllAudios();
  resetGame();
  // 입력 플래그/현재 손 상태까지 초기화 (빠른 템포에서 재시작 시 오입력 방지)
  isLeftFist = false;
  isRightFist = false;
  leftReady = true;
  rightReady = true;
  updateHud('재시작됨');
}

function advanceGame() {
  currentIndex += 1;
  renderGameLine();
}

function handleCorrectInput(expectedChar) {
  if (expectedChar === '촵') {
    playInterrupt(audioRight);
    advanceGame();
  } else {
    // '츄'
    const wasLast = currentIndex === targetString.length - 1;
    playInterrupt(audioLeft);
    advanceGame();
    if (wasLast) {
      pendingVictory = true;
      isFinishing = true;
      // 요구사항: 마지막 '츄'가 지워지는 시점으로부터 정확히 200ms 후 sound3 재생
      victoryTimeoutId = setTimeout(() => {
        victoryTimeoutId = null;
        if (!pendingVictory) return;
        pendingVictory = false;
        playInterrupt(audioVictory);
      }, 200);
    }
  }
}

function processGameInput({ leftPunch, rightPunch }) {
  // 피날레 예약(200ms) 상태에서는 다른 입력이 스케줄/상태를 방해하지 않도록 무시
  if (isFinishing) return;

  // 끝났으면(이미 전부 처리) 추가 입력은 무시
  if (currentIndex >= targetString.length) return;

  const expectedChar = Array.from(targetString)[currentIndex];
  const expectsRight = expectedChar === '촵';
  const expectsLeft = expectedChar === '츄';

  // 프레임 내 입력이 둘 다 들어올 수 있으므로, "정답 우선"으로 1개만 처리
  if (expectsRight && rightPunch) {
    handleCorrectInput(expectedChar);
    return;
  }
  if (expectsLeft && leftPunch) {
    handleCorrectInput(expectedChar);
    return;
  }

  // 입력이 있었는데 정답이 아니면 오답 처리(리셋)
  if (leftPunch || rightPunch) {
    // 빠른 템포: 오답도 즉시 개입(기존 소리 중단)
    stopAllAudios();
    resetGame();
  }
}

// ====== Drawing ======
function resizeCanvasToVideo() {
  const w = videoEl.videoWidth || 0;
  const h = videoEl.videoHeight || 0;
  if (!w || !h) return;
  if (canvasEl.width !== w) canvasEl.width = w;
  if (canvasEl.height !== h) canvasEl.height = h;
}

function drawHands(results) {
  resizeCanvasToVideo();
  ctx.save();
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

  // MediaPipe drawing utils는 캔버스 좌표계 그대로 쓰므로,
  // 우리는 CSS로 미러링만 하고 실제 좌표는 그대로 그린다(비디오/캔버스가 함께 뒤집혀 보임).
  // 따라서 ctx.scale(-1,1) 같은 추가 변환은 하지 않는다.

  if (!results.multiHandLandmarks || !results.multiHandLandmarks.length) {
    // 손이 없으면 fist 상태를 OFF로 복귀 + ready 재장전
    if (isLeftFist) isLeftFist = false;
    if (isRightFist) isRightFist = false;
    leftReady = true;
    rightReady = true;
    ctx.restore();
    return;
  }

  let leftPunch = false;
  let rightPunch = false;
  let sawLeft = false;
  let sawRight = false;

  for (let i = 0; i < results.multiHandLandmarks.length; i++) {
    const lm = results.multiHandLandmarks[i];
    const handed = results.multiHandedness?.[i]?.label || 'Unknown';
    const userLabel = getUserPerspectiveLabel(handed);

    // Color by userLabel (after mirror correction)
    const connColor = userLabel === 'Left' ? '#7c5cff' : '#20d3ff';
    const dotColor = userLabel === 'Left' ? '#b7a7ff' : '#8cecff';

    // Connections + landmarks
    drawConnectors(ctx, lm, HAND_CONNECTIONS, { color: connColor, lineWidth: 3 });
    drawLandmarks(ctx, lm, { color: dotColor, radius: 3 });

    // Fist detect (Metric) + game input extraction
    const fistNow = isFist(lm);

    if (userLabel === 'Left') {
      sawLeft = true;
      if (!fistNow) leftReady = true;
      const edge = !isLeftFist && fistNow;
      if (edge && leftReady) {
        leftPunch = true;
        leftReady = false;
      }
      isLeftFist = fistNow;
    } else if (userLabel === 'Right') {
      sawRight = true;
      if (!fistNow) rightReady = true;
      const edge = !isRightFist && fistNow;
      if (edge && rightReady) {
        rightPunch = true;
        rightReady = false;
      }
      isRightFist = fistNow;
    }

    // label 텍스트를 손목 근처에 표시
    const wrist = lm[0];
    const x = clamp(wrist.x * canvasEl.width + 8, 8, canvasEl.width - 8);
    const y = clamp(wrist.y * canvasEl.height - 10, 18, canvasEl.height - 8);
    ctx.font = '600 14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
    ctx.fillStyle = 'rgba(10,14,20,0.72)';
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    const text = `${userLabel}${fistNow ? ' (FIST)' : ''}`;
    const padX = 8;
    const padY = 5;
    const metrics = ctx.measureText(text);
    const boxW = metrics.width + padX * 2;
    const boxH = 18 + padY * 2;
    ctx.beginPath();
    roundRect(ctx, x, y - boxH + 2, boxW, boxH, 10);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = fistNow ? '#e7eef7' : 'rgba(231,238,247,0.85)';
    ctx.fillText(text, x + padX, y + padY);
  }

  // 손이 한쪽만 감지된 프레임에서, 감지되지 않은 손은 OFF로 취급 + ready 재장전
  if (!sawLeft) {
    isLeftFist = false;
    leftReady = true;
  }
  if (!sawRight) {
    isRightFist = false;
    rightReady = true;
  }

  processGameInput({ leftPunch, rightPunch });

  ctx.restore();
}

function roundRect(ctx2d, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx2d.moveTo(x + rr, y);
  ctx2d.arcTo(x + w, y, x + w, y + h, rr);
  ctx2d.arcTo(x + w, y + h, x, y + h, rr);
  ctx2d.arcTo(x, y + h, x, y, rr);
  ctx2d.arcTo(x, y, x + w, y, rr);
  ctx2d.closePath();
}

// ====== Camera / Hands setup ======
async function setupCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

function initHands(onResultsCb) {
  const hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: MIN_CONFIDENCE,
    minTrackingConfidence: MIN_CONFIDENCE,
  });

  hands.onResults(onResultsCb);
  return hands;
}

function updateHud(extra = '') {
  const now = performance.now();
  const dt = now - lastFrameAt;
  lastFrameAt = now;
  const fps = dt > 0 ? (1000 / dt) : 0;

  const leftTxt = `Left fist: ${isLeftFist ? 'ON' : 'OFF'}`;
  const rightTxt = `Right fist: ${isRightFist ? 'ON' : 'OFF'}`;
  const anyPlaying =
    (!audioLeft.paused && !audioLeft.ended) ||
    (!audioRight.paused && !audioRight.ended) ||
    (!audioVictory.paused && !audioVictory.ended);
  const audioTxt = `Audio: ${anyPlaying ? 'PLAYING' : 'IDLE'} (interrupt)`;
  hudEl.innerHTML = `
    <div>FPS: ${fps.toFixed(1)} | Mirror view: ${MIRROR_VIEW ? 'ON' : 'OFF'}</div>
    <div>${leftTxt} / ${rightTxt} | ${audioTxt}</div>
    ${extra ? `<div>${extra}</div>` : ''}
  `;
}

async function unlockAudio() {
  // 클릭 이벤트 안에서 아주 짧게 재생 시도하여 오디오 정책을 통과시키는 방식
  const audios = [audioLeft, audioRight, audioVictory];
  for (const a of audios) {
    try {
      a.muted = true;
      a.currentTime = 0;
      const p = a.play();
      if (p && typeof p.then === 'function') await p;
      a.pause();
      a.muted = false;
    } catch (_) {
      // ignore
    }
  }
}

async function start() {
  startBtn.disabled = true;
  updateHud('권한 요청 중...');

  await unlockAudio();

  await setupCamera(videoEl);

  // 비디오 메타가 준비된 후에 캔버스 크기 세팅
  await new Promise((r) => {
    if (videoEl.videoWidth) return r();
    videoEl.onloadedmetadata = () => r();
  });
  resizeCanvasToVideo();

  const hands = initHands((results) => {
    drawHands(results);
    updateHud();
  });

  const camera = new Camera(videoEl, {
    onFrame: async () => {
      await hands.send({ image: videoEl });
    },
    width: 1280,
    height: 720,
  });

  camera.start();
  gateEl.style.display = 'none';
  updateHud('실행 중: 손을 화면 중앙에 위치시켜보세요.');
  renderGameLine();
}

// ====== Boot ======
startBtn.addEventListener('click', () => {
  start().catch((err) => {
    console.error(err);
    startBtn.disabled = false;
    updateHud('오류: 카메라 권한/HTTPS 여부를 확인하세요.');
  });
});

restartBtn.addEventListener('click', () => restartAll());

