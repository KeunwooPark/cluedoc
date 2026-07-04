/* Cluedoc paper viewer
   Renders a single .cluedoc paper (YAML frontmatter + Markdown + Mermaid),
   rewrites inter-paper links to stay in the viewer, and builds a sidebar by
   crawling the citation graph outward from the example's root paper.
   No build step — everything is derived from the papers themselves. */

(function () {
  var params = new URLSearchParams(location.search);
  var docPath = params.get('doc');
  var exTitle = params.get('title') || 'Example';

  var bodyEl = document.getElementById('body');
  var crumbsEl = document.getElementById('crumbs');
  var treeEl = document.getElementById('tree');
  var nameEl = document.getElementById('exName');
  var repoEl = document.getElementById('exRepo');

  if (!docPath) {
    bodyEl.innerHTML = '<div class="status">No paper specified.</div>';
    return;
  }

  // --- path helpers (paths are site-root-relative, e.g. examples/foo/.cluedoc/a/README.md) ---
  function dirOf(p) { return p.slice(0, p.lastIndexOf('/') + 1); }
  function normalize(p) {
    var parts = p.split('/'), out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (seg === '.' || seg === '') { if (i === parts.length - 1) out.push(''); continue; }
      if (seg === '..') { out.pop(); continue; }
      out.push(seg);
    }
    return out.join('/');
  }
  function resolve(fromDoc, rel) { return normalize(dirOf(fromDoc) + rel); }

  // The example's .cluedoc root, e.g. examples/foo/.cluedoc/
  var cluIdx = docPath.indexOf('.cluedoc/');
  var docRoot = cluIdx >= 0 ? docPath.slice(0, cluIdx + '.cluedoc/'.length) : dirOf(docPath);
  var rootDoc = docRoot + 'README.md';

  function isPaperLink(href) {
    return /README\.md(\?.*)?(#.*)?$/.test(href) &&
      !/^https?:/i.test(href) && !href.startsWith('#') && !href.startsWith('mailto:');
  }
  function viewerHref(absPath) {
    return 'viewer.html?doc=' + encodeURIComponent(absPath) + '&title=' + encodeURIComponent(exTitle);
  }

  // --- frontmatter ---
  function splitFrontmatter(md) {
    if (md.slice(0, 3) !== '---') return { fm: {}, body: md };
    var end = md.indexOf('\n---', 3);
    if (end < 0) return { fm: {}, body: md };
    var raw = md.slice(3, end);
    var body = md.slice(md.indexOf('\n', end + 1) + 1);
    var fm = {};
    raw.split('\n').forEach(function (line) {
      var m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
    return { fm: fm, body: body };
  }

  // --- mermaid init (light only) ---
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' });
  }

  // --- render one paper ---
  function renderPaper(md, thisDoc) {
    var split = splitFrontmatter(md);
    var renderer = new marked.Renderer();

    // Rewrite links: inter-paper README links go through the viewer; others open normally.
    renderer.link = function (href, title, text) {
      var h = href, external = false;
      if (isPaperLink(href)) {
        h = viewerHref(resolve(thisDoc, href.replace(/[#?].*$/, '')));
      } else if (/^https?:/i.test(href)) {
        external = true;
      }
      return '<a href="' + h + '"' + (title ? ' title="' + title + '"' : '') +
        (external ? ' target="_blank" rel="noopener"' : '') + '>' + text + '</a>';
    };

    // Tag fenced code: mermaid → live diagram; a leading ASCII banner → accent styling.
    renderer.code = function (code, infostring) {
      var lang = (infostring || '').trim().split(/\s+/)[0];
      if (lang === 'mermaid') {
        return '<div class="mermaid">' + code.replace(/</g, '&lt;') + '</div>';
      }
      var looksBanner = /[█▓▄▀◆═╗╔]/.test(code) || (!lang && /^\s*[A-Z0-9 ]{6,}\s*$/.test(code.split('\n')[0] || ''));
      var cls = looksBanner ? ' class="banner"' : '';
      return '<pre' + cls + '><code>' + code.replace(/[&<>]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
      }) + '</code></pre>';
    };

    marked.setOptions({ renderer: renderer, breaks: false, gfm: true });
    var title = split.fm.title || exTitle;
    var html = marked.parse(split.body);
    // Ensure the paper title shows even if the body doesn't repeat it as an h1.
    if (!/^\s*<h1/.test(html) && title) html = '<h1>' + escapeHtml(title) + '</h1>' + html;

    // On an example's root paper, surface a link to the source repository.
    var isRoot = normalize(thisDoc) === normalize(rootDoc);
    if (isRoot && split.fm.repo) {
      var repo = split.fm.repo.trim();
      html = '<a class="gh-link" href="https://github.com/' + encodeURI(repo) +
        '" target="_blank" rel="noopener"><span>◆</span> ' + escapeHtml(repo) + ' on GitHub ↗</a>' + html;
    }

    bodyEl.innerHTML = html;
    document.title = 'Cluedoc — ' + title;

    // Breadcrumbs from the path under .cluedoc/
    var relFromRoot = thisDoc.slice(docRoot.length).replace(/README\.md$/, '');
    var segs = relFromRoot.split('/').filter(Boolean);
    var crumb = ['<a href="examples.html">examples</a>', '<a href="' + viewerHref(rootDoc) + '">' + escapeHtml(exTitle) + '</a>'];
    var acc = docRoot;
    segs.forEach(function (s, i) {
      acc += s + '/';
      var last = i === segs.length - 1;
      var label = s.replace(/-/g, ' ');
      crumb.push(last ? escapeHtml(label) : '<a href="' + viewerHref(acc + 'README.md') + '">' + escapeHtml(label) + '</a>');
    });
    crumbsEl.innerHTML = crumb.join(' <span style="opacity:.5">/</span> ');

    if (window.mermaid) {
      try { mermaid.run({ nodes: bodyEl.querySelectorAll('.mermaid') }); } catch (e) {}
    }
    window.scrollTo(0, 0);
    highlightTree(thisDoc);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // --- load the requested paper ---
  fetch(docPath, { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
    .then(function (md) { renderPaper(md, normalize(docPath)); })
    .catch(function (e) { bodyEl.innerHTML = '<div class="status">Could not load paper (' + escapeHtml(String(e)) + ').</div>'; });

  // --- sidebar: crawl the citation graph from the root, build a tree by path ---
  nameEl.textContent = exTitle;
  var cache = {};
  function fetchDoc(p) {
    if (cache[p]) return cache[p];
    cache[p] = fetch(p, { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .catch(function () { return ''; });
    return cache[p];
  }

  function crawl() {
    var seen = {}, order = [];
    var queue = [rootDoc];
    seen[rootDoc] = true;
    function step() {
      if (!queue.length) { buildTree(order); return; }
      var p = queue.shift();
      fetchDoc(p).then(function (md) {
        order.push(p);
        var split = splitFrontmatter(md || '');
        if (!repoEl.textContent && split.fm.repo) repoEl.textContent = split.fm.repo;
        var re = /\]\(([^)]+README\.md)[^)]*\)/g, m;
        while ((m = re.exec(md || ''))) {
          var href = m[1];
          if (/^https?:/i.test(href)) continue;
          var abs = resolve(p, href);
          if (abs.indexOf(docRoot) !== 0) continue; // stay within this example
          if (!seen[abs]) { seen[abs] = true; queue.push(abs); }
        }
        step();
      });
    }
    step();
  }

  function titleFromPath(p) {
    var rel = p.slice(docRoot.length).replace(/\/?README\.md$/, '');
    if (!rel) return exTitle;
    var last = rel.split('/').pop();
    return last.replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function buildTree(paths) {
    // Build nested structure keyed by path segments under docRoot.
    var root = { children: {}, path: rootDoc };
    paths.forEach(function (p) {
      var rel = p.slice(docRoot.length).replace(/\/?README\.md$/, '');
      if (!rel) return;
      var segs = rel.split('/');
      var node = root, acc = docRoot;
      segs.forEach(function (s) {
        acc += s + '/';
        node.children[s] = node.children[s] || { children: {}, path: acc + 'README.md' };
        node = node.children[s];
      });
    });
    function render(node) {
      var keys = Object.keys(node.children).sort();
      if (!keys.length) return '';
      return '<ul>' + keys.map(function (k) {
        var c = node.children[k];
        return '<li><a href="' + viewerHref(c.path) + '" data-doc="' + escapeHtml(normalize(c.path)) + '">' +
          escapeHtml(titleFromPath(c.path)) + '</a>' + render(c) + '</li>';
      }).join('') + '</ul>';
    }
    treeEl.innerHTML = '<ul><li><a href="' + viewerHref(rootDoc) + '" data-doc="' + escapeHtml(normalize(rootDoc)) +
      '">' + escapeHtml(exTitle) + ' <span style="opacity:.6">(root)</span></a>' + render(root) + '</li></ul>';
    highlightTree(normalize(docPath));
  }

  function highlightTree(activeDoc) {
    var links = treeEl.querySelectorAll('a[data-doc]');
    for (var i = 0; i < links.length; i++) {
      links[i].classList.toggle('active', links[i].getAttribute('data-doc') === activeDoc);
    }
  }

  crawl();
})();
