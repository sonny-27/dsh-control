// No content scripts, web-accessible resources or page message handlers.
// The plugin talks to this privileged context through its private CDP connection.
globalThis.dshGroups=async ({op,targetId,groupId,title,color,windowId})=>{
  if(op==='groups')return await chrome.tabGroups.query({});
  const target=(await chrome.debugger.getTargets()).find(t=>t.id===targetId);
  if(!target?.tabId)throw new Error('Owned page target is no longer a browser tab');
  const tab=await chrome.tabs.get(target.tabId);
  if(op==='check')return {tabId:tab.id,groupId:tab.groupId,windowId:tab.windowId,url:tab.url??'',pendingUrl:tab.pendingUrl??''};
  if(op!=='assign')throw new Error('Unsupported group operation');
  if(windowId!==undefined&&tab.windowId!==windowId)await chrome.tabs.move(tab.id,{windowId,index:-1});
  let existing=false;if(groupId!==undefined)try{await chrome.tabGroups.get(groupId);existing=true;}catch{}
  const id=await chrome.tabs.group(existing?{tabIds:[tab.id],groupId}:{tabIds:[tab.id]});
  await chrome.tabGroups.update(id,{title,color,collapsed:false});
  const group=await chrome.tabGroups.get(id);return {id:group.id,title:group.title,color:group.color,windowId:group.windowId,tabId:tab.id};
};
