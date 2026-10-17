import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import vm from 'node:vm';
const ctx={window:{},localStorage:{getItem(){return null},setItem(){}},fetch(){},AbortController,setTimeout,clearTimeout,console};
vm.createContext(ctx); vm.runInContext(fs.readFileSync(new URL('./geo.js',import.meta.url),'utf8'),ctx);
const parse=ctx.window.Geo._parseAreaCsv;
test('公式の列順(コード,地域名,都道府県名,地方名,緯度,経度)を優先',()=>{
  const r=parse('地域コード,地域名,都道府県名,地方名,緯度,経度\n100,石狩地方北部,北海道,北海道,43.5,141.7\n200,東京都,東京都,関東,35.7,139.7\n');
  assert.deepEqual(JSON.parse(JSON.stringify(r)),[[100,'北海道','石狩地方北部',43.5,141.7],[200,'東京都','東京都',35.7,139.7]]);
});
test('地域名が県名と同じでも列順で正しく読む',()=>{
  const r=parse('300,神奈川県,神奈川県,関東,35.4,139.6\n');
  assert.equal(r[0][1],'神奈川県'); assert.equal(r[0][3],35.4); assert.equal(r[0][4],139.6);
});
test('列順が違う表は自動判別(予備)',()=>{
  const r=parse('400,大阪府,大阪府北部,34.8,135.5\n');
  assert.equal(r[0][1],'大阪府'); assert.equal(r[0][3],34.8);
});
test('座標が無い表は県庁所在地の周囲に配置',()=>{
  const r=parse('500,愛知県西部,愛知県\n'); assert.equal(r[0][1],'愛知県'); assert.ok(Number.isFinite(r[0][3]));
});
