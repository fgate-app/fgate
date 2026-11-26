import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'freedomgate-auth-'));
const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:'18787',FREEDOMGATE_DB:join(dir,'test.sqlite')},stdio:['ignore','pipe','pipe']});
let browser;
async function openMobileMenu(page){
 if(!await page.getByTestId('mobile-navigation-toggle').isVisible())return;
 if(await page.getByTestId('mobile-navigation-toggle').getAttribute('aria-expanded')==='false')await page.locator('dialog.is-drawer[open]').waitFor({state:'hidden'});
 if(!await page.locator('dialog.is-drawer[open]').isVisible())await page.getByTestId('mobile-navigation-toggle').click();
}
async function navigate(page,target){
 if(await page.locator('.user-popup').isVisible())await page.keyboard.press('Escape');
 await openMobileMenu(page);
 const nav=await page.getByTestId('mobile-navigation-toggle').isVisible()?page.locator('dialog.is-drawer nav'):page.locator('aside nav');
 if(typeof target==='number')await nav.locator('button').nth(target).click();else await nav.getByRole('button',{name:target,exact:true}).click();
}
async function selectValue(page,testId,value){
 const control=page.getByTestId(testId);
 const interactive=await control.isVisible() && await control.evaluate(element=>!element.closest('[inert]'));
 if(!interactive && await page.getByTestId('user-menu').count()){
  await openMobileMenu(page);await page.locator('[data-testid="user-menu"]:visible').click();
 }
 await page.getByTestId(testId).click();
 const label={en:'English',ru:'Русский',light:(await page.locator('html').getAttribute('lang'))==='ru'?'Светлая':'Light',dark:(await page.locator('html').getAttribute('lang'))==='ru'?'Тёмная':'Dark'}[value];
 await page.getByRole('option',{name:label,exact:true}).click();
}

try{
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(Error('Test server exited '+code)));});
 browser=await chromium.launch({channel:'chrome',headless:true});const externalRequests=[];
 const page=await browser.newPage();
 page.context().on('request',request=>{if(new URL(request.url()).origin!=='http://127.0.0.1:18787')externalRequests.push(request.url());});await page.addInitScript(()=>localStorage.setItem('fg.locale','ru'));const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:18787');
 await page.getByRole('heading',{name:'Первый запуск'}).waitFor();
 await page.getByLabel('Логин',{exact:true}).fill('admin');await page.getByLabel('Пароль',{exact:true}).fill('browser test password');await page.getByRole('button',{name:'Создать администратора'}).click();
 await page.getByRole('heading',{name:'Обзор',exact:true}).waitFor();
 if(new URL(page.url()).pathname!=='/overview')throw Error('Overview URL');
 await page.locator('aside nav').getByRole('button',{name:'Шлюзы',exact:true}).click();if(new URL(page.url()).pathname!=='/connections')throw Error('Connections URL');
 await page.goBack();await page.getByRole('heading',{name:'Обзор',exact:true}).waitFor();await page.goForward();await page.getByRole('heading',{name:'Шлюзы',exact:true}).waitFor();
 await page.locator('nav button').filter({hasText:'Обзор'}).click();
 const edge=await page.locator('aside').boundingBox(),toggle=await page.getByTestId('sidebar-toggle').boundingBox();if(Math.abs(toggle.x+toggle.width/2-(edge.x+edge.width))>1 || toggle.width>24)throw Error('Sidebar toggle position/size');
 await page.getByTestId('sidebar-toggle').click();if(!(await page.locator('.shell').getAttribute('class')).includes('sidebar-collapsed'))throw Error('Sidebar did not collapse');if(!(await page.locator('aside .brand-logo').isVisible()))throw Error('Collapsed logo hidden');if(await page.locator('aside .brand-wordmark').isVisible())throw Error('Collapsed wordmark visible');await page.getByTestId('user-menu').click();await page.getByRole('dialog').waitFor();await page.getByTestId('user-reload').click();const systemDialog=page.getByRole('dialog');await systemDialog.getByTestId('system-config').waitFor();await systemDialog.getByTestId('system-reboot').waitFor();await systemDialog.getByTestId('system-poweroff').waitFor();await page.keyboard.press('Escape');await page.getByTestId('sidebar-toggle').click();
 await page.locator('nav button').filter({hasText:'Настройки'}).click();
 await page.locator('.settings-tabs button').filter({hasText:'Пользователи'}).click();
 await page.getByTestId('add-user').click();const userDialog=page.getByRole('dialog');const closeBox=await userDialog.locator('.dialog-close').boundingBox();if(Math.abs(closeBox.width-closeBox.height)>0.5)throw Error('Dialog close not square');await userDialog.getByLabel('Логин пользователя').fill('reader');await userDialog.getByLabel('Начальный пароль').fill('reader test password');await userDialog.getByTestId('dialog-add-user').click();await userDialog.waitFor({state:'hidden'});await page.getByText('Пользователь создан.',{exact:true}).waitFor();
 const adminRow=page.locator('[data-testid="user-row"]').filter({hasText:'admin'});
 await adminRow.locator('.row-menu-trigger').click();
 await page.getByRole('menuitem',{name:'Отключить'}).click();
 await page.locator('.toast').filter({hasText:"Нельзя отключить или понизить последнего администратора."}).waitFor();
 await page.route('**/api/modules',route=>route.fulfill({json:{ok:true,modules:[]}}));
 await page.route('**/api/zapret/status',route=>route.fulfill({json:{ok:true,running:true,nftables:true}}));
 await page.route('**/api/domain-lists',route=>route.fulfill({json:{loaded:true,repository:'MetaCubeX/meta-rules-dat',ref:'1234567890abcdef',presets:[{id:'youtube',available:true}]}}));
 await page.locator('.settings-tabs button').filter({hasText:'Модули и интеграции'}).click();
 const moduleRows=page.locator('[data-testid="module-row"]');
 await moduleRows.filter({hasText:'zapret'}).getByText('Работает',{exact:true}).waitFor();
 await moduleRows.filter({hasText:'Пресеты доменов'}).getByText('Работает',{exact:true}).waitFor();
 if(await moduleRows.count()!==11)throw Error('Module rows count');
 if(!(await page.getByTestId('check-updates').isVisible()))throw Error('Check updates button missing');
 if(await moduleRows.first().locator('.row-menu-trigger').count()!==0)throw Error('Bundled system module must not expose independent updates');
 await page.getByTestId('user-menu').click();await page.getByRole('button',{name:'Выйти',exact:true}).click();await page.locator('.auth-form').waitFor();
 await page.getByLabel('Логин',{exact:true}).fill('reader');await page.getByLabel('Пароль',{exact:true}).fill('reader test password');await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('heading',{name:'Обзор',exact:true}).waitFor();
 await page.locator('nav button').filter({hasText:'Настройки'}).click();
 await page.locator('.settings-tabs button').filter({hasText:'Пользователи'}).click();
 const viewerRows=page.locator('[data-testid="user-row"]');
 if(await viewerRows.count()!==1)throw Error('Viewer sees more than self');
 if(!(await viewerRows.first().textContent()).includes('reader'))throw Error('Viewer sees wrong user');
 if(await page.getByTestId('add-user').count())throw Error('Viewer sees add user');
 await viewerRows.first().locator('.row-menu-trigger').click();
 await page.getByRole('menuitem',{name:'Сменить пароль'}).click();
 const viewerPasswordDialog=page.getByRole('dialog');
 await viewerPasswordDialog.getByLabel('Текущий пароль',{exact:true}).waitFor();
 await viewerPasswordDialog.getByLabel('Новый пароль',{exact:true}).waitFor();
 await viewerPasswordDialog.getByLabel('Повторите новый пароль',{exact:true}).waitFor();
 await page.keyboard.press('Escape');
 await page.locator('aside nav').getByRole('button',{name:'Шлюзы',exact:true}).click();if(await page.getByRole('button',{name:'Сохранить черновик'}).count())throw Error('Viewer sees write form');
 await page.reload();await page.getByRole('heading',{name:'Шлюзы',exact:true}).waitFor();if(new URL(page.url()).pathname!=='/connections')throw Error('Reload changed route');
 await page.goto('http://127.0.0.1:18787/settings/users');await page.getByRole('heading',{name:'Настройки',exact:true}).waitFor();await page.waitForURL('**/settings/users');
 await navigate(page,'Клиенты');await page.getByText('Клиентов пока нет',{exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile overflow');
 // Every screen in both locales/themes at narrow mobile, tablet and desktop sizes.
 await openMobileMenu(page);await page.locator('[data-testid="user-menu"]:visible').click();if(await page.getByTestId('user-reload').count())throw Error('Viewer sees reload');await page.getByRole('button',{name:'Выйти',exact:true}).click();
 await page.getByLabel('Логин',{exact:true}).fill('admin');await page.getByLabel('Пароль',{exact:true}).fill('browser test password');await page.getByRole('button',{name:'Войти',exact:true}).click();await page.locator('.shell').waitFor();
 await navigate(page,'Клиенты');await page.getByText('Клиентов пока нет',{exact:true}).waitFor();
 for(const locale of ['en','ru'])for(const theme of ['light','dark']){
   await navigate(page,/^(Настройки|Settings)$/);
   await page.waitForSelector('.settings-tabs');
   const first = await page.locator('.settings-tabs button').first().textContent();
   if (!['Система','System'].includes(first)) throw Error('First tab is ' + first + ', expected System');
   await page.locator('.settings-tabs button').filter({hasText:/^(Интерфейс|Appearance)$/}).click();
   await selectValue(page,'language',locale);await selectValue(page,'theme',theme);
   const expectedTabBg=await page.evaluate(()=>{const node=document.createElement('span');node.style.backgroundColor=document.documentElement.dataset.theme==='light'?'var(--color-white)':'var(--color-page)';document.body.append(node);const color=getComputedStyle(node).backgroundColor;node.remove();return color;});
   await page.waitForFunction(expected=>{const node=document.querySelector('.settings-tabs .app-button.active');return node&&getComputedStyle(node).backgroundColor===expected;},expectedTabBg);
   for(const width of [320,390,768,1440]){
     await page.setViewportSize({width,height:950});
     for(let i=0;i<await page.locator('aside nav button').count();i++){
       await navigate(page,i);
       if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Overflow '+JSON.stringify({locale,theme,width,i}));
       if(locale==='en' && /[А-Яа-я]/.test(await page.locator('main').evaluate(el=>{const clone=el.cloneNode(true);clone.querySelectorAll('select,.architecture-node-name').forEach(n=>n.remove());return clone.textContent;})))throw Error('Untranslated Russian content on page '+i);
     }
     await navigate(page,/^(Правила|Rules)$/);
     for(let section=0;section<3;section++){
       await page.locator('#route-tabs button').nth(section).click();
       if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Routes overflow');
     }
     await navigate(page,/^(Настройки|Settings)$/);
     for(let section=0;section<6;section++){
       await page.locator('.settings-tabs button').nth(section).click();
       if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Settings overflow '+JSON.stringify({locale,theme,width,section}));
     }
   }
 }
 await navigate(page,/^(Настройки|Settings)$/);await page.locator('.settings-tabs button').filter({hasText:/^(Интерфейс|Appearance)$/}).click();
 await selectValue(page,'language','en');await selectValue(page,'theme','light');
 await page.locator('nav button').nth(0).click();await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'/tmp/freedomgate-light.png',fullPage:true});
 await page.setViewportSize({width:390,height:950});await page.screenshot({path:'/tmp/freedomgate-mobile.png',fullPage:true});
 await page.reload();await page.locator('.shell').waitFor();
 if(await page.locator('html').getAttribute('data-theme')!=='light')throw Error('Theme not persisted');
 // addInitScript above intentionally resets locale on reload; remove it in a fresh page for default-language checks.
 const fresh=await browser.newContext();fresh.on('request',request=>{if(new URL(request.url()).origin!=='http://127.0.0.1:18787')externalRequests.push(request.url());});const welcome=await fresh.newPage();await welcome.goto('http://127.0.0.1:18787');await welcome.locator('.auth-form').waitFor();
 await selectValue(welcome,'language','ru');await welcome.reload();await welcome.locator('.auth-form').waitFor();await fresh.close();
 if(externalRequests.length)throw Error('Unexpected external requests: '+externalRequests.join(', '));
 if(errors.length)throw Error(errors.join('\n'));console.log('Browser auth: setup, create user, login/logout, viewer permissions, session reload, mobile layout passed.');
}finally{await browser?.close();child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await rm(dir,{recursive:true,force:true});}
