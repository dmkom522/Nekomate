import {test,expect,_electron as electron} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';

test('repeated launches exit silently, preserve pet state and focus, and allow a new launch after exit',async()=>{
  const profile=await mkdtemp(path.resolve('.local/single-instance-'));
  const env={...process.env,DESKMATE_TEST_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.env.DESKMATE_ELECTRON_PATH;
  let app;
  const launch=()=>electron.launch({args:['.'],env,executablePath});
  const duplicate=()=>new Promise((resolve,reject)=>{
    const child=spawn(app.process().spawnfile,[path.resolve('.')],{cwd:path.resolve('.'),env,windowsHide:true,stdio:'ignore'});
    const timer=setTimeout(()=>{child.kill();reject(new Error('Duplicate application did not exit'));},8000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
  });
  try{
    app=await launch();
    await expect.poll(()=>app.windows().some(page=>page.url().endsWith('/pet.html'))).toBe(true);
    const pet=app.windows().find(page=>page.url().endsWith('/pet.html'));
    const page=app.windows().find(page=>page.url().endsWith('/index.html'));
    await expect(pet.locator('#petState')).toHaveText('点我提问');
    await pet.locator('#petButton').click();await page.locator('#question').fill('保留这段未发送的输入');
    await page.evaluate(()=>window.deskmate.hidePanel());
    await app.evaluate(async({BrowserWindow})=>{
      globalThis.focusFixture=new BrowserWindow({width:240,height:100,show:false,webPreferences:{sandbox:true}});
      await globalThis.focusFixture.loadURL('data:text/html,<title>Focus fixture</title><body>Other window</body>');
      globalThis.focusFixture.show();globalThis.focusFixture.focus();
    });
    for(const state of ['cat','chat','tail']){
      if(state==='chat')await pet.locator('#petButton').click();
      if(state==='tail'){
        await app.evaluate(({BrowserWindow,screen})=>{
          const bounds=screen.getPrimaryDisplay().bounds;
          BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/pet.html')).setBounds({x:bounds.x+200,y:bounds.y+200,width:126,height:118});
          globalThis.fixtureCursor={x:bounds.x+240,y:bounds.y+240};screen.getCursorScreenPoint=()=>globalThis.fixtureCursor;
        });
        await pet.evaluate(()=>window.pet.action('drag-start'));
        await app.evaluate(({screen})=>{globalThis.fixtureCursor={...globalThis.fixtureCursor,x:screen.getPrimaryDisplay().bounds.x};});
        await pet.evaluate(()=>window.pet.action('drag-move'));await pet.evaluate(()=>window.pet.action('drag-end'));
        await expect(pet.locator('body')).toHaveAttribute('data-docked','left');
      }
      await app.evaluate(()=>globalThis.focusFixture.focus());
      await expect.poll(()=>app.evaluate(()=>globalThis.focusFixture.isFocused())).toBe(true);
      const snapshot=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(window=>({id:window.id,bounds:window.getBounds(),visible:window.isVisible(),focused:window.isFocused()})).sort((a,b)=>a.id-b.id));
      const before=await snapshot(),docked=await pet.locator('body').getAttribute('data-docked');
      expect(await duplicate()).toEqual({code:0,signal:null});
      expect(await snapshot()).toEqual(before);
      await expect(pet.locator('body')).toHaveAttribute('data-docked',docked??'');
      await expect(page.locator('#question')).toHaveValue('保留这段未发送的输入');
    }
    await app.close();app=await launch();
    await expect.poll(()=>app.windows().some(page=>page.url().endsWith('/pet.html'))).toBe(true);
    await expect(app.windows().find(page=>page.url().endsWith('/pet.html')).locator('#petState')).toHaveText('点我提问');
  }finally{if(app)await app.close();}
});
