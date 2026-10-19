'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {appendObservedCampPoint:append}=require('../vendor/server/minecraft/houseCampTrace');
const p=x=>({x,y:64,z:0}),anchor=p(0);
test('an actual work loop is erased at its observed rejoin without inventing a cell',()=>{
 let path=[anchor];for(const x of [1,2,3,2,1,4])path=append(path,p(x),anchor);
 assert.deepEqual(path,[anchor,p(1),p(4)]);
});
test('stationary ticks retain the same bounded trace and actual camp resets it',()=>{
 const path=[anchor,p(1),p(2)];assert.equal(append(path,p(2),anchor),path);
 assert.deepEqual(append(path,anchor,anchor),[anchor]);assert.equal(path.length,3);
});
test('trace limit refuses new unobserved suffix but permits closing an actual loop',()=>{
 const path=[anchor,p(1),p(2)];assert.throws(()=>append(path,p(3),anchor,3),{code:'house_surface_camp_work_route_limit'});
 assert.deepEqual(append(path,p(1),anchor,3),[anchor,p(1)]);
});
test('fractional or missing points cannot become integer camp goals',()=>{
 for(const point of [{x:1,y:63.9375,z:0},{x:NaN,y:64,z:0},null])assert.throws(()=>append([anchor],point,anchor));
});

test('world58 498-point food walk can omit only closed observed loops while retaining its required node and every actual edge',()=>{
 const saved=require('../test-support/fixtures/world58-food-return-loop.json'),{compactObservedReturnTrace}=require('../vendor/server/minecraft/houseCampTrace'),before=JSON.stringify(saved.path),key=p=>`${p.x},${p.y},${p.z}`;
 const result=compactObservedReturnTrace(saved.path,{anchor:saved.anchor,requiredNode:saved.requiredNode});assert.equal(result.path.length,73);assert.equal(result.removed,425);assert.equal(JSON.stringify(saved.path),before);
 assert.ok(result.path.some(p=>key(p)===saved.requiredNode));const edges=new Set(saved.path.slice(1).map((p,i)=>`${key(saved.path[i])}>${key(p)}`));
 assert.ok(result.path.slice(1).every((p,i)=>edges.has(`${key(result.path[i])}>${key(p)}`)),'A compacted trace cannot invent a connector');
 assert.equal(compactObservedReturnTrace(saved.path,{anchor:saved.anchor,requiredNode:saved.requiredNode,pendingTransport:true}).path,saved.path);
 assert.equal(compactObservedReturnTrace(saved.path,{anchor:saved.anchor,requiredNode:'unobserved-required-node'}).path,saved.path);
});
