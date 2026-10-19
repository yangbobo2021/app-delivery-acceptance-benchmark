import {readFileSync, writeFileSync, renameSync, mkdirSync, existsSync} from 'node:fs';
import {join} from 'node:path'; import {randomUUID} from 'node:crypto';
type Note = {id:string;title:string;body:string};
export class Store {
 private notes: Note[]; private path: string;
 constructor(dir: string) {mkdirSync(dir,{recursive:true});this.path=join(dir,'notes.json');this.notes=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):[];}
 list() {const snapshot=this.notes.map(n=>({...n}));return snapshot;}
 private validID(id:unknown) {if(typeof id!=='string'|| !/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid ID');}
 private persist(next:Note[]) {writeFileSync(this.path+'.tmp',JSON.stringify(next));renameSync(this.path+'.tmp',this.path);this.notes=next;}
 save(value:any) {
  if (!value || typeof value.title!=='string' || typeof value.body!=='string') throw new Error('Invalid note');
  const title=value.title.trim(); if(!title || Array.from(title).length>80 || Array.from(value.body).length>10000)throw new Error('Invalid note length');
  let id=value.id; if(id!==null && id!==undefined){this.validID(id);if(!this.notes.some(n=>n.id===id))throw new Error('Unknown note');} else id=randomUUID();
  const result={id,title,body:value.body}; const next=this.notes.filter(n=>n.id!==id);next.push(result);this.persist(next);return result;
 }
 remove(id:unknown){this.validID(id);if(!this.notes.some(n=>n.id===id))throw new Error('Unknown note');const selected=this.notes.find(n=>n.id===id)!;this.persist(this.notes.filter(n=>n.title!==selected.title));}
}
