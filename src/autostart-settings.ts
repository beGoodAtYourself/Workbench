import {asFault,type AutostartChange,type AutostartStatus,type Repository,type Settings} from './types';

interface SettingsActions {
 updated(settings:Settings):void;
 saved(message:string):void;
 exit():void;
 folder():void;
}

export function openSettings(repo:Repository,initial:Settings,actions:SettingsActions){
 const dialog=document.createElement('dialog');dialog.className='modal settings-modal';
 dialog.setAttribute('aria-labelledby','settings-title');
 dialog.innerHTML='<form><div class="modal-kicker">按你的习惯来</div><h2 id="settings-title">工作台设置</h2><label class="field-label">全局快捷键<input name="shortcut" required placeholder="Control+Alt+Space"></label><p class="input-help">例如 Control+Alt+Space。若组合键被占用，会保留原有设置。</p><label class="check-row"><input name="floating" type="checkbox">显示桌面悬浮入口</label><section class="autostart-settings"><label class="check-row"><input name="autostart" type="checkbox" disabled aria-describedby="autostart-help autostart-status autostart-target">开机自启动</label><p id="autostart-help" class="input-help">登录 Windows 后在后台运行，可通过托盘、悬浮入口或快捷键调出。</p><p id="autostart-status" role="status" aria-live="polite">正在读取自启动状态…</p><p id="autostart-target" class="autostart-target" hidden></p><button type="button" id="autostart-retry" class="secondary" disabled>重新读取自启动状态</button><p class="input-help">此开关表示启动项已注册。若 Windows 禁止执行，请在系统「设置 → 应用 → 启动」中检查。</p></section><div class="settings-folder"><small>笔记存放位置</small><p></p><button type="button" id="settings-folder" class="secondary">更换文件夹</button></div><p class="form-error" role="alert"></p><button type="button" id="settings-retry" class="secondary" hidden>重新读取设置</button><div class="modal-actions"><button type="button" class="secondary" id="settings-exit">退出拾页</button><span></span><button type="button" class="secondary" id="settings-cancel">取消</button><button class="primary" type="submit">保存设置</button></div></form>';
 const form=dialog.querySelector<HTMLFormElement>('form')!,shortcut=form.elements.namedItem('shortcut') as HTMLInputElement,floating=form.elements.namedItem('floating') as HTMLInputElement,checkbox=form.elements.namedItem('autostart') as HTMLInputElement;
 const statusText=dialog.querySelector<HTMLElement>('#autostart-status')!,targetText=dialog.querySelector<HTMLElement>('#autostart-target')!,retry=dialog.querySelector<HTMLButtonElement>('#autostart-retry')!,actualRetry=dialog.querySelector<HTMLButtonElement>('#settings-retry')!,save=dialog.querySelector<HTMLButtonElement>('[type="submit"]')!,error=dialog.querySelector<HTMLElement>('.form-error')!;
 let status:AutostartStatus={state:'error',target:null,revision:null,message:null},loading=true,saving=false,refreshing=false,readEpoch=0;
 const busy=()=>saving||refreshing;
 const writable=()=>['enabled','disabled','other'].includes(status.state)&&status.revision!==null;
 function updateControls(){
  for(const element of dialog.querySelectorAll<HTMLInputElement|HTMLButtonElement>('input,button'))element.disabled=busy();
  checkbox.disabled=busy()||loading||!writable();retry.disabled=busy()||loading||status.state==='unavailable';
  save.textContent=saving?'正在保存…':'保存设置';dialog.setAttribute('aria-busy',String(busy()));
 }
 function fillSettings(settings:Settings){
  shortcut.value=settings.shortcut;floating.checked=settings.floating;
  dialog.querySelector('.settings-folder p')!.textContent=settings.root||'尚未选择';
 }
 function renderStatus(){
  checkbox.checked=status.state==='enabled';
  const descriptions:Record<AutostartStatus['state'],string>={enabled:'已为当前程序开启。',disabled:'当前程序未注册开机自启动。',other:'启动项指向另一份拾页。主动开启并保存，可切换到当前程序；关闭当前副本不会删除另一份的启动项。',error:'开机自启动状态未知，请重试读取。',unavailable:'开机自启动仅 Windows 桌面版可用。'};
  statusText.textContent=status.state==='unavailable'&&status.message?status.message:descriptions[status.state]+(status.message?' '+status.message:'');
  targetText.textContent=status.target?'启动项目标：'+status.target:'';targetText.hidden=!status.target;
  retry.hidden=status.state==='unavailable';retry.textContent=status.state==='error'?'重试读取自启动状态':'重新读取自启动状态';updateControls();
 }
 async function readStatus():Promise<AutostartStatus>{
  const epoch=++readEpoch;loading=true;checkbox.disabled=true;retry.disabled=true;
  statusText.textContent='正在读取自启动状态…';
  let result:AutostartStatus;
  try{result=await repo.autostart();}catch(cause){result={state:'error',target:null,revision:null,message:asFault(cause).message};}
  if(epoch===readEpoch&&dialog.isConnected){status=result;loading=false;renderStatus();}
  return result;
 }
 async function readActual(){
  const results=await Promise.allSettled([repo.settings(),readStatus()]);
  if(!dialog.isConnected)return;
  const actual=results[0];
  if(actual.status==='fulfilled'){fillSettings(actual.value);actions.updated(actual.value);}
  else error.textContent+=' 无法重新读取本地设置：'+asFault(actual.reason).message;
 }
 async function refreshActual(){
  if(busy())return;refreshing=true;updateControls();
  try{await readActual();}finally{refreshing=false;updateControls();}
 }
 fillSettings(initial);document.body.append(dialog);dialog.showModal();
 dialog.addEventListener('close',()=>{readEpoch++;dialog.remove();},{once:true});
 dialog.addEventListener('cancel',event=>{if(busy())event.preventDefault();});
 dialog.querySelector('#settings-cancel')!.addEventListener('click',()=>{if(!busy())dialog.close();});
 dialog.querySelector('#settings-exit')!.addEventListener('click',()=>{if(!busy()){dialog.close();actions.exit();}});
 dialog.querySelector('#settings-folder')!.addEventListener('click',()=>{if(!busy()){dialog.close();actions.folder();}});
 retry.addEventListener('click',()=>{if(!busy()&&!loading)void readStatus();});actualRetry.addEventListener('click',()=>{void refreshActual();});
 form.addEventListener('submit',event=>{
  event.preventDefault();if(busy())return;
  const change:AutostartChange|undefined=writable()&&!loading&&checkbox.checked!==(status.state==='enabled')?{enabled:checkbox.checked,revision:status.revision!}:undefined;
  const requestedShortcut=shortcut.value.trim(),requestedFloating=floating.checked;
  saving=true;error.textContent='';actualRetry.hidden=true;updateControls();
  void (async()=>{
   try{
    const next=await repo.configure(requestedShortcut,requestedFloating,change);actions.updated(next);
    const actual=await readStatus();
    if(change&&(actual.state!==(change.enabled?'enabled':'disabled'))){
     throw new Error(actual.state==='error'||actual.state==='unavailable'?'设置保存后无法确认开机自启动的实际状态，请重试读取。':'开机自启动状态已被外部修改，请确认当前状态后重试。');
    }
    dialog.close();actions.saved('设置已保存。');
   }catch(cause){
    error.textContent=asFault(cause).message;actualRetry.hidden=false;
    await readActual();
   }finally{saving=false;if(dialog.isConnected)updateControls();}
  })();
 });
 void readStatus();
}
