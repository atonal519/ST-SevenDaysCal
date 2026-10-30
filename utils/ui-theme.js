// 只传播插件根的主题类；不重建其内容、焦点或展开状态。
export function syncUiTheme(root, theme, forced = false) {
    if (!root?.classList) return;
    root.classList.remove('sp-day', 'sp-night', 'sp-forced-day', 'sp-forced-night');
    root.classList.add(`sp-${theme}`);
    if (forced) root.classList.add(`sp-forced-${theme}`);
}

// 主操作沿用白字/深灰字，按实际主色选择较高对比，兼容 auto 的自定义酒馆配色。
export function primaryTextColor(rgb) {
    const luminance = channels => channels.reduce((sum, value, index) => {
        const channel = value / 255;
        return sum + (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index];
    }, 0);
    const lightness = luminance(rgb);
    const dark = luminance([39, 40, 41]);
    const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    return contrast(lightness, 1) >= contrast(lightness, dark) ? '#ffffff' : '#272829';
}
