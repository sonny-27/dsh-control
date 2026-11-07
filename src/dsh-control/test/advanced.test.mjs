import test from 'node:test';
import assert from 'node:assert/strict';
import {Observations} from '../lib/common.js';
import {waitOptions,captureOptions,imagePoint,strokeOptions,batchSteps} from '../lib/advanced.js';
import {isJsonValue} from '@deepseek-ai/dsh-util-values';

test('condition waits require explicit targets, legal conditions and bounded time',()=>{
  assert.deepEqual(waitOptions({condition:'enabled',query:'Save',waitMs:300}),{condition:'enabled',query:'Save',waitMs:300,windowId:undefined});
  for(const args of [{condition:'script',query:'x'},{condition:'focused'},{waitMs:10001},{waitMs:0}])assert.throws(()=>waitOptions(args));
});
test('regional capture rejects malformed/empty geometry without silently clipping',()=>{
  assert.deepEqual(captureOptions({region:{x:-1200,y:10,width:100,height:50},maxWidth:200}),{region:{x:-1200,y:10,width:100,height:50},maxWidth:200});
  for(const args of [{region:{x:1,y:1,width:0,height:20}},{region:[1,2,3,4]},{region:{x:1,y:1,width:30,height:20,extra:1}},{maxWidth:159}])assert.throws(()=>captureOptions(args));
});
test('image mapping preserves crop origin, negative monitor coordinates and unequal scale',()=>{
  const o={kind:'desktop',imageTransform:{originX:-1920,originY:30,imageWidth:400,imageHeight:201,scaleX:2,scaleY:401/201}};
  assert.deepEqual(imagePoint(o,100,100),{x:-1720,y:230});assert.throws(()=>imagePoint(o,400,0),{code:'OUT_OF_IMAGE'});assert.throws(()=>imagePoint({},0,0),{code:'IMAGE_MAPPING_REQUIRED'});
});
test('browser image mapping retains fractional CSS coordinates',()=>{assert.deepEqual(imagePoint({kind:'browser',imageTransform:{originX:5,originY:10,imageWidth:200,imageHeight:100,scaleX:1.5,scaleY:1.5}},1,1),{x:6.5,y:11.5});});
test('negative-origin image mapping produces lossless SDK JSON instead of negative zero',()=>{const p=imagePoint({kind:'desktop',imageTransform:{originX:-1,originY:0,imageWidth:10,imageHeight:10,scaleX:1,scaleY:1}},0.8,0);assert.equal(Object.is(p.x,-0),false);assert.equal(isJsonValue({point:p}),true);});
test('paths reject nonfinite/incomplete points, UIA modes and unbounded strokes',()=>{
  const path=[{x:10,y:20},{x:15,y:30}];assert.deepEqual(strokeOptions({path,durationMs:300},'desktop'),{strokes:[path],durationMs:300});
  for(const args of [{path:[{x:1,y:2}]},{path:[{x:1,y:2},{x:Infinity,y:3}]},{path,mode:'uia'},{path,strokes:[path]},{strokes:Array(33).fill(path)},{path,durationMs:10001}])assert.throws(()=>strokeOptions(args,'desktop'));
});
test('desktop paths require integer pixels, browser paths allow fractional CSS pixels',()=>{const path=[{x:1.5,y:2},{x:3.5,y:4}];assert.throws(()=>strokeOptions({path},'desktop'));assert.equal(strokeOptions({path},'browser').strokes.length,1);});
test('batch steps cannot include nested batches, arbitrary coordinates, navigation or keys',()=>{
  const steps=[{action:'type',observationId:'o',elementId:'e',text:'hello'}];const copy=batchSteps(steps);copy[0].text='changed';assert.equal(steps[0].text,'hello');
  for(const s of [[],Array(9).fill(steps[0]),[{action:'click',observationId:'o',x:2,y:3}],[{action:'key',observationId:'o',elementId:'e',key:'Delete'}],[{action:'batch',requestId:'id'}],[{...steps[0],unknown:true}]])assert.throws(()=>batchSteps(s),{code:'INVALID_BATCH'});
});
test('UI change invalidates only earlier observations of the affected tab document',()=>{
  const store=new Observations(),a=store.add('a',{kind:'browser',tabId:'t',uiSourceId:'doc1',uiVersion:1}),fresh=store.add('a',{kind:'browser',tabId:'t',uiSourceId:'doc1',uiVersion:2}),newDoc=store.add('a',{kind:'browser',tabId:'t',uiSourceId:'doc2',uiVersion:0});
  store.invalidate('browser',{tabId:'t',sourceId:'doc1',version:2});assert.throws(()=>store.get('a',a,'browser'),{code:'UI_CHANGED'});assert.equal(store.get('a',fresh,'browser').uiVersion,2);assert.equal(store.get('a',newDoc,'browser').uiVersion,0);
});
test('delayed desktop property notifications invalidate exact old tokens and preserve fresh captures',()=>{
  const store=new Observations(),a=store.add('a',{kind:'desktop',windowId:4,nativeObservation:'old'}),fresh=store.add('a',{kind:'desktop',windowId:4,nativeObservation:'new'});
  store.invalidate('desktop',{windowId:4,version:100,nativeObservations:['old']});assert.throws(()=>store.get('a',a,'desktop'),{code:'UI_CHANGED'});assert.equal(store.get('a',fresh,'desktop').nativeObservation,'new');
});
test('focus change invalidates foreground keyboard carriers but preserves background UIA observations',()=>{
  const store=new Observations(),screen=store.add('a',{kind:'desktop',scope:'screen',foregroundWindowId:2}),back=store.add('a',{kind:'desktop',scope:'window',windowId:2,foreground:false});
  store.invalidateFocus(3);assert.throws(()=>store.get('a',screen,'desktop'),{code:'UI_CHANGED'});assert.equal(store.get('a',back,'desktop').windowId,2);
});
