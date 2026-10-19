import {app, BrowserWindow, ipcMain} from 'electron'; import {join} from 'node:path'; import {Store} from './store';
const arg=process.argv.indexOf('--user-data-dir'); if(arg>=0 && process.argv[arg+1])app.setPath('userData',process.argv[arg+1]);
app.whenReady().then(()=>{
 const store=new Store(app.getPath('userData'));
 ipcMain.handle('notes:list',()=>store.list()); ipcMain.handle('notes:save',(_event,value)=>store.save(value)); ipcMain.handle('notes:delete',(_event,id)=>store.remove(id));
 const window=new BrowserWindow({width:850,height:650,webPreferences:{preload:join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 window.loadFile(join(__dirname,'index.html'));
});
app.on('window-all-closed',()=>app.quit());
