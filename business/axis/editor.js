import { axisState } from './state.js';

export function openAxisEditor(id, prefill, render) {
    axisState._almanacEditor = { id: id || null, prefill: prefill || null };
    if (axisState.almanacMode) render();
}

export function closeAxisEditor(render) {
    axisState._almanacEditor = null;
    if (axisState.almanacMode) render();
}

export function setAxisSheet(sheet, render, resetBatch) {
    if (axisState._almanacSheet === sheet) return;
    axisState._almanacSheet = sheet;
    axisState._almanacCalDay = null;
    resetBatch?.();
    render();
}

export function selectAxisDay(day, render) {
    axisState._almanacCalDay = axisState._almanacCalDay === day ? null : day;
    render();
}

export function navigateAxisMonth(delta, monthCount, currentMonth, render) {
    const mc = monthCount();
    axisState._almanacCalMonth = (currentMonth() + delta + mc) % mc;
    axisState._almanacCalDay = null;
    render();
}
