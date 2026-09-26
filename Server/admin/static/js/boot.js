/* OwnCord admin panel: global keyboard handling and start-up. Loads last, so
   every page script has run before checkAuth() can render a section. */

/* ═══ Keyboard + Init ═══ */
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){if(document.querySelector('#toast.visible.error'))dismissToast();else closeModal()}
  /* "/" jumps to the page's search box — but only from outside a text
     field. The filter boxes are themselves .filter-search, so an unguarded
     preventDefault dropped every "/" typed into the very input it focuses
     (no log line filterable by path), and the login overlay inherited the
     swallow because hideAll() leaves #content's markup in place. */
  if(e.key==='/'&&!document.querySelector('.modal-overlay.visible')){
    const t=e.target;
    if(t&&(t.isContentEditable||/^(input|textarea|select)$/i.test(t.tagName)))return;
    const s=document.querySelector('.filter-search');if(s){e.preventDefault();s.focus()}
  }
});
document.getElementById('modal').addEventListener('click',e=>{if(e.target===e.currentTarget)closeModal()});

checkAuth();
