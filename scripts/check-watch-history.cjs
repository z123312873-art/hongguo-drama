const assert = require('node:assert/strict');
const fs = require('node:fs');
const modulePath = require('node:path').join(__dirname, '../src/native/watch-history.js');
assert.ok(fs.existsSync(modulePath), '观看记录模块尚未实现');
const { listHistory, recordPlayback, applyEpisodeUpdate, findSequels, acknowledge, forgetPlayback } = require(modulePath);
const series = [
 { series_id:'1000001', series_title:'春日来信', total:12, episodes:Array.from({length:12},(_,i)=>({vid_index:i+1})) },
 { series_id:'1000002', series_title:'春日来信第二季', total:8, episodes:[] },
 { series_id:'1000003', series_title:'仅打开', total:10, episodes:[] },
];
const map = { '1000002': {vid_index:3,currentTime:12,updatedAt:100}, '1000003': {vid_index:1,currentTime:0,updatedAt:500} };
assert.deepEqual(listHistory(series,map).map(s=>s.series_id),['1000002']);
map['1000001']=recordPlayback(null,series[0],2,0,200);
assert.deepEqual(listHistory(series,map).map(s=>s.series_id),['1000001','1000002']);
assert.equal(listHistory(series,map)[0].vid_index,2);
assert.throws(()=>recordPlayback(null,series[0],2,Infinity),/进度/);
assert.throws(()=>recordPlayback(null,series[0],0,12),/进度/);
let updated=applyEpisodeUpdate(map['1000001'],series[0],{...series[0],total:14,episodes:Array.from({length:14},(_,i)=>({vid_index:i+1}))},300);
assert.equal(updated.unreadEpisodes,2);
updated=recordPlayback(updated, {...series[0],total:14},2,34,400);
assert.equal(updated.unreadEpisodes,2,'日常保存不能自动吞掉红点');
assert.equal(updated.knownTotal,14);
assert.equal(applyEpisodeUpdate(updated,series[0],{total:11,episodes:Array(11).fill({})},500).knownTotal,14);
const candidates=[{series_id:'1000002',series_title:'春日来信第二季'},{series_id:'1000004',series_title:'春日来信第三季'},{series_id:'1000005',series_title:'春日来信番外'},{series_id:'1000006',series_title:'春日来信之另一个故事'},{series_id:'xifan:1:7',series_title:'春日来信第二季'},{series_id:'javascript:alert(1)',series_title:'春日来信第二季'}];
assert.deepEqual(findSequels(series[0],candidates).map(s=>s.series_id),['1000002','1000004']);
assert.deepEqual(findSequels(series[1],candidates).map(s=>s.series_id),['1000004']);
assert.deepEqual(findSequels({...series[0],series_title:'春日来信第十二季'},[{series_id:'1000007',series_title:'春日来信第十三季'}]).map(s=>s.series_id),['1000007']);
updated.sequels=findSequels(series[0],candidates);
updated.seenSequelIds=[];
assert.equal(listHistory(series,{...map,'1000001':updated})[0].hasUpdates,true);
const read=acknowledge(updated);
assert.equal(read.unreadEpisodes,0);
assert.equal(read.acknowledgedTotal,14);
assert.deepEqual(read.seenSequelIds,['1000002','1000004']);
assert.equal(listHistory(series,{'1000001':read})[0].hasUpdates,false);
assert.equal(applyEpisodeUpdate(read,series[0],{total:14,episodes:Array(14).fill({})},600).unreadEpisodes,0);
assert.equal(applyEpisodeUpdate(read,series[0],{total:15,episodes:Array(15).fill({})},700).unreadEpisodes,1);
const kept = { ...map, '1000001': read };
assert.equal(forgetPlayback(kept, '1000002'), true);
assert.equal(Object.hasOwn(kept, '1000002'), false);
assert.equal(Object.hasOwn(kept, '1000001'), true);
assert.deepEqual(listHistory(series, kept).map(item => item.series_id), ['1000001']);
assert.equal(forgetPlayback(kept, '1000002'), false);
assert.equal(forgetPlayback(kept, ''), false);
assert.equal(forgetPlayback(kept, '__proto__'), false);
assert.equal(forgetPlayback(null, '1000001'), false);
console.log('PASS watch history: watched-only, resume metadata, ordering, update baseline, sequel matching, acknowledgement, single removal');
