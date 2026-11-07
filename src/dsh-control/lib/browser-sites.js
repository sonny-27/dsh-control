import {parse} from 'tldts';
import {ControlError} from './common.js';
export function browserSite(value){
  const url=new URL(value);
  if(url.href==='about:blank')return 'about:blank';
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new ControlError('INVALID_URL','浏览器授权仅支持无凭据的 http/https 站点');
  const parsed=parse(url.hostname,{allowPrivateDomains:true});
  const domain=parsed.domain??url.hostname;
  return `${url.protocol}//${domain}${url.port?':'+url.port:''}`;
}
export function browsingAction(action){
  const args=action.arguments??{},element=action.target?.element;
  if(['open','navigate','back','forward','reload','select-tab','hover','scroll'].includes(action.action))return true;
  if(action.action==='batch')return (action.steps??[]).every(s=>browsingAction({action:s.action.action,arguments:s.action,target:{element:s.element}}));
  if(!element)return false;
  if(action.action==='type')return element.search===true&&!element.password;
  if(action.action==='key')return args.key==='Enter'&&element.search===true;
  if(action.action==='click'){
    if(/删除|付款|支付|购买|发布|提交|发送|上传|下载|delete|purchase|payment|publish|submit|upload|download/i.test(element.name??''))return false;
    if(element.tag==='a'&&element.href&&/^https?:/.test(element.href)){
      const url=new URL(element.href);return !/\/(?:delete|remove|purchase|pay|checkout|logout)(?:\/|\?|$)/i.test(url.pathname);
    }
    return element.search===true||/^(关闭(?:验证|弹窗)?|取消|返回|搜索|查询|close|cancel|back|search)$/i.test(element.name??'');
  }
  return false;
}
export function actionSites(action){
  const values=[];const add=v=>{if(v)values.push(browserSite(v));};
  if(action.action==='batch'){for(const entry of action.steps??[])add(entry.observation?.url);}
  else {add(action.target?.url);if(['open','navigate'].includes(action.action))add(action.arguments?.url??'about:blank');if(action.action==='click'&&action.target?.element?.href&&/^https?:/.test(action.target.element.href))add(action.target.element.href);}
  return [...new Set(values)];
}
