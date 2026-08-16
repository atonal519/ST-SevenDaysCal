// utils/format.js — 格式化/图标/脱敏纯函数。Phase 0 从 index.js 机械搬移。
import { escapeHtml } from './dom.js';


export function maskKey(k) { return k.length <= 8 ? '•'.repeat(k.length) : '•'.repeat(k.length - 4) + k.slice(-4); }

export function weatherGlyph(weather) {
    const w = String(weather || '');
    if (!w) return '';
    if (/雷/.test(w))                       return '⛈️';
    if (/雨夹雪/.test(w))                    return '🌨️';
    if (/雪/.test(w))                        return '❄️';
    if (/雨/.test(w))                        return '🌧️';
    if (/雾|霾|沙尘/.test(w))                return '🌫️';
    if (/阴/.test(w))                        return '☁️';
    if (/多云|少云/.test(w))                 return '⛅';
    if (/晴/.test(w))                        return '☀️';
    if (/风/.test(w))                        return '💨';
    return '🌤️';
}

export function weatherChipHtml(weather, temp) {
    const w  = String(weather || '').trim();
    const tp = String(temp || '').trim();
    if (!w && !tp) return '';
    return `<div class="sp-day-weather">`
        + `<span class="sp-day-weather-icon">${weatherGlyph(w) || '🌤️'}</span>`
        + (w  ? `<span class="sp-day-weather-txt">${escapeHtml(w)}</span>`   : '')
        + (tp ? `<span class="sp-day-weather-temp">${escapeHtml(tp)}</span>` : '')
        + `</div>`;
}

export function fmtAnchorTs(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(+d)) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
