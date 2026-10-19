'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {waterThreatEscapeForward:forward}=require('../vendor/server/minecraft/houseWaterThreatPolicy');
const route={from:{x:-175,y:63,z:-80},to:{x:-175,y:63,z:-37}};
const actual={x:-174.5,y:62.7,z:-78.5};
test('a hostile behind a long crossing does not repeatedly cancel escape back into it',()=>{
 assert.equal(forward(route,actual,[{position:{x:-177,y:64,z:-83}}]),true);
 assert.equal(forward({...route,from:route.to,to:route.from},actual,[{position:{x:-177,y:64,z:-83}}]),false);
});
test('a second hostile covering the destination prevents forward escape',()=>{
 assert.equal(forward(route,actual,[{position:{x:-177,y:64,z:-83}},{position:{x:-176,y:64,z:-39}}]),false);
});
test('unknown threat position, no threat, short escape or already at target cannot authorize it',()=>{
 assert.equal(forward(route,actual,[{}]),false);
 assert.equal(forward(route,actual,[]),false);
 assert.equal(forward({...route,to:{x:-175,y:63,z:-75}},actual,[{position:{x:-177,y:64,z:-83}}]),false);
 assert.equal(forward(route,{x:-174.5,y:63,z:-37.5},[{position:{x:-177,y:64,z:-83}}]),false);
});
