type Note={id:string;title:string;body:string};
declare global {interface Window {notes:{list:()=>Promise<Note[]>;save:(n:unknown)=>Promise<Note>;remove:(id:string)=>Promise<void>}}}
let selected:string|null=null;
const title=document.querySelector<HTMLInputElement>('#title')!,body=document.querySelector<HTMLTextAreaElement>('#body')!,error=document.querySelector('#error')!;
async function render(){const list=document.querySelector('#notes')!;list.replaceChildren();for(const note of await window.notes.list()){const b=document.createElement('button');b.textContent=note.title;b.dataset.id=note.id;b.onclick=()=>{selected=note.id;title.value=note.title;body.value=note.body;error.textContent='';};list.append(b);}}
document.querySelector<HTMLButtonElement>('#new')!.onclick=()=>{selected=null;title.value='';body.value='';error.textContent='';};
document.querySelector<HTMLButtonElement>('#save')!.onclick=async()=>{try{const note=await window.notes.save({id:selected,title:title.value,body:body.value});selected=note.id;title.value=note.title;error.textContent='';await render();}catch(e){error.textContent=String(e);}};
document.querySelector<HTMLButtonElement>('#delete')!.onclick=async()=>{if(!selected)return;try{await window.notes.remove(selected);selected=null;title.value='';body.value='';error.textContent='';await render();}catch(e){error.textContent=String(e);}};
render();
export {};
