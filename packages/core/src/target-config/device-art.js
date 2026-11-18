'use strict';

const crypto = require('node:crypto');
// User-provided 45-degree/no-wheels original. Geometry is preserved; only
// screen palette/glyph and non-data descriptive text vary by page state.
// The same face groups also texture the interactive CSS cabinet.
const CABINET_SOURCE_SHA256 = 'ddc7bdf025a6a70767d86417b7a8dd527682ec64d61d9b41301278c80c30ed17';
const CABINET_SOURCE = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"160\" height=\"200\" viewBox=\"0 0 320 400\" role=\"img\" aria-labelledby=\"device-title device-desc\"><title id=\"device-title\">伊辛机设备示意图：45度俯视，无脚轮</title><desc id=\"device-desc\">独立静态矢量设备稿，平整柜底，无脚轮。绿色屏幕表示示例检测可达，不代表实时状态。</desc><ellipse cx=\"160\" cy=\"351\" rx=\"114\" ry=\"28\" fill=\"#0f172a\" opacity=\".07\" /><path d=\"M50 85 160 30 270 85 160 140Z\" fill=\"#66727e\" /><path d=\"M160 140 270 85V315L160 370Z\" fill=\"#232e38\" /><path d=\"M50 85 160 140V370L50 315Z\" fill=\"#35414d\" /><path d=\"m50 85 110 55 110-55\" fill=\"none\" stroke=\"#8c98a3\" stroke-width=\"1.2\" opacity=\".55\" /><path d=\"M160 140V370\" fill=\"none\" stroke=\"#151f29\" stroke-width=\"1.3\" />\n<g transform=\"matrix(1 -.5 0 1 160 140)\"><rect x=\"5\" y=\"7\" width=\"99\" height=\"216\" rx=\"2\" fill=\"none\" stroke=\"#43515e\" stroke-width=\".9\" /><rect x=\"17\" y=\"27\" width=\"77\" height=\"47\" rx=\"2\" fill=\"#1c2630\" /><rect x=\"24\" y=\"34\" width=\"26\" height=\"3\" rx=\"1\" fill=\"#101922\" /><rect x=\"59\" y=\"34\" width=\"26\" height=\"3\" rx=\"1\" fill=\"#101922\" /><rect x=\"24\" y=\"40\" width=\"26\" height=\"3\" rx=\"1\" fill=\"#101922\" /><rect x=\"59\" y=\"40\" width=\"26\" height=\"3\" rx=\"1\" fill=\"#101922\" /><rect x=\"24\" y=\"46\" width=\"26\" height=\"3\" rx=\"1\" fill=\"#101922\" /><rect x=\"59\" y=\"46\" width=\"26\" height=\"3\" rx=\"1\" fill=\"#101922\" /><rect x=\"24\" y=\"52\" width=\"26\" height=\"3\" rx=\"1\" fill=\"#101922\" /><rect x=\"59\" y=\"52\" width=\"26\" height=\"3\" rx=\"1\" fill=\"#101922\" /><rect x=\"24\" y=\"58\" width=\"26\" height=\"3\" rx=\"1\" fill=\"#101922\" /><rect x=\"59\" y=\"58\" width=\"26\" height=\"3\" rx=\"1\" fill=\"#101922\" /><rect x=\"24\" y=\"64\" width=\"26\" height=\"3\" rx=\"1\" fill=\"#101922\" /><rect x=\"59\" y=\"64\" width=\"26\" height=\"3\" rx=\"1\" fill=\"#101922\" /><circle cx=\"10\" cy=\"13\" r=\".9\" fill=\"#788692\" /><circle cx=\"99\" cy=\"13\" r=\".9\" fill=\"#788692\" /><circle cx=\"10\" cy=\"217\" r=\".9\" fill=\"#788692\" /><circle cx=\"99\" cy=\"217\" r=\".9\" fill=\"#788692\" /><circle cx=\"21\" cy=\"31\" r=\".9\" fill=\"#788692\" /><circle cx=\"90\" cy=\"31\" r=\".9\" fill=\"#788692\" /><circle cx=\"21\" cy=\"70\" r=\".9\" fill=\"#788692\" /><circle cx=\"90\" cy=\"70\" r=\".9\" fill=\"#788692\" /></g><g transform=\"matrix(1 .5 0 1 50 85)\"><rect x=\"5\" y=\"7\" width=\"99\" height=\"216\" rx=\"2\" fill=\"none\" stroke=\"#65727e\" stroke-width=\".9\" /><rect x=\"13\" y=\"22\" width=\"84\" height=\"60\" rx=\"4\" fill=\"#243329\" /><rect x=\"17\" y=\"26\" width=\"76\" height=\"52\" rx=\"3\" fill=\"#163824\" /><rect x=\"22\" y=\"31\" width=\"66\" height=\"42\" rx=\"2\" fill=\"#22c55e\" /><path d=\"M52 45h-3a8 8 0 0 0 0 16h6m3-16h3a8 8 0 0 1 0 16h-5m-7-8h13\" fill=\"none\" stroke=\"#f0fff4\" stroke-width=\"3.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" /><path d=\"M24 33h62\" stroke=\"#8bf0ac\" stroke-width=\"1\" opacity=\".6\" /><text x=\"16\" y=\"114\" font-family=\"Arial,sans-serif\" font-size=\"7\" letter-spacing=\"1.2\" fill=\"#a8b2bc\">ISINGQ</text><rect x=\"86\" y=\"109\" width=\"11\" height=\"41\" rx=\"3\" fill=\"#202c36\" /><rect x=\"89\" y=\"113\" width=\"5\" height=\"33\" rx=\"2.5\" fill=\"#a9b3bc\" /><path d=\"M91 115v28\" stroke=\"#d7dee4\" stroke-width=\"1\" /><rect x=\"102\" y=\"91\" width=\"5\" height=\"11\" rx=\"1\" fill=\"#52616e\" /><rect x=\"102\" y=\"153\" width=\"5\" height=\"11\" rx=\"1\" fill=\"#52616e\" /><rect x=\"14\" y=\"174\" width=\"82\" height=\"35\" rx=\"2\" fill=\"#2c3742\" /><rect x=\"23\" y=\"180\" width=\"28\" height=\"3\" rx=\"1\" fill=\"#17222c\" /><rect x=\"58\" y=\"180\" width=\"28\" height=\"3\" rx=\"1\" fill=\"#17222c\" /><rect x=\"23\" y=\"186\" width=\"28\" height=\"3\" rx=\"1\" fill=\"#17222c\" /><rect x=\"58\" y=\"186\" width=\"28\" height=\"3\" rx=\"1\" fill=\"#17222c\" /><rect x=\"23\" y=\"192\" width=\"28\" height=\"3\" rx=\"1\" fill=\"#17222c\" /><rect x=\"58\" y=\"192\" width=\"28\" height=\"3\" rx=\"1\" fill=\"#17222c\" /><rect x=\"23\" y=\"198\" width=\"28\" height=\"3\" rx=\"1\" fill=\"#17222c\" /><rect x=\"58\" y=\"198\" width=\"28\" height=\"3\" rx=\"1\" fill=\"#17222c\" /><circle cx=\"10\" cy=\"13\" r=\".9\" fill=\"#85929d\" /><circle cx=\"99\" cy=\"13\" r=\".9\" fill=\"#85929d\" /><circle cx=\"10\" cy=\"217\" r=\".9\" fill=\"#85929d\" /><circle cx=\"99\" cy=\"217\" r=\".9\" fill=\"#85929d\" /><circle cx=\"18\" cy=\"178\" r=\".9\" fill=\"#85929d\" /><circle cx=\"92\" cy=\"178\" r=\".9\" fill=\"#85929d\" /><circle cx=\"18\" cy=\"205\" r=\".9\" fill=\"#85929d\" /><circle cx=\"92\" cy=\"205\" r=\".9\" fill=\"#85929d\" /></g></svg>";
const LINK = '<path d="M52 45h-3a8 8 0 0 0 0 16h6m3-16h3a8 8 0 0 1 0 16h-5m-7-8h13" fill="none" stroke="#f0fff4" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" />';
const screenGlyph = path => `<path d="${path}" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" />`;
const definitions = {
  neutral: { screen: '#596675', frame: '#24313e', inner: '#1d2935', glow: '#d2dbe5', glyph: screenGlyph('M43 52h25'), title: '未检测信息' },
  success: { screen: '#22c55e', frame: '#243329', inner: '#163824', glow: '#8bf0ac', glyph: LINK, title: '信息读取完整' },
  partial: { screen: '#f59e0b', frame: '#3d3422', inner: '#3d2c12', glow: '#ffe1a1', glyph: screenGlyph('M55 41v13m0 8v.1'), title: '部分信息可用' },
  failed: { screen: '#dc4458', frame: '#402a32', inner: '#3c1c25', glow: '#ffd2d8', glyph: screenGlyph('M46 43l18 18m0-18L46 61'), title: '信息读取失败' },
  cloud: { screen: '#2563eb', frame: '#24313e', inner: '#172c4b', glow: '#b9d3ff', glyph: screenGlyph('M40 60H70C79 60 80 47 70 44C69 34 54 33 49 42C39 38 31 45 33 53C34 58 37 60 40 60Z'), title: '公开云端目录来源' },
};
const STATIC_SVG_ASSETS = Object.create(null);
const DEVICE_ART = {};
function faceAsset(name, group, fill) {
  if (!group) throw new Error(`设备插画缺少${name}面分组，请核对固定SVG资产`);
  const content = `<svg xmlns="http://www.w3.org/2000/svg" width="110" height="230" viewBox="0 0 110 230"><rect width="110" height="230" fill="${fill}"/>${group[1]}</svg>`;
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const path = `/assets/device-${name}-${sha256.slice(0, 16)}.svg`;
  STATIC_SVG_ASSETS[path] = content; return path;
}
const sidePath = faceAsset('side', /<g transform="matrix\(1 -\.5 0 1 160 140\)">([\s\S]*?)<\/g>/.exec(CABINET_SOURCE), '#232e38');
for (const [tone, definition] of Object.entries(definitions)) {
  const content = CABINET_SOURCE
    .replace(/<title id="device-title">[\s\S]*?<\/title>/, `<title id="device-title">${definition.title}：机柜示意图</title>`)
    .replace(/<desc id="device-desc">[\s\S]*?<\/desc>/, '<desc id="device-desc">用户提供的45度无脚轮机柜示意；屏幕仅对应页面信息状态，不代表实时在线或任务可提交。</desc>')
    .replace('fill="#243329"', `fill="${definition.frame}"`)
    .replace('fill="#163824"', `fill="${definition.inner}"`)
    .replace('fill="#22c55e"', `fill="${definition.screen}"`)
    .replace('stroke="#8bf0ac"', `stroke="${definition.glow}"`)
    .replace(LINK, definition.glyph);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const path = `/assets/device-${tone}-${sha256.slice(0, 16)}.svg`;
  STATIC_SVG_ASSETS[path] = content;
  const frontPath = faceAsset(`front-${tone}`, /<g transform="matrix\(1 \.5 0 1 50 85\)">([\s\S]*?)<\/g>/.exec(content), '#35414d');
  DEVICE_ART[tone] = Object.freeze({ path, sha256, frontPath, sidePath });
}
const ACTION_ICONS = Object.freeze({
  refresh: [['path', { d: 'M3 11a8 8 0 0 1 13.65-5.65L21 8M21 3v5h-5M21 13a8 8 0 0 1-13.65 5.65L3 16M8 16H3v5' }]],
  pencil: [['path', { d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4ZM15 5l3 3M4 21h16' }]],
  power: [['path', { d: 'M12 2v10M5.64 4.64a9 9 0 1 0 12.72 0' }]],
  info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v6m0-10v.01' }]],
  more: [['circle', { cx: 5, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 12, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 19, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }]],
});
const ART_DIGEST = crypto.createHash('sha256').update(JSON.stringify([STATIC_SVG_ASSETS, ACTION_ICONS])).digest('hex');
Object.freeze(STATIC_SVG_ASSETS); Object.freeze(DEVICE_ART);
module.exports = { CABINET_SOURCE_SHA256, DEVICE_ART, STATIC_SVG_ASSETS, ACTION_ICONS, ART_DIGEST };
