(function () {
  'use strict';
  const notes = window.BLOG_DESIGN_NOTES;
  const preview = document.getElementById('preview');
  const descriptions = {
    a: 'A · 白底、蓝色链接、按年份排列的紧凑目录；与现有主页衔接最自然，文章右侧保留轻量目录。',
    b: 'B · 左侧主题导航，右侧文章列表；适合查算法资料。主题为设计示例，正式使用前需为 29 篇无标签笔记归类。',
    c: 'C · 温暖纸色、衬线标题和摘要列表；更像独立个人博客，适合将来并列展示技术文章、游记和随笔。'
  };
  const topics = ['全部笔记', '数学', '数据结构', '字符串', '动态规划', '图论', '几何与数值', '其他'];
  let design = 'a';
  let topic = '全部笔记';
  let mobile = false;
  let view = 'list';

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  }

  function render() {
    preview.className = 'preview design-' + design + (mobile ? ' mobile' : '');
    preview.dataset.view = view;
    document.getElementById('list-view').hidden = view !== 'list';
    document.getElementById('article-view').hidden = view !== 'article';
    document.getElementById('design-description').textContent = descriptions[design];
    document.getElementById('list-heading').textContent = design === 'c' ? '文章与记录' : design === 'b' ? '算法笔记' : '笔记';
    document.getElementById('list-subtitle').textContent = design === 'c' ? '留下一些想明白的事。' : '算法、数学与学习中的思考。';
    document.querySelectorAll('[data-design]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.design === design)));
    document.querySelectorAll('[data-device]').forEach(el => el.setAttribute('aria-pressed', String((el.dataset.device === 'mobile') === mobile)));
    document.querySelectorAll('[data-view]').forEach(el => {
      if (el.tagName === 'BUTTON') el.setAttribute('aria-pressed', String(el.dataset.view === view));
    });
    const query = document.getElementById('search').value.trim().toLocaleLowerCase();
    const filtered = notes.filter(note => note.title.toLocaleLowerCase().includes(query) && (design !== 'b' || topic === '全部笔记' || note.topic === topic));
    document.getElementById('result-count').textContent = filtered.length === notes.length ? '29 篇笔记' : filtered.length + ' / 29 篇笔记';
    document.getElementById('no-results').hidden = filtered.length > 0;
    const list = document.getElementById('post-list');
    list.replaceChildren();
    const groups = new Map();
    filtered.forEach(note => {
      const group = design === 'b' ? note.topic : design === 'c' ? '全部文章' : note.date.slice(0, 4);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(note);
    });
    const orderedGroups = design === 'b' ? topics.filter(label => groups.has(label)).map(label => [label, groups.get(label)]) : Array.from(groups);
    orderedGroups.forEach(([label, items]) => {
      const section = element('section', 'post-group');
      section.appendChild(element('h2', 'group-heading', label));
      items.forEach(note => {
        const row = element('article', 'post-row');
        const title = element('h3', 'post-title');
        const link = element('a', '', note.title);
        link.href = note.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        title.appendChild(link);
        row.appendChild(title);
        const date = element('time', '', note.date);
        date.dateTime = note.date;
        row.appendChild(date);
        row.appendChild(element('span', 'post-topic', note.topic));
        if (note.excerpt) row.appendChild(element('p', 'post-excerpt', note.excerpt));
        section.appendChild(row);
      });
      list.appendChild(section);
    });
    const nav = document.getElementById('topic-nav');
    nav.replaceChildren();
    topics.forEach(label => {
      const count = label === '全部笔记' ? notes.length : notes.filter(note => note.topic === label).length;
      if (!count) return;
      const button = element('button', '', label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(topic === label));
      button.appendChild(element('span', '', String(count)));
      button.addEventListener('click', () => { topic = label; view = 'list'; render(); });
      nav.appendChild(button);
    });
  }
  document.querySelectorAll('[data-design]').forEach(button => button.addEventListener('click', () => { design = button.dataset.design; render(); }));
  document.querySelectorAll('button[data-view]').forEach(button => button.addEventListener('click', () => { view = button.dataset.view; render(); }));
  document.querySelectorAll('[data-device]').forEach(button => button.addEventListener('click', () => { mobile = button.dataset.device === 'mobile'; render(); }));
  document.querySelectorAll('[data-show-list]').forEach(button => button.addEventListener('click', () => { view = 'list'; topic = '全部笔记'; document.getElementById('search').value = ''; render(); }));
  document.getElementById('search').addEventListener('input', render);
  render();
})();
