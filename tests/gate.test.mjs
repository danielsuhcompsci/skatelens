import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventGate, sampleIndices, roundEven } from '../web/gate.mjs';
const kickflip={label:'kickflip',confidence:.95,margin:.9};
test('automatic acceptance needs two distinct agreeing windows',()=>{
  const gate=new EventGate();
  assert.equal(gate.update(kickflip,{now:0,end:2}).state,'candidate');
  assert.equal(gate.update(kickflip,{now:100,end:2}).state,'unknown');
  assert.equal(gate.update(kickflip,{now:1100,end:3}).state,'accepted');
});
test('idle and uncertainty reset accumulated agreement',()=>{
  const gate=new EventGate();gate.update(kickflip,{now:0,end:2});
  assert.equal(gate.update(null,{now:100,end:3,active:false}).state,'idle');
  assert.equal(gate.update(kickflip,{now:200,end:4}).state,'candidate');
  assert.equal(gate.update({...kickflip,confidence:.7},{now:300,end:5}).state,'unknown');
  assert.equal(gate.update(kickflip,{now:400,end:6}).state,'candidate');
});
test('manual acceptance remains gated and duplicate events are suppressed',()=>{
  const gate=new EventGate();
  assert.equal(gate.update(kickflip,{now:0,end:2,manual:true}).state,'accepted');
  assert.equal(gate.update(kickflip,{now:100,end:3,manual:true}).state,'cooldown');
  assert.equal(gate.update(kickflip,{now:4000,end:4,manual:true}).state,'accepted');
  assert.equal(gate.update({...kickflip,confidence:.8},{now:8000,end:5,manual:true}).state,'unknown');
});
test('NumPy sampling parity includes both endpoints and ties to even',()=>{
  assert.equal(roundEven(2.5),2);assert.equal(roundEven(3.5),4);
  assert.deepEqual(sampleIndices(60),[0,4,8,12,16,20,24,28,31,35,39,43,47,51,55,59]);
  assert.deepEqual(sampleIndices(1),Array(16).fill(0));assert.throws(()=>sampleIndices(0));
});
