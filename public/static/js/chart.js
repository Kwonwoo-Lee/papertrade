/**
 * chart.js - 캔버스 기반 캔들스틱 차트
 * ==========================================
 * SVG로 수백 개 봉을 고정 뷰박스에 욱여넣으면 봉이 서브픽셀 두께가 되어
 * 브라우저 래스터라이저가 일부를 아예 그리지 못하는(=화면에서 깨져 보이는)
 * 현상이 생김. 캔버스로 실제 픽셀에 맞춰 그리고, 기본적으로 최근 80개
 * 봉만 보여준 뒤 마우스 휠로 확대/축소하도록 해서 이 문제를 근본적으로
 * 해결함. 가격/시간축, 마우스 위치 점선 크로스헤어, 호버 시 OHLC 정보를
 * 함께 제공.
 */
function pad2(n) { return String(n).padStart(2, "0"); }

function fmtAxisPrice(v) {
  return Math.round(v).toLocaleString();
}

function fmtAxisTime(ts, interval, full) {
  const d = new Date(ts * 1000);
  if (interval === "1d") {
    return full
      ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
      : `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  }
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return full ? `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${hhmm}` : hhmm;
}

class CandleChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.candles = [];
    this.interval = "5m";
    this.visibleCount = 80;
    this.hover = null; // CSS 픽셀 좌표 {x,y}
    this.onCrosshair = null; // (candle|null) => void
    this.dpr = window.devicePixelRatio || 1;
    this._raf = null;

    this._onWheel = e => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.15 : 0.87;
      const next = Math.round(this.visibleCount * factor);
      this.visibleCount = Math.min(this.candles.length || 1, Math.max(15, next));
      this._requestDraw();
    };
    this._onMove = e => {
      const rect = this.canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this._requestDraw();
    };
    this._onLeave = () => { this.hover = null; this._requestDraw(); };

    canvas.addEventListener("wheel", this._onWheel, { passive: false });
    canvas.addEventListener("mousemove", this._onMove);
    canvas.addEventListener("mouseleave", this._onLeave);

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(canvas.parentElement);
  }

  setInterval(interval) { this.interval = interval; }

  setData(candles, resetView = true) {
    this.candles = candles || [];
    if (resetView) {
      this.visibleCount = Math.min(this.candles.length, 80);
      this.hover = null;
    } else {
      this.visibleCount = Math.min(this.visibleCount, this.candles.length || 1);
    }
    this._requestDraw();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * this.dpr));
    const h = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this._requestDraw();
  }

  destroy() {
    this._resizeObserver.disconnect();
    this.canvas.removeEventListener("wheel", this._onWheel);
    this.canvas.removeEventListener("mousemove", this._onMove);
    this.canvas.removeEventListener("mouseleave", this._onLeave);
  }

  _requestDraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._draw(); });
  }

  _cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  _draw() {
    const ctx = this.ctx, dpr = this.dpr;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!this.candles.length || W < 20 || H < 20) {
      if (this.onCrosshair) this.onCrosshair(null);
      return;
    }

    const ink2 = this._cssVar("--ink-2", "#666");
    const muted = this._cssVar("--muted", "#999");
    const border = this._cssVar("--border", "rgba(0,0,0,.1)");
    const good = this._cssVar("--good", "#0a7d34");
    const bad = this._cssVar("--bad", "#d0392f");
    const accent = this._cssVar("--accent", "#1f5fd6");

    const PAD_RIGHT = 58 * dpr, PAD_BOTTOM = 22 * dpr, PAD_TOP = 8 * dpr, PAD_LEFT = 4 * dpr;
    const plotW = W - PAD_LEFT - PAD_RIGHT;
    const plotH = H - PAD_TOP - PAD_BOTTOM;

    const total = this.candles.length;
    const start = Math.max(0, total - this.visibleCount);
    const visible = this.candles.slice(start);
    const n = visible.length;
    if (n < 1 || plotW <= 0 || plotH <= 0) return;

    let min = Math.min(...visible.map(c => c.l));
    let max = Math.max(...visible.map(c => c.h));
    if (min === max) { min -= 1; max += 1; }
    const pricePad = (max - min) * 0.08;
    min -= pricePad; max += pricePad;

    const slotW = plotW / n;
    const bodyW = Math.max(1 * dpr, Math.min(slotW * 0.7, 14 * dpr));
    const xAt = i => PAD_LEFT + slotW * i + slotW / 2;
    const yAt = v => PAD_TOP + plotH * (1 - (v - min) / (max - min));

    // 가격축 그리드 + 라벨
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.fillStyle = muted;
    ctx.font = `${11 * dpr}px -apple-system, "Segoe UI", "Noto Sans KR", sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const gridLines = 5;
    for (let i = 0; i <= gridLines; i++) {
      const v = min + (max - min) * (i / gridLines);
      const y = yAt(v);
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, y);
      ctx.lineTo(PAD_LEFT + plotW, y);
      ctx.stroke();
      ctx.fillText(fmtAxisPrice(v), PAD_LEFT + plotW + 6 * dpr, y);
    }

    // 캔들
    visible.forEach((c, i) => {
      const cx = xAt(i);
      const up = c.c >= c.o;
      const color = up ? good : bad;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      ctx.moveTo(cx, yAt(c.h));
      ctx.lineTo(cx, yAt(c.l));
      ctx.stroke();
      const yO = yAt(c.o), yC = yAt(c.c);
      const top = Math.min(yO, yC);
      const bh = Math.max(1 * dpr, Math.abs(yC - yO));
      ctx.fillRect(cx - bodyW / 2, top, bodyW, bh);
    });

    // 시간축 라벨
    ctx.fillStyle = muted;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelEvery = Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i += labelEvery) {
      ctx.fillText(fmtAxisTime(visible[i].t, this.interval), xAt(i), PAD_TOP + plotH + 6 * dpr);
    }

    // 크로스헤어
    let hoveredCandle = null;
    if (this.hover) {
      const hx = this.hover.x * dpr, hy = this.hover.y * dpr;
      if (hx >= PAD_LEFT && hx <= PAD_LEFT + plotW && hy >= PAD_TOP && hy <= PAD_TOP + plotH) {
        ctx.save();
        ctx.strokeStyle = ink2;
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PAD_LEFT, hy); ctx.lineTo(PAD_LEFT + plotW, hy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(hx, PAD_TOP); ctx.lineTo(hx, PAD_TOP + plotH); ctx.stroke();
        ctx.restore();

        // 가격 라벨 (우측 축)
        const priceVal = min + (max - min) * (1 - (hy - PAD_TOP) / plotH);
        const priceLabel = fmtAxisPrice(priceVal);
        ctx.font = `${11 * dpr}px -apple-system, "Segoe UI", "Noto Sans KR", sans-serif`;
        ctx.fillStyle = accent;
        ctx.fillRect(PAD_LEFT + plotW, hy - 9 * dpr, PAD_RIGHT, 18 * dpr);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(priceLabel, PAD_LEFT + plotW + 6 * dpr, hy);

        // 시간 라벨 (하단 축) + 가까운 봉 찾기
        const idx = Math.min(n - 1, Math.max(0, Math.round((hx - PAD_LEFT - slotW / 2) / slotW)));
        hoveredCandle = visible[idx];
        if (hoveredCandle) {
          const tLabel = fmtAxisTime(hoveredCandle.t, this.interval, true);
          const tw = ctx.measureText(tLabel).width + 10 * dpr;
          ctx.fillStyle = accent;
          ctx.fillRect(xAt(idx) - tw / 2, PAD_TOP + plotH, tw, PAD_BOTTOM);
          ctx.fillStyle = "#fff";
          ctx.textAlign = "center"; ctx.textBaseline = "top";
          ctx.fillText(tLabel, xAt(idx), PAD_TOP + plotH + 4 * dpr);
        }
      }
    }
    if (!hoveredCandle) hoveredCandle = visible[visible.length - 1];
    if (this.onCrosshair) this.onCrosshair(hoveredCandle);
  }
}
