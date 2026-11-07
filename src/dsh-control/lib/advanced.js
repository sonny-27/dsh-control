import {ControlError,integer} from './common.js';

export const waitConditions=['window','active-window','element','enabled','focused','text'];
export function waitOptions(args){
  const condition=args.condition??'window';
  if(!waitConditions.includes(condition))throw new ControlError('INVALID_CONDITION','等待条件必须是 window/active-window/element/enabled/focused/text');
  integer(args.waitMs??2000,'waitMs',200,10000);
  if(args.query!==undefined&&(typeof args.query!=='string'||!args.query.trim()||args.query.length>200))throw new ControlError('QUERY_REQUIRED','query 为实际窗口/控件/文本名称');
  if(condition!=='window'&&!args.query)throw new ControlError('QUERY_REQUIRED','条件等待需要 query');
  return {condition,query:args.query??'',waitMs:args.waitMs??2000,windowId:args.windowId};
}
export function captureOptions(args){
  if(args.region!==undefined){const r=args.region;if(!r||Array.isArray(r)||Object.keys(r).some(k=>!['x','y','width','height'].includes(k)))throw new ControlError('INVALID_REGION','region 为 x/y/width/height 对象');for(const k of ['x','y','width','height'])integer(r[k],`region.${k}`,k==='width'||k==='height'?1:-2147483648,2147483647);}
  if(args.maxWidth!==undefined)integer(args.maxWidth,'maxWidth',160,4096);
  return {region:args.region,maxWidth:args.maxWidth};
}
export function imagePoint(observation,x,y){
  const t=observation.imageTransform;
  if(!t)throw new ControlError('IMAGE_MAPPING_REQUIRED','此观察没有截图坐标映射，请重新截图');
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=t.imageWidth||y>=t.imageHeight)throw new ControlError('OUT_OF_IMAGE','坐标必须处于返回的截图像素范围');
  const p={x:t.originX+x*t.scaleX,y:t.originY+y*t.scaleY};
  const zero=n=>n===0?0:n;
  return observation.kind==='desktop'?{x:zero(Math.min(Math.ceil(t.originX+t.scaleX*t.imageWidth)-1,Math.round(p.x))),y:zero(Math.min(Math.ceil(t.originY+t.scaleY*t.imageHeight)-1,Math.round(p.y)))}:p;
}
export function strokeOptions(args,kind){
  if(args.path!==undefined&&args.strokes!==undefined)throw new ControlError('INVALID_PATH','path 和 strokes 不能同时提供');
  const strokes=args.strokes??(args.path?[args.path]:null);
  if(!Array.isArray(strokes)||strokes.length<1||strokes.length>32)throw new ControlError('INVALID_PATH','需要 1..32 个笔画，每个笔画为点列表');
  let total=0;for(const path of strokes){if(!Array.isArray(path)||path.length<2||path.length>256)throw new ControlError('INVALID_PATH','每个笔画需要 2..256 个点');for(const point of path){if(!point||Array.isArray(point)||Object.keys(point).some(k=>!['x','y'].includes(k))||!Number.isFinite(point.x)||!Number.isFinite(point.y))throw new ControlError('INVALID_PATH','路径点为有限数值的 x/y 对象');if(kind==='desktop'){integer(point.x,'path.x');integer(point.y,'path.y');}}total+=path.length;}
  if(total>1024)throw new ControlError('PATH_TOO_LONG','总路径点不能超过 1024');
  integer(args.durationMs??1000,'durationMs',100,10000);
  if(args.mode!==undefined&&args.mode!=='mouse')throw new ControlError('MOUSE_REQUIRED','路径拖拽与笔画只支持 mouse 模式');
  return {strokes,durationMs:args.durationMs??1000};
}
export function batchSteps(value){
  if(!Array.isArray(value)||value.length<1||value.length>8)throw new ControlError('INVALID_BATCH','批量操作需要 1..8 个步骤');
  const keys=['action','requestId','observationId','elementId','mode','text','replace','button','count','deltaX','deltaY'];
  for(const s of value){if(!s||Array.isArray(s)||Object.keys(s).some(k=>!keys.includes(k))||!['perform','click','type','hover','scroll'].includes(s.action))throw new ControlError('INVALID_BATCH','步骤仅支持已观察控件的 perform/click/type/hover/scroll，不允许坐标、导航、嵌套批量或按键');if(s.action!=='perform'&&(!s.observationId||!s.elementId))throw new ControlError('INVALID_BATCH','每个步骤必须引用观察中的控件编号');}
  return JSON.parse(JSON.stringify(value));
}
