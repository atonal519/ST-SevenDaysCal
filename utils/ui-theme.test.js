import test from 'node:test';
import assert from 'node:assert/strict';
import { primaryTextColor, syncUiTheme } from './ui-theme.js';

test('主操作文字按现有深色字与白色字取对比更高者', () => {
    assert.equal(primaryTextColor([69, 120, 146]), '#ffffff');
    assert.equal(primaryTextColor([168, 164, 158]), '#272829');
    assert.equal(primaryTextColor([240, 200, 90]), '#272829');
    assert.equal(primaryTextColor([20, 40, 70]), '#ffffff');
});

test('根主题同步只更换主题类，保留业务类及已打开状态', () => {
    const classes = new Set(['sp-inline-box', 'sp-day', 'sp-forced-day']);
    const root = { classList: { remove: (...names) => names.forEach(name => classes.delete(name)), add: (...names) => names.forEach(name => classes.add(name)) }, open: true };
    syncUiTheme(root, 'night', true);
    assert.deepEqual([...classes].sort(), ['sp-forced-night', 'sp-inline-box', 'sp-night']);
    syncUiTheme(root, 'day', false);
    assert.deepEqual([...classes].sort(), ['sp-day', 'sp-inline-box']);
    assert.equal(root.open, true);
});
