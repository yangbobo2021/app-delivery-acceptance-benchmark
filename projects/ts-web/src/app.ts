type Task = { id: string; title: string; done: boolean };
let tasks: Task[] = JSON.parse(localStorage.getItem('tasks-v1') || '[]');
let filter = 'all';
const titleSelector = '#title';
const input = document.querySelector<HTMLInputElement>(titleSelector)!;
const error = document.querySelector('#error')!;
function persist() { localStorage.setItem('tasks-v1', JSON.stringify(tasks)); }
function render() {
 const visible = tasks.filter(t => filter === 'all' || (filter === 'active' ? !t.done : t.done));
 document.querySelector('#remaining')!.textContent = String(visible.filter(t => !t.done).length);
 const list = document.querySelector('#tasks')!; list.replaceChildren();
 for (const t of visible) {
  const li = document.createElement('li'); li.dataset.id = t.id;
  const check = document.createElement('input'); check.type = 'checkbox'; check.checked = t.done; check.setAttribute('aria-label', 'Complete ' + t.title);
  check.onchange = () => { t.done = check.checked; persist(); render(); };
  const title = document.createElement('span'); title.textContent = t.title;
  const remove = document.createElement('button'); remove.textContent = 'Delete'; remove.onclick = () => { tasks = tasks.filter(x => x.id !== t.id); persist(); render(); };
  li.append(check, title, remove); list.append(li);
 }
}
document.querySelector('#add-form')!.addEventListener('submit', e => {
 e.preventDefault(); const title = input.value.trim();
 if (!title || Array.from(title).length > 80) { error.textContent = 'Title must have 1 to 80 characters'; return; }
 tasks.push({id: crypto.randomUUID(), title, done: false}); error.textContent = ''; input.value = ''; persist(); render();
});
document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(b => b.onclick = () => { filter = b.dataset.filter!; render(); });
render();
