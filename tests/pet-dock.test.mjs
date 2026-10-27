import test from 'node:test';
import assert from 'node:assert/strict';
import {PET_SIZE,DOCK_SIZE,dockAtEdge,dockScene,dockProximity} from '../src/core/pet-dock.mjs';

test('pet docks only after leaving the screen, and never at a connected monitor seam',()=>{
  const area={x:0,y:0,width:1920,height:1080};
  assert.equal(dockAtEdge({...PET_SIZE,x:0,y:200},area),null);
  assert.equal(dockAtEdge({...PET_SIZE,x:1794,y:200},area),null);
  assert.equal(dockAtEdge({...PET_SIZE,x:-10,y:200},area),null);
  assert.equal(dockAtEdge({...PET_SIZE,x:-40,y:200},area).edge,'left');
  const right={...PET_SIZE,x:1840,y:200};
  assert.equal(dockAtEdge(right,area).edge,'right');
  assert.equal(dockAtEdge(right,area,{neighbors:[{x:1920,y:0,width:1920,height:1080}]}),null);
  const workArea={...area,height:1040};
  assert.equal(dockAtEdge({...PET_SIZE,x:200,y:950},workArea,{limits:area}),null);
});

test('transition scene includes the offscreen cat and the on-screen ears without moving either drawing',()=>{
  const area={x:0,y:0,width:1920,height:1080},expanded={...PET_SIZE,x:-40,y:200};
  const dock=dockAtEdge(expanded,area),scene=dockScene(expanded,dock.bounds);
  assert.equal(scene.bounds.x+scene.cat.x,expanded.x);
  assert.equal(scene.bounds.y+scene.cat.y,expanded.y);
  assert.equal(scene.bounds.x+scene.peek.x,dock.bounds.x);
  assert.equal(scene.bounds.y+scene.peek.y,dock.bounds.y);
  assert.equal(scene.peek.width,DOCK_SIZE.depth);assert.equal(scene.peek.height,DOCK_SIZE.width);
  assert.equal(scene.bounds.width,126);
});

test('ears fit all four work-area edges on displays with negative coordinates and skip connected seams',()=>{
  assert.deepEqual(DOCK_SIZE,{width:80,depth:40});
  const limits={x:-1280,y:-240,width:1280,height:960};
  const area={x:-1280,y:-215,width:1280,height:895};
  const cases=[
    ['left',{...PET_SIZE,x:-1320,y:100},{x:-2560,y:-240,width:1280,height:960}],
    ['right',{...PET_SIZE,x:-80,y:100},{x:0,y:-240,width:1280,height:960}],
    ['top',{...PET_SIZE,x:-800,y:-280},{x:-1280,y:-1200,width:1280,height:960}],
    ['bottom',{...PET_SIZE,x:-800,y:650},{x:-1280,y:720,width:1280,height:960}],
  ];
  for(const [edge,bounds,neighbor] of cases){
    const dock=dockAtEdge(bounds,area,{limits});
    assert.equal(dock.edge,edge);
    const vertical=edge==='left'||edge==='right';
    assert.equal(dock.bounds.width,vertical?40:80);assert.equal(dock.bounds.height,vertical?80:40);
    assert.ok(dock.bounds.x>=area.x&&dock.bounds.y>=area.y);
    assert.ok(dock.bounds.x+dock.bounds.width<=area.x+area.width);
    assert.ok(dock.bounds.y+dock.bounds.height<=area.y+area.height);
    if(edge==='left')assert.equal(dock.bounds.x,area.x);
    if(edge==='right')assert.equal(dock.bounds.x+dock.bounds.width,area.x+area.width);
    if(edge==='top')assert.equal(dock.bounds.y,area.y);
    if(edge==='bottom')assert.equal(dock.bounds.y+dock.bounds.height,area.y+area.height);
    assert.equal(dockAtEdge(bounds,area,{limits,neighbors:[neighbor]}),null,`${edge} connected monitor seam`);
  }
});

test('small work areas keep the complete native ear window inside the available rectangle',()=>{
  const area={x:-30,y:-20,width:32,height:24};
  for(const bounds of [{...PET_SIZE,x:-70,y:-20},{...PET_SIZE,x:-30,y:-60}]){
    const dock=dockAtEdge(bounds,area);
    assert.ok(dock);
    assert.ok(dock.bounds.width>0&&dock.bounds.height>0);
    assert.ok(dock.bounds.x>=area.x&&dock.bounds.y>=area.y);
    assert.ok(dock.bounds.x+dock.bounds.width<=area.x+area.width);
    assert.ok(dock.bounds.y+dock.bounds.height<=area.y+area.height);
  }
});

test('mouse proximity uses rectangle distance with exact activation and departure hysteresis',()=>{
  const bounds={x:-120,y:40,width:40,height:80};
  assert.equal(dockProximity(bounds,{x:-100,y:80}),true);
  assert.equal(dockProximity(bounds,{x:-62,y:80}),true);
  assert.equal(dockProximity(bounds,{x:-61,y:80}),false);
  assert.equal(dockProximity(bounds,{x:-46,y:80},true),true);
  assert.equal(dockProximity(bounds,{x:-45,y:80},true),false);
  assert.equal(dockProximity(bounds,{x:-100,y:22}),true);
  assert.equal(dockProximity(bounds,{x:-100,y:21}),false);
  assert.equal(dockProximity(bounds,{x:-69,y:28}),true); // 11/12 diagonal, less than 18.
  assert.equal(dockProximity(bounds,{x:-67,y:27}),false); // 13/13 diagonal, more than 18.
  assert.equal(dockProximity(bounds,{x:-56,y:16},true),true); // 24/24 diagonal, less than 34.
  assert.equal(dockProximity(bounds,{x:-55,y:15},true),false); // 25/25 diagonal, more than 34.
});
