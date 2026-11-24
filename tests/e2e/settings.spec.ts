import {test,expect,type Page} from '@playwright/test';
import type {AutostartStatus,Settings} from '../../src/types';

interface SettingsMock {
 settings:Settings;
 status:AutostartStatus;
 readError:boolean;
 readErrorAfterSave:boolean;
 holdFirstRead:boolean;
 releaseRead:(()=>void)|null;
 saveError:string|null;
 partial:boolean;
 hold:boolean;
 release:(()=>void)|null;
 reads:number;
 updates:Array<{shortcut:string;floating:boolean;autostart:{enabled:boolean;revision:string}|null}>;
}
declare global {interface Window {__settingsMock:SettingsMock}}

const target='C:\\本地应用\\拾页 工作台\\shiye.exe';
const state=(value:AutostartStatus['state'],revision='r1',path:string|null=value==='enabled'?target:null):AutostartStatus=>({state:value,target:path,revision,message:null});
async function desktop(page:Page,status=state('disabled'),options:Partial<Pick<SettingsMock,'readError'|'readErrorAfterSave'|'holdFirstRead'|'saveError'|'partial'|'hold'>>={}){
 await page.addInitScript(({status,options})=>{
  const mock:SettingsMock={settings:{root:null,shortcut:'Control+Alt+Space',floating:true,floatX:40,floatY:180,session:{module:'notes',panes:[],expanded:[]}},status,readError:false,readErrorAfterSave:false,holdFirstRead:false,releaseRead:null,saveError:null,partial:false,hold:false,release:null,reads:0,updates:[],...options};
  window.__settingsMock=mock;
  let callback=0;
  Object.assign(window,{__TAURI_INTERNALS__:{transformCallback:()=>++callback,invoke:async(cmd:string,args:Record<string,unknown>)=>{
   if(cmd==='get_settings')return structuredClone(mock.settings);
   if(cmd==='text_restore')return {schema:1,generation:0,documents:[],views:[],active:0};
   if(cmd==='text_checkpoint')return {generation:(args.value as {generation:number}).generation,token:'settings-test-checkpoint'};
   if(cmd==='text_notes'||cmd==='text_invalidate')return null;
   if(cmd==='text_note_owner')return null;
   if(cmd==='get_autostart_status'){mock.reads++;if(mock.readError)throw {code:'autostart',message:'无法读取 Windows 启动项。'};const result=structuredClone(mock.status);if(mock.holdFirstRead&&mock.reads===1)await new Promise<void>(resolve=>{mock.releaseRead=resolve;});return result;}
   if(cmd==='update_settings'){
    const update=args as unknown as SettingsMock['updates'][number];mock.updates.push(structuredClone(update));
    if(mock.hold)await new Promise<void>(resolve=>{mock.release=resolve;});
    if(update.autostart&&update.autostart.revision!==mock.status.revision)throw {code:'stale',message:'启动项已被外部修改，请重新确认后重试。'};
    if(mock.saveError){
     const message=mock.saveError;mock.saveError=null;
     if(mock.partial){mock.settings.shortcut='Control+Shift+F8';mock.settings.floating=false;mock.status={state:'enabled',target:'C:\\恢复失败\\shiye.exe',revision:'partial',message:null};}
     throw {code:'settings',message};
    }
    mock.settings={...mock.settings,shortcut:update.shortcut,floating:update.floating};
    if(update.autostart)mock.status={state:update.autostart.enabled?'enabled':'disabled',target:update.autostart.enabled?'C:\\本地应用\\拾页 工作台\\shiye.exe':null,revision:'saved-'+mock.updates.length,message:null};
    if(mock.readErrorAfterSave)mock.readError=true;
    return structuredClone(mock.settings);
   }
   if(cmd==='plugin:event|listen')return ++callback;
   if(cmd==='folder_order')return {root:'',revision:'',parents:{}};
   return null;
  }}});
 },{status,options});
 await page.goto('/');await expect(page.locator('#settings')).toBeVisible();
}
async function open(page:Page){await page.locator('#settings').click();await expect(page.getByRole('dialog')).toBeVisible();await expect(page.locator('#autostart-status')).not.toHaveText('正在读取自启动状态…');}
const updates=(page:Page)=>page.evaluate(()=>window.__settingsMock.updates);

test('desktop status defaults off and enables only when saved, then reads actual state again',async({page})=>{
 await desktop(page);await open(page);
 const toggle=page.getByLabel('开机自启动',{exact:true});await expect(toggle).not.toBeChecked();await expect(toggle).toBeEnabled();
 await expect(page.getByRole('dialog')).toContainText('登录 Windows 后在后台运行');await expect(page.getByRole('dialog')).toContainText('设置 → 应用 → 启动');
 await toggle.check();await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(await updates(page)).toEqual([{shortcut:'Control+Alt+Space',floating:true,autostart:{enabled:true,revision:'r1'}}]);
 await open(page);await expect(toggle).toBeChecked();await expect(page.locator('#autostart-target')).toHaveText('启动项目标：'+target);
 await page.getByRole('dialog').screenshot({path:'.qa/autostart-settings-desktop.png'});
 expect(await page.evaluate(()=>window.__settingsMock.reads)).toBe(3);
});

test('enabled status can be disabled and cancel performs no write',async({page})=>{
 await desktop(page,state('enabled'));await open(page);const toggle=page.getByLabel('开机自启动',{exact:true});await expect(toggle).toBeChecked();
 await toggle.uncheck();await page.getByRole('button',{name:'取消',exact:true}).click();expect(await updates(page)).toEqual([]);
 await open(page);await expect(toggle).toBeChecked();await toggle.uncheck();await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 expect((await updates(page))[0].autostart).toEqual({enabled:false,revision:'r1'});
});

test('saving shortcut and floating preferences leaves unchanged startup registration alone',async({page})=>{
 await desktop(page,state('enabled'));await open(page);
 await page.getByLabel('全局快捷键',{exact:true}).fill('Control+Shift+F9');await page.getByLabel('显示桌面悬浮入口',{exact:true}).uncheck();
 await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(await updates(page)).toEqual([{shortcut:'Control+Shift+F9',floating:false,autostart:null}]);
});

test('reopening after external deletion reads off and saving other settings does not recreate it',async({page})=>{
 await desktop(page,state('enabled'));await open(page);await page.getByRole('button',{name:'取消',exact:true}).click();
 await page.evaluate(()=>{window.__settingsMock.status={state:'disabled',target:null,revision:'deleted',message:null};});
 await open(page);await expect(page.getByLabel('开机自启动',{exact:true})).not.toBeChecked();await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 expect((await updates(page))[0].autostart).toBeNull();
});

test('another copy is displayed unchecked and only an explicit enable switches its target',async({page})=>{
 const other='D:\\另一份 拾页\\shiye.exe';await desktop(page,state('other','other-revision',other));await open(page);
 const toggle=page.getByLabel('开机自启动',{exact:true});await expect(toggle).not.toBeChecked();await expect(page.locator('#autostart-target')).toHaveText('启动项目标：'+other);await expect(page.locator('#autostart-status')).toContainText('主动开启并保存');
 await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await updates(page))[0].autostart).toBeNull();
 await open(page);await toggle.check();await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await updates(page))[1].autostart).toEqual({enabled:true,revision:'other-revision'});
});

test('read failure shows unknown, disables only startup and can retry',async({page})=>{
 await desktop(page,state('disabled'),{readError:true});await open(page);
 await expect(page.getByLabel('开机自启动',{exact:true})).toBeDisabled();await expect(page.locator('#autostart-status')).toContainText('状态未知');await expect(page.locator('#autostart-status')).toContainText('无法读取 Windows 启动项');
 await expect(page.getByLabel('全局快捷键',{exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'保存设置',exact:true})).toBeEnabled();
 await page.evaluate(()=>{window.__settingsMock.readError=false;window.__settingsMock.status={state:'enabled',target:'C:\\修复路径\\shiye.exe',revision:'recovered',message:null};});
 await page.getByRole('button',{name:'重试读取自启动状态',exact:true}).click();await expect(page.getByLabel('开机自启动',{exact:true})).toBeEnabled();await expect(page.getByLabel('开机自启动',{exact:true})).toBeChecked();
});

test('other settings can save while startup status is unreadable',async({page})=>{
 await desktop(page,state('disabled'),{readError:true});await open(page);await page.getByLabel('全局快捷键',{exact:true}).fill('Control+Shift+F9');
 await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await updates(page))[0].autostart).toBeNull();
});

test('browser preview explains unavailable startup and saves its usable preferences',async({page})=>{
 await page.goto('/');await open(page);await expect(page.getByLabel('开机自启动',{exact:true})).toBeDisabled();await expect(page.locator('#autostart-status')).toContainText('浏览器预览');
 await expect(page.locator('#autostart-retry')).toBeHidden();await page.getByLabel('显示桌面悬浮入口',{exact:true}).uncheck();await page.getByRole('button',{name:'保存设置',exact:true}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);await open(page);await expect(page.getByLabel('显示桌面悬浮入口',{exact:true})).not.toBeChecked();await page.getByRole('dialog').screenshot({path:'.qa/autostart-settings-preview.png'});
});

test('saving locks controls and escape, and repeated submit issues one command',async({page})=>{
 await desktop(page,state('disabled'),{hold:true});await open(page);await page.getByLabel('开机自启动',{exact:true}).check();
 await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.getByRole('button',{name:'正在保存…',exact:true})).toBeDisabled();
 for(const selector of ['[name="shortcut"]','[name="floating"]','[name="autostart"]','#settings-cancel','#settings-exit','#settings-folder','#autostart-retry'])await expect(page.locator(selector)).toBeDisabled();
 await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toBeVisible();await page.locator('dialog form').evaluate(form=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 expect(await updates(page)).toHaveLength(1);await page.evaluate(()=>window.__settingsMock.release?.());await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('save failure retains its error, reloads actual preferences and permits retry',async({page})=>{
 await desktop(page,state('disabled'),{saveError:'注册失败，已恢复原设置。'});await open(page);await page.getByLabel('开机自启动',{exact:true}).check();await page.getByLabel('全局快捷键',{exact:true}).fill('Control+Shift+F9');
 await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.locator('.form-error')).toHaveText('注册失败，已恢复原设置。');await expect(page.getByRole('button',{name:'保存设置',exact:true})).toBeEnabled();
 await expect(page.getByLabel('开机自启动',{exact:true})).not.toBeChecked();await expect(page.getByLabel('全局快捷键',{exact:true})).toHaveValue('Control+Alt+Space');await expect(page.locator('#settings-retry')).toBeVisible();
 await page.locator('#settings-retry').click();await expect(page.locator('.form-error')).toHaveText('注册失败，已恢复原设置。');await page.getByLabel('开机自启动',{exact:true}).check();
 await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(await updates(page)).toHaveLength(2);
});

test('rollback failure displays partial actual state without losing the failure message',async({page})=>{
 await desktop(page,state('disabled'),{saveError:'保存失败；恢复失败，部分变更已生效。',partial:true});await open(page);await page.getByLabel('开机自启动',{exact:true}).check();
 await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.locator('.form-error')).toHaveText('保存失败；恢复失败，部分变更已生效。');await expect(page.getByLabel('开机自启动',{exact:true})).toBeChecked();
 await expect(page.getByLabel('全局快捷键',{exact:true})).toHaveValue('Control+Shift+F8');await expect(page.getByLabel('显示桌面悬浮入口',{exact:true})).not.toBeChecked();await expect(page.locator('#autostart-target')).toContainText('恢复失败');
});

test('external change during editing refreshes the revision and requires a new explicit choice',async({page})=>{
 await desktop(page,state('disabled'));await open(page);await page.getByLabel('开机自启动',{exact:true}).check();
 await page.evaluate(()=>{window.__settingsMock.status={state:'other',target:'D:\\外部副本\\shiye.exe',revision:'external',message:null};});
 await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.locator('.form-error')).toHaveText('启动项已被外部修改，请重新确认后重试。');await expect(page.getByLabel('开机自启动',{exact:true})).not.toBeChecked();await expect(page.locator('#autostart-target')).toContainText('外部副本');
 await page.getByLabel('开机自启动',{exact:true}).check();await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await updates(page))[1].autostart).toEqual({enabled:true,revision:'external'});
});

test('backend error status remains unknown with the explanation and retry available',async({page})=>{
 await desktop(page,{state:'error',target:null,revision:null,message:'没有权限读取启动项。'});await open(page);
 await expect(page.getByLabel('开机自启动',{exact:true})).toBeDisabled();await expect(page.locator('#autostart-status')).toContainText('没有权限读取启动项');await expect(page.getByRole('button',{name:'重试读取自启动状态',exact:true})).toBeEnabled();
});

test('a failed status read after saving keeps the dialog open without claiming success',async({page})=>{
 await desktop(page,state('disabled'),{readErrorAfterSave:true});await open(page);await page.getByLabel('开机自启动',{exact:true}).check();
 await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.locator('.form-error')).toContainText('无法确认开机自启动的实际状态');await expect(page.getByLabel('开机自启动',{exact:true})).toBeDisabled();
 await expect(page.locator('#toast.visible')).toHaveCount(0);await page.evaluate(()=>{window.__settingsMock.readError=false;});await page.getByRole('button',{name:'重试读取自启动状态',exact:true}).click();
 await expect(page.getByLabel('开机自启动',{exact:true})).toBeChecked();await expect(page.locator('.form-error')).toContainText('无法确认开机自启动的实际状态');
});

test('other preferences save during the first status read without sending a startup change',async({page})=>{
 await desktop(page,state('enabled'),{holdFirstRead:true});await page.locator('#settings').click();await expect(page.locator('#autostart-status')).toHaveText('正在读取自启动状态…');await expect(page.getByLabel('开机自启动',{exact:true})).toBeDisabled();
 await page.getByLabel('全局快捷键',{exact:true}).fill('Control+Shift+F9');await page.evaluate(()=>{window.__settingsMock.status={state:'disabled',target:null,revision:'deleted-during-read',message:null};});
 await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await updates(page))[0].autostart).toBeNull();
 await page.evaluate(()=>window.__settingsMock.releaseRead?.());await open(page);await expect(page.getByLabel('开机自启动',{exact:true})).not.toBeChecked();
});

test('long external paths wrap and settings remain usable in a short viewport',async({page})=>{
 await page.setViewportSize({width:760,height:640});await desktop(page,state('other','long-target','C:\\'+('中文 空格路径'.repeat(30))+'\\shiye.exe'));await open(page);
 expect(await page.locator('#autostart-target').evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
 const bounds=await page.getByRole('dialog').boundingBox();expect(bounds!.y).toBeGreaterThanOrEqual(19);expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(621);
 await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(await updates(page)).toEqual([]);
});
