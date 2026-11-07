import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './fixture.js'
import { initialState, stateStatus } from '../model.js'

test('message delivery during an open turn is not terminal', async t => {
  const f = await fixture(t), parent=f.add('parent'), child=f.add('child','parent')
  child.session.append('turn/start',{turn:1})
  child.session.append('tool/call',{name:'send_message',arguments:JSON.stringify({agent_id:parent.id,message:'progress'})})
  child.session.append('tool/result',{message:{content:[{type:'text',text:'message delivered'}]}})
  assert.equal((await f.supervisor.snapshot(parent.id)).entries[0].status,'running')
  assert.equal(child.cancelled.length,0)
})

test('snapshot refreshes a live projection if the child completes during the async read', async t => {
  const f=await fixture(t), parent=f.add('parent'), child=f.add('child','parent')
  child.session.append('turn/start',{turn:1})
  child.session.append('tool/result',{message:{content:[{type:'text',text:'message delivered'}]}})
  const original=f.ctx.sessionProjections.snapshot;let armed=true
  f.ctx.sessionProjections.snapshot=session=>{
    const value=original(session)
    if(session===child.session&&armed){armed=false;queueMicrotask(()=>{child.session.append('turn/end',{turn:1,reason:{kind:'completed'}});child.status='idle'})}
    return value
  }
  const entry=(await f.supervisor.snapshot(parent.id)).entries[0]
  assert.equal(entry.status,'completed','A stale open projection must not turn normal completion into stopped')
  assert.equal(child.cancelled.length,0)
})

test('an idle runtime with an unclosed log is uncertain, not evidence of a stop',()=>{
  assert.equal(stateStatus({...initialState(),open:true},false,false),'unknown')
})

test('actual cancellation and explicit pause still show stopped',()=>{
  assert.equal(stateStatus({...initialState(),open:false,reason:{kind:'aborted',reason:{kind:'parent'}}},false,false),'stopped')
  assert.equal(stateStatus({...initialState(),open:true},false,true),'stopped')
})

test('a later running turn is not rendered using the previous terminal projection',async t=>{
  const f=await fixture(t), parent=f.add('parent'), child=f.add('child','parent',{running:false})
  child.session.append('turn/start',{turn:1});child.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
  const original=f.ctx.sessionProjections.snapshot;let armed=true
  f.ctx.sessionProjections.snapshot=session=>{const value=original(session);if(session===child.session&&armed){armed=false;queueMicrotask(()=>{child.session.append('turn/start',{turn:2});child.status='running'})}return value}
  const entry=(await f.supervisor.snapshot(parent.id)).entries[0]
  assert.equal(entry.status,'running');assert.equal(entry.turnEpoch,2)
})

test('pause timestamps come from the pause event, not an older progress message',async t=>{
  const f=await fixture(t), parent=f.add('parent'), child=f.add('child','parent')
  child.session.append('turn/start',{turn:1})
  const older=child.session.events.at(-1).time
  child.session.append('unrelated/event',{})
  await f.preStep(child);child.cancel({kind:'user'},{keepInbox:true})
  const entry=(await f.supervisor.snapshot(parent.id)).entries[0]
  assert.equal(entry.status,'stopped');assert.equal(entry.statusAt,entry.paused.at);assert.notEqual(entry.statusAt,older)
})
